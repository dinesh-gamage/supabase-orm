import { describe, it, expect } from 'vitest';
import { diff } from '../src/schema/differ.js';
import { table, col, defineSchema } from '../src/schema/builder.js';
import type { LiveSchema, LiveTable } from '../src/schema/types.js';
import { liveTableFromDesired, defaultRlsPoliciesFor } from './fixtures/schemas.js';

function emptyLive(tables: LiveTable[] = []): LiveSchema {
  return { tables, enums: [], functions: [], triggers: [] };
}

describe('diff — column rename', () => {
  it('happy path: renamedFrom emits rename_column, not add_column/drop_column', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        full_name: col.text().notNull().renamedFrom('name'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([liveTable]));

    const renameChange = result.changes.find((c) => c.kind === 'rename_column');
    expect(renameChange).toMatchObject({
      kind: 'rename_column',
      tableName: 't_widgets',
      columnName: 'full_name',
      renamedFrom: 'name',
      category: 'safe',
    });
    expect(result.changes.find((c) => c.kind === 'add_column')).toBeUndefined();
    expect(result.changes.find((c) => c.kind === 'drop_column')).toBeUndefined();
  });

  it('rename + type change emits rename_column and alter_column_type(destructive)', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        amount_cents: col.integer().notNull().renamedFrom('amount'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'amount', pgType: 'DECIMAL', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([liveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_column')).toMatchObject({
      tableName: 't_widgets',
      columnName: 'amount_cents',
      renamedFrom: 'amount',
    });
    const typeChange = result.changes.find((c) => c.kind === 'alter_column_type');
    expect(typeChange).toBeDefined();
    expect(typeChange?.category).toBe('destructive');
    expect(typeChange?.tableName).toBe('t_widgets');
    expect(typeChange?.columnName).toBe('amount_cents');
    expect(typeChange?.detail).toContain('desired: INTEGER');
    expect(typeChange?.detail).toContain('live: DECIMAL');
  });

  it('inert hint: new name already exists live -> no rename change, staleHints entry emitted', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        full_name: col.text().notNull().renamedFrom('name'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'full_name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([liveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_column')).toBeUndefined();
    expect(result.staleHints).toContain("table t_widgets: column full_name: remove .renamedFrom('name') — already applied");
  });

  it('neither name live -> plain add_column only', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        full_name: col.text().notNull().renamedFrom('name'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([liveTable]));

    expect(result.changes.find((c) => c.kind === 'add_column' && c.columnName === 'full_name')).toBeDefined();
    expect(result.changes.find((c) => c.kind === 'rename_column')).toBeUndefined();
    expect(result.staleHints).toEqual([]);
  });

  it('throws on duplicate renamedFrom sources within the same table', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        full_name: col.text().notNull().renamedFrom('name'),
        display_name: col.text().notNull().renamedFrom('name'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    expect(() => diff(desired, emptyLive([liveTable]))).toThrow(/renamedFrom/i);
  });

  it('a renamed live column is not double-counted as drop_column', () => {
    const desired = defineSchema('t', [
      table('t_widgets', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        full_name: col.text().notNull().renamedFrom('name'),
      }),
    ]);
    const liveTable: LiveTable = {
      tableName: 't_widgets',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([liveTable]));
    expect(result.changes.filter((c) => c.kind === 'drop_column')).toEqual([]);
  });
});

