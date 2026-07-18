import type { SupaormConfig } from './types.js';

/** Identity helper for authoring `supaorm.config.ts` with type-checking and autocomplete. */
export function defineConfig(config: SupaormConfig): SupaormConfig {
  return config;
}
