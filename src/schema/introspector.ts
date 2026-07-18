import type { SqlExecutor } from '../client/executor.js';
import type {
  LiveSchema,
  LiveTable,
  LiveColumn,
  LiveIndex,
  LiveCheck,
  LiveRlsPolicy,
  LiveEnum,
  LiveFunction,
  LiveTrigger,
  ForeignKeyRef,
} from './types.js';

// Introspects the live Supabase (PostgreSQL) database and returns a LiveSchema
// for the given set of table names and function names.

export async function introspectSchema(
  executor: SqlExecutor,
  tableNames: string[],
  functionNames: string[] = []
): Promise<LiveSchema> {
  if (tableNames.length === 0 && functionNames.length === 0) {
    return { tables: [], enums: [], functions: [], triggers: [] };
  }

  const [
    columns,
    pkCols,
    uniqueCols,
    checks,
    fks,
    indexes,
    enums,
    triggers,
    rlsPolicies,
    rlsEnabled,
    liveFunctions,
    liveTriggers,
  ] = await Promise.all([
    tableNames.length ? fetchColumns(executor, tableNames) : [],
    tableNames.length ? fetchPrimaryKeys(executor, tableNames) : [],
    tableNames.length ? fetchUniqueColumns(executor, tableNames) : [],
    tableNames.length ? fetchChecks(executor, tableNames) : [],
    tableNames.length ? fetchForeignKeys(executor, tableNames) : [],
    tableNames.length ? fetchIndexes(executor, tableNames) : [],
    fetchEnums(executor),
    tableNames.length ? fetchUpdatedAtTriggers(executor, tableNames) : [],
    tableNames.length ? fetchRlsPolicies(executor, tableNames) : [],
    tableNames.length ? fetchRlsEnabled(executor, tableNames) : [],
    functionNames.length ? fetchFunctions(executor, functionNames) : [],
    tableNames.length ? fetchCustomTriggers(executor, tableNames) : [],
  ]);

  // Only build LiveTable entries for tables that actually exist in the DB.
  // A table with no columns in information_schema.columns doesn't exist yet.
  const existingTableNames = tableNames.filter((tableName) =>
    columns.some((c) => c.table_name === tableName)
  );

  const tables: LiveTable[] = existingTableNames.map((tableName) => {
    const tableCols = columns.filter((c) => c.table_name === tableName);
    const tablePks = new Set(pkCols.filter((p) => p.table_name === tableName).map((p) => p.column_name));
    const tableUniq = new Set(uniqueCols.filter((u) => u.table_name === tableName).map((u) => u.column_name));
    const tableFks = fks.filter((f) => f.table_name === tableName);
    const tableChecks = checks.filter((c) => c.table_name === tableName);
    const tableIndexes = indexes.filter((i) => i.tablename === tableName);
    const hasTrigger = triggers.some(
      (t) => t.event_object_table === tableName && t.trigger_name.startsWith('update_') && t.trigger_name.endsWith('_updated_at')
    );
    const tableRls = rlsPolicies.filter((p) => p.tablename === tableName);
    const isRlsEnabled = rlsEnabled.some((r) => r.tablename === tableName && r.rowsecurity);

    const liveColumns: LiveColumn[] = tableCols.map((col) => {
      const fkRow = tableFks.find((f) => f.column_name === col.column_name);
      const reference: ForeignKeyRef | null = fkRow
        ? {
            table: fkRow.foreign_table_name,
            column: fkRow.foreign_column_name,
            onDelete: normalizeFkAction(fkRow.delete_rule),
            onUpdate: normalizeFkAction(fkRow.update_rule),
          }
        : null;

      return {
        columnName: col.column_name,
        pgType: normalizePgType(col),
        isNullable: col.is_nullable === 'YES',
        isPrimaryKey: tablePks.has(col.column_name),
        defaultExpr: col.column_default,
        isUnique: tableUniq.has(col.column_name),
        isGenerated: col.is_generated === 'ALWAYS',
        reference,
      };
    });

    const liveIndexes: LiveIndex[] = tableIndexes.map((idx) => {
      const cols = extractIndexColumns(idx.indexdef);
      return {
        indexName: idx.indexname,
        columns: cols,
        unique: idx.indexdef.includes(' UNIQUE '),
        where: extractIndexWhere(idx.indexdef),
      };
    });

    const liveChecks: LiveCheck[] = tableChecks.map((c) => ({
      name: c.constraint_name,
      expression: c.check_clause,
    }));

    const livePolicies: LiveRlsPolicy[] = tableRls.map((p) => ({
      policyName: p.policyname,
      roles: p.roles ? p.roles.replace(/[{}]/g, '').split(',').map((s: string) => s.trim()).filter(Boolean) : [],
      cmd: p.cmd,
      qual: p.qual ?? null,
      withCheck: p.with_check ?? null,
    }));

    return {
      tableName,
      columns: liveColumns,
      indexes: liveIndexes,
      checks: liveChecks,
      rlsEnabled: isRlsEnabled,
      rlsPolicies: livePolicies,
      hasTrigger,
    };
  });

  return { tables, enums, functions: liveFunctions, triggers: liveTriggers };
}

