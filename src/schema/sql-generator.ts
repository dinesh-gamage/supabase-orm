// Converts a SchemaDiff into one or two SQL migration strings.
//
// Returns { enumSql, structuralSql } — either or both may be null. Enum SQL
// is kept separate because `ALTER TYPE ... ADD VALUE` cannot run inside a
// transaction in PostgreSQL.
//
// Destructive changes (category: 'destructive') are excluded by default —
// only a summary comment is emitted. Pass `includeDestructive: true` to
// generate the real SQL for them. Manual changes (category: 'manual') are
// never auto-generated; they always render as guidance comments.

import type {
  SchemaDiff,
  DiffChange,
  TableDef,
  ColumnDef,
  ModuleSchema,
  FunctionDef,
  TriggerDef,
  PolicyDef,
} from './types.js';

export const DESTRUCTIVE_MARKER = '-- supaorm:destructive';

export interface GenerateSqlOptions {
  functions?: FunctionDef[];
  triggers?: TriggerDef[];
  policies?: PolicyDef[];
  includeDestructive?: boolean;
}

export function generateSql(
  diffResult: SchemaDiff,
  schema: ModuleSchema,
  opts: GenerateSqlOptions = {}
): { enumSql: string | null; structuralSql: string | null } {
  const functions = opts.functions ?? [];
  const triggers = opts.triggers ?? [];
  const policies = opts.policies ?? [];
  const includeDestructive = opts.includeDestructive ?? false;

  const enumChanges = diffResult.changes.filter(
    (c) => c.kind === 'create_enum' || c.kind === 'add_enum_value'
  );
  const structChanges = diffResult.changes.filter(
    (c) => c.kind !== 'create_enum' && c.kind !== 'add_enum_value'
  );

  const tableMap = new Map(schema.tables.map((t) => [t.tableName, t]));
  const enumMap = new Map(schema.enums.map((e) => [e.typeName, e]));
  const fnMap = new Map(functions.map((f) => [f.name, f]));
  const trigMap = new Map(triggers.map((t) => [`${t.name}::${t.table}`, t]));
  const policyMap = new Map(policies.map((p) => [`${p.table}::${p.name}`, p]));

  const enumSql = enumChanges.length ? buildEnumSql(enumChanges, enumMap) : null;
  const structuralSql = buildStructuralSql(structChanges, tableMap, fnMap, trigMap, policyMap, includeDestructive);

  return { enumSql, structuralSql };
}

/** One-line human-readable description of a change, used in summary/warning blocks. */
export function describeChange(change: DiffChange): string {
  const kind = change.kind;
  switch (kind) {
    case 'drop_table':
      return `${kind}  ${change.tableName}`;
    case 'drop_column':
      return `${kind}  ${change.tableName}.${change.columnName}`;
    case 'alter_column_type':
      return `${kind}  ${change.tableName}.${change.columnName} (${change.detail})`;
    case 'drop_function':
      return `${kind}  ${change.functionName}(${change.detail ?? ''})`;
    case 'drop_trigger':
      return `${kind}  ${change.tableName}.${change.triggerName}`;
    case 'drop_policy':
      return `${kind}  ${change.tableName}.${change.policyName}`;
    case 'alter_policy':
      return `${kind}  ${change.tableName}.${change.policyName}${change.detail ? ` (${change.detail})` : ''}`;
    case 'drop_enum_value':
      return `${kind}  ${change.enumName}.${change.detail}`;
    default: {
      const subject = change.tableName ?? change.functionName ?? change.triggerName ?? change.policyName ?? change.enumName ?? '';
      return `${kind}  ${subject}`.trim();
    }
  }
}

// ─── ENUM SQL (no transaction — Postgres restriction) ─────────────────────────

