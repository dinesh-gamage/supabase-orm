import { defineConfig } from '../../../src/config/define-config.js';

export default defineConfig({
  modules: [{ id: 'demo', schema: './does-not-exist.ts', migrationsDir: './migrations' }],
});
