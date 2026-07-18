// Minimal typed CRUD helper over supabase-js. Type parameters bind to the
// TablesMap shape emitted by `generateTypes()` (see schema/type-generator.ts).
import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';

export interface TableTypes {
  Row: unknown;
  Insert: unknown;
  Update: unknown;
}

export type TablesMap = Record<string, TableTypes>;

export class SupaormError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SupaormError';
  }
}

function fail(context: string, error: PostgrestError): never {
  throw new SupaormError(`${context} failed: ${error.message}`, error);
}

export interface FindManyOptions<Row> {
  eq?: Partial<Row>;
  order?: (keyof Row & string) | [keyof Row & string, { ascending?: boolean }][];
  limit?: number;
  offset?: number;
}

/** What `client.from(tableName)` returns — the raw escape hatch's type. */
export type QueryBuilder = ReturnType<SupabaseClient<any>['from']>;

export interface Repository<T extends TableTypes> {
  findById(id: string): Promise<T['Row'] | null>;
  findMany(opts?: FindManyOptions<T['Row']>): Promise<T['Row'][]>;
  insert(data: T['Insert']): Promise<T['Row']>;
  insertMany(rows: T['Insert'][]): Promise<T['Row'][]>;
  update(id: string, patch: T['Update']): Promise<T['Row']>;
  delete(id: string): Promise<void>;
  /** Raw typed `client.from(tableName)` escape hatch for anything this helper doesn't cover. */
  query(): QueryBuilder;
}

export function createRepository<Tables extends TablesMap, K extends keyof Tables & string>(
  client: SupabaseClient<any>,
  tableName: K
): Repository<Tables[K]> {
  type Row = Tables[K]['Row'];
  type Insert = Tables[K]['Insert'];
  type Update = Tables[K]['Update'];

  return {
    async findById(id: string): Promise<Row | null> {
      const { data, error } = await client.from(tableName).select('*').eq('id', id).maybeSingle();
      if (error) fail(`findById(${tableName})`, error);
      return (data ?? null) as Row | null;
    },

    async findMany(opts?: FindManyOptions<Row>): Promise<Row[]> {
      let q = client.from(tableName).select('*');

      if (opts?.eq) {
        for (const [key, value] of Object.entries(opts.eq)) {
          q = q.eq(key, value);
        }
      }

      if (opts?.order !== undefined) {
        if (Array.isArray(opts.order)) {
          for (const [col, ord] of opts.order) {
            q = q.order(col, ord);
          }
        } else {
          q = q.order(opts.order);
        }
      }

      // range()-based pagination: an explicit offset always pairs with a
      // window (defaulting to a generous 1000 rows if no limit is given).
      if (opts?.limit !== undefined || opts?.offset !== undefined) {
        const from = opts.offset ?? 0;
        const to = opts.limit !== undefined ? from + opts.limit - 1 : from + 999;
        q = q.range(from, to);
      }

      const { data, error } = await q;
      if (error) fail(`findMany(${tableName})`, error);
      return (data ?? []) as Row[];
    },

    async insert(data: Insert): Promise<Row> {
      const { data: row, error } = await client.from(tableName).insert(data).select().single();
      if (error) fail(`insert(${tableName})`, error);
      return row as Row;
    },

    async insertMany(rows: Insert[]): Promise<Row[]> {
      const { data, error } = await client.from(tableName).insert(rows).select();
      if (error) fail(`insertMany(${tableName})`, error);
      return (data ?? []) as Row[];
    },

    async update(id: string, patch: Update): Promise<Row> {
      const { data, error } = await client.from(tableName).update(patch).eq('id', id).select().single();
      if (error) fail(`update(${tableName})`, error);
      return data as Row;
    },

    async delete(id: string): Promise<void> {
      const { error } = await client.from(tableName).delete().eq('id', id);
      if (error) fail(`delete(${tableName})`, error);
    },

    query(): QueryBuilder {
      return client.from(tableName);
    },
  };
}

// ─── MergeDatabases ────────────────────────────────────────────────────────────

type DbTables<D> = D extends { public: { Tables: infer T } } ? T : never;
type DbEnums<D> = D extends { public: { Enums: infer E } } ? E : never;

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I
) => void
  ? I
  : never;

/**
 * Intersects the `public.Tables` and `public.Enums` of multiple generated
 * `*Database` types (as emitted by `generateTypes()`) into a single
 * Database-shaped type, so a single supabase-js client can be typed across
 * every module sharing one Supabase project.
 *
 * Type-level only — there is no runtime component.
 *
 * @example
 * ```ts
 * import type { FinDatabase } from '../modules/fin/types/generated.js';
 * import type { PmDatabase } from '../modules/pm/types/generated.js';
 *
 * type AppDatabase = MergeDatabases<[FinDatabase, PmDatabase]>;
 * const client = createClient<AppDatabase>(url, key);
 * ```
 */
export type MergeDatabases<Dbs extends readonly unknown[]> = {
  public: {
    Tables: UnionToIntersection<DbTables<Dbs[number]>>;
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: UnionToIntersection<DbEnums<Dbs[number]>>;
    CompositeTypes: { [_ in never]: never };
  };
};
