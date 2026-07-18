// Shared fixture builders for differ/sql-generator tests.
//
// Builds a representative `fin` module schema using the public DSL
// (src/schema/builder.ts) covering: enums, a uuid PK with gen_random_uuid()
// default, FKs with CASCADE/SET NULL incl. a cross-schema ref to auth.users,
// a partial unique index, a CHECK constraint, a generatedAs STORED column,
// standard + custom RLS, and an updated_at column (auto trigger).
//
// Also exports helpers to build a LiveSchema that exactly matches the
// desired schema (for "in sync" tests) plus small mutation helpers tests use
// to build perturbed LiveSchema variants.

import {
  table,
  col,
  enumType,
  defineSchema,
  defineFunction,
  defineTrigger,
  definePolicy,
} from '../../src/schema/builder.js';
import type {
  ModuleSchema,
  FunctionDef,
  TriggerDef,
  PolicyDef,
  LiveSchema,
  LiveTable,
  LiveColumn,
  LiveIndex,
  LiveRlsPolicy,
  LiveFunction,
  LiveTrigger,
  TableDef,
  ColumnDef,
} from '../../src/schema/types.js';

// ─── Desired schema ────────────────────────────────────────────────────────────

export const finGoalStatusEnum = enumType('fin_goal_status', ['active', 'completed', 'archived']);

export const finCategoriesTable = table('fin_categories', {
  id: col.uuid().primaryKey().default('gen_random_uuid()'),
  name: col.text().notNull().unique(),
  created_at: col.timestamptz().notNull().default('now()'),
});

export const finAccountsTable = table('fin_accounts', {
  id: col.uuid().primaryKey().default('gen_random_uuid()'),
  user_id: col.uuid().notNull().references('auth.users', 'id', { onDelete: 'CASCADE' }),
  name: col.text().notNull(),
  balance: col.decimal(14, 2).notNull().default('0'),
  is_active: col.boolean().notNull().default('true'),
  created_at: col.timestamptz().notNull().default('now()'),
  updated_at: col.timestamptz().notNull().default('now()'),
})
  .indexes([{ columns: ['user_id', 'name'], unique: true, where: 'is_active = true' }])
  .rls('standard');

export const finGoalsTable = table('fin_goals', {
  id: col.uuid().primaryKey().default('gen_random_uuid()'),
  account_id: col.uuid().notNull().references('fin_accounts', 'id', { onDelete: 'CASCADE' }),
  category_id: col.uuid().nullable().references('fin_categories', 'id', { onDelete: 'SET NULL' }),
  status: col.enum('fin_goal_status').notNull().default("'active'"),
  target_amount: col.decimal(14, 2).notNull(),
  saved_amount: col.decimal(14, 2).notNull().default('0'),
  progress_pct: col
    .decimal(5, 2)
    .generatedAs(
      'CASE WHEN target_amount = 0 THEN 0 ELSE LEAST((saved_amount / target_amount) * 100, 100) END',
      'STORED'
    ),
  updated_at: col.timestamptz().notNull().default('now()'),
})
  .checks([{ name: 'fin_goals_saved_amount_check', expression: 'saved_amount >= 0' }])
  .rls('custom');

export const desiredSchema: ModuleSchema = defineSchema(
  'fin',
  [finCategoriesTable, finAccountsTable, finGoalsTable],
  [finGoalStatusEnum],
  { tablePrefix: 'fin_' }
);

export const desiredFunctions: FunctionDef[] = [
  defineFunction('fin_recalc_goal_progress', {
    returns: 'TRIGGER',
    body: `
      BEGIN
        RETURN NEW;
      END;
    `,
  }),
];

export const desiredTriggers: TriggerDef[] = [
  defineTrigger('fin_goals_progress_trigger', {
    table: 'fin_goals',
    timing: 'BEFORE',
    events: ['INSERT', 'UPDATE'],
    function: 'fin_recalc_goal_progress',
  }),
];

export const desiredPolicies: PolicyDef[] = [
  definePolicy('fin_goals_owner_access', {
    table: 'fin_goals',
    for: 'ALL',
    to: 'authenticated',
    using: 'account_id IN (SELECT id FROM fin_accounts WHERE user_id = auth.uid())',
    withCheck: 'account_id IN (SELECT id FROM fin_accounts WHERE user_id = auth.uid())',
  }),
];

