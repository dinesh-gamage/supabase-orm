# verify/dev — end-to-end validation results

First real write-cycle validation of `@dinesh-gamage/supabase-orm` against a
**blank** dev Supabase project (`grwgpesbwyhbtokrqual`, `NEXT_PUBLIC_SUPABASE_URL_DEV`
/ `SUPABASE_SECRET_KEY_DEV` in life-grid's `.env.local`). No production
credentials were touched — every command below used
`--config verify/dev/supaorm.config.ts`, whose `connection` block points
exclusively at the `_DEV` env var names.

## Connection method that worked

- `psql` was not installed; installed via `brew install libpq` (kept
  keg-only, not symlinked — no conflict with any existing postgres install).
- Session pooler hosts tried per the brief (`aws-1-`/`aws-0-` ×
  `ap-southeast-1`/`ap-south-1`/`us-east-1`) all returned
  `FATAL: tenant/user postgres.<ref> not found` — the pooler doesn't
  recognize this project ref at those hosts (likely a different pooler
  region/tier for this project).
- **Direct connection worked**: `postgresql://postgres:<DB_PASSWORD>@db.<ref>.supabase.co:5432/postgres`.
  Used for `bootstrap.sql` application and all verification queries
  throughout. All app-facing `supaorm` CLI commands themselves go through
  the RPC executor (`exec_sql`/`query_sql`), never a direct PG connection —
  psql was only used for the one-time bootstrap paste and for independently
  verifying results out-of-band.

## Step-by-step results

| Step | Result | Notes |
|---|---|---|
| 1. Bootstrap | PASS | `bootstrap.sql` applied cleanly via psql; `exec_sql`/`query_sql`/`_migrations` created; `status` connected successfully afterward. |
| 2. Happy-path cycle | PASS | `diff` → 3 creates (`create_enum`, 2×`create_table`) → `generate` wrote `001_enum_additions.sql` (NO TRANSACTION header, `CREATE TYPE`) + `002_schema_changes.sql` (tables, index, RLS policies, `updated_at` triggers, FK) → `apply` OK (enum ran per-statement, structural ran atomic) → `status` applied:2 → `diff` in sync. |
| 2b. CRUD (`crud-test.mjs`) | PASS | insert ×3, findMany(eq/order/limit), update ×1, delete ×1, count-remaining — all assertions passed against `demo_projects` via `createRepository`. |
| 3. Rename cycle | PASS (after a bug fix — see below) | `demo_projects.budget→cost` and `demo_tasks→demo_todos` via `.renamedFrom()`. First `diff` attempt misclassified the table rename as `create_table` — **bug, fixed** (see "Bugs found"). After the fix: `diff` correctly reported `rename_column` + `rename_table`, both `safe` → `generate` wrote `ALTER TABLE demo_projects RENAME COLUMN budget TO cost;` / `ALTER TABLE demo_tasks RENAME TO demo_todos;` → `apply` OK → verified via `query_sql`-equivalent (`psql`): the 2 remaining project rows kept their `cost` values (Alpha 2500.00, Gamma 1000.00 — unchanged from before the rename), `demo_todos` exists, `demo_tasks` gone → `diff` again → in sync + 2 correct stale-hint cleanup reminders → removed hints from schema → **second bug surfaced and fixed** (trigger rename, see below) → `diff` stayed in sync. |
| 4. Destructive gating | PASS | Removed `demo_projects.status` (enum column). `diff` → `[destructive] drop_column` tagged, excluded by default. `generate` (no force) → no file written, no DROP anywhere. `generate --force-destructive` → file starts with `-- supaorm:destructive` marker + real `ALTER TABLE demo_projects DROP COLUMN status;`. `apply` (no force) → refused: `"...marked destructive... was not run. Re-run with { forceDestructive: true }..."`, recorded as a FAILED attempt. `apply --force-destructive` → succeeded; column confirmed gone via `information_schema.columns`. |
| 5. Atomic apply spike | **PASS — the core design goal holds** | Hand-wrote `005_atomic_test.sql`: `CREATE TABLE demo_atomic_ok (id INT);` then `INSERT INTO demo_atomic_ok VALUES ('not-an-int');`. `apply` → `[FAILED]`, error `invalid input syntax for type integer`. Checked `demo_atomic_ok` via psql: **table does NOT exist** — the whole file (both statements) rolled back as a single transaction (one `exec_sql` call = one transaction, confirmed by the package's own doc comment in `runner.ts`). `status` showed the migration as both `pending` and `failed`. Edited the file to a valid `INSERT INTO demo_atomic_ok VALUES (42);`, re-ran `status` — **no drift error**, confirming `checkDrift` only inspects `success: true` records — then `apply` retried and succeeded. Cleaned up: dropped `demo_atomic_ok`, deleted `005_atomic_test.sql`, deleted its `_migrations` row directly (no CLI "un-record" command exists for a deleted file, so this was done via SQL to fully reset state). |
| 6. `push` (dev-only, untracked) | PASS | Added `demo_projects.notes text` to schema, `push --yes` → column created (confirmed via `information_schema.columns`), **NOT** present in `_migrations` (still exactly `001`–`004`). Removed `notes` from schema, `push --force-destructive --yes` → dropped. Final `diff` → in sync; `status` → applied: 4, pending: none — schema and DB in sync at the end, exactly as required. |

## Bugs found (in package code)

Both bugs live in the **table-rename path** and only surface once you go
through the full CLI → introspect → diff pipeline against a real database —
the existing unit tests build `LiveSchema` fixtures by hand and already
include the old-named table/trigger, so they never exercised the gap. Both
are fixed, with regression tests added, and `npx vitest run` is green
(130 → 133 tests, all passing).

### Bug 1 — `renamedFrom` on a table was never detected: silently became `create_table`

**File:** `src/cli/index.ts`, three call sites (`diff`, `generate`, `push`
commands — originally lines 148, 210, 360).

**Root cause:** `introspectSchema()` is only ever given the table names from
the *desired* schema:
```ts
const tableNames = db.schema.tables.map((t) => t.tableName);
```
For a table renamed via `.renamedFrom('demo_tasks')`, the desired name is
`demo_todos` — the OLD name `demo_tasks` was never passed to
`introspectSchema`, so the live schema it returned never contained an entry
for `demo_tasks` at all. `differ.ts`'s rename-detection logic
(`diffTables`, `liveTableMap.get(renamedFrom)`) correctly looks for the old
table by name, but it was looking in a live schema that was never asked
about it — so it always fell through to `create_table`, defeating the
entire rename workflow the README documents for tables (column renames
worked fine, because a table's own columns are introspected in full
regardless of which columns are new/renamed).

**Fix:** added a small helper and used it at all three call sites:
```ts
function tableNamesForIntrospection(tables: TableDef[]): string[] {
  const names = new Set<string>();
  for (const t of tables) {
    names.add(t.tableName);
    if (t.renamedFrom) names.add(t.renamedFrom);
  }
  return [...names];
}
```
Verified live: before the fix, `diff` reported `create_table demo_todos`;
after rebuilding with the fix, the same live DB state correctly produced
`rename_table demo_todos (renamedFrom demo_tasks)`.

### Bug 2 — after a table rename, the `updated_at` trigger's stale old name gets misclassified as an orphaned custom trigger and flagged for destructive drop

**Files:** `src/schema/differ.ts` (`diffTables` rename branch),
`src/schema/sql-generator.ts` (`buildRenameSql`), `src/schema/types.ts`
(new `DiffChangeKind`).

**Root cause:** `ALTER TABLE ... RENAME TO ...` does not rename a table's
triggers in Postgres. After renaming `demo_tasks` → `demo_todos`, the
auto-managed trigger stayed named `update_demo_tasks_updated_at`, attached
to `demo_todos`. `introspector.ts`'s loose `hasTrigger` check (any trigger
matching `update_%_updated_at` on the table) still returned `true`, so no
`add_trigger` was (correctly) emitted in the same migration as the rename —
but nothing renamed the trigger either. Once the `.renamedFrom()` hint was
removed from the schema (the documented cleanup step), `fetchCustomTriggers`
excludes auto-managed triggers by **exact name** match against the
*current* table name (`update_demo_todos_updated_at`) — the leftover
`update_demo_tasks_updated_at` no longer matched that exclusion, so it was
picked up as an unrecognized "custom" trigger and the differ emitted a
`[destructive] drop_trigger` for it. This directly broke the documented
promise that removing an applied rename hint leaves `diff` in sync.

**Fix:** in the `diffTables` rename branch, when the desired table has an
`updated_at` column and the old live table already had an auto-managed
trigger, emit a new `rename_trigger` change (`kind`, `tableName`,
`triggerName`, `renamedFrom`, `category: 'safe'`) instead of the normal
`diffTrigger` check — computed purely from the naming convention already
used everywhere else in the codebase (`update_${tableName}_updated_at`), no
extra introspection needed. `sql-generator.ts` renders it as
`ALTER TRIGGER {old} ON {table} RENAME TO {new};`, grouped with the other
rename statements (which always run first, right after the table rename
that makes the new table name valid for the `ON` clause).

Verified live: reproduced the false-positive `drop_trigger`, fixed the
package, rebuilt, and manually applied the equivalent `ALTER TRIGGER`
against the dev DB (since the earlier rename had already run under the old
code path) — `diff` returned to `in sync` with no destructive changes.

### Minor cosmetic inconsistency (not fixed — not a functional bug)

`supaorm status`'s `pending` list includes the `.sql` extension
(`005_atomic_test.sql`) while its `failed` list does not
(`005_atomic_test`) — same migration, two different name formats in the
same command's output. Purely cosmetic; left as-is.

### Environment note (not a package bug)

Local Node is v18.20.8; `@supabase/supabase-js` prints a deprecation warning
on every CLI invocation ("Node.js 18 and below are deprecated..."). Doesn't
affect functionality — every command still worked correctly — but worth
upgrading the dev/CI Node version at some point since `package.json`
declares `"engines": { "node": ">=18" }` and `tsup` targets `node18`.

## Final state of the dev DB

- Tables: `_migrations`, `demo_projects` (`id`, `name`, `cost`,
  `created_at`, `updated_at` — 2 rows: Alpha/2500.00, Gamma/1000.00),
  `demo_todos` (`id`, `project_id`, `title`, `done`, `created_at`,
  `updated_at` — 0 rows).
- Enum `demo_status` exists (declared in schema, unused by any column —
  intentionally left, per the brief; dropping an enum type isn't something
  this tool auto-generates).
- Triggers: `update_demo_projects_updated_at`, `update_demo_todos_updated_at`
  — both correctly named.
- `_migrations`: exactly 4 successful rows for module `demo`
  (`001_enum_additions`, `002_schema_changes`, `003_schema_changes`,
  `004_schema_changes`). No failed/orphaned rows.
- `supaorm diff` reports **in sync**; `supaorm status` reports
  **applied: 4, pending: none**, no drift.
- `demo_atomic_ok` (step 5 spike) and `005_atomic_test.sql` were both
  cleaned up — do not exist.

## Package changes made

```
 src/cli/index.ts            | 22 ++++++++++++++++++----
 src/schema/differ.ts        | 19 ++++++++++++++++++-
 src/schema/sql-generator.ts | 13 +++++++++++--
 src/schema/types.ts         |  5 +++++
 test/differ-rename.test.ts          | +2 tests
 test/sql-generator-destructive.test.ts | +1 test
```

`npm run build` succeeds; `npx vitest run` → **133/133 passing** (was 130
before this session). Not committed, per instructions.
