// Public API barrel for @dinesh-gamage/supabase-orm.

// ─── DSL (schema definition) ───────────────────────────────────────────────
export {
  col,
  table,
  enumType,
  defineSchema,
  defineFunction,
  defineTrigger,
  definePolicy,
  ColumnBuilder,
  TableBuilder,
} from './schema/builder.js';
export type { DefineSchemaOptions } from './schema/builder.js';

// ─── Engine (diff / SQL generation / introspection / types / migrations) ──
export { diff } from './schema/differ.js';
export { generateSql, describeChange, DESTRUCTIVE_MARKER } from './schema/sql-generator.js';
export type { GenerateSqlOptions } from './schema/sql-generator.js';
export { generateTypes } from './schema/type-generator.js';
export { introspectSchema } from './schema/introspector.js';
export { splitSqlStatements } from './migrate/splitter.js';
export { MigrationRunner } from './migrate/runner.js';
export type {
  AppliedMigration,
  DriftReport,
  MigrationOutcome,
  RunResult,
  MigrationRunnerOptions,
  RunOptions,
} from './migrate/runner.js';
export { generateBootstrapSql } from './migrate/bootstrap.js';
export type { GenerateBootstrapSqlOptions } from './migrate/bootstrap.js';
export {
  getNextMigrationNumber,
  listMigrationFiles,
  hasDestructiveMarker,
  isEnumMigration,
  migrationFileName,
} from './migrate/planner.js';

// ─── Client (executor / typed repository) ──────────────────────────────────
export { createRpcExecutor, SqlExecutionError } from './client/executor.js';
export type { SqlExecutor, RpcExecutorOptions } from './client/executor.js';
export { createRepository, SupaormError } from './client/repository.js';
export type {
  Repository,
  TableTypes,
  TablesMap,
  FindManyOptions,
  QueryBuilder,
  MergeDatabases,
} from './client/repository.js';

// ─── Config ─────────────────────────────────────────────────────────────────
export { defineConfig } from './config/define-config.js';
export { loadConfig, loadModuleDatabase, findConfigFile, getConnection } from './config/load-config.js';
export type { LoadConfigOptions } from './config/load-config.js';
export type {
  ModuleEntry,
  ConnectionConfig,
  SupaormConfig,
  ResolvedConfig,
  ResolvedModule,
} from './config/types.js';

// ─── Schema types ───────────────────────────────────────────────────────────
export type {
  RlsPolicy,
  ForeignKeyRef,
  GeneratedColumnDef,
  ColumnDef,
  IndexDef,
  CheckDef,
  TableDef,
  EnumDef,
  ModuleSchema,
  FunctionLanguage,
  FunctionVolatility,
  FunctionSecurity,
  FunctionArg,
  FunctionDef,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  TriggerDef,
  PolicyCmd,
  PolicyDef,
  ModuleDatabase,
  LiveColumn,
  LiveIndex,
  LiveCheck,
  LiveRlsPolicy,
  LiveTable,
  LiveEnum,
  LiveFunction,
  LiveTrigger,
  LiveSchema,
  DiffCategory,
  DiffChangeKind,
  DiffChange,
  SchemaDiff,
} from './schema/types.js';
