import type { SqlDb, SqlRow, SqlValue } from "../../agent/sql";

/** The slice of DurableObjectStorage used here (so Node tests can fake it). */
export interface StorageLike {
  sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] } };
  transactionSync<T>(fn: () => T): T;
}

/**
 * ctx.storage → the SqlDb port. The cursor is read straight away, so writes run now (same as node:sqlite in tests).
 * Transactions are re-entrant: only the outermost level opens one; an inner level just runs, and a throw anywhere
 * propagates to the outermost level, which rolls everything back.
 */
export function cfDb(storage: StorageLike): SqlDb {
  let depth = 0;
  return {
    sql: {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) {
        const rows = storage.sql.exec(query, ...bindings).toArray() as T[];
        return { toArray: () => rows };
      },
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      return storage.transactionSync(() => {
        depth += 1;
        try {
          return fn();
        } finally {
          depth -= 1;
        }
      });
    },
  };
}
