// Same as lifegrid.config.ts, but with `fin`'s typesOutput redirected into
// this repo's scratchpad so `supaorm types --module fin` can be diffed
// against the app's committed generated.types.ts without ever writing back
// into the consuming app.

import { defineConfig } from '../src/config/define-config.js';

const APP_ROOT = '/Users/dineshgamage/personal/projects/life-grid';
const SCRATCH =
  '/private/tmp/claude-501/-Users-dineshgamage-personal-projects-life-grid/d5c2ebf5-848f-45af-8b48-ef5619ec35a8/scratchpad';

export default defineConfig({
  connection: {
    urlEnv: 'NEXT_PUBLIC_SUPABASE_URL',
    serviceKeyEnv: 'SUPABASE_SECRET_KEY',
    envFile: `${APP_ROOT}/.env.local`,
  },
  aliases: {
    '@': `${APP_ROOT}/src`,
  },
  modules: [
    {
      id: 'fin',
      schema: `${APP_ROOT}/src/modules/fin/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/fin/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/fin/database/migrations`,
      typesOutput: `${SCRATCH}/fin-generated.types.ts`,
    },
  ],
});
