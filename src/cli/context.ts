// Shared CLI bootstrap: parses global options, loads the config, and lazily
// builds the Supabase client / SqlExecutor only when a command actually needs
// the database. Commands that don't touch the DB (types, bootstrap, init)
// never trigger the env-var requirement in getConnection().

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig, getConnection } from '../config/load-config.js';
import { createRpcExecutor } from '../client/executor.js';
import type { SqlExecutor } from '../client/executor.js';
import type { ResolvedConfig, ResolvedModule } from '../config/types.js';

export interface GlobalOpts {
  config?: string;
  envFile?: string;
}

export class CliContext {
  private supabase: SupabaseClient | undefined;
  private executor: SqlExecutor | undefined;

  private constructor(public readonly config: ResolvedConfig) {}

  static async create(globalOpts: GlobalOpts): Promise<CliContext> {
    const config = await loadConfig({ configPath: globalOpts.config, envFile: globalOpts.envFile });
    return new CliContext(config);
  }

  getSupabase(): SupabaseClient {
    if (!this.supabase) {
      const { url, serviceKey } = getConnection(this.config);
      this.supabase = createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    return this.supabase;
  }

  getExecutor(): SqlExecutor {
    if (!this.executor) {
      this.executor = createRpcExecutor(this.getSupabase());
    }
    return this.executor;
  }

  /** Modules matching `--module <id>`, or every configured module if omitted. */
  selectModules(moduleId?: string): ResolvedModule[] {
    if (!moduleId) return this.config.modules;
    const found = this.config.modules.find((m) => m.id === moduleId);
    if (!found) {
      const known = this.config.modules.map((m) => m.id).join(', ') || '(none configured)';
      throw new Error(`Unknown module "${moduleId}". Known modules: ${known}`);
    }
    return [found];
  }
}
