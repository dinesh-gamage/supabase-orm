/** One schema module registered with the tool. */
export interface ModuleEntry {
  /** Unique module id, e.g. 'fin'. */
  id: string;
  /** Path to the schema file (default export or `schema` export: ModuleSchema). */
  schema: string;
  /** Optional path to a file exporting `functions: FunctionDef[]`. */
  functions?: string;
  /** Optional path to a file exporting `triggers: TriggerDef[]`. */
  triggers?: string;
  /** Optional path to a file exporting `policies: PolicyDef[]`. */
  policies?: string;
  /** Directory holding this module's numbered .sql migrations. */
  migrationsDir: string;
  /** Where to write generated types. Omit to skip type generation. */
  typesOutput?: string;
  /** Required table prefix(es) validated at load. false disables validation. */
  tablePrefix?: string | string[] | false;
}

export interface ConnectionConfig {
  /** Env var NAME holding the Supabase URL. Default 'SUPABASE_URL'. */
  urlEnv?: string;
  /** Env var NAME holding the service-role key. Default 'SUPABASE_SERVICE_ROLE_KEY'. */
  serviceKeyEnv?: string;
  /** Optional .env file loaded (via dotenv) before reading the vars. */
  envFile?: string;
}

export interface SupaormConfig {
  connection?: ConnectionConfig;
  modules: ModuleEntry[];
  /** Migrations tracking table. Default '_migrations'. */
  migrationsTable?: string;
  /** Include destructive statements in generate/push without the CLI flag. Default false. */
  allowDestructive?: boolean;
  /** Path aliases for loading TS schema files (passed to jiti), e.g. { '@': './src' }. */
  aliases?: Record<string, string>;
}

/** Config after loading: absolute paths, defaults applied. */
export interface ResolvedConfig {
  configDir: string;
  connection: Required<Pick<ConnectionConfig, 'urlEnv' | 'serviceKeyEnv'>> & {
    envFile: string | null;
  };
  modules: ResolvedModule[];
  migrationsTable: string;
  allowDestructive: boolean;
  aliases: Record<string, string>;
}

export interface ResolvedModule extends Omit<ModuleEntry, 'schema' | 'functions' | 'triggers' | 'policies' | 'migrationsDir' | 'typesOutput'> {
  schema: string;        // absolute
  functions: string | null;
  triggers: string | null;
  policies: string | null;
  migrationsDir: string; // absolute
  typesOutput: string | null;
}
