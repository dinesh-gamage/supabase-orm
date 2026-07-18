import { col, defineSchema, table } from '../../../src/schema/builder.js';

// Named export (`schema`) — exercises the "named schema export" load path.
export const schema = defineSchema('demo', [
  table('demo_widgets', {
    id: col.uuid().primaryKey().default('gen_random_uuid()'),
    name: col.text().notNull(),
  }),
]);
