import type {
  ColumnDef,
  TableDef,
  EnumDef,
  ModuleSchema,
  IndexDef,
  CheckDef,
  ForeignKeyRef,
  RlsPolicy,
  FunctionDef,
  FunctionArg,
  FunctionLanguage,
  FunctionSecurity,
  FunctionVolatility,
  TriggerDef,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  PolicyDef,
  PolicyCmd,
} from './types.js';

// ─── ColumnBuilder ────────────────────────────────────────────────────────────

export class ColumnBuilder {
  private def: ColumnDef;

  constructor(pgType: string) {
    this.def = {
      pgType,
      isNullable: true,
      isPrimaryKey: false,
      defaultExpr: null,
      isUnique: false,
      reference: null,
      generatedAs: null,
      comment: null,
      renamedFrom: null,
    };
  }

  private clone(): ColumnBuilder {
    const b = new ColumnBuilder(this.def.pgType);
    b.def = { ...this.def, reference: this.def.reference ? { ...this.def.reference } : null };
    return b;
  }

  primaryKey(): ColumnBuilder {
    const b = this.clone();
    b.def.isPrimaryKey = true;
    b.def.isNullable = false;
    return b;
  }

  notNull(): ColumnBuilder {
    const b = this.clone();
    b.def.isNullable = false;
    return b;
  }

  nullable(): ColumnBuilder {
    const b = this.clone();
    b.def.isNullable = true;
    return b;
  }

  default(sqlExpr: string): ColumnBuilder {
    const b = this.clone();
    b.def.defaultExpr = sqlExpr;
    return b;
  }

  unique(): ColumnBuilder {
    const b = this.clone();
    b.def.isUnique = true;
    return b;
  }

  references(
    tableName: string,
    column: string,
    opts?: Partial<Pick<ForeignKeyRef, 'onDelete' | 'onUpdate'>>
  ): ColumnBuilder {
    const b = this.clone();
    b.def.reference = {
      table: tableName,
      column,
      onDelete: opts?.onDelete ?? 'NO ACTION',
      onUpdate: opts?.onUpdate ?? 'NO ACTION',
    };
    return b;
  }

  generatedAs(expression: string, mode: 'STORED' = 'STORED'): ColumnBuilder {
    const b = this.clone();
    b.def.generatedAs = { expression, stored: mode === 'STORED' };
    b.def.isNullable = false;
    return b;
  }

  comment(text: string): ColumnBuilder {
    const b = this.clone();
    b.def.comment = text;
    return b;
  }

  /** Mark this column as a rename of an existing live column. Remove the hint after applying. */
  renamedFrom(oldName: string): ColumnBuilder {
    const b = this.clone();
    b.def.renamedFrom = oldName;
    return b;
  }

  build(): ColumnDef {
    return { ...this.def };
  }
}

// ─── col factory ─────────────────────────────────────────────────────────────

export const col = {
  uuid(): ColumnBuilder          { return new ColumnBuilder('UUID'); },
  text(): ColumnBuilder          { return new ColumnBuilder('TEXT'); },
  boolean(): ColumnBuilder       { return new ColumnBuilder('BOOLEAN'); },
  integer(): ColumnBuilder       { return new ColumnBuilder('INTEGER'); },
  bigint(): ColumnBuilder        { return new ColumnBuilder('BIGINT'); },
  smallint(): ColumnBuilder      { return new ColumnBuilder('SMALLINT'); },
  decimal(precision: number, scale: number): ColumnBuilder {
    return new ColumnBuilder(`DECIMAL(${precision},${scale})`);
  },
  numeric(precision?: number, scale?: number): ColumnBuilder {
    if (precision !== undefined && scale !== undefined) {
      return new ColumnBuilder(`NUMERIC(${precision},${scale})`);
    }
    return new ColumnBuilder('NUMERIC');
  },
  real(): ColumnBuilder          { return new ColumnBuilder('REAL'); },
  doublePrecision(): ColumnBuilder { return new ColumnBuilder('DOUBLE PRECISION'); },
  date(): ColumnBuilder          { return new ColumnBuilder('DATE'); },
  time(): ColumnBuilder          { return new ColumnBuilder('TIME'); },
  timestamp(): ColumnBuilder     { return new ColumnBuilder('TIMESTAMP'); },
  timestamptz(): ColumnBuilder   { return new ColumnBuilder('TIMESTAMPTZ'); },
  interval(): ColumnBuilder      { return new ColumnBuilder('INTERVAL'); },
  inet(): ColumnBuilder          { return new ColumnBuilder('INET'); },
  bytea(): ColumnBuilder         { return new ColumnBuilder('BYTEA'); },
  jsonb(): ColumnBuilder         { return new ColumnBuilder('JSONB'); },
  textArray(): ColumnBuilder     { return new ColumnBuilder('TEXT[]'); },
  varchar(length: number): ColumnBuilder { return new ColumnBuilder(`VARCHAR(${length})`); },
  enum(typeName: string): ColumnBuilder  { return new ColumnBuilder(typeName); },
};

