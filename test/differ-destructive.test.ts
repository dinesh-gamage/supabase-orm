import { describe, it, expect } from 'vitest';
import { diff } from '../src/schema/differ.js';
import {
  desiredSchema,
  desiredFunctions,
  desiredTriggers,
  desiredPolicies,
  buildMatchingLiveSchema,
  cloneLive,
} from './fixtures/schemas.js';
import type { LiveRlsPolicy } from '../src/schema/types.js';

describe('diff — destructive changes are fully classified, never filtered', () => {
  it('flags a live-only table as drop_table(destructive)', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    live.tables.push({
      tableName: 'fin_legacy_ledger',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    });

    const result = diff(desiredSchema, live, desiredFunctions, desiredTriggers, desiredPolicies);
    const change = result.changes.find((c) => c.kind === 'drop_table');
    expect(change).toMatchObject({ kind: 'drop_table', tableName: 'fin_legacy_ledger', category: 'destructive' });
  });

  it('flags a live-only column as drop_column(destructive)', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    accounts.columns.push({
      columnName: 'legacy_code',
      pgType: 'TEXT',
      isNullable: true,
      isPrimaryKey: false,
      defaultExpr: null,
      isUnique: false,
      isGenerated: false,
      reference: null,
    });

    const result = diff(desiredSchema, live, [], [], []);
    const change = result.changes.find((c) => c.kind === 'drop_column');
    expect(change).toMatchObject({
      kind: 'drop_column',
      tableName: 'fin_accounts',
      columnName: 'legacy_code',
      category: 'destructive',
    });
  });

  it('flags a type mismatch as alter_column_type(destructive)', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    const balanceCol = accounts.columns.find((c) => c.columnName === 'balance')!;
    balanceCol.pgType = 'INTEGER';

    const result = diff(desiredSchema, live, [], [], []);
    const change = result.changes.find((c) => c.kind === 'alter_column_type');
    expect(change).toMatchObject({
      kind: 'alter_column_type',
      tableName: 'fin_accounts',
      columnName: 'balance',
      category: 'destructive',
    });
    expect(change?.detail).toContain('desired: DECIMAL(14,2)');
    expect(change?.detail).toContain('live: INTEGER');
  });

  it('flags a live-only function/trigger/policy as destructive', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    live.functions.push({
      name: 'fin_legacy_helper',
      argsSignature: 'sql text',
      returns: 'VOID',
      language: 'plpgsql',
      security: 'INVOKER',
      volatility: 'VOLATILE',
      body: 'BEGIN END;',
    });
    live.triggers.push({
      name: 'fin_legacy_trigger',
      table: 'fin_accounts',
      timing: 'AFTER',
      events: ['DELETE'],
      forEach: 'ROW',
      functionName: 'fin_legacy_helper',
      columns: [],
    });
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    const legacyPolicy: LiveRlsPolicy = {
      policyName: 'fin_legacy_policy',
      roles: ['authenticated'],
      cmd: 'SELECT',
      qual: 'true',
      withCheck: null,
    };
    accounts.rlsPolicies.push(legacyPolicy);

    const result = diff(desiredSchema, live, desiredFunctions, desiredTriggers, desiredPolicies);

    const fnChange = result.changes.find((c) => c.kind === 'drop_function');
    expect(fnChange).toMatchObject({ kind: 'drop_function', functionName: 'fin_legacy_helper', category: 'destructive' });
    expect(fnChange?.detail).toBe('sql text');

    const trigChange = result.changes.find((c) => c.kind === 'drop_trigger');
    expect(trigChange).toMatchObject({
      kind: 'drop_trigger',
      triggerName: 'fin_legacy_trigger',
      tableName: 'fin_accounts',
      category: 'destructive',
    });

    const policyChange = result.changes.find((c) => c.kind === 'drop_policy');
    expect(policyChange).toMatchObject({
      kind: 'drop_policy',
      policyName: 'fin_legacy_policy',
      tableName: 'fin_accounts',
      category: 'destructive',
    });
  });

  it('flags a live-only enum value as drop_enum_value(manual)', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const statusEnum = live.enums.find((e) => e.typeName === 'fin_goal_status')!;
    statusEnum.values.push('legacy_status');

    const result = diff(desiredSchema, live, [], [], []);
    const change = result.changes.find((c) => c.kind === 'drop_enum_value');
    expect(change).toMatchObject({
      kind: 'drop_enum_value',
      enumName: 'fin_goal_status',
      detail: 'legacy_status',
      category: 'manual',
    });
  });

  it('keeps a mixed safe+destructive diff fully classified (nothing dropped/filtered)', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    // Safe: missing column.
    const categories = live.tables.find((t) => t.tableName === 'fin_categories')!;
    categories.columns = categories.columns.filter((c) => c.columnName !== 'created_at');
    // Destructive: extra live-only table.
    live.tables.push({
      tableName: 'fin_orphan',
      columns: [{ columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: null, isUnique: false, isGenerated: false, reference: null }],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    });
    // Manual: extra enum value.
    const statusEnum = live.enums.find((e) => e.typeName === 'fin_goal_status')!;
    statusEnum.values.push('stale_value');

    const result = diff(desiredSchema, live, desiredFunctions, desiredTriggers, desiredPolicies);

    const safeChange = result.changes.find((c) => c.kind === 'add_column' && c.columnName === 'created_at');
    const destructiveChange = result.changes.find((c) => c.kind === 'drop_table' && c.tableName === 'fin_orphan');
    const manualChange = result.changes.find((c) => c.kind === 'drop_enum_value');

    expect(safeChange?.category).toBe('safe');
    expect(destructiveChange?.category).toBe('destructive');
    expect(manualChange?.category).toBe('manual');
    // All three categories present simultaneously — the differ never filters.
    expect(result.changes.length).toBeGreaterThanOrEqual(3);
  });
});
