# @dinesh-gamage/supabase-orm

Schema-as-code, safe auto-generated migrations, and typed data access for
Supabase — no separate schema-drift tooling, no manually-written migrations
for the common case, and no `any`-typed `.from()` calls.

You describe your tables in TypeScript. The tool diffs that description
against the live database, generates the SQL to close the gap, and writes
numbered migration files you can review before they run. Destructive changes
(dropped columns, dropped tables, type changes, ...) are never generated or
applied silently — they require an explicit flag every time.

- **Schema-as-code** — tables, enums, functions, triggers, and RLS policies
  defined with a small TypeScript DSL.
- **Safe by default** — creates, additive `ALTER TABLE`s, and renames are
  generated automatically; drops and type changes are not, unless you say so.
- **Typed access** — generates `Row` / `Insert` / `Update` types per table and
  a `Database`-shaped type block compatible with `createClient<Database>()`.
- **RPC-only** — the tool never opens a direct Postgres connection. Every
  operation goes through two `SECURITY DEFINER` functions
  (`exec_sql` / `query_sql`) installed once via `supaorm bootstrap`.

## Install

```bash
npm install --save-dev @dinesh-gamage/supabase-orm
npm install @supabase/supabase-js
```

`@supabase/supabase-js` is a peer dependency — the tool talks to Supabase
through your own client instance.

## Quick start

```bash
npx supaorm init
```

This writes `supaorm.config.ts` and an example `supaorm/schema.ts` in the
current directory.

```bash
npx supaorm bootstrap --write
```

Paste the generated `supabase/bootstrap.sql` into the Supabase Dashboard →
SQL Editor and run it once. It creates `exec_sql` / `query_sql` (restricted
to `service_role`), a shared `update_updated_at_column()` trigger function,
and the `_migrations` tracking table. It's idempotent, so re-running it later
(e.g. after upgrading the package) is always safe.

Now describe a table in `supaorm/schema.ts`:

```ts
import { col, defineSchema, table } from '@dinesh-gamage/supabase-orm';

export default defineSchema('app', [
  table('app_widgets', {
    id: col.uuid().primaryKey().default('gen_random_uuid()'),
    name: col.text().notNull(),
    created_at: col.timestamptz().notNull().default('NOW()'),
    updated_at: col.timestamptz().notNull().default('NOW()'),
  }),
]);
```

Then:

```bash
npx supaorm diff        # what would change? (read-only, CI-friendly exit code)
npx supaorm generate    # write a numbered migration file for the safe changes
npx supaorm apply       # run pending migration files, tracked in _migrations
npx supaorm types       # write Row/Insert/Update types for the module
```

`diff` exits `0` when every module is in sync and `1` when anything is
pending, so it works as a CI drift check without any extra flags.

## The destructive-gating story

Every detected change is classified into one of three categories:

| Category      | Examples                                              | Behavior                                            |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `safe`        | create table, add column, create index, rename, add RLS policy | Generated and applied automatically.                |
| `destructive` | drop column, drop table, change a column's type, drop policy   | **Excluded** from generated SQL unless forced.       |
| `manual`      | dropping an enum value                                | **Never** auto-generated — Postgres can't drop enum values without recreating the type; the tool always emits a comment explaining the manual steps. |

By default, `supaorm generate` only ever writes SQL for `safe` changes. If
destructive changes exist, the command still tells you about them:

```
fin: 1 destructive change(s) excluded — re-run with --force-destructive to include:
  drop_column  fin_accounts.legacy_balance
```

To actually generate the destructive SQL, pass `--force-destructive`, or set
`allowDestructive: true` in the config (useful for a scratch/dev database).
A migration file containing destructive SQL is marked with a header the
runner checks for:

```sql
-- supaorm:destructive
-- This migration includes DESTRUCTIVE changes. Review carefully before applying:
--   drop_column  fin_accounts.legacy_balance

ALTER TABLE fin_accounts DROP COLUMN legacy_balance;
```

That marker is a second, independent gate: even if a destructive file exists
on disk, `supaorm apply` refuses to run it unless you pass
`--force-destructive` on the `apply` command too. Generating a destructive
migration and applying it are two separate, explicit decisions.

Enum additions (`CREATE TYPE` / `ALTER TYPE ... ADD VALUE`) get their own
migration file, marked `-- NO TRANSACTION` at the top, because Postgres
cannot run `ALTER TYPE ... ADD VALUE` inside a transaction. The runner
detects that header and executes the file statement-by-statement instead of
as a single atomic transaction.

## Rename workflow

Postgres can't tell a rename from a drop-and-recreate — from the database's
point of view, `pm_client` disappearing and `pm_clients` appearing look
identical to a `DROP TABLE` + `CREATE TABLE`. To get a real `ALTER TABLE ...
RENAME`, tell the tool about the rename explicitly:

```ts
table('pm_clients', {
  /* ... */
}).renamedFrom('pm_client')
```

```ts
col.text().notNull().renamedFrom('client_name') // column rename
```

