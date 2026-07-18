import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The package's entire DB interface. The default implementation calls the
 * exec_sql / query_sql RPCs installed by `supaorm bootstrap`. An alternative
 * executor (e.g. direct pg connection) can be swapped in without touching
 * the rest of the library.
 */
export interface SqlExecutor {
  /** Execute one or more SQL statements. No result. One call = one transaction. */
  exec(sql: string): Promise<void>;
  /** Run a SELECT and return rows as JSON objects. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

export interface RpcExecutorOptions {
  /** RPC name for statement execution. Default 'exec_sql'. */
  execFn?: string;
  /** RPC name for querying. Default 'query_sql'. */
  queryFn?: string;
}

export class SqlExecutionError extends Error {
  constructor(message: string, public readonly sql: string) {
    super(message);
    this.name = 'SqlExecutionError';
  }
}

export function createRpcExecutor(
  supabase: SupabaseClient,
  opts?: RpcExecutorOptions
): SqlExecutor {
  const execFn = opts?.execFn ?? 'exec_sql';
  const queryFn = opts?.queryFn ?? 'query_sql';

  return {
    async exec(sql: string): Promise<void> {
      const { error } = await supabase.rpc(execFn, { sql });
      if (error) throw new SqlExecutionError(error.message, sql);
    },

    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const { data, error } = await supabase.rpc(queryFn, { sql });
      if (error) throw new SqlExecutionError(error.message, sql);
      return (data ?? []) as T[];
    },
  };
}
