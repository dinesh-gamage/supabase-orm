// Executes pending migrations for a module through a SqlExecutor, tracking
// state in the migrations table (default `_migrations` — see bootstrap.ts
// for its DDL). All DB access goes through SqlExecutor; the tracking table
// is `_`-prefixed and unreachable via PostgREST, so reads/writes here always
// use raw SQL (executor.query / executor.exec), never a table client.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { SqlExecutor } from '../client/executor.js';
import { splitSqlStatements } from './splitter.js';
import { hasDestructiveMarker, isEnumMigration, listMigrationFiles } from './planner.js';

/** Checksum value that exempts a record from drift checking (see markDone). */
const MANUAL_CHECKSUM = 'manual';

export interface AppliedMigration {
  name: string;
  checksum: string | null;
  success: boolean;
  executedAt: string;
  errorMessage: string | null;
}

export interface DriftReport {
  name: string;
  recordedChecksum: string;
  currentChecksum: string;
}

export interface MigrationOutcome {
  name: string;
  success: boolean;
  executionTimeMs: number;
  errorMessage?: string;
  /** 'atomic' = whole file in one exec call; 'per-statement' = split and run individually. */
  mode: 'atomic' | 'per-statement';
  statementCount: number;
}

export interface RunResult {
  moduleId: string;
  dryRun: boolean;
  /** Migration names that were (or, in dryRun, would be) run, in order. */
  pending: string[];
  /** Migrations actually executed, in order. Empty in dryRun mode. */
  executed: MigrationOutcome[];
  /** True if a migration failed or was blocked, halting the remaining pending migrations. */
  stoppedEarly: boolean;
  /** True if every pending migration ran successfully (or dryRun / nothing pending). */
  success: boolean;
}

export interface MigrationRunnerOptions {
  /** Migrations tracking table name. Default '_migrations'. */
  migrationsTable?: string;
}

export interface RunOptions {
  /** Run migrations marked `-- supaorm:destructive` instead of skipping them. */
  forceDestructive?: boolean;
  /** Force every migration in this run to execute statement-by-statement. */
  perStatement?: boolean;
  /** List what would run without executing or recording anything. */
  dryRun?: boolean;
}

export class MigrationRunner {
  private readonly table: string;

  constructor(
    private readonly executor: SqlExecutor,
    opts: MigrationRunnerOptions = {}
  ) {
    this.table = opts.migrationsTable ?? '_migrations';
  }

  /** All recorded migration attempts for a module, oldest first. */
  async getApplied(moduleId: string): Promise<AppliedMigration[]> {
    const sql = `
      SELECT migration_name, checksum, success, executed_at, error_message
      FROM ${this.table}
      WHERE module_id = '${escapeSql(moduleId)}'
      ORDER BY executed_at ASC
    `;

    const rows = await this.executor.query<{
      migration_name: string;
      checksum: string | null;
      success: boolean;
      executed_at: string;
      error_message: string | null;
    }>(sql);

    return rows.map((r) => ({
      name: r.migration_name,
      checksum: r.checksum,
      success: r.success,
      executedAt: r.executed_at,
      errorMessage: r.error_message,
    }));
  }

  /** Migration filenames not yet successfully applied, in file order. */
  async getPending(moduleId: string, migrationsDir: string): Promise<string[]> {
    const files = listMigrationFiles(migrationsDir);
    const applied = await this.getApplied(moduleId);
    const successfulNames = new Set(applied.filter((a) => a.success).map((a) => a.name));
    return files.filter((file) => !successfulNames.has(nameFromFile(file)));
  }

  /**
   * Compares the checksum of every successfully-applied migration against its
   * current on-disk content. A mismatch means the file was edited after being
   * applied — a dangerous state, since re-running would silently apply
   * different SQL than what's recorded as having run.
   *
   * Migrations recorded with checksum 'manual' (via markDone) are exempt.
   * Migrations whose file no longer exists on disk are skipped (nothing to compare).
   */
  async checkDrift(moduleId: string, migrationsDir: string): Promise<DriftReport[]> {
    const applied = await this.getApplied(moduleId);
    const drift: DriftReport[] = [];

    for (const record of applied) {
      if (!record.success) continue;
      if (record.checksum == null || record.checksum === MANUAL_CHECKSUM) continue;

      const filePath = path.join(migrationsDir, `${record.name}.sql`);
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf8');
      } catch {
        continue;
      }

      const currentChecksum = sha256(content);
      if (currentChecksum !== record.checksum) {
        drift.push({ name: record.name, recordedChecksum: record.checksum, currentChecksum });
      }
    }

