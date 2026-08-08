export interface DbResultLike<T = Record<string, unknown>> {
  results: T[];
  success?: boolean;
  meta?: Record<string, unknown>;
}

export interface DbPreparedStatementLike {
  bind(...values: unknown[]): DbPreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResultLike<T>>;
  run(): Promise<unknown>;
}

export interface DbDatabaseLike {
  prepare(sql: string): DbPreparedStatementLike;
  withSession?(mode?: string): DbDatabaseLike;
  batch?(statements: DbPreparedStatementLike[]): Promise<DbResultLike<unknown>[]>;
}