function buildEnumSql(
  changes: DiffChange[],
  enumMap: Map<string, { typeName: string; values: string[] }>
): string {
  const lines: string[] = ['-- NO TRANSACTION', '-- ENUM additions must run outside a transaction in PostgreSQL', ''];

  for (const change of changes) {
    if (change.kind === 'create_enum') {
      const e = enumMap.get(change.enumName!);
      if (e) {
        const vals = e.values.map((v) => `'${v}'`).join(', ');
        lines.push(`CREATE TYPE ${change.enumName} AS ENUM (${vals});`);
      }
    } else if (change.kind === 'add_enum_value') {
      lines.push(`ALTER TYPE ${change.enumName} ADD VALUE IF NOT EXISTS '${change.detail}';`);
    }
  }

  return lines.join('\n');
}

// ─── Topological sort for CREATE TABLE ordering ───────────────────────────────
// Ensures tables are created before any table that FK-references them (within
// the same module). Cross-module FKs (e.g. auth.users) are ignored.

function topoSortTables(tableNames: string[], tableMap: Map<string, TableDef>): string[] {
  const nameSet = new Set(tableNames);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    const t = tableMap.get(name);
    if (t) {
      for (const col of Object.values(t.columns)) {
        if (col.reference) {
          const refTable = col.reference.table;
          if (nameSet.has(refTable) && !visited.has(refTable)) {
            visit(refTable);
          }
        }
      }
    }
    result.push(name);
  }

  for (const name of tableNames) {
    visit(name);
  }

  return result;
}

// ─── Structural SQL (inside BEGIN/COMMIT unless destructive) ──────────────────

function buildStructuralSql(
  changes: DiffChange[],
  tableMap: Map<string, TableDef>,
  fnMap: Map<string, FunctionDef>,
  trigMap: Map<string, TriggerDef>,
  policyMap: Map<string, PolicyDef>,
  includeDestructive: boolean
): string | null {
  if (changes.length === 0) return null;

  const renameChanges = changes.filter(
    (c) => c.kind === 'rename_table' || c.kind === 'rename_column' || c.kind === 'rename_trigger'
  );
  const safeChanges = changes.filter(
    (c) =>
      c.category === 'safe' &&
      c.kind !== 'rename_table' &&
      c.kind !== 'rename_column' &&
      c.kind !== 'rename_trigger'
  );
  const destructiveChanges = changes.filter((c) => c.category === 'destructive');
  const manualChanges = changes.filter((c) => c.category === 'manual');

  const hasSafeOrRename = renameChanges.length > 0 || safeChanges.length > 0;
  const hasRealDestructive = destructiveChanges.length > 0;
  const includeDestructiveSql = includeDestructive && hasRealDestructive;

  // Nothing actionable to emit as real SQL — don't litter a comment-only file.
  if (!hasSafeOrRename && !includeDestructiveSql) {
    return null;
  }

  const lines: string[] = [];

  if (includeDestructiveSql) {
    lines.push(DESTRUCTIVE_MARKER);
    lines.push('-- This migration includes DESTRUCTIVE changes. Review carefully before applying:');
    for (const c of destructiveChanges) lines.push(`--   ${describeChange(c)}`);
    lines.push('');
  } else if (hasRealDestructive) {
    lines.push('-- ─── Destructive changes detected but NOT generated ───');
    lines.push('-- Re-run with --force-destructive (or set allowDestructive: true) to include:');
    for (const c of destructiveChanges) lines.push(`--   ${describeChange(c)}`);
    lines.push('');
  }

  // Renames always emitted first among the actual SQL statements — subsequent
  // statements may reference the new table/column name.
  for (const c of renameChanges) {
    lines.push(buildRenameSql(c));
  }
  if (renameChanges.length) lines.push('');

  lines.push(...buildSafeSql(safeChanges, tableMap, fnMap, trigMap, policyMap));

  if (includeDestructiveSql) {
    for (const c of destructiveChanges) {
      lines.push(...buildDestructiveSql(c, tableMap, policyMap));
    }
  }

  // Manual changes are always comment-only guidance, in both modes.
  for (const c of manualChanges) {
    lines.push(...buildManualComment(c));
  }

  return lines.join('\n');
}

// ─── Renames ───────────────────────────────────────────────────────────────────