// ─── Raw DB queries ────────────────────────────────────────────────────────────

// query_sql wraps a SELECT in jsonb_agg(row_to_json(t)) and returns JSONB.
// exec_sql returns VOID and cannot be used for reads.
async function querySql(executor: SqlExecutor, sql: string): Promise<any[]> {
  const rows = await executor.query<any>(sql);
  return Array.isArray(rows) ? rows : [];
}

function tableList(tableNames: string[]): string {
  return `ARRAY[${tableNames.map((t) => `'${t}'`).join(',')}]`;
}

async function fetchColumns(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT table_name, column_name, data_type, udt_name, column_default,
           is_nullable, is_generated, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY(${tableList(tableNames)})
    ORDER BY table_name, ordinal_position
  `);
}

async function fetchPrimaryKeys(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY(${tableList(tableNames)})
  `);
}

async function fetchUniqueColumns(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY(${tableList(tableNames)})
  `);
}

async function fetchChecks(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT tc.table_name, tc.constraint_name, cc.check_clause
    FROM information_schema.table_constraints tc
    JOIN information_schema.check_constraints cc
      ON tc.constraint_name = cc.constraint_name AND tc.table_schema = cc.constraint_schema
    WHERE tc.constraint_type = 'CHECK'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY(${tableList(tableNames)})
  `);
}

async function fetchForeignKeys(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      rc.delete_rule,
      rc.update_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_catalog
    JOIN information_schema.constraint_column_usage ccu
      ON rc.unique_constraint_name = ccu.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ANY(${tableList(tableNames)})
  `);
}

async function fetchIndexes(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT schemaname, tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = ANY(${tableList(tableNames)})
      AND indexname NOT LIKE '%_pkey'
    ORDER BY tablename, indexname
  `);
}

async function fetchEnums(executor: SqlExecutor) {
  const rows = await querySql(executor, `
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder
  `);
  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (!map.has(row.typname)) map.set(row.typname, []);
    map.get(row.typname)!.push(row.enumlabel);
  }
  return Array.from(map.entries()).map(([typeName, values]): LiveEnum => ({ typeName, values }));
}

async function fetchUpdatedAtTriggers(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
      AND event_object_table = ANY(${tableList(tableNames)})
  `);
}

async function fetchRlsPolicies(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT tablename, policyname, roles::text, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = ANY(${tableList(tableNames)})
  `);
}

async function fetchFunctions(executor: SqlExecutor, functionNames: string[]): Promise<LiveFunction[]> {
  const rows = await querySql(executor, `
    SELECT
      p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS args_signature,
      pg_get_function_result(p.oid) AS returns,
      l.lanname AS language,
      p.prosecdef AS security_definer,
      CASE p.provolatile
        WHEN 'v' THEN 'VOLATILE'
        WHEN 's' THEN 'STABLE'
        WHEN 'i' THEN 'IMMUTABLE'
      END AS volatility,
      p.prosrc AS body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND p.proname = ANY(ARRAY[${functionNames.map((f) => `'${f}'`).join(',')}])
    ORDER BY p.proname
  `);

  return rows.map((r: any): LiveFunction => ({
    name: r.name,
    argsSignature: r.args_signature ?? '',
    returns: (r.returns ?? '').toUpperCase(),
    language: r.language,
    security: r.security_definer ? 'DEFINER' : 'INVOKER',
    volatility: r.volatility as 'VOLATILE' | 'STABLE' | 'IMMUTABLE',
    body: normalizeBody(r.body ?? ''),
  }));
}