    return drift;
  }

  /**
   * Runs all pending migrations for a module, in file order, stopping at the
   * first failure (failed files remain pending for retry).
   *
   * Flow:
   *   1. Drift check — refuses to run anything if an already-applied migration's
   *      file has changed since it ran (throws with a `mark-done` remediation hint).
   *   2. For each pending file:
   *      - destructive marker + no forceDestructive → recorded as a failure, stop.
   *      - enum migration (`-- NO TRANSACTION` header) or perStatement → split
   *        via splitSqlStatements and exec() each statement individually
   *        (required: Postgres can't run `ALTER TYPE ... ADD VALUE` in a transaction).
   *      - otherwise (ATOMIC MODE) → the entire file content is sent in ONE
   *        executor.exec() call. One exec_sql call = one transaction, so the
   *        whole file applies completely or not at all.
   *   3. Each result is recorded in the migrations table via an escaped-string
   *      INSERT ... ON CONFLICT (module_id, migration_name) upsert.
   */
  async run(moduleId: string, migrationsDir: string, opts: RunOptions = {}): Promise<RunResult> {
    const drift = await this.checkDrift(moduleId, migrationsDir);
    if (drift.length > 0) {
      const names = drift.map((d) => d.name).join(', ');
      throw new Error(
        `Checksum drift detected for module "${moduleId}": ${names}. ` +
          `The content applied for ${drift.length === 1 ? 'this migration' : 'these migrations'} ` +
          `no longer matches the file on disk. If the on-disk change is intentional and was ` +
          `already applied by hand, run \`markDone("${moduleId}", "<migrationName>", migrationsDir)\` ` +
          `(CLI: mark-done) for each drifted migration to accept its current content, then re-run.`
      );
    }

    const pendingFiles = await this.getPending(moduleId, migrationsDir);
    const dryRun = opts.dryRun ?? false;

    const result: RunResult = {
      moduleId,
      dryRun,
      pending: pendingFiles.map(nameFromFile),
      executed: [],
      stoppedEarly: false,
      success: true,
    };

    if (dryRun) return result;

    for (const file of pendingFiles) {
      const name = nameFromFile(file);
      const content = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = sha256(content);

      if (hasDestructiveMarker(content) && !opts.forceDestructive) {
        const errorMessage =
          `Migration "${name}" is marked destructive (${'-- supaorm:destructive'}) and was not run. ` +
          `Re-run with { forceDestructive: true } to apply it.`;
        await this.record(moduleId, name, checksum, 0, false, errorMessage);
        result.executed.push({
          name,
          success: false,
          executionTimeMs: 0,
          errorMessage,
          mode: 'atomic',
          statementCount: 0,
        });
        result.stoppedEarly = true;
        result.success = false;
        break;
      }

      const perStatement = opts.perStatement === true || isEnumMigration(content);
      const mode: MigrationOutcome['mode'] = perStatement ? 'per-statement' : 'atomic';
      const startedAt = Date.now();

      try {
        let statementCount: number;
        if (perStatement) {
          const statements = splitSqlStatements(content);
          for (const statement of statements) {
            await this.executor.exec(statement);
          }
          statementCount = statements.length;
        } else {
          // ATOMIC MODE: the entire file is sent as a single executor.exec()
          // call — one exec_sql call = one transaction, so the file applies
          // completely or not at all.
          await this.executor.exec(content);
          statementCount = 1;
        }

        const executionTimeMs = Date.now() - startedAt;
        await this.record(moduleId, name, checksum, executionTimeMs, true);
        result.executed.push({ name, success: true, executionTimeMs, mode, statementCount });
      } catch (err) {
        const executionTimeMs = Date.now() - startedAt;
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.record(moduleId, name, checksum, executionTimeMs, false, errorMessage);
        result.executed.push({
          name,
          success: false,
          executionTimeMs,
          errorMessage,
          mode,
          statementCount: 0,
        });
        result.stoppedEarly = true;
        result.success = false;
        break;
      }
    }

    return result;
  }

  /**
   * Marks a migration as successfully applied without running it, recording
   * the file's *current* checksum. Used to accept manual/hand-applied changes
   * and to clear checksum drift.
   */
  async markDone(moduleId: string, migrationName: string, migrationsDir: string): Promise<void> {
    const filePath = path.join(migrationsDir, `${migrationName}.sql`);
    const content = await fs.readFile(filePath, 'utf8');
    const checksum = sha256(content);
    await this.record(moduleId, migrationName, checksum, 0, true);
  }

  private async record(
    moduleId: string,
    migrationName: string,
    checksum: string,
    executionTimeMs: number,
    success: boolean,
    errorMessage?: string
  ): Promise<void> {
    const errorValue = errorMessage ? `'${escapeSql(errorMessage)}'` : 'NULL';
    // migration_file duplicates migration_name (+ .sql) for compatibility with
    // pre-existing tracking tables where that column is NOT NULL.
    const migrationFile = `${migrationName}.sql`;
    const sql = `
      INSERT INTO ${this.table}
        (module_id, migration_name, migration_file, checksum, success, error_message, execution_time_ms)
      VALUES
        ('${escapeSql(moduleId)}', '${escapeSql(migrationName)}', '${escapeSql(migrationFile)}',
         '${escapeSql(checksum)}', ${success}, ${errorValue}, ${executionTimeMs})
      ON CONFLICT (module_id, migration_name) DO UPDATE SET
        migration_file      = EXCLUDED.migration_file,
        checksum           = EXCLUDED.checksum,
        success             = EXCLUDED.success,
        error_message       = EXCLUDED.error_message,
        execution_time_ms   = EXCLUDED.execution_time_ms,
        executed_at         = NOW();
    `;
    await this.executor.exec(sql);
  }
}

function nameFromFile(filename: string): string {
  return filename.endsWith('.sql') ? filename.slice(0, -'.sql'.length) : filename;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}
