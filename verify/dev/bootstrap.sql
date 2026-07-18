-- supaorm bootstrap SQL
-- Paste this once into the Supabase SQL Editor (Dashboard → SQL Editor) on a
-- fresh database. Safe to re-run — every statement here is idempotent.

-- ─── exec_sql / query_sql ──────────────────────────────────────────────────
-- Everything this package does to the database — running migrations,
-- introspecting the live schema — goes through these two SECURITY DEFINER
-- functions, restricted to service_role below.

CREATE OR REPLACE FUNCTION exec_sql(sql TEXT)
  RETURNS VOID
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
AS $$
BEGIN
  EXECUTE sql;
END;
$$;

CREATE OR REPLACE FUNCTION query_sql(sql TEXT)
  RETURNS JSONB
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  EXECUTE 'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (' || sql || ') t'
    INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

-- Restrict exec_sql / query_sql to service_role — these bypass RLS and can
-- run arbitrary SQL, so they must never be reachable by anon/authenticated.
REVOKE ALL ON FUNCTION exec_sql(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION exec_sql(TEXT) FROM anon;
REVOKE ALL ON FUNCTION exec_sql(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION exec_sql(TEXT) TO service_role;

REVOKE ALL ON FUNCTION query_sql(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION query_sql(TEXT) FROM anon;
REVOKE ALL ON FUNCTION query_sql(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION query_sql(TEXT) TO service_role;

-- ─── update_updated_at_column ──────────────────────────────────────────────
-- Shared trigger function modules attach to their own updated_at columns.

CREATE OR REPLACE FUNCTION update_updated_at_column()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  VOLATILE
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ─── Migrations tracking table ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id TEXT NOT NULL,
  migration_name TEXT NOT NULL,
  migration_file TEXT NOT NULL,
  checksum TEXT,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  execution_time_ms INTEGER,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT _migrations_module_id_migration_name_key UNIQUE (module_id, migration_name)
);

-- Upgrade path for tracking tables created by earlier tooling: ensure the
-- upsert conflict target exists even when the table pre-dates this script.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = '_migrations_module_id_migration_name_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = '_migrations' AND indexdef ILIKE '%UNIQUE%module_id%migration_name%'
  ) THEN
    ALTER TABLE _migrations ADD CONSTRAINT _migrations_module_id_migration_name_key UNIQUE (module_id, migration_name);
  END IF;
END;
$bootstrap$;

CREATE INDEX IF NOT EXISTS idx__migrations_module_id ON _migrations (module_id);
CREATE INDEX IF NOT EXISTS idx__migrations_executed_at ON _migrations (executed_at);
CREATE INDEX IF NOT EXISTS idx__migrations_success ON _migrations (success);

ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_manage__migrations" ON _migrations;
CREATE POLICY "service_role_manage__migrations" ON _migrations
  AS PERMISSIVE FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

