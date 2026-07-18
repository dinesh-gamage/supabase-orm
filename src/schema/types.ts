// Schema definition types — all pure data, no logic

export type RlsPolicy = 'standard' | 'custom' | 'none';
// standard: auto-generate authenticated (full) + service_role (full) policies
// custom:   emit only ENABLE ROW LEVEL SECURITY, developer writes policies
// none:     skip RLS entirely

export interface ForeignKeyRef {
  table: string;
  column: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

export interface GeneratedColumnDef {
  expression: string;
  stored: boolean;
}

export interface ColumnDef {
  pgType: string;             // e.g. 'UUID', 'TEXT', 'DECIMAL(10,2)', 'pm_task_status'
  isNullable: boolean;
  isPrimaryKey: boolean;
  defaultExpr: string | null; // raw SQL e.g. "gen_random_uuid()", "'USD'"
  isUnique: boolean;
  reference: ForeignKeyRef | null;
  generatedAs: GeneratedColumnDef | null;
  comment: string | null;
  /** Rename hint: the previous column name in the live DB. Inert once applied. */
  renamedFrom?: string | null;
}

export interface IndexDef {
  columns: string[];
  unique?: boolean;
  name?: string;   // auto-named if omitted: idx_{table}_{columns_joined_by_underscore}
  where?: string;  // partial index predicate
}

export interface CheckDef {
  name: string;
  expression: string;
}

export interface TableDef {
  tableName: string;
  columns: Record<string, ColumnDef>;
  indexes: IndexDef[];
  checks: CheckDef[];
  rlsPolicy: RlsPolicy;
  comment: string | null;
  /** Rename hint: the previous table name in the live DB. Inert once applied. */
  renamedFrom?: string | null;
}

export interface EnumDef {
  typeName: string;
  values: string[];
}

export interface ModuleSchema {
  moduleId: string;
  tables: TableDef[];
  enums: EnumDef[];
}

// ─── Function definition ─────────────────────────────────────────────────────

export type FunctionLanguage = 'plpgsql' | 'sql';
export type FunctionVolatility = 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
export type FunctionSecurity = 'INVOKER' | 'DEFINER';

export interface FunctionArg {
  name: string;
  type: string;
}

export interface FunctionDef {
  name: string;
  args: FunctionArg[];      // [] for no-arg functions
  returns: string;          // e.g. 'TRIGGER', 'VOID', 'BOOLEAN', 'TEXT', 'TABLE(...)'
  language: FunctionLanguage;
  security: FunctionSecurity;
  volatility: FunctionVolatility;
  body: string;             // raw SQL body (between $$...$$)
}

// ─── Trigger definition ───────────────────────────────────────────────────────

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF';
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
export type TriggerForEach = 'ROW' | 'STATEMENT';

export interface TriggerDef {
  name: string;
  table: string;
  timing: TriggerTiming;
  events: TriggerEvent[];
  columns?: string[];       // for UPDATE OF col1, col2 ... (optional)
  forEach: TriggerForEach;
  function: string;         // function name to call
  when?: string;            // WHEN condition (optional)
}

// ─── RLS policy definition ────────────────────────────────────────────────────

export type PolicyCmd = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface PolicyDef {
  name: string;
  table: string;
  for: PolicyCmd;
  to: string | string[];    // role or array of roles, e.g. 'authenticated', ['authenticated', 'anon']
  using?: string;           // USING expression (required for SELECT/UPDATE/DELETE/ALL)
  withCheck?: string;       // WITH CHECK expression (required for INSERT/UPDATE/ALL)
  permissive?: boolean;     // default true (PERMISSIVE vs RESTRICTIVE)
}

// ─── Module database definition ───────────────────────────────────────────────

export interface ModuleDatabase {
  moduleId: string;
  schema: ModuleSchema;
  functions: FunctionDef[];
  triggers: TriggerDef[];
  policies: PolicyDef[];
}

// ─── Live schema (from DB introspection) ─────────────────────────────────────

export interface LiveColumn {
  columnName: string;
  pgType: string;       // normalized e.g. 'uuid', 'text', 'decimal', 'pm_task_status'
  isNullable: boolean;
  isPrimaryKey: boolean;
  defaultExpr: string | null;
  isUnique: boolean;
  isGenerated: boolean;
  reference: ForeignKeyRef | null;
}

export interface LiveIndex {
  indexName: string;
  columns: string[];
  unique: boolean;
  where: string | null;
}

export interface LiveCheck {
  name: string;
  expression: string;
}

export interface LiveRlsPolicy {
  policyName: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  withCheck: string | null;
}

export interface LiveTable {
  tableName: string;
  columns: LiveColumn[];
  indexes: LiveIndex[];
  checks: LiveCheck[];
  rlsEnabled: boolean;
  rlsPolicies: LiveRlsPolicy[];
  hasTrigger: boolean; // true if update_{table}_updated_at trigger exists
}

export interface LiveEnum {
  typeName: string;
  values: string[];
}

export interface LiveFunction {
  name: string;
  argsSignature: string; // e.g. "sql text" or "" for no args
  returns: string;
  language: string;
  security: 'INVOKER' | 'DEFINER';
  volatility: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
  body: string;         // normalized body (trimmed)
}

export interface LiveTrigger {
  name: string;
  table: string;
  timing: string;       // 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  events: string[];     // sorted: ['DELETE', 'INSERT', 'UPDATE']
  forEach: string;      // 'ROW' | 'STATEMENT'
  functionName: string;
  columns: string[];    // UPDATE OF columns (empty if none)
}

export interface LiveSchema {
  tables: LiveTable[];
  enums: LiveEnum[];
  functions: LiveFunction[];
  triggers: LiveTrigger[];
}

// ─── Diff result ─────────────────────────────────────────────────────────────

/**
 * safe        — applied automatically (creates, additive alters, renames)
 * destructive — only generated/applied with the force-destructive flag
 * manual      — never auto-generated; always emitted as guidance comments
 */
export type DiffCategory = 'safe' | 'destructive' | 'manual';

export type DiffChangeKind =
  // tables/columns/indexes
  | 'create_table'
  | 'add_column'
  | 'create_index'
  | 'create_enum'
  | 'add_enum_value'
  | 'add_trigger'
  | 'enable_rls'
  | 'add_rls_policy'
  // renames (safe — metadata only)
  | 'rename_table'
  | 'rename_column'
  // Postgres doesn't rename a table's triggers on ALTER TABLE ... RENAME TO,
  // so the auto-managed updated_at trigger needs its own explicit rename to
  // keep matching the `update_{tableName}_updated_at` convention. Emitted
  // alongside rename_table, not standalone.
  | 'rename_trigger'
  // functions
  | 'create_function'
  | 'alter_function'
  // triggers
  | 'create_trigger'
  | 'alter_trigger'
  // policies
  | 'create_policy'
  | 'alter_policy'
  // destructive
  | 'drop_column'
  | 'alter_column_type'
  | 'drop_table'
  | 'drop_function'
  | 'drop_trigger'
  | 'drop_policy'
  // manual (Postgres cannot drop enum values)
  | 'drop_enum_value';

export interface DiffChange {
  kind: DiffChangeKind;
  category: DiffCategory;
  tableName?: string;
  columnName?: string;
  indexName?: string;
  enumName?: string;
  functionName?: string;
  triggerName?: string;
  policyName?: string;
  /** For rename_* changes: the previous (live) name being renamed away from. */
  renamedFrom?: string;
  detail?: string; // extra context, used in SQL generation
}

export interface SchemaDiff {
  moduleId: string;
  changes: DiffChange[];
  hasEnumChanges: boolean;       // true = needs split migration file
  hasStructuralChanges: boolean; // true = table/column/index/function/trigger/policy changes
  /**
   * renamedFrom hints whose target name already exists live — the rename has
   * been applied, so the hint is inert and can be removed from the schema file.
   */
  staleHints: string[];
}