// ─── Live-schema conversion helpers ────────────────────────────────────────────

export function liveColumnFromDesired(name: string, c: ColumnDef): LiveColumn {
  return {
    columnName: name,
    pgType: c.pgType,
    isNullable: c.isNullable,
    isPrimaryKey: c.isPrimaryKey,
    defaultExpr: c.defaultExpr,
    isUnique: c.isUnique,
    isGenerated: !!c.generatedAs,
    reference: c.reference,
  };
}

export function liveIndexFromDesired(t: TableDef, idx: TableDef['indexes'][number]): LiveIndex {
  const name = idx.name ?? `idx_${t.tableName}_${idx.columns.join('_')}`;
  return { indexName: name, columns: idx.columns, unique: !!idx.unique, where: idx.where ?? null };
}

export function defaultRlsPoliciesFor(t: TableDef): LiveRlsPolicy[] {
  if (t.rlsPolicy === 'standard') {
    return [
      { policyName: `allow_authenticated_${t.tableName}`, roles: ['authenticated'], cmd: 'ALL', qual: 'true', withCheck: 'true' },
      { policyName: `allow_service_role_${t.tableName}`, roles: ['service_role'], cmd: 'ALL', qual: 'true', withCheck: 'true' },
    ];
  }
  return [];
}

export function livePolicyFromDesired(p: PolicyDef): LiveRlsPolicy {
  const roles = Array.isArray(p.to) ? p.to : [p.to];
  return {
    policyName: p.name,
    roles,
    cmd: p.for,
    qual: p.using ?? null,
    withCheck: p.withCheck ?? null,
  };
}

export function liveTableFromDesired(t: TableDef, opts?: { rlsPolicies?: LiveRlsPolicy[] }): LiveTable {
  return {
    tableName: t.tableName,
    columns: Object.entries(t.columns).map(([name, c]) => liveColumnFromDesired(name, c)),
    indexes: t.indexes.map((idx) => liveIndexFromDesired(t, idx)),
    checks: t.checks.map((c) => ({ name: c.name, expression: c.expression })),
    rlsEnabled: t.rlsPolicy !== 'none',
    rlsPolicies: opts?.rlsPolicies ?? defaultRlsPoliciesFor(t),
    hasTrigger: 'updated_at' in t.columns,
  };
}

export function liveFunctionFromDesired(f: FunctionDef): LiveFunction {
  return {
    name: f.name,
    argsSignature: f.args.map((a) => `${a.name} ${a.type}`).join(', '),
    returns: f.returns,
    language: f.language,
    security: f.security,
    volatility: f.volatility,
    body: f.body,
  };
}

export function liveTriggerFromDesired(t: TriggerDef): LiveTrigger {
  return {
    name: t.name,
    table: t.table,
    timing: t.timing,
    events: [...t.events].sort(),
    forEach: t.forEach,
    functionName: t.function,
    columns: t.columns ?? [],
  };
}

/** A LiveSchema that exactly matches `desiredSchema` (+ functions/triggers/policies) — zero-diff baseline. */
export function buildMatchingLiveSchema(): LiveSchema {
  return {
    tables: desiredSchema.tables.map((t) => {
      const policiesForTable = desiredPolicies.filter((p) => p.table === t.tableName);
      const rlsPolicies =
        t.rlsPolicy === 'custom' ? policiesForTable.map(livePolicyFromDesired) : undefined;
      return liveTableFromDesired(t, rlsPolicies ? { rlsPolicies } : undefined);
    }),
    enums: desiredSchema.enums.map((e) => ({ typeName: e.typeName, values: [...e.values] })),
    functions: desiredFunctions.map(liveFunctionFromDesired),
    triggers: desiredTriggers.map(liveTriggerFromDesired),
  };
}

/** Deep-clone a LiveSchema so tests can mutate it without affecting the baseline. */
export function cloneLive(live: LiveSchema): LiveSchema {
  return structuredClone(live);
}