async function fetchCustomTriggers(executor: SqlExecutor, tableNames: string[]): Promise<LiveTrigger[]> {
  // Exclude standard updated_at triggers by their exact auto-generated names:
  // `update_{tableName}_updated_at`. Using exact names (not LIKE) avoids false
  // exclusions when a table name itself contains underscores (e.g. `_modules`).
  const autoManagedNames = tableNames.map((t) => `'update_${t}_updated_at'`).join(',');
  const excludeClause = autoManagedNames
    ? `AND t.trigger_name NOT IN (${autoManagedNames})`
    : '';

  const rows = await querySql(executor, `
    SELECT
      t.trigger_name,
      t.event_object_table AS table_name,
      t.action_timing AS timing,
      t.event_manipulation AS event,
      t.action_orientation AS for_each,
      t.action_statement
    FROM information_schema.triggers t
    WHERE t.trigger_schema = 'public'
      AND t.event_object_table = ANY(${tableList(tableNames)})
      ${excludeClause}
    ORDER BY t.trigger_name, t.event_manipulation
  `);

  // Group by trigger name + table (one row per event in info_schema)
  const triggerMap = new Map<string, LiveTrigger>();

  for (const r of rows) {
    const key = `${r.trigger_name}::${r.table_name}`;
    if (!triggerMap.has(key)) {
      // Extract function name from "EXECUTE FUNCTION foo()" or "EXECUTE PROCEDURE foo()"
      const fnMatch = (r.action_statement as string).match(/EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)/i);
      const functionName = fnMatch ? fnMatch[1] : r.action_statement;

      triggerMap.set(key, {
        name: r.trigger_name,
        table: r.table_name,
        timing: r.timing,
        events: [],
        forEach: r.for_each,
        functionName,
        columns: [],
      });
    }
    const trig = triggerMap.get(key)!;
    if (!trig.events.includes(r.event)) {
      trig.events.push(r.event);
    }
  }

  // Sort events for consistent comparison
  for (const trig of triggerMap.values()) {
    trig.events.sort();
  }

  return Array.from(triggerMap.values());
}

async function fetchRlsEnabled(executor: SqlExecutor, tableNames: string[]) {
  return querySql(executor, `
    SELECT tablename, rowsecurity
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = ANY(${tableList(tableNames)})
  `);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizePgType(col: any): string {
  const dt = col.data_type as string;
  if (dt === 'USER-DEFINED') return col.udt_name; // enum types
  if (dt === 'ARRAY') return col.udt_name?.replace(/^_/, '') + '[]'; // e.g. _text → text[]
  if (dt === 'character varying') {
    return col.character_maximum_length ? `VARCHAR(${col.character_maximum_length})` : 'TEXT';
  }
  if (dt === 'numeric' || dt === 'decimal') {
    if (col.numeric_precision && col.numeric_scale !== null) {
      return `DECIMAL(${col.numeric_precision},${col.numeric_scale})`;
    }
    return 'NUMERIC';
  }
  const typeMap: Record<string, string> = {
    'uuid': 'UUID',
    'text': 'TEXT',
    'boolean': 'BOOLEAN',
    'integer': 'INTEGER',
    'bigint': 'BIGINT',
    'smallint': 'SMALLINT',
    'date': 'DATE',
    'timestamp with time zone': 'TIMESTAMPTZ',
    'timestamp without time zone': 'TIMESTAMP',
    'jsonb': 'JSONB',
    'json': 'JSON',
    'ARRAY': 'TEXT[]',
  };
  return typeMap[dt] ?? dt.toUpperCase();
}

function normalizeFkAction(action: string): 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' {
  switch (action?.toUpperCase()) {
    case 'CASCADE':   return 'CASCADE';
    case 'SET NULL':  return 'SET NULL';
    case 'RESTRICT':  return 'RESTRICT';
    default:          return 'NO ACTION';
  }
}

function extractIndexColumns(indexdef: string): string[] {
  // e.g. CREATE INDEX idx_foo ON pm_clients USING btree (email)
  // or CREATE UNIQUE INDEX idx_foo ON pm_clients (email, name)
  const match = indexdef.match(/\((.+?)\)(?:\s+WHERE)?/);
  if (!match) return [];
  return match[1].split(',').map((c) => c.trim().replace(/"/g, '').split(' ')[0]);
}

function extractIndexWhere(indexdef: string): string | null {
  const match = indexdef.match(/WHERE\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Normalize function body for comparison: collapse whitespace, trim
export function normalizeBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}