describe('diff — table rename', () => {
  it('renames a table and continues diffing columns against the OLD live table', () => {
    const desired = defineSchema('t', [
      table('t_new_name', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        name: col.text().notNull(),
        extra: col.text().notNull(), // new column added at the same time as the rename
      }).renamedFrom('t_old_name'),
    ]);
    const oldLiveTable: LiveTable = {
      tableName: 't_old_name',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([oldLiveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_table')).toMatchObject({
      kind: 'rename_table',
      tableName: 't_new_name',
      renamedFrom: 't_old_name',
      category: 'safe',
    });
    // Column diffing happened against the OLD live table, in the same pass.
    const addCol = result.changes.find((c) => c.kind === 'add_column');
    expect(addCol).toMatchObject({ tableName: 't_new_name', columnName: 'extra' });
    // The old table must not also show up as drop_table.
    expect(result.changes.find((c) => c.kind === 'drop_table')).toBeUndefined();
  });

  it('table rename with an existing updated_at trigger also emits rename_trigger (old table name -> new)', () => {
    const desired = defineSchema('t', [
      table('t_new_name', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        name: col.text().notNull(),
        updated_at: col.timestamptz().notNull().default('NOW()'),
      }).renamedFrom('t_old_name'),
    ]);
    const oldLiveTable: LiveTable = {
      tableName: 't_old_name',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'name', pgType: 'TEXT', isNullable: false, isPrimaryKey: false, defaultExpr: null, isUnique: false, isGenerated: false, reference: null },
        { columnName: 'updated_at', pgType: 'TIMESTAMPTZ', isNullable: false, isPrimaryKey: false, defaultExpr: 'NOW()', isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      // Auto-managed trigger already exists — under the OLD table name, since
      // Postgres never renames triggers as part of ALTER TABLE ... RENAME TO.
      hasTrigger: true,
    };

    const result = diff(desired, emptyLive([oldLiveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_table')).toBeDefined();
    expect(result.changes.find((c) => c.kind === 'add_trigger')).toBeUndefined();
    expect(result.changes.find((c) => c.kind === 'rename_trigger')).toMatchObject({
      kind: 'rename_trigger',
      tableName: 't_new_name',
      triggerName: 'update_t_new_name_updated_at',
      renamedFrom: 'update_t_old_name_updated_at',
      category: 'safe',
    });
  });

  it('table rename with no existing trigger still emits add_trigger (not rename_trigger)', () => {
    const desired = defineSchema('t', [
      table('t_new_name', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
        updated_at: col.timestamptz().notNull().default('NOW()'),
      }).renamedFrom('t_old_name'),
    ]);
    const oldLiveTable: LiveTable = {
      tableName: 't_old_name',
      columns: [
        { columnName: 'id', pgType: 'UUID', isNullable: false, isPrimaryKey: true, defaultExpr: 'gen_random_uuid()', isUnique: false, isGenerated: false, reference: null },
        { columnName: 'updated_at', pgType: 'TIMESTAMPTZ', isNullable: false, isPrimaryKey: false, defaultExpr: 'NOW()', isUnique: false, isGenerated: false, reference: null },
      ],
      indexes: [],
      checks: [],
      rlsEnabled: false,
      rlsPolicies: [],
      hasTrigger: false,
    };

    const result = diff(desired, emptyLive([oldLiveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_trigger')).toBeUndefined();
    expect(result.changes.find((c) => c.kind === 'add_trigger')).toMatchObject({
      kind: 'add_trigger',
      tableName: 't_new_name',
    });
  });

  it('inert table rename hint: new name already exists live -> no rename change, staleHints entry', () => {
    const desiredTableDef = table('t_new_name', {
      id: col.uuid().primaryKey().default('gen_random_uuid()'),
      name: col.text().notNull(),
    }).renamedFrom('t_old_name');
    const desired = defineSchema('t', [desiredTableDef]);
    const liveTable = liveTableFromDesired(desiredTableDef.build());

    const result = diff(desired, emptyLive([liveTable]));

    expect(result.changes.find((c) => c.kind === 'rename_table')).toBeUndefined();
    expect(result.staleHints).toContain("table t_new_name: remove .renamedFrom('t_old_name') — already applied");
  });

  it('neither name live -> plain create_table (hint ignored)', () => {
    const desired = defineSchema('t', [
      table('t_new_name', {
        id: col.uuid().primaryKey().default('gen_random_uuid()'),
      }).renamedFrom('t_old_name'),
    ]);

    const result = diff(desired, emptyLive([]));

    expect(result.changes).toEqual([{ kind: 'create_table', tableName: 't_new_name', category: 'safe' }]);
    expect(result.staleHints).toEqual([]);
  });

  it('throws on duplicate renamedFrom sources across tables', () => {
    const desired = defineSchema('t', [
      table('t_a', { id: col.uuid().primaryKey().default('gen_random_uuid()') }).renamedFrom('t_old'),
      table('t_b', { id: col.uuid().primaryKey().default('gen_random_uuid()') }).renamedFrom('t_old'),
    ]);

    expect(() => diff(desired, emptyLive([]))).toThrow(/renamedFrom/i);
  });

  it('does not double count the old live table as drop_table when renamed', () => {
    const desiredTableDef = table('t_new_name', {
      id: col.uuid().primaryKey().default('gen_random_uuid()'),
    }).renamedFrom('t_old_name');
    const desired = defineSchema('t', [desiredTableDef]);
    const oldLive = liveTableFromDesired(desiredTableDef.build());
    oldLive.tableName = 't_old_name';
    oldLive.rlsPolicies = defaultRlsPoliciesFor(desiredTableDef.build());

    const result = diff(desired, emptyLive([oldLive]));
    expect(result.changes.filter((c) => c.kind === 'drop_table')).toEqual([]);
  });
});
