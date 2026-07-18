import { describe, it, expect } from 'vitest';
import { diff } from '../src/schema/differ.js';
import { generateSql } from '../src/schema/sql-generator.js';
import {
  desiredSchema,
  desiredFunctions,
  desiredTriggers,
  desiredPolicies,
} from './fixtures/schemas.js';
import type { LiveSchema } from '../src/schema/types.js';

function emptyLive(): LiveSchema {
  return { tables: [], enums: [], functions: [], triggers: [] };
}

describe('generateSql — CREATE TABLE topo ordering', () => {
  it('creates FK-referenced tables before their dependents', () => {
    const result = diff(desiredSchema, emptyLive(), desiredFunctions, desiredTriggers, desiredPolicies);
    const { structuralSql } = generateSql(result, desiredSchema, {
      functions: desiredFunctions,
      triggers: desiredTriggers,
      policies: desiredPolicies,
    });

    expect(structuralSql).toBeTruthy();
    const sql = structuralSql!;
    const categoriesIdx = sql.indexOf('CREATE TABLE IF NOT EXISTS fin_categories');
    const accountsIdx = sql.indexOf('CREATE TABLE IF NOT EXISTS fin_accounts');
    const goalsIdx = sql.indexOf('CREATE TABLE IF NOT EXISTS fin_goals');

    expect(categoriesIdx).toBeGreaterThanOrEqual(0);
    expect(accountsIdx).toBeGreaterThanOrEqual(0);
    expect(goalsIdx).toBeGreaterThanOrEqual(0);
    // fin_goals FKs to both fin_accounts and fin_categories — both must precede it.
    expect(accountsIdx).toBeLessThan(goalsIdx);
    expect(categoriesIdx).toBeLessThan(goalsIdx);
  });
});

describe('generateSql — column rendering matrix', () => {
  const result = diff(desiredSchema, emptyLive());
  const { structuralSql } = generateSql(result, desiredSchema);
  const sql = structuralSql!;

  it('renders PRIMARY KEY without a redundant NOT NULL', () => {
    expect(sql).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
  });

  it('renders NOT NULL for required non-PK columns', () => {
    expect(sql).toContain('name TEXT NOT NULL');
  });

  it('renders UNIQUE', () => {
    expect(sql).toMatch(/name TEXT NOT NULL UNIQUE/);
  });

  it('renders DEFAULT expressions', () => {
    expect(sql).toContain('DEFAULT 0'); // raw SQL default expr, not a quoted string
    expect(sql).toContain('DEFAULT now()');
  });

  it('renders GENERATED ALWAYS AS ... STORED for computed columns', () => {
    expect(sql).toContain('GENERATED ALWAYS AS (');
    expect(sql).toContain(') STORED');
  });

  it('renders REFERENCES with ON DELETE for both CASCADE and SET NULL', () => {
    expect(sql).toContain('REFERENCES auth.users(id) ON DELETE CASCADE');
    expect(sql).toContain('REFERENCES fin_categories(id) ON DELETE SET NULL');
    expect(sql).toContain('REFERENCES fin_accounts(id) ON DELETE CASCADE');
  });

  it('renders inline CHECK constraints', () => {
    expect(sql).toContain('CONSTRAINT fin_goals_saved_amount_check CHECK (saved_amount >= 0)');
  });
});

describe('generateSql — partial index SQL', () => {
  it('emits a UNIQUE INDEX with WHERE clause', () => {
    const result = diff(desiredSchema, emptyLive());
    const { structuralSql } = generateSql(result, desiredSchema);
    expect(structuralSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_accounts_user_id_name ON fin_accounts (user_id, name) WHERE is_active = true;'
    );
  });
});

describe('generateSql — RLS + standard policies', () => {
  it('emits ENABLE ROW LEVEL SECURITY and standard authenticated/service_role policies', () => {
    const result = diff(desiredSchema, emptyLive());
    const { structuralSql } = generateSql(result, desiredSchema);
    const sql = structuralSql!;

    expect(sql).toContain('ALTER TABLE fin_accounts ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY "allow_authenticated_fin_accounts" ON fin_accounts');
    expect(sql).toContain('CREATE POLICY "allow_service_role_fin_accounts" ON fin_accounts');
    // fin_goals uses rls('custom') — enabled, but no standard policies auto-generated.
    expect(sql).toContain('ALTER TABLE fin_goals ENABLE ROW LEVEL SECURITY;');
    expect(sql).not.toContain('allow_authenticated_fin_goals');
  });
});

describe('generateSql — updated_at trigger auto-emission', () => {
  it('emits the updated_at trigger for tables with an updated_at column', () => {
    const result = diff(desiredSchema, emptyLive());
    const { structuralSql } = generateSql(result, desiredSchema);
    const sql = structuralSql!;

    expect(sql).toContain('CREATE TRIGGER update_fin_accounts_updated_at');
    expect(sql).toContain('BEFORE UPDATE ON fin_accounts');
    expect(sql).toContain('EXECUTE FUNCTION update_updated_at_column();');
    expect(sql).toContain('CREATE TRIGGER update_fin_goals_updated_at');
    // fin_categories has no updated_at column — no trigger for it.
    expect(sql).not.toContain('update_fin_categories_updated_at');
  });
});

describe('generateSql — function/trigger/policy SQL', () => {
  it('emits CREATE OR REPLACE FUNCTION, custom trigger, and custom policy SQL', () => {
    const result = diff(desiredSchema, emptyLive(), desiredFunctions, desiredTriggers, desiredPolicies);
    const { structuralSql } = generateSql(result, desiredSchema, {
      functions: desiredFunctions,
      triggers: desiredTriggers,
      policies: desiredPolicies,
    });
    const sql = structuralSql!;

    expect(sql).toContain('CREATE OR REPLACE FUNCTION fin_recalc_goal_progress()');
    expect(sql).toContain('RETURNS TRIGGER');

    expect(sql).toContain('DROP TRIGGER IF EXISTS fin_goals_progress_trigger ON fin_goals;');
    expect(sql).toContain('CREATE TRIGGER fin_goals_progress_trigger');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON fin_goals');
    expect(sql).toContain('EXECUTE FUNCTION fin_recalc_goal_progress();');

    expect(sql).toContain('CREATE POLICY "fin_goals_owner_access" ON fin_goals');
    expect(sql).toContain('FOR ALL TO authenticated');
    expect(sql).toContain('USING (account_id IN (SELECT id FROM fin_accounts WHERE user_id = auth.uid()))');
  });
});

describe('generateSql — enum SQL is separated from structural SQL', () => {
  it('returns enumSql and structuralSql as independent strings', () => {
    const result = diff(desiredSchema, emptyLive());
    const { enumSql, structuralSql } = generateSql(result, desiredSchema);

    expect(enumSql).toBeTruthy();
    expect(enumSql).toContain('CREATE TYPE fin_goal_status AS ENUM');
    expect(enumSql).toContain('NO TRANSACTION');
    expect(structuralSql).toBeTruthy();
    expect(structuralSql).not.toContain('CREATE TYPE');
  });

  it('returns null enumSql when there are no enum changes', () => {
    // A live schema that already has the enum in sync, but nothing else.
    const live: LiveSchema = {
      tables: [],
      enums: [{ typeName: 'fin_goal_status', values: ['active', 'completed', 'archived'] }],
      functions: [],
      triggers: [],
    };
    const result = diff(desiredSchema, live);
    const { enumSql } = generateSql(result, desiredSchema);
    expect(enumSql).toBeNull();
  });
});