function buildRenameSql(c: DiffChange): string {
  if (c.kind === 'rename_table') {
    return `ALTER TABLE ${c.renamedFrom} RENAME TO ${c.tableName};`;
  }
  if (c.kind === 'rename_trigger') {
    return `ALTER TRIGGER ${c.renamedFrom} ON ${c.tableName} RENAME TO ${c.triggerName};`;
  }
  // rename_column
  return `ALTER TABLE ${c.tableName} RENAME COLUMN ${c.renamedFrom} TO ${c.columnName};`;
}

// ─── Safe SQL ────────────────────────────────────────────────────────────────

function buildSafeSql(
  changes: DiffChange[],
  tableMap: Map<string, TableDef>,
  fnMap: Map<string, FunctionDef>,
  trigMap: Map<string, TriggerDef>,
  policyMap: Map<string, PolicyDef>
): string[] {
  const lines: string[] = [];

  // Group create_table changes — emit in topological order (dependency-first).
  const createTableChanges = changes.filter((c) => c.kind === 'create_table');
  const sortedTableNames = topoSortTables(createTableChanges.map((c) => c.tableName!), tableMap);
  const createdTables = new Set<string>();

  for (const tableName of sortedTableNames) {
    const t = tableMap.get(tableName);
    if (t && !createdTables.has(tableName)) {
      createdTables.add(tableName);
      lines.push(...buildCreateTable(t));
    }
  }

  for (const change of changes) {
    if (change.kind === 'create_table') {
      // Already handled above in topo order.
    } else if (change.kind === 'add_column') {
      const t = tableMap.get(change.tableName!);
      const colDef = t?.columns[change.columnName!];
      if (colDef) {
        lines.push(buildAddColumn(change.tableName!, change.columnName!, colDef));
      }
    } else if (change.kind === 'create_index') {
      const t = tableMap.get(change.tableName!);
      if (t) {
        const idx = t.indexes.find(
          (i) => (i.name ?? `idx_${t.tableName}_${i.columns.join('_')}`) === change.indexName
        );
        if (idx) {
          lines.push(buildCreateIndex(t.tableName, change.indexName!, idx.columns, idx.unique, idx.where));
        }
      }
    } else if (change.kind === 'enable_rls') {
      lines.push(`ALTER TABLE ${change.tableName} ENABLE ROW LEVEL SECURITY;`);
    } else if (change.kind === 'add_rls_policy') {
      if (change.detail === 'authenticated') {
        lines.push(buildRlsPolicy(change.tableName!, 'authenticated'));
      } else if (change.detail === 'service_role') {
        lines.push(buildRlsPolicy(change.tableName!, 'service_role'));
      }
    } else if (change.kind === 'add_trigger') {
      lines.push(buildTrigger(change.tableName!));
    } else if (change.kind === 'create_function' || change.kind === 'alter_function') {
      const fn = fnMap.get(change.functionName!);
      if (fn) lines.push(buildCreateOrReplaceFunction(fn));
    } else if (change.kind === 'create_trigger' || change.kind === 'alter_trigger') {
      const key = `${change.triggerName}::${change.tableName}`;
      const trig = trigMap.get(key);
      if (trig) lines.push(buildDropCreateTrigger(trig));
    } else if (change.kind === 'create_policy') {
      const key = `${change.tableName}::${change.policyName}`;
      const pol = policyMap.get(key);
      if (pol) lines.push(buildCreatePolicy(pol));
    }
  }

  return lines;
}

// ─── Destructive SQL ───────────────────────────────────────────────────────────

