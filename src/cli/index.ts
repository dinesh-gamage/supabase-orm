import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';

import { CliContext } from './context.js';
import { loadModuleDatabase } from '../config/load-config.js';
import type { ResolvedModule } from '../config/types.js';
import { diff } from '../schema/differ.js';
import { generateSql, describeChange } from '../schema/sql-generator.js';
import { generateTypes } from '../schema/type-generator.js';
import { introspectSchema } from '../schema/introspector.js';
import type { DiffChange, TableDef } from '../schema/types.js';
import { splitSqlStatements } from '../migrate/splitter.js';
import { MigrationRunner } from '../migrate/runner.js';
import { generateBootstrapSql } from '../migrate/bootstrap.js';
import { getNextMigrationNumber, migrationFileName } from '../migrate/planner.js';

// ─── package.json (for --version) ──────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string };

// ─── error handling ─────────────────────────────────────────────────────────

function withErrorHandling(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  };
}

// A `renamedFrom` table hint only becomes detectable if the OLD name is also
// introspected — the differ matches the desired table's renamedFrom against
// a live table under that old name. Without this, a table rename is
// indistinguishable from `create_table` (the old name is simply never asked
// about) and the rename workflow described in the README silently fails.
function tableNamesForIntrospection(tables: TableDef[]): string[] {
  const names = new Set<string>();
  for (const t of tables) {
    names.add(t.tableName);
    if (t.renamedFrom) names.add(t.renamedFrom);
  }
  return [...names];
}

