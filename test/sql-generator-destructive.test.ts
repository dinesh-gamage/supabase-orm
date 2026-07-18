import { describe, it, expect } from 'vitest';
import { generateSql, DESTRUCTIVE_MARKER } from '../src/schema/sql-generator.js';
import { desiredSchema, desiredPolicies } from './fixtures/schemas.js';
import type { DiffChange, SchemaDiff } from '../src/schema/types.js';

function makeDiff(changes: DiffChange[]): SchemaDiff {
  return {
    moduleId: 'fin',
    changes,
    hasEnumChanges: false,
    hasStructuralChanges: changes.length > 0,
    staleHints: [],
  };
}

const addColumnChange: DiffChange = {
  kind: 'add_column',
  tableName: 'fin_categories',
  columnName: 'created_at',
  category: 'safe',
};

const dropTableChange: DiffChange = {
  kind: 'drop_table',
  tableName: 'fin_orphan',
  category: 'destructive',
};

const dropColumnChange: DiffChange = {
  kind: 'drop_column',
  tableName: 'fin_accounts',
  columnName: 'legacy_code',
  category: 'destructive',
};

const alterColumnTypeChange: DiffChange = {
  kind: 'alter_column_type',
  tableName: 'fin_accounts',
  columnName: 'balance',
  category: 'destructive',
  detail: 'desired: DECIMAL(14,2), live: INTEGER',
};

const dropFunctionChange: DiffChange = {
  kind: 'drop_function',
  functionName: 'fin_old_helper',
  category: 'destructive',
  detail: 'sql text',
};

const dropTriggerChange: DiffChange = {
  kind: 'drop_trigger',
  triggerName: 'fin_old_trigger',
  tableName: 'fin_accounts',
  category: 'destructive',
};

const dropPolicyChange: DiffChange = {
  kind: 'drop_policy',
  policyName: 'fin_old_policy',
  tableName: 'fin_accounts',
  category: 'destructive',
};

const alterPolicyChange: DiffChange = {
  kind: 'alter_policy',
  policyName: 'fin_goals_owner_access',
  tableName: 'fin_goals',
  category: 'destructive',
  detail: 'expression changed',
};

const dropEnumValueChange: DiffChange = {
  kind: 'drop_enum_value',
  enumName: 'fin_goal_status',
  detail: 'legacy_status',
  category: 'manual',
};

const renameTableChange: DiffChange = {
  kind: 'rename_table',
  tableName: 'fin_categories',
  renamedFrom: 'fin_old_categories',
  category: 'safe',
};

const renameColumnChange: DiffChange = {
  kind: 'rename_column',
  tableName: 'fin_categories',
  columnName: 'name',
  renamedFrom: 'title',
  category: 'safe',
};