function buildDestructiveSql(
  c: DiffChange,
  tableMap: Map<string, TableDef>,
  policyMap: Map<string, PolicyDef>
): string[] {
  switch (c.kind) {
    case 'drop_table':
      return [`DROP TABLE ${c.tableName} CASCADE;`];
    case 'drop_column':
      return [`ALTER TABLE ${c.tableName} DROP COLUMN ${c.columnName};`];
    case 'alter_column_type': {
      const t = tableMap.get(c.tableName!);
      const colDef = t?.columns[c.columnName!];
      const newType = colDef?.pgType ?? 'TEXT';
      return [
        `ALTER TABLE ${c.tableName} ALTER COLUMN ${c.columnName} TYPE ${newType} USING ${c.columnName}::${newType}; -- review USING clause`,
      ];
    }
    case 'drop_function':
      return [`DROP FUNCTION IF EXISTS ${c.functionName}(${c.detail ?? ''});`];
    case 'drop_trigger':
      return [`DROP TRIGGER IF EXISTS ${c.triggerName} ON ${c.tableName};`];
    case 'drop_policy':
      return [`DROP POLICY IF EXISTS "${c.policyName}" ON ${c.tableName};`];
    case 'alter_policy': {
      const key = `${c.tableName}::${c.policyName}`;
      const pol = policyMap.get(key);
      if (!pol) return [];
      return buildDropCreatePolicy(pol).split('\n');
    }
    default:
      return [];
  }
}

// ─── Manual-only SQL (never auto-generated) ────────────────────────────────────

function buildManualComment(c: DiffChange): string[] {
  if (c.kind === 'drop_enum_value') {
    return [
      `-- MANUAL: Enum value "${c.detail}" on type "${c.enumName}" exists in the database but not in the schema.`,
      `--   PostgreSQL cannot remove enum values directly. Removing it requires recreating the`,
      `--   enum type (create new type, migrate columns, drop old type) — handle this by hand.`,
    ];
  }
  return [];
}

// ─── CREATE TABLE ─────────────────────────────────────────────────────────────

function buildCreateTable(t: TableDef): string[] {
  const lines: string[] = [];
  const colLines: string[] = [];

  for (const [colName, col] of Object.entries(t.columns)) {
    colLines.push('  ' + buildColumnDef(colName, col));
  }

  // Inline CHECK constraints
  for (const check of t.checks) {
    colLines.push(`  CONSTRAINT ${check.name} CHECK (${check.expression})`);
  }

  lines.push(`CREATE TABLE IF NOT EXISTS ${t.tableName} (`);
  lines.push(colLines.join(',\n'));
  lines.push(');');
  lines.push('');

  // Indexes (after table creation)
  for (const idx of t.indexes) {
    const name = idx.name ?? `idx_${t.tableName}_${idx.columns.join('_')}`;
    lines.push(buildCreateIndex(t.tableName, name, idx.columns, idx.unique, idx.where));
  }

  // RLS
  if (t.rlsPolicy !== 'none') {
    lines.push(`ALTER TABLE ${t.tableName} ENABLE ROW LEVEL SECURITY;`);
    if (t.rlsPolicy === 'standard') {
      lines.push(buildRlsPolicy(t.tableName, 'authenticated'));
      lines.push(buildRlsPolicy(t.tableName, 'service_role'));
    }
    lines.push('');
  }

  // updated_at trigger
  if ('updated_at' in t.columns) {
    lines.push(buildTrigger(t.tableName));
    lines.push('');
  }

  return lines;
}

// ─── Column definition ────────────────────────────────────────────────────────

function buildColumnDef(name: string, col: ColumnDef): string {
  const parts: string[] = [name, col.pgType];

  if (col.isPrimaryKey) {
    parts.push('PRIMARY KEY');
  }
  if (!col.isNullable && !col.isPrimaryKey) {
    parts.push('NOT NULL');
  }
  if (col.isUnique) {
    parts.push('UNIQUE');
  }
  if (col.defaultExpr !== null) {
    parts.push(`DEFAULT ${col.defaultExpr}`);
  }
  if (col.generatedAs) {
    parts.push(`GENERATED ALWAYS AS (${col.generatedAs.expression}) STORED`);
  }
  if (col.reference) {
    const ref = col.reference;
    let fkStr = `REFERENCES ${ref.table}(${ref.column})`;
    if (ref.onDelete !== 'NO ACTION') fkStr += ` ON DELETE ${ref.onDelete}`;
    if (ref.onUpdate !== 'NO ACTION') fkStr += ` ON UPDATE ${ref.onUpdate}`;
    parts.push(fkStr);
  }

  return parts.join(' ');
}