function tagFor(c: DiffChange): string {
  if (c.category === 'destructive') return '[destructive] ';
  if (c.category === 'manual') return '[manual] ';
  return '';
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ─── program ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('supaorm')
  .description('Schema-as-code, safe auto-generated migrations, and typed data access for Supabase')
  .version(pkg.version)
  .option('--config <path>', 'Path to a supaorm config file (default: discovered by walking up from cwd)')
  .option('--env-file <path>', 'Path to a .env file to load before reading connection env vars');

// ─── init ─────────────────────────────────────────────────────────────────

const CONFIG_TEMPLATE = `import { defineConfig } from '@dinesh-gamage/supabase-orm';

export default defineConfig({
  connection: {
    urlEnv: 'SUPABASE_URL',
    serviceKeyEnv: 'SUPABASE_SERVICE_ROLE_KEY',
    // envFile: '.env.local',
  },
  modules: [
    {
      id: 'app',
      schema: './supaorm/schema.ts',
      migrationsDir: './supaorm/migrations',
      typesOutput: './supaorm/generated.types.ts',
    },
  ],
});
`;

const SCHEMA_TEMPLATE = `import { col, defineSchema, table } from '@dinesh-gamage/supabase-orm';

export default defineSchema('app', [
  table('app_widgets', {
    id: col.uuid().primaryKey().default('gen_random_uuid()'),
    name: col.text().notNull(),
    created_at: col.timestamptz().notNull().default('NOW()'),
    updated_at: col.timestamptz().notNull().default('NOW()'),
  }),
]);
`;

program
  .command('init')
  .description('Write a starter supaorm.config.ts + example schema file in the current directory')
  .option('--force', 'Overwrite existing files')
  .action(
    withErrorHandling(async (opts: { force?: boolean }) => {
      const cwd = process.cwd();
      const configPath = resolve(cwd, 'supaorm.config.ts');
      const schemaDir = resolve(cwd, 'supaorm');
      const schemaPath = resolve(schemaDir, 'schema.ts');

      const existing = [configPath, schemaPath].filter(existsSync);
      if (existing.length > 0 && !opts.force) {
        throw new Error(`File(s) already exist: ${existing.join(', ')}. Re-run with --force to overwrite.`);
      }

      mkdirSync(schemaDir, { recursive: true });
      writeFileSync(configPath, CONFIG_TEMPLATE, 'utf8');
      writeFileSync(schemaPath, SCHEMA_TEMPLATE, 'utf8');

      console.log('  created supaorm.config.ts');
      console.log('  created supaorm/schema.ts');
      console.log('');
      console.log('Next steps:');
      console.log('  1. supaorm bootstrap --write      (paste supabase/bootstrap.sql into the Supabase SQL editor)');
      console.log('  2. Edit supaorm/schema.ts to describe your tables');
      console.log('  3. supaorm diff');
      console.log('  4. supaorm generate');
      console.log('  5. supaorm apply');
    })
  );

// ─── diff ─────────────────────────────────────────────────────────────────

interface ModuleDiffResult {
  moduleId: string;
  changes: DiffChange[];
  staleHints: string[];
}

program
  .command('diff')
  .description('Show pending schema changes for one or all modules (read-only)')
  .option('--module <id>', 'Scope to one module')
  .option('--json', 'Print machine-readable JSON instead of text')
  .action(
    withErrorHandling(async (opts: { module?: string; json?: boolean }, cmd: Command) => {
      const ctx = await CliContext.create(cmd.optsWithGlobals());
      const modules = ctx.selectModules(opts.module);

      const results: ModuleDiffResult[] = [];
      for (const module of modules) {
        const db = await loadModuleDatabase(module, ctx.config.aliases, ctx.config.configDir);
        const tableNames = tableNamesForIntrospection(db.schema.tables);
        const functionNames = db.functions.map((f) => f.name);
        const live = await introspectSchema(ctx.getExecutor(), tableNames, functionNames);
        const result = diff(db.schema, live, db.functions, db.triggers, db.policies);
        results.push({ moduleId: module.id, changes: result.changes, staleHints: result.staleHints });
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        let totalChanges = 0;
        for (const r of results) {
          console.log(`\n== ${r.moduleId} ==`);
          if (r.changes.length === 0) {
            console.log('  in sync');
          } else {
            for (const c of r.changes) {
              console.log(`  ${tagFor(c)}${describeChange(c)}`);
            }
            totalChanges += r.changes.length;
            const destructiveCount = r.changes.filter((c) => c.category === 'destructive').length;
            if (destructiveCount > 0) {
              console.log(
                `  -- ${destructiveCount} destructive change(s) excluded by default; re-run generate/apply with --force-destructive to include them`
              );
            }
          }
          if (r.staleHints.length > 0) {
            console.log('  cleanup reminders:');
            for (const h of r.staleHints) console.log(`    ${h}`);
          }
        }
        console.log('');
        console.log(totalChanges === 0 ? 'Schema in sync — no changes needed.' : `${totalChanges} pending change(s).`);
      }

      const anyChanges = results.some((r) => r.changes.length > 0);
      if (anyChanges) process.exitCode = 1;
    })
  );

// ─── generate ───────────────────────────────────────────────────────────────

program
  .command('generate')
  .description('Generate migration file(s) from the diff')
  .option('--module <id>', 'Scope to one module')
  .option('--dry-run', 'Print SQL without writing files')
  .option('--force-destructive', 'Include destructive changes in the generated SQL')
  .option('--name <label>', 'Label used for the structural migration filename')
  .action(
    withErrorHandling(
      async (
        opts: { module?: string; dryRun?: boolean; forceDestructive?: boolean; name?: string },
        cmd: Command
      ) => {
        const ctx = await CliContext.create(cmd.optsWithGlobals());
        const modules = ctx.selectModules(opts.module);
        const includeDestructive = Boolean(opts.forceDestructive) || ctx.config.allowDestructive;

        for (const module of modules) {
          const db = await loadModuleDatabase(module, ctx.config.aliases, ctx.config.configDir);
          const tableNames = tableNamesForIntrospection(db.schema.tables);
          const functionNames = db.functions.map((f) => f.name);
          const live = await introspectSchema(ctx.getExecutor(), tableNames, functionNames);
          const result = diff(db.schema, live, db.functions, db.triggers, db.policies);

          if (result.changes.length === 0) {
            console.log(`${module.id}: in sync`);
            continue;
          }

          const destructiveChanges = result.changes.filter((c) => c.category === 'destructive');
          if (destructiveChanges.length > 0 && !includeDestructive) {
            console.log(
              `${module.id}: ${destructiveChanges.length} destructive change(s) excluded — re-run with --force-destructive to include:`
            );
            for (const c of destructiveChanges) console.log(`  ${describeChange(c)}`);
          }

          const { enumSql, structuralSql } = generateSql(result, db.schema, {
            functions: db.functions,
            triggers: db.triggers,
            policies: db.policies,
            includeDestructive,
          });

          if (!enumSql && !structuralSql) {
            console.log(`${module.id}: no safe changes to generate`);
            continue;
          }

          const files: { name: string; sql: string }[] = [];
          let nextNum = getNextMigrationNumber(module.migrationsDir);
          if (enumSql) {
            files.push({ name: migrationFileName(nextNum, 'enum_additions'), sql: enumSql });
            nextNum = String(Number(nextNum) + 1).padStart(3, '0');
          }
          if (structuralSql) {
            files.push({ name: migrationFileName(nextNum, opts.name ?? 'schema_changes'), sql: structuralSql });
          }

          for (const file of files) {
            if (opts.dryRun) {
              console.log(`\n-- ${module.id} / ${file.name} --`);
              console.log(file.sql);
            } else {
              mkdirSync(module.migrationsDir, { recursive: true });
              writeFileSync(join(module.migrationsDir, file.name), file.sql, 'utf8');
              console.log(`  wrote ${module.id}/${file.name}`);
            }
          }
        }
      }
    )
  );

// ─── apply ────────────────────────────────────────────────────────────────

program
  .command('apply')
  .description('Run pending migration files against the database')
  .option('--module <id>', 'Scope to one module')
  .option('--dry-run', 'List what would run without executing or recording anything')
  .option('--force-destructive', 'Run migrations marked destructive instead of skipping them')
  .option('--per-statement', 'Force every migration in this run to execute statement-by-statement')
  .action(
    withErrorHandling(
      async (
        opts: { module?: string; dryRun?: boolean; forceDestructive?: boolean; perStatement?: boolean },
        cmd: Command
      ) => {
        const ctx = await CliContext.create(cmd.optsWithGlobals());
        const modules = ctx.selectModules(opts.module);
        const runner = new MigrationRunner(ctx.getExecutor(), { migrationsTable: ctx.config.migrationsTable });

        let anyFailed = false;

        for (const module of modules) {
          console.log(`\n== ${module.id} ==`);
          try {
            const result = await runner.run(module.id, module.migrationsDir, {
              forceDestructive: opts.forceDestructive,
              perStatement: opts.perStatement,
              dryRun: opts.dryRun,
            });

            if (result.dryRun) {
              if (result.pending.length === 0) {
                console.log('  up to date');
              } else {
                console.log('  pending:');
                for (const name of result.pending) console.log(`    ${name}`);
              }
              continue;
            }

            if (result.executed.length === 0) {
              console.log('  up to date');
              continue;
            }

            for (const outcome of result.executed) {
              const status = outcome.success ? 'OK' : 'FAILED';
              console.log(
                `  [${status}] ${outcome.name} (${outcome.mode}, ${outcome.statementCount} stmt, ${outcome.executionTimeMs}ms)`
              );
              if (!outcome.success && outcome.errorMessage) {
                console.log(`    ${outcome.errorMessage}`);
              }
            }

            if (!result.success) anyFailed = true;
          } catch (err) {
            console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
            anyFailed = true;
          }
        }

        if (anyFailed) process.exitCode = 1;
      }
    )
  );

// ─── push ─────────────────────────────────────────────────────────────────

interface PushItem {
  module: ResolvedModule;
  enumSql: string | null;
  structuralSql: string | null;
}

program
  .command('push')
  .description('Diff, generate, and execute SQL directly against the database — dev-only, NOT recorded as a migration')
  .option('--module <id>', 'Scope to one module')
  .option('--dry-run', 'Print SQL without executing anything')
  .option('--force-destructive', 'Include destructive changes')
  .option('--yes', 'Skip the confirmation prompt')
  .action(
    withErrorHandling(
      async (
        opts: { module?: string; dryRun?: boolean; forceDestructive?: boolean; yes?: boolean },
        cmd: Command
      ) => {
        const ctx = await CliContext.create(cmd.optsWithGlobals());
        const modules = ctx.selectModules(opts.module);
        const includeDestructive = Boolean(opts.forceDestructive) || ctx.config.allowDestructive;

        const toPush: PushItem[] = [];
        for (const module of modules) {
          const db = await loadModuleDatabase(module, ctx.config.aliases, ctx.config.configDir);
          const tableNames = tableNamesForIntrospection(db.schema.tables);
          const functionNames = db.functions.map((f) => f.name);
          const live = await introspectSchema(ctx.getExecutor(), tableNames, functionNames);
          const result = diff(db.schema, live, db.functions, db.triggers, db.policies);
          if (result.changes.length === 0) continue;

          const { enumSql, structuralSql } = generateSql(result, db.schema, {
            functions: db.functions,
            triggers: db.triggers,
            policies: db.policies,
            includeDestructive,
          });
          if (!enumSql && !structuralSql) continue;

          toPush.push({ module, enumSql, structuralSql });
        }

        if (toPush.length === 0) {
          console.log('Nothing to push — all modules in sync.');
          return;
        }

        console.log('WARNING: push applies directly to the database and is dev-only — it is NEVER recorded');
        console.log('in the migrations table. Prefer `generate` + `apply` for anything you want tracked.\n');

        for (const item of toPush) {
          console.log(`\n== ${item.module.id} ==`);
          if (item.enumSql) {
            console.log('-- enum additions --');
            console.log(item.enumSql);
          }
          if (item.structuralSql) {
            console.log('-- structural changes --');
            console.log(item.structuralSql);
          }
        }

        if (opts.dryRun) return;

        if (!opts.yes) {
          const confirmed = await promptYesNo('\nApply to database? (y/N) ');
          if (!confirmed) {
            console.log('Aborted.');
            return;
          }
        }

        const executor = ctx.getExecutor();
        for (const item of toPush) {
          if (item.enumSql) {
            for (const statement of splitSqlStatements(item.enumSql)) {
              await executor.exec(statement);
            }
          }
          if (item.structuralSql) {
            await executor.exec(item.structuralSql);
          }
          console.log(`  pushed ${item.module.id}`);
        }
      }
    )
  );

// ─── types ────────────────────────────────────────────────────────────────

program
  .command('types')
  .description('Regenerate TypeScript types from schema files (no DB needed)')
  .option('--module <id>', 'Scope to one module')
  .action(
    withErrorHandling(async (opts: { module?: string }, cmd: Command) => {
      const ctx = await CliContext.create(cmd.optsWithGlobals());
      const modules = ctx.selectModules(opts.module).filter((m) => m.typesOutput);

      if (modules.length === 0) {
        console.log('No modules with typesOutput configured.');
        return;
      }

      for (const module of modules) {
        const db = await loadModuleDatabase(module, ctx.config.aliases, ctx.config.configDir);
        const src = generateTypes(db.schema);
        mkdirSync(dirname(module.typesOutput!), { recursive: true });
        writeFileSync(module.typesOutput!, src, 'utf8');
        console.log(`  wrote ${module.typesOutput}`);
      }
    })
  );

// ─── status ───────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show applied/pending/failed migrations and checksum drift per module')
  .option('--module <id>', 'Scope to one module')
  .option('--json', 'Print machine-readable JSON instead of text')
  .action(
    withErrorHandling(async (opts: { module?: string; json?: boolean }, cmd: Command) => {
      const ctx = await CliContext.create(cmd.optsWithGlobals());
      const modules = ctx.selectModules(opts.module);
      const runner = new MigrationRunner(ctx.getExecutor(), { migrationsTable: ctx.config.migrationsTable });

      const results = [];
      for (const module of modules) {
        const applied = await runner.getApplied(module.id);
        const appliedOk = applied.filter((a) => a.success);
        const failed = applied.filter((a) => !a.success);
        const pending = await runner.getPending(module.id, module.migrationsDir);
        const drift = await runner.checkDrift(module.id, module.migrationsDir);

        results.push({
          moduleId: module.id,
          applied: appliedOk.length,
          pending,
          failed: failed.map((f) => ({ name: f.name, errorMessage: f.errorMessage })),
          drift,
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      for (const r of results) {
        console.log(`\n== ${r.moduleId} ==`);
        console.log(`  applied: ${r.applied}`);
        console.log(`  pending: ${r.pending.length ? r.pending.join(', ') : '(none)'}`);
        if (r.failed.length > 0) {
          console.log('  failed:');
          for (const f of r.failed) console.log(`    ${f.name}: ${f.errorMessage}`);
        }
        if (r.drift.length > 0) {
          console.log('  drift:');
          for (const d of r.drift) {
            console.log(`    ${d.name} (recorded ${d.recordedChecksum.slice(0, 8)} != current ${d.currentChecksum.slice(0, 8)})`);
          }
        }
      }

      const anyIssues = results.some((r) => r.failed.length > 0 || r.drift.length > 0);
      if (anyIssues) process.exitCode = 1;
    })
  );

// ─── bootstrap ────────────────────────────────────────────────────────────

program
  .command('bootstrap')
  .description('Print (or write) the one-time bootstrap SQL for a fresh Supabase project')
  .option('--write [path]', 'Write to a file instead of stdout (default: supabase/bootstrap.sql relative to the config dir)')
  .action(
    withErrorHandling(async (opts: { write?: string | boolean }, cmd: Command) => {
      // Bootstrap runs before any config/DB exists — only load the config when
      // it's actually needed (default output path or a custom migrations table).
      const loadCtx = async () => {
        try {
          return await CliContext.create(cmd.optsWithGlobals());
        } catch {
          return null;
        }
      };

      const needsConfig = opts.write === true;
      const ctx = await loadCtx();
      if (needsConfig && !ctx) {
        throw new Error(
          'No config file found — pass an explicit path (--write <path>) or run from a directory with a supaorm config.'
        );
      }
      const sql = generateBootstrapSql({ migrationsTable: ctx?.config.migrationsTable });

      if (opts.write === undefined) {
        console.log(sql);
        return;
      }

      const outPath =
        typeof opts.write === 'string'
          ? resolve(process.cwd(), opts.write)
          : resolve(ctx!.config.configDir, 'supabase/bootstrap.sql');

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, sql, 'utf8');
      console.log(`  wrote ${outPath}`);
    })
  );

// ─── mark-done ────────────────────────────────────────────────────────────

program
  .command('mark-done <module> <migration>')
  .description('Mark a migration as successfully applied without running it')
  .action(
    withErrorHandling(async (moduleId: string, migrationName: string, _opts: unknown, cmd: Command) => {
      const ctx = await CliContext.create(cmd.optsWithGlobals());
      const [module] = ctx.selectModules(moduleId);
      const runner = new MigrationRunner(ctx.getExecutor(), { migrationsTable: ctx.config.migrationsTable });
      await runner.markDone(moduleId, migrationName, module.migrationsDir);
      console.log(`  ${moduleId} / ${migrationName} marked as done`);
    })
  );

// ─── run ──────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
