import { defineConfig } from '../../../src/config/define-config.js';

export default defineConfig({
  modules: [
    { id: 'demo', schema: '../config/schema.ts', migrationsDir: './migrations' },
    { id: 'demo', schema: '../config/schema.ts', migrationsDir: './migrations' },
  ],
});
