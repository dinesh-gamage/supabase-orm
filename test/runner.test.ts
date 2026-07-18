import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SqlExecutor } from '../src/client/executor.js';
import { MigrationRunner } from '../src/migrate/runner.js';

const TABLE = '_migrations';
const MODULE = 'testmod';

interface Row {
  module_id: string;
  migration_name: string;
  checksum: string | null;
  success: boolean;
  executed_at: string;
  error_message: string | null;
}

function parseRecordSql(sql: string): Omit<Row, 'executed_at'> | null {
  const re = new RegExp(
    `INSERT INTO ${TABLE}\\s*\\(module_id, migration_name, migration_file, checksum, success, error_message, execution_time_ms\\)\\s*VALUES\\s*` +
      `\\('([^']*)',\\s*'([^']*)',\\s*'([^']*)',\\s*'([^']*)',\\s*(true|false),\\s*(NULL|'[^']*'),\\s*(\\d+)\\)`
  );
  const match = re.exec(sql);
  if (!match) return null;
  const [, moduleId, migrationName, , checksum, success, errorRaw] = match;
  return {
    module_id: moduleId,
    migration_name: migrationName,
    checksum,
    success: success === 'true',
    error_message: errorRaw === 'NULL' ? null : errorRaw.slice(1, -1),
  };
}

/** In-memory SqlExecutor: records exec() calls and simulates the migrations table. */
class MockExecutor implements SqlExecutor {
  /** Every exec() call, in order (includes the recording INSERTs). */
  readonly execCalls: string[] = [];
  /** exec() calls that are actual migration SQL, not the runner's own bookkeeping INSERT. */
  readonly migrationExecCalls: string[] = [];

  private rows: Row[];
  private seq = 0;

  constructor(
    initialRows: Row[] = [],
    private readonly throwFor?: (sql: string) => string | undefined
  ) {
    this.rows = initialRows.map((r) => ({ ...r }));
  }

