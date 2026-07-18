// Verification config for exercising the CLI end-to-end against a BLANK dev
// Supabase project. DEV ONLY — connection points at the *_DEV env vars.
// Never point this at the production URL/key.

import { defineConfig } from '../../src/config/define-config.js';

export default defineConfig({
  connection: {
    urlEnv: 'NEXT_PUBLIC_SUPABASE_URL_DEV',
    serviceKeyEnv: 'SUPABASE_SECRET_KEY_DEV',
    envFile: '/Users/dineshgamage/personal/projects/life-grid/.env.local',
  },
  modules: [
    {
      id: 'demo',
      schema: './schema.ts',
      migrationsDir: './migrations',
      tablePrefix: 'demo_',
    },
  ],
});
