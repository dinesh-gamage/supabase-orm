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

describe('diff — in-sync baseline', () => {
  it('produces zero changes and empty staleHints when live matches desired exactly', () => {
    const live = buildMatchingLiveSchema();
    const result = diff(desiredSchema, live, desiredFunctions, desiredTriggers, desiredPolicies);

    expect(result.changes).toEqual([]);
    expect(result.staleHints).toEqual([]);
    expect(result.hasEnumChanges).toBe(false);
    expect(result.hasStructuralChanges).toBe(false);
    expect(result.moduleId).toBe('fin');
  });
});

describe('diff — tables/columns/indexes/enums', () => {
  it('emits create_table for a table missing from live', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    live.tables = live.tables.filter((t) => t.tableName !== 'fin_categories');

    const result = diff(desiredSchema, live, desiredFunctions, desiredTriggers, desiredPolicies);

    const change = result.changes.find((c) => c.kind === 'create_table' && c.tableName === 'fin_categories');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
    expect(result.hasStructuralChanges).toBe(true);
  });

  it('emits add_column for a column missing from live', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    accounts.columns = accounts.columns.filter((c) => c.columnName !== 'balance');

    const result = diff(desiredSchema, live, [], [], []);

    const change = result.changes.find(
      (c) => c.kind === 'add_column' && c.tableName === 'fin_accounts' && c.columnName === 'balance'
    );
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
  });

  it('emits create_index for a missing partial unique index', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    accounts.indexes = [];

    const result = diff(desiredSchema, live, [], [], []);

    const change = result.changes.find((c) => c.kind === 'create_index' && c.tableName === 'fin_accounts');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
    expect(change?.indexName).toBe('idx_fin_accounts_user_id_name');
    expect(change?.detail).toContain('WHERE is_active = true');
  });

  it('emits create_enum + add_enum_value for missing enum / missing values', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    live.enums = [];

    let result = diff(desiredSchema, live, [], [], []);
    let change = result.changes.find((c) => c.kind === 'create_enum');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
    expect(result.hasEnumChanges).toBe(true);

    // Now enum exists live but missing a value.
    live.enums = [{ typeName: 'fin_goal_status', values: ['active', 'completed'] }];
    result = diff(desiredSchema, live, [], [], []);
    change = result.changes.find((c) => c.kind === 'add_enum_value');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
    expect(change?.detail).toBe('archived');
  });
});

describe('diff — functions', () => {
  it('emits alter_function when the body changes and nothing when normalized bodies are equal', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const fn = live.functions.find((f) => f.name === 'fin_recalc_goal_progress')!;
    fn.body = 'BEGIN\n  RETURN OLD;\nEND;';

    let result = diff(desiredSchema, live, desiredFunctions, [], []);
    let change = result.changes.find((c) => c.kind === 'alter_function');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
    expect(change?.detail).toBe('body changed');

    // Same logical body, different whitespace/formatting — normalizeBody should treat as equal.
    fn.body = `
      BEGIN


        RETURN   NEW;
      END;
    `;
    result = diff(desiredSchema, live, desiredFunctions, [], []);
    expect(result.changes.find((c) => c.kind === 'alter_function')).toBeUndefined();
  });
});

describe('diff — triggers', () => {
  it('emits alter_trigger when trigger definition changes', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const trig = live.triggers.find((t) => t.name === 'fin_goals_progress_trigger')!;
    trig.events = ['INSERT'];

    const result = diff(desiredSchema, live, [], desiredTriggers, []);
    const change = result.changes.find((c) => c.kind === 'alter_trigger');
    expect(change).toBeDefined();
    expect(change?.category).toBe('safe');
  });
});

describe('diff — policies', () => {
  it('does not flag alter_policy for cosmetic parens/whitespace differences', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const goals = live.tables.find((t) => t.tableName === 'fin_goals')!;
    const pol = goals.rlsPolicies.find((p) => p.policyName === 'fin_goals_owner_access')!;
    // Postgres commonly re-decompiles to add outer parens + normalize whitespace.
    pol.qual = `(  account_id  IN  (SELECT id FROM fin_accounts WHERE user_id = auth.uid())  )`;
    pol.withCheck = pol.qual;

    const result = diff(desiredSchema, live, [], [], desiredPolicies);
    expect(result.changes.find((c) => c.kind === 'alter_policy')).toBeUndefined();
  });

  it('detects standard RLS policies already present and does not re-add them', () => {
    const live = buildMatchingLiveSchema();
    const result = diff(desiredSchema, live, [], [], []);
    expect(result.changes.find((c) => c.kind === 'enable_rls')).toBeUndefined();
    expect(result.changes.find((c) => c.kind === 'add_rls_policy')).toBeUndefined();
  });

  it('emits enable_rls + add_rls_policy when standard RLS is entirely missing', () => {
    const live = cloneLive(buildMatchingLiveSchema());
    const accounts = live.tables.find((t) => t.tableName === 'fin_accounts')!;
    accounts.rlsEnabled = false;
    accounts.rlsPolicies = [];

    const result = diff(desiredSchema, live, [], [], []);
    expect(result.changes.some((c) => c.kind === 'enable_rls' && c.tableName === 'fin_accounts')).toBe(true);
    const addPolicyChanges = result.changes.filter((c) => c.kind === 'add_rls_policy' && c.tableName === 'fin_accounts');
    expect(addPolicyChanges.map((c) => c.detail).sort()).toEqual(['authenticated', 'service_role']);
    for (const c of addPolicyChanges) expect(c.category).toBe('safe');
  });
});
