/** Values both Cloudflare's SqlStorage and node:sqlite accept and return (we never store blobs). */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlCursor<T> {
  toArray(): T[];
}

/** The slice of Cloudflare's `ctx.storage.sql` this project uses. Tests adapt node:sqlite to it. */
export interface SqlLike {
  exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

/** SQL plus an all-or-nothing wrapper (Cloudflare: ctx.storage.transactionSync; tests: BEGIN/COMMIT). */
export interface SqlDb {
  sql: SqlLike;
  transaction<T>(fn: () => T): T;
}
