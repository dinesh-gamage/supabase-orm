import { createJiti } from 'jiti';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ModuleDatabase, ModuleSchema, FunctionDef, TriggerDef, PolicyDef } from '../schema/types.js';
import type { ResolvedConfig, ResolvedModule, SupaormConfig } from './types.js';

const CONFIG_FILENAMES = ['supaorm.config.ts', 'supaorm.config.mts', 'supaorm.config.js'];

/** Walk up from `startDir` looking for a supaorm config file. Returns its absolute path, or null. */
export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export interface LoadConfigOptions {
  /** Explicit config file path. Wins over discovery. Resolved against `cwd`. */
  configPath?: string;
  /** Directory to search/resolve from. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit .env file path (CLI override). Wins over `config.connection.envFile`. Resolved against `cwd`. */
  envFile?: string;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();

  const configPath = opts.configPath ? resolve(cwd, opts.configPath) : findConfigFile(cwd);
  if (!configPath) {
    throw new Error(
      `Could not find a supaorm config file (${CONFIG_FILENAMES.join(', ')}) starting from "${cwd}" and walking up to the filesystem root.`
    );
  }
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const configDir = dirname(configPath);

  // Load the config file itself WITHOUT aliases. Aliases are declared inside
  // the config, so they can't be used to resolve the config file's own
  // imports — they only apply to schema/functions/triggers/policies files,
  // loaded later via loadModuleDatabase().
  const configJiti = createJiti(configPath, { interopDefault: true });
  const mod = await configJiti.import<Record<string, unknown>>(configPath);
  // NOTE: with interopDefault:true, jiti's proxy makes `mod.default` fall back
  // to the whole module when there's no real default export (CJS-interop
  // convenience) — so `mod.default` is never `undefined` and `??` can't be
  // used to detect a *real* default export. Check ownership via `in` instead.
  const raw = ('default' in mod ? mod.default : mod.config) as SupaormConfig | undefined;
  if (!raw) {
    throw new Error(
      `Config file ${configPath} must have a default export or a named "config" export (a SupaormConfig, typically via defineConfig()).`
    );
  }
  if (!Array.isArray(raw.modules)) {
    throw new Error(`Config file ${configPath}: "modules" must be an array.`);
  }

  // ─── modules ────────────────────────────────────────────────────────────────
  const seenIds = new Set<string>();
  const modules: ResolvedModule[] = raw.modules.map((m) => {
    if (!m.id || m.id.trim() === '') {
      throw new Error(`Config file ${configPath}: every module must have a non-empty "id".`);
    }
    if (seenIds.has(m.id)) {
      throw new Error(`Config file ${configPath}: duplicate module id "${m.id}".`);
    }
    seenIds.add(m.id);

    const schemaPath = resolve(configDir, m.schema);
    if (!existsSync(schemaPath)) {
      throw new Error(`Module "${m.id}": schema file not found: ${schemaPath}`);
    }

    const resolved: ResolvedModule = {
      id: m.id,
      schema: schemaPath,
      functions: m.functions ? resolve(configDir, m.functions) : null,
      triggers: m.triggers ? resolve(configDir, m.triggers) : null,
      policies: m.policies ? resolve(configDir, m.policies) : null,
      // migrationsDir need not exist yet; typesOutput's directory need not exist either.
      migrationsDir: resolve(configDir, m.migrationsDir),
      typesOutput: m.typesOutput ? resolve(configDir, m.typesOutput) : null,
      tablePrefix: m.tablePrefix,
    };
    return resolved;
  });

  // ─── connection + envFile ───────────────────────────────────────────────────
  const urlEnv = raw.connection?.urlEnv ?? 'SUPABASE_URL';
  const serviceKeyEnv = raw.connection?.serviceKeyEnv ?? 'SUPABASE_SERVICE_ROLE_KEY';

  const rawEnvFile = opts.envFile ?? raw.connection?.envFile;
  let envFile: string | null = null;
  if (rawEnvFile) {
    // A CLI-supplied envFile resolves against cwd; one declared in the config resolves against configDir.
    const base = opts.envFile ? cwd : configDir;
    envFile = isAbsolute(rawEnvFile) ? rawEnvFile : resolve(base, rawEnvFile);
    if (existsSync(envFile)) {
      loadDotenv({ path: envFile });
    }
  }

  return {
    configDir,
    connection: { urlEnv, serviceKeyEnv, envFile },
    modules,
    migrationsTable: raw.migrationsTable ?? '_migrations',
    allowDestructive: raw.allowDestructive ?? false,
    aliases: raw.aliases ?? {},
  };
}

/**
 * Loads a module's schema file (and optional functions/triggers/policies
 * files) via jiti, using aliases resolved absolute against `configDir`.
 */
export async function loadModuleDatabase(
  module: ResolvedModule,
  aliases: Record<string, string>,
  configDir: string
): Promise<ModuleDatabase> {
  const resolvedAliases: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    resolvedAliases[key] = isAbsolute(value) ? value : resolve(configDir, value);
  }

  const jiti = createJiti(module.schema, { alias: resolvedAliases, interopDefault: true });

  const schemaMod = await jiti.import<Record<string, unknown>>(module.schema);
  const schema = ('default' in schemaMod ? schemaMod.default : schemaMod.schema) as
    | ModuleSchema
    | undefined;
  if (!schema || !Array.isArray(schema.tables)) {
    throw new Error(
      `Module "${module.id}": schema file ${module.schema} must have a default export or a named "schema" export (a ModuleSchema).`
    );
  }

  validateTablePrefix(schema, module.tablePrefix, module.id);

  const functions = module.functions
    ? await loadNamedExport<FunctionDef[]>(jiti, module.functions, 'functions', module.id)
    : [];
  const triggers = module.triggers
    ? await loadNamedExport<TriggerDef[]>(jiti, module.triggers, 'triggers', module.id)
    : [];
  const policies = module.policies
    ? await loadNamedExport<PolicyDef[]>(jiti, module.policies, 'policies', module.id)
    : [];

  return { moduleId: module.id, schema, functions, triggers, policies };
}

async function loadNamedExport<T>(
  jiti: ReturnType<typeof createJiti>,
  filePath: string,
  exportName: string,
  moduleId: string
): Promise<T> {
  const mod = await jiti.import<Record<string, unknown>>(filePath);
  const value = mod[exportName];
  if (value === undefined) {
    throw new Error(`Module "${moduleId}": ${filePath} must export a named "${exportName}" array.`);
  }
  return value as T;
}

function validateTablePrefix(
  schema: ModuleSchema,
  tablePrefix: string | string[] | false | undefined,
  moduleId: string
): void {
  if (tablePrefix === undefined || tablePrefix === false) return;
  const prefixes = Array.isArray(tablePrefix) ? tablePrefix : [tablePrefix];
  for (const t of schema.tables) {
    if (!prefixes.some((p) => t.tableName.startsWith(p))) {
      throw new Error(
        `Table "${t.tableName}" in module "${moduleId}" must start with one of: ${prefixes.join(', ')}`
      );
    }
  }
}

/** Reads the Supabase URL + service-role key from `process.env`, per `config.connection`. */
export function getConnection(config: ResolvedConfig): { url: string; serviceKey: string } {
  const url = process.env[config.connection.urlEnv];
  const serviceKey = process.env[config.connection.serviceKeyEnv];
  const missing: string[] = [];
  if (!url) missing.push(config.connection.urlEnv);
  if (!serviceKey) missing.push(config.connection.serviceKeyEnv);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
  return { url: url as string, serviceKey: serviceKey as string };
}