// ─── TableBuilder ─────────────────────────────────────────────────────────────

export class TableBuilder {
  private name: string;
  private columnDefs: Record<string, ColumnBuilder>;
  private _indexes: IndexDef[] = [];
  private _checks: CheckDef[] = [];
  private _rlsPolicy: RlsPolicy = 'standard';
  private _comment: string | null = null;
  private _renamedFrom: string | null = null;

  constructor(name: string, columns: Record<string, ColumnBuilder>) {
    this.name = name;
    this.columnDefs = columns;
  }

  indexes(defs: IndexDef[]): TableBuilder {
    this._indexes = defs;
    return this;
  }

  checks(defs: CheckDef[]): TableBuilder {
    this._checks = defs;
    return this;
  }

  rls(policy: RlsPolicy): TableBuilder {
    this._rlsPolicy = policy;
    return this;
  }

  comment(text: string): TableBuilder {
    this._comment = text;
    return this;
  }

  /** Mark this table as a rename of an existing live table. Remove the hint after applying. */
  renamedFrom(oldName: string): TableBuilder {
    this._renamedFrom = oldName;
    return this;
  }

  build(): TableDef {
    const columns: Record<string, ColumnDef> = {};
    for (const [name, builder] of Object.entries(this.columnDefs)) {
      columns[name] = builder.build();
    }
    return {
      tableName: this.name,
      columns,
      indexes: this._indexes,
      checks: this._checks,
      rlsPolicy: this._rlsPolicy,
      comment: this._comment,
      renamedFrom: this._renamedFrom,
    };
  }
}

// ─── Public API — tables/enums ─────────────────────────────────────────────────

export function table(
  name: string,
  columns: Record<string, ColumnBuilder>
): TableBuilder {
  return new TableBuilder(name, columns);
}

export function enumType(typeName: string, values: string[]): EnumDef {
  return { typeName, values };
}

export interface DefineSchemaOptions {
  /**
   * Required table-name prefix(es). Pass false to disable validation.
   * Unset = no validation here (a config-level tablePrefix may still validate).
   */
  tablePrefix?: string | string[] | false;
  /** Legacy alias for tablePrefix: false. */
  rawTableNames?: boolean;
}

export function defineSchema(
  moduleId: string,
  tables: TableBuilder[],
  enums?: EnumDef[],
  opts?: DefineSchemaOptions
): ModuleSchema {
  const builtTables = tables.map((tb) => tb.build());

  const prefixOpt = opts?.rawTableNames ? false : opts?.tablePrefix;
  if (prefixOpt !== undefined && prefixOpt !== false) {
    const prefixes = Array.isArray(prefixOpt) ? prefixOpt : [prefixOpt];
    for (const t of builtTables) {
      if (!prefixes.some((p) => t.tableName.startsWith(p))) {
        throw new Error(
          `Table "${t.tableName}" in module "${moduleId}" must start with one of: ${prefixes.join(', ')}`
        );
      }
    }
  }

  return {
    moduleId,
    tables: builtTables,
    enums: enums ?? [],
  };
}

// ─── Public API — functions ───────────────────────────────────────────────────

export function defineFunction(
  name: string,
  def: {
    args?: FunctionArg[];
    returns: string;
    language?: FunctionLanguage;
    security?: FunctionSecurity;
    volatility?: FunctionVolatility;
    body: string;
  }
): FunctionDef {
  return {
    name,
    args: def.args ?? [],
    returns: def.returns,
    language: def.language ?? 'plpgsql',
    security: def.security ?? 'INVOKER',
    volatility: def.volatility ?? 'VOLATILE',
    body: def.body,
  };
}

// ─── Public API — triggers ────────────────────────────────────────────────────

export function defineTrigger(
  name: string,
  def: {
    table: string;
    timing: TriggerTiming;
    events: TriggerEvent[];
    columns?: string[];
    forEach?: TriggerForEach;
    function: string;
    when?: string;
  }
): TriggerDef {
  return {
    name,
    table: def.table,
    timing: def.timing,
    events: def.events,
    columns: def.columns,
    forEach: def.forEach ?? 'ROW',
    function: def.function,
    when: def.when,
  };
}

// ─── Public API — policies ────────────────────────────────────────────────────

export function definePolicy(
  name: string,
  def: {
    table: string;
    for?: PolicyCmd;
    to: string | string[];
    using?: string;
    withCheck?: string;
    permissive?: boolean;
  }
): PolicyDef {
  return {
    name,
    table: def.table,
    for: def.for ?? 'ALL',
    to: def.to,
    using: def.using,
    withCheck: def.withCheck,
    permissive: def.permissive ?? true,
  };
}
