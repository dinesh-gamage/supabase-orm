// Verification config for running this package's CLI against a real,
// already-shipped consuming application (a private repo, not published with
// this package — see package.json "files": ["dist"] and .gitignore, which
// excludes verify/output; this whole directory is dev-only tooling for
// exercising the CLI end-to-end against a live schema).
//
// Module list mirrors that app's own schema CLI (scripts/schema.ts,
// ALL_MODULES) — same ids, same schema/functions/triggers/policies/migration
// paths — so `diff` / `generate --dry-run` output can be compared directly
// against that tool's output.
//
// Read-only usage only: never run `apply`, `push`, or `mark-done` against
// this config.

import { defineConfig } from '../src/config/define-config.js';

const APP_ROOT = '/Users/dineshgamage/personal/projects/life-grid';

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
      id: 'system',
      schema: `${APP_ROOT}/src/core/database/schema.ts`,
      functions: `${APP_ROOT}/src/core/database/functions.ts`,
      triggers: `${APP_ROOT}/src/core/database/triggers.ts`,
      policies: `${APP_ROOT}/src/core/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/supabase/migrations`,
    },
    {
      id: 'core/user',
      schema: `${APP_ROOT}/src/modules/core/user/database/schema.ts`,
      functions: `${APP_ROOT}/src/modules/core/user/database/functions.ts`,
      triggers: `${APP_ROOT}/src/modules/core/user/database/triggers.ts`,
      policies: `${APP_ROOT}/src/modules/core/user/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/core/user/database/migrations`,
    },
    {
      id: 'core/audit',
      schema: `${APP_ROOT}/src/modules/core/audit/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/core/audit/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/core/audit/database/migrations`,
    },
    {
      id: 'core/login-attempts',
      schema: `${APP_ROOT}/src/modules/core/login-attempts/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/core/login-attempts/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/core/login-attempts/database/migrations`,
    },
    {
      id: 'pm',
      schema: `${APP_ROOT}/src/modules/pm/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/pm/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/pm/database/migrations`,
    },
    {
      id: 'fin',
      schema: `${APP_ROOT}/src/modules/fin/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/fin/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/fin/database/migrations`,
    },
    {
      id: 'invoicing',
      schema: `${APP_ROOT}/src/modules/invoicing/database/schema.ts`,
      functions: `${APP_ROOT}/src/modules/invoicing/database/functions.ts`,
      triggers: `${APP_ROOT}/src/modules/invoicing/database/triggers.ts`,
      policies: `${APP_ROOT}/src/modules/invoicing/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/invoicing/database/migrations`,
    },
    {
      id: 'portfolio',
      schema: `${APP_ROOT}/src/modules/portfolio/database/schema.ts`,
      policies: `${APP_ROOT}/src/modules/portfolio/database/policies.ts`,
      migrationsDir: `${APP_ROOT}/src/modules/portfolio/database/migrations`,
    },
  ],
});