// ─── ADD COLUMN ───────────────────────────────────────────────────────────────

function buildAddColumn(tableName: string, colName: string, col: ColumnDef): string {
  return `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${buildColumnDef(colName, col)};`;
}

// ─── INDEX ────────────────────────────────────────────────────────────────────

function buildCreateIndex(
  tableName: string,
  indexName: string,
  columns: string[],
  unique?: boolean,
  where?: string | null
): string {
  const uniqueStr = unique ? 'UNIQUE ' : '';
  const colStr = columns.join(', ');
  const whereStr = where ? ` WHERE ${where}` : '';
  return `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${colStr})${whereStr};`;
}

// ─── RLS POLICY ───────────────────────────────────────────────────────────────

function buildRlsPolicy(tableName: string, role: 'authenticated' | 'service_role'): string {
  if (role === 'authenticated') {
    return [
      `CREATE POLICY "allow_authenticated_${tableName}" ON ${tableName}`,
      `  FOR ALL TO authenticated USING (true) WITH CHECK (true);`,
    ].join('\n');
  }
  return [
    `CREATE POLICY "allow_service_role_${tableName}" ON ${tableName}`,
    `  FOR ALL TO service_role USING (true) WITH CHECK (true);`,
  ].join('\n');
}

// ─── TRIGGER (updated_at) ─────────────────────────────────────────────────────

function buildTrigger(tableName: string): string {
  const fnName = `update_${tableName}_updated_at`;
  return [
    `CREATE TRIGGER ${fnName}`,
    `  BEFORE UPDATE ON ${tableName}`,
    `  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`,
  ].join('\n');
}

// ─── FUNCTION ────────────────────────────────────────────────────────────────

function buildCreateOrReplaceFunction(fn: FunctionDef): string {
  const args = fn.args.map((a) => `${a.name} ${a.type}`).join(', ');
  const security = fn.security === 'DEFINER' ? '\n  SECURITY DEFINER' : '';
  return [
    `CREATE OR REPLACE FUNCTION ${fn.name}(${args})`,
    `  RETURNS ${fn.returns}`,
    `  LANGUAGE ${fn.language}`,
    `  ${fn.volatility}${security}`,
    `AS $$`,
    fn.body,
    `$$;`,
  ].join('\n');
}

// ─── CUSTOM TRIGGER ───────────────────────────────────────────────────────────

function buildDropCreateTrigger(trig: TriggerDef): string {
  const events = trig.events.join(' OR ');
  const colStr = trig.columns?.length ? ` OF ${trig.columns.join(', ')}` : '';
  const whenStr = trig.when ? `\n  WHEN (${trig.when})` : '';
  return [
    `DROP TRIGGER IF EXISTS ${trig.name} ON ${trig.table};`,
    `CREATE TRIGGER ${trig.name}`,
    `  ${trig.timing} ${events}${colStr} ON ${trig.table}`,
    `  FOR EACH ${trig.forEach}${whenStr}`,
    `  EXECUTE FUNCTION ${trig.function}();`,
  ].join('\n');
}

// ─── POLICY ──────────────────────────────────────────────────────────────────

function buildCreatePolicy(pol: PolicyDef): string {
  const roles = Array.isArray(pol.to) ? pol.to.join(', ') : pol.to;
  const permissive = pol.permissive === false ? 'AS RESTRICTIVE' : 'AS PERMISSIVE';
  const lines = [`CREATE POLICY "${pol.name}" ON ${pol.table}`, `  ${permissive} FOR ${pol.for} TO ${roles}`];
  if (pol.using) lines.push(`  USING (${pol.using})`);
  if (pol.withCheck) lines.push(`  WITH CHECK (${pol.withCheck})`);
  lines[lines.length - 1] += ';';
  return lines.join('\n');
}

function buildDropCreatePolicy(pol: PolicyDef): string {
  return [`DROP POLICY IF EXISTS "${pol.name}" ON ${pol.table};`, buildCreatePolicy(pol)].join('\n');
}
