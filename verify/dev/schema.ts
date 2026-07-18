// verify/dev — end-to-end schema-diff/generate/apply validation against a
// blank dev Supabase project. Module id 'demo', table prefix 'demo_'.
//
// v3 (step 4, destructive gating): demo_projects.status dropped (and its
// demo_status enum usage removed). The demo_status enum type itself is left
// declared here — dropping an enum type is out of scope (Postgres can't drop
// enum values without recreating the type; this tool never auto-generates
// that).
//
// v4 (step 6, push): demo_projects.notes added then removed again via
// `push`, to leave schema and DB in sync at the end without a tracked
// migration file (push is dev-only and never recorded in _migrations).

import { col, defineSchema, enumType, table } from '../../src/index.js';

export default defineSchema(
  'demo',
  [
    table('demo_projects', {
      id: col.uuid().primaryKey().default('gen_random_uuid()'),
      name: col.text().notNull(),
      cost: col.decimal(12, 2),
      created_at: col.timestamptz().notNull().default('NOW()'),
      updated_at: col.timestamptz().notNull().default('NOW()'),
    })
      .indexes([{ columns: ['name'] }])
      .rls('standard'),

    table('demo_todos', {
      id: col.uuid().primaryKey().default('gen_random_uuid()'),
      project_id: col.uuid().notNull().references('demo_projects', 'id', { onDelete: 'CASCADE' }),
      title: col.text().notNull(),
      done: col.boolean().notNull().default('false'),
      created_at: col.timestamptz().notNull().default('NOW()'),
      updated_at: col.timestamptz().notNull().default('NOW()'),
    })
      .rls('standard'),
  ],
  [enumType('demo_status', ['active', 'archived'])],
  { tablePrefix: 'demo_' }
);
