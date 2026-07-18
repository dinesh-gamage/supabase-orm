import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConfigFile, getConnection, loadConfig, loadModuleDatabase } from '../src/config/load-config.js';
import type { ResolvedModule } from '../src/config/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');
const CONFIG_DIR = join(FIXTURES, 'config');

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('findConfigFile', () => {
  it('finds the config file in the starting directory', () => {
    expect(findConfigFile(CONFIG_DIR)).toBe(join(CONFIG_DIR, 'supaorm.config.ts'));
  });

  it('walks up parent directories until it finds one', () => {
    const deepDir = join(CONFIG_DIR, 'nested', 'deep');
    expect(findConfigFile(deepDir)).toBe(join(CONFIG_DIR, 'supaorm.config.ts'));
  });

  it('returns null when no config file exists up to the filesystem root', () => {
    // /tmp itself (or its parents) should not contain a supaorm.config.* file.
    expect(findConfigFile('/tmp')).toBeNull();
  });
});

describe('loadConfig', () => {
  it('discovers the config file, applies defaults, and resolves all paths absolute (jiti loads the TS fixture)', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR });

    expect(config.configDir).toBe(CONFIG_DIR);

    // defaults
    expect(config.connection.urlEnv).toBe('SUPABASE_URL');
    expect(config.connection.serviceKeyEnv).toBe('SUPABASE_SERVICE_ROLE_KEY');
    expect(config.connection.envFile).toBeNull();
    expect(config.migrationsTable).toBe('_migrations');
    expect(config.allowDestructive).toBe(false);
    expect(config.aliases).toEqual({});

    // module resolution
    expect(config.modules).toHaveLength(1);
    const mod = config.modules[0];
    expect(mod.id).toBe('demo');
    expect(mod.tablePrefix).toBe('demo_');

    expect(isAbsolute(mod.schema)).toBe(true);
    expect(mod.schema).toBe(join(CONFIG_DIR, 'schema.ts'));

    expect(isAbsolute(mod.migrationsDir)).toBe(true);
    expect(mod.migrationsDir).toBe(join(CONFIG_DIR, 'migrations')); // fine even though it doesn't exist

    expect(mod.typesOutput).not.toBeNull();
    expect(isAbsolute(mod.typesOutput as string)).toBe(true);

    expect(mod.functions).toBeNull();
    expect(mod.triggers).toBeNull();
    expect(mod.policies).toBeNull();
  });

  it('accepts an explicit configPath', async () => {
    const config = await loadConfig({ configPath: join(CONFIG_DIR, 'supaorm.config.ts'), cwd: FIXTURES });
    expect(config.configDir).toBe(CONFIG_DIR);
  });

  it('throws when no config file can be found', async () => {
    await expect(loadConfig({ cwd: '/tmp' })).rejects.toThrow(/could not find a supaorm config file/i);
  });

  it('throws on duplicate module ids', async () => {
    const dir = join(FIXTURES, 'config-dup-ids');
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/duplicate module id "demo"/i);
  });

  it('throws when a module schema file does not exist', async () => {
    const dir = join(FIXTURES, 'config-missing-schema');
    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/schema file not found/i);
  });

  it('loads and applies a .env file (CLI override), populating process.env', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR, envFile: '.env.test' });
    expect(config.connection.envFile).toBe(resolve(CONFIG_DIR, '.env.test'));
    expect(process.env.SUPABASE_URL).toBe('http://fixture.local');
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe('fixture-service-key');
  });
});

describe('loadModuleDatabase', () => {
  it('loads the schema (named export) and defaults functions/triggers/policies to [] when their files are absent', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR });
    const db = await loadModuleDatabase(config.modules[0], config.aliases, config.configDir);

    expect(db.moduleId).toBe('demo');
    expect(db.schema.tables.map((t) => t.tableName)).toEqual(['demo_widgets']);
    expect(db.functions).toEqual([]);
    expect(db.triggers).toEqual([]);
    expect(db.policies).toEqual([]);
  });

  it('throws when tablePrefix is set and a table does not match', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR });
    const violating: ResolvedModule = { ...config.modules[0], tablePrefix: 'nope_' };

    await expect(loadModuleDatabase(violating, config.aliases, config.configDir)).rejects.toThrow(
      /must start with one of: nope_/i
    );
  });

  it('skips tablePrefix validation when unset or false', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR });
    const unset: ResolvedModule = { ...config.modules[0], tablePrefix: undefined };
    const disabled: ResolvedModule = { ...config.modules[0], tablePrefix: false };

    await expect(loadModuleDatabase(unset, config.aliases, config.configDir)).resolves.toBeTruthy();
    await expect(loadModuleDatabase(disabled, config.aliases, config.configDir)).resolves.toBeTruthy();
  });
});

describe('getConnection', () => {
  it('returns the URL and service key read from the configured env var names', async () => {
    process.env.SUPABASE_URL = 'http://x';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc-key';
    const config = await loadConfig({ cwd: CONFIG_DIR });

    expect(getConnection(config)).toEqual({ url: 'http://x', serviceKey: 'svc-key' });
  });

  it('throws an error that lists the missing env var name(s)', async () => {
    const config = await loadConfig({ cwd: CONFIG_DIR });
    expect(() => getConnection(config)).toThrow(/SUPABASE_URL/);
    expect(() => getConnection(config)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('lists only the specific missing var when one is set', async () => {
    process.env.SUPABASE_URL = 'http://x';
    const config = await loadConfig({ cwd: CONFIG_DIR });
    try {
      getConnection(config);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect((err as Error).message).not.toContain('SUPABASE_URL,');
    }
  });
});