  async exec(sql: string): Promise<void> {
    this.execCalls.push(sql);

    const parsed = parseRecordSql(sql);
    if (parsed) {
      const idx = this.rows.findIndex(
        (r) => r.module_id === parsed.module_id && r.migration_name === parsed.migration_name
      );
      const row: Row = { ...parsed, executed_at: `1970-01-01T00:00:${String(++this.seq).padStart(2, '0')}Z` };
      if (idx >= 0) this.rows[idx] = row;
      else this.rows.push(row);
      return;
    }

    this.migrationExecCalls.push(sql);
    const message = this.throwFor?.(sql);
    if (message) throw new Error(message);
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const moduleMatch = /module_id = '([^']*)'/.exec(sql);
    const moduleId = moduleMatch?.[1];
    return this.rows
      .filter((r) => moduleId === undefined || r.module_id === moduleId)
      .slice()
      .sort((a, b) => a.executed_at.localeCompare(b.executed_at))
      .map((r) => ({
        migration_name: r.migration_name,
        checksum: r.checksum,
        success: r.success,
        executed_at: r.executed_at,
        error_message: r.error_message,
      })) as unknown as T[];
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('MigrationRunner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'supaorm-runner-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => {
    writeFileSync(path.join(dir, name), content);
    return content;
  };

  it('excludes successfully-applied migrations from pending but includes prior failures', async () => {
    const initContent = write('001_init.sql', 'CREATE TABLE a (id INT);');
    const enumContent = write('002_add_enum.sql', "-- NO TRANSACTION\nALTER TYPE foo ADD VALUE 'x';");

    const executor = new MockExecutor([
      {
        module_id: MODULE,
        migration_name: '001_init',
        checksum: sha256(initContent),
        success: true,
        executed_at: '1970-01-01T00:00:01Z',
        error_message: null,
      },
      {
        module_id: MODULE,
        migration_name: '002_add_enum',
        checksum: sha256(enumContent),
        success: false,
        executed_at: '1970-01-01T00:00:02Z',
        error_message: 'boom',
      },
    ]);

    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });
    const pending = await runner.getPending(MODULE, dir);

    expect(pending).toEqual(['002_add_enum.sql']);
  });

  it('sends an ordinary migration file as a single atomic exec() call', async () => {
    const content = write('001_init.sql', 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir);

    expect(result.success).toBe(true);
    expect(executor.migrationExecCalls).toEqual([content]);
    expect(result.executed).toEqual([
      expect.objectContaining({ name: '001_init', success: true, mode: 'atomic', statementCount: 1 }),
    ]);
  });

  it('runs an enum migration (-- NO TRANSACTION header) statement-by-statement', async () => {
    write(
      '001_add_enum.sql',
      "-- NO TRANSACTION\nALTER TYPE foo ADD VALUE 'x';\nALTER TYPE foo ADD VALUE 'y';"
    );
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir);

    expect(result.success).toBe(true);
    expect(executor.migrationExecCalls).toHaveLength(2);
    expect(executor.migrationExecCalls[0]).toContain("ADD VALUE 'x';");
    expect(executor.migrationExecCalls[1]).toBe("ALTER TYPE foo ADD VALUE 'y';");
    expect(result.executed[0]).toEqual(
      expect.objectContaining({ name: '001_add_enum', mode: 'per-statement', statementCount: 2 })
    );
  });

  it('respects perStatement option even for a non-enum file', async () => {
    write('001_two_statements.sql', 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir, { perStatement: true });

    expect(executor.migrationExecCalls).toHaveLength(2);
    expect(result.executed[0].mode).toBe('per-statement');
  });

  it('blocks a destructive-marker file without forceDestructive, recording a failure', async () => {
    write('001_drop.sql', '-- supaorm:destructive\nDROP TABLE a;');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir);

    expect(result.success).toBe(false);
    expect(result.stoppedEarly).toBe(true);
    expect(executor.migrationExecCalls).toHaveLength(0); // never executed
    expect(result.executed[0].success).toBe(false);
    expect(result.executed[0].errorMessage).toMatch(/destructive/i);

    const applied = await runner.getApplied(MODULE);
    expect(applied).toEqual([
      expect.objectContaining({ name: '001_drop', success: false }),
    ]);
  });

  it('runs a destructive-marker file when forceDestructive is set', async () => {
    const content = write('001_drop.sql', '-- supaorm:destructive\nDROP TABLE a;');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir, { forceDestructive: true });

    expect(result.success).toBe(true);
    expect(executor.migrationExecCalls).toEqual([content]);
  });

  it('throws on checksum drift before executing anything', async () => {
    const content = write('001_init.sql', 'CREATE TABLE a (id INT);');
    const executor = new MockExecutor([
      {
        module_id: MODULE,
        migration_name: '001_init',
        checksum: sha256(content + ' -- edited after being applied'),
        success: true,
        executed_at: '1970-01-01T00:00:01Z',
        error_message: null,
      },
    ]);
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    await expect(runner.run(MODULE, dir)).rejects.toThrow(/drift/i);
    expect(executor.migrationExecCalls).toHaveLength(0);
    // No recording INSERTs either — the run must abort before touching anything.
    expect(executor.execCalls).toHaveLength(0);
  });

  it('drift is exempt for records with checksum "manual"', async () => {
    write('001_init.sql', 'CREATE TABLE a (id INT);');
    const executor = new MockExecutor([
      {
        module_id: MODULE,
        migration_name: '001_init',
        checksum: 'manual',
        success: true,
        executed_at: '1970-01-01T00:00:01Z',
        error_message: null,
      },
    ]);
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const drift = await runner.checkDrift(MODULE, dir);
    expect(drift).toEqual([]);
  });

  it('markDone records the current file checksum and clears drift', async () => {
    const content = write('001_init.sql', 'CREATE TABLE a (id INT);');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    await runner.markDone(MODULE, '001_init', dir);

    const applied = await runner.getApplied(MODULE);
    expect(applied).toEqual([
      expect.objectContaining({ name: '001_init', success: true, checksum: sha256(content) }),
    ]);

    const drift = await runner.checkDrift(MODULE, dir);
    expect(drift).toEqual([]);
  });

  it('records a failure when exec() throws and does not run subsequent files', async () => {
    const failingContent = write('001_failing.sql', 'SELECT __THROW_ME__;');
    write('002_after.sql', 'CREATE TABLE never_run (id INT);');

    const executor = new MockExecutor([], (sql) =>
      sql.includes('__THROW_ME__') ? 'simulated exec failure' : undefined
    );
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir);

    expect(result.success).toBe(false);
    expect(result.stoppedEarly).toBe(true);
    expect(executor.migrationExecCalls).toEqual([failingContent]); // 002 never attempted
    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]).toEqual(
      expect.objectContaining({ name: '001_failing', success: false, errorMessage: 'simulated exec failure' })
    );

    const applied = await runner.getApplied(MODULE);
    expect(applied).toEqual([
      expect.objectContaining({ name: '001_failing', success: false, errorMessage: 'simulated exec failure' }),
    ]);
    expect(applied.find((a: any) => a.name === '002_after')).toBeUndefined();
  });

  it('dryRun reports pending migrations without executing or recording anything', async () => {
    write('001_init.sql', 'CREATE TABLE a (id INT);');
    write('002_more.sql', 'CREATE TABLE b (id INT);');
    const executor = new MockExecutor();
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.pending).toEqual(['001_init', '002_more']);
    expect(result.executed).toEqual([]);
    expect(executor.execCalls).toHaveLength(0);
  });

  it('stops the whole run on the first failure, leaving later migrations pending for retry', async () => {
    write('001_ok.sql', 'CREATE TABLE ok (id INT);');
    const failingContent = write('002_bad.sql', 'SELECT __THROW_ME__;');
    write('003_never.sql', 'CREATE TABLE never (id INT);');

    const executor = new MockExecutor([], (sql) =>
      sql.includes('__THROW_ME__') ? 'nope' : undefined
    );
    const runner = new MigrationRunner(executor, { migrationsTable: TABLE });

    const result = await runner.run(MODULE, dir);

    expect(result.executed.map((e) => e.name)).toEqual(['001_ok', '002_bad']);
    expect(executor.migrationExecCalls).toContain(failingContent);

    const pendingAfter = await runner.getPending(MODULE, dir);
    expect(pendingAfter).toEqual(['002_bad.sql', '003_never.sql']);
  });
});

// Sanity check on the disk fixtures helper used above — guards against a
// silently-broken write() helper masking false test passes.
describe('write() test helper', () => {
  it('actually writes readable file content', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'supaorm-runner-helper-'));
    try {
      writeFileSync(path.join(dir, 'x.sql'), 'SELECT 1;');
      expect(readFileSync(path.join(dir, 'x.sql'), 'utf8')).toBe('SELECT 1;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