`supaorm diff` / `generate` then emits `ALTER TABLE pm_client RENAME TO
pm_clients;` (and the same for columns) instead of a destructive drop +
create — renames are always classified `safe`.

Once the rename has been applied, the hint becomes inert (the new name
already exists live). Rather than silently ignoring it, the diff reports a
cleanup reminder so you remember to delete the now-pointless call:

```
core: cleanup reminders:
  table pm_clients: remove .renamedFrom('pm_client') — already applied
```

`SchemaDiff.staleHints` carries these programmatically if you're scripting
against the diff engine directly.

## Config reference

```ts
import { defineConfig } from '@dinesh-gamage/supabase-orm';

export default defineConfig({
  connection: {
    urlEnv: 'SUPABASE_URL',               // default 'SUPABASE_URL'
    serviceKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY', // default 'SUPABASE_SERVICE_ROLE_KEY'
    envFile: '.env.local',                // optional, loaded via dotenv
  },
  migrationsTable: '_migrations',         // default '_migrations'
  allowDestructive: false,                // default false
  aliases: { '@': './src' },              // path aliases for schema/functions/triggers/policies files
  modules: [
    {
      id: 'fin',
      schema: './src/modules/fin/database/schema.ts',
      functions: './src/modules/fin/database/functions.ts', // optional
      triggers: './src/modules/fin/database/triggers.ts',   // optional
      policies: './src/modules/fin/database/policies.ts',   // optional
      migrationsDir: './src/modules/fin/database/migrations',
      typesOutput: './src/modules/fin/types/generated.types.ts', // omit to skip type generation
      tablePrefix: 'fin_', // validated at load; false disables validation
    },
  ],
});
```

- `supaorm.config.ts` (or `.mts` / `.js`) is discovered by walking up from
  the current directory, or pointed at explicitly with `--config <path>`.
- Schema/functions/triggers/policies files are loaded with
  [`jiti`](https://github.com/unjs/jiti), so plain TypeScript works with no
  separate build step. `aliases` are resolved only for those files — never
  for the config file's own imports.
- Every module owns its own `migrationsDir`; migration numbering
  (`001_`, `002_`, ...) is per-module.

## Typed data access

`generateTypes()` (invoked via `supaorm types`) writes a `Row` / `Insert` /
`Update` type per table plus a `{ModuleId}Database` block shaped for
supabase-js's `createClient<Database>()` generic:

```ts
import { createClient } from '@supabase/supabase-js';
import { createRepository } from '@dinesh-gamage/supabase-orm';
import type { FinDatabase, FinTables } from './src/modules/fin/types/generated.types.js';

const client = createClient<FinDatabase>(url, key);

const accounts = createRepository<FinTables, 'fin_accounts'>(client, 'fin_accounts');

const row = await accounts.insert({ name: 'Checking', currency: 'USD' });
const all = await accounts.findMany({ eq: { is_archived: false }, order: 'name' });
await accounts.update(row.id, { name: 'Checking (joint)' });

// Escape hatch for anything the helper doesn't cover:
await accounts.query().select('id, name').ilike('name', '%check%');
```

If your project spans multiple modules on one Supabase project, merge their
generated `Database` types into one client type with `MergeDatabases`:

```ts
import type { MergeDatabases } from '@dinesh-gamage/supabase-orm';
import type { FinDatabase } from './src/modules/fin/types/generated.types.js';
import type { PmDatabase } from './src/modules/pm/types/generated.types.js';

type AppDatabase = MergeDatabases<[FinDatabase, PmDatabase]>;
const client = createClient<AppDatabase>(url, key);
```

## `push` — dev-only, untracked

`supaorm push` diffs, generates, prints the SQL, and (after a confirmation
prompt, unless `--yes`) executes it immediately — skipping the
generate-a-file-and-review-it step entirely.

**It is never recorded in the migrations table.** Use it for fast local
iteration on a schema you're still shaping; use `generate` + `apply` for
anything that needs to reach a shared or production database, since only
`apply` leaves an auditable, re-runnable trail in `_migrations`.

## Architecture note

This package never opens a direct Postgres connection — every read and write
goes through two `SECURITY DEFINER` RPC functions installed by `supaorm
bootstrap`:

- `exec_sql(sql text)` — runs one or more statements, no result. Used for
  migrations and `push`.
- `query_sql(sql text)` — wraps a `SELECT` in
  `jsonb_agg(row_to_json(t))` and returns JSONB. Used by the introspector to
  read `information_schema` / `pg_catalog`.

Both are revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only
to `service_role` — the same key you'd use for any other server-side admin
operation against Supabase.

**Trust boundary:** schema definitions (tables, columns, functions,
triggers, policies) are treated as **trusted developer input**, written by
whoever owns the codebase and reviewed like any other source file. The SQL
generator interpolates `pgType`, `defaultExpr`, check/policy expressions, and
similar fields directly into the SQL it emits. Never construct a schema
definition — or any string passed into `col.default()`, `.checks()`,
`definePolicy()`, `defineFunction()`, etc. — from end-user input. If you need
runtime-driven data, that belongs in a table row, not in the DSL that defines
the table.

## License

MIT
