import { defineConfig } from '../../../src/config/define-config.js';

// Default export — exercises the "default config export" load path.
export default defineConfig({
  modules: [
    {
      id: 'demo',
      schema: './schema.ts',
      migrationsDir: './migrations', // intentionally doesn't exist on disk
      typesOutput: './generated.types.ts',
      tablePrefix: 'demo_',
    },
  ],
});