describe('generateSql — default mode (destructive excluded)', () => {
  it('does not emit destructive SQL and lists excluded changes in a comment block', () => {
    const diffResult = makeDiff([addColumnChange, dropColumnChange, alterColumnTypeChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema);

    expect(structuralSql).toBeTruthy();
    const sql = structuralSql!;

    expect(sql).toContain('Destructive changes detected but NOT generated');
    expect(sql).toContain('--force-destructive');
    expect(sql).toContain('drop_column  fin_accounts.legacy_code');
    expect(sql).toContain('alter_column_type  fin_accounts.balance (desired: DECIMAL(14,2), live: INTEGER)');

    // The safe change is still generated.
    expect(sql).toContain('ALTER TABLE fin_categories ADD COLUMN IF NOT EXISTS created_at');
    // No real destructive DDL present.
    expect(sql).not.toContain('DROP COLUMN legacy_code;');
    expect(sql).not.toMatch(/ALTER COLUMN balance TYPE/);
    expect(sql).not.toContain(DESTRUCTIVE_MARKER);
  });

  it('returns structuralSql: null when the diff contains only destructive/manual changes', () => {
    const diffResult = makeDiff([dropTableChange, dropEnumValueChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema);
    expect(structuralSql).toBeNull();
  });

  it('returns structuralSql: null for a diff with no changes at all', () => {
    const diffResult = makeDiff([]);
    const { structuralSql } = generateSql(diffResult, desiredSchema);
    expect(structuralSql).toBeNull();
  });

  it('emits renames first, after the exclusion comment block, ahead of other safe SQL', () => {
    const diffResult = makeDiff([renameTableChange, addColumnChange, dropTableChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema);
    const sql = structuralSql!;

    const commentIdx = sql.indexOf('Destructive changes detected but NOT generated');
    const renameIdx = sql.indexOf('ALTER TABLE fin_old_categories RENAME TO fin_categories;');
    const addColIdx = sql.indexOf('ALTER TABLE fin_categories ADD COLUMN IF NOT EXISTS created_at');

    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(commentIdx);
    expect(addColIdx).toBeGreaterThan(renameIdx);
  });
});

describe('generateSql — force mode (includeDestructive: true)', () => {
  it('starts with EXACTLY the destructive marker on the first line', () => {
    const diffResult = makeDiff([dropTableChange, addColumnChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    const sql = structuralSql!;
    expect(sql.split('\n')[0]).toBe(DESTRUCTIVE_MARKER);
  });

  it('includes a warning block listing the destructive ops', () => {
    const diffResult = makeDiff([dropTableChange, dropColumnChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    const sql = structuralSql!;
    expect(sql).toContain('DESTRUCTIVE');
    expect(sql).toContain('drop_table  fin_orphan');
    expect(sql).toContain('drop_column  fin_accounts.legacy_code');
  });

  it('emits correct DROP TABLE ... CASCADE SQL', () => {
    const diffResult = makeDiff([dropTableChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain('DROP TABLE fin_orphan CASCADE;');
  });

  it('emits correct ALTER TABLE ... DROP COLUMN SQL', () => {
    const diffResult = makeDiff([dropColumnChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain('ALTER TABLE fin_accounts DROP COLUMN legacy_code;');
  });

  it('emits correct ALTER COLUMN ... TYPE ... USING SQL', () => {
    const diffResult = makeDiff([alterColumnTypeChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain(
      'ALTER TABLE fin_accounts ALTER COLUMN balance TYPE DECIMAL(14,2) USING balance::DECIMAL(14,2); -- review USING clause'
    );
  });

  it('emits correct DROP FUNCTION IF EXISTS SQL with args', () => {
    const diffResult = makeDiff([dropFunctionChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain('DROP FUNCTION IF EXISTS fin_old_helper(sql text);');
  });

  it('emits correct DROP TRIGGER IF EXISTS SQL', () => {
    const diffResult = makeDiff([dropTriggerChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain('DROP TRIGGER IF EXISTS fin_old_trigger ON fin_accounts;');
  });

  it('emits correct DROP POLICY IF EXISTS SQL', () => {
    const diffResult = makeDiff([dropPolicyChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    expect(structuralSql).toContain('DROP POLICY IF EXISTS "fin_old_policy" ON fin_accounts;');
  });

  it('emits DROP POLICY + CREATE POLICY (real SQL) for alter_policy', () => {
    const diffResult = makeDiff([alterPolicyChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, {
      includeDestructive: true,
      policies: desiredPolicies,
    });
    const sql = structuralSql!;
    expect(sql).toContain('DROP POLICY IF EXISTS "fin_goals_owner_access" ON fin_goals;');
    expect(sql).toContain('CREATE POLICY "fin_goals_owner_access" ON fin_goals');
    const dropIdx = sql.indexOf('DROP POLICY IF EXISTS "fin_goals_owner_access" ON fin_goals;');
    const createIdx = sql.indexOf('CREATE POLICY "fin_goals_owner_access" ON fin_goals');
    expect(dropIdx).toBeLessThan(createIdx);
  });

  it('keeps manual drop_enum_value as a comment even in force mode', () => {
    const diffResult = makeDiff([dropTableChange, dropEnumValueChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    const sql = structuralSql!;
    expect(sql).toContain('MANUAL: Enum value "legacy_status"');
    // No DDL was generated for the enum value removal — only guidance comments.
    expect(sql).not.toMatch(/^ALTER TYPE fin_goal_status/m);
    expect(sql).not.toMatch(/^DROP TYPE/m);
  });

  it('emits renames first, right after the marker/warning block', () => {
    const diffResult = makeDiff([renameTableChange, renameColumnChange, dropTableChange]);
    const { structuralSql } = generateSql(diffResult, desiredSchema, { includeDestructive: true });
    const sql = structuralSql!;

    const renameTableIdx = sql.indexOf('ALTER TABLE fin_old_categories RENAME TO fin_categories;');
    const renameColIdx = sql.indexOf('ALTER TABLE fin_categories RENAME COLUMN title TO name;');
    const dropIdx = sql.indexOf('DROP TABLE fin_orphan CASCADE;');

    expect(sql.split('\n')[0]).toBe(DESTRUCTIVE_MARKER);
    expect(renameTableIdx).toBeGreaterThan(0);
    expect(renameColIdx).toBeGreaterThan(renameTableIdx);
    expect(dropIdx).toBeGreaterThan(renameColIdx);
  });
});
