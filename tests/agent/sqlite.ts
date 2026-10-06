import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlRow, SqlValue } from "../../src/agent/sql";

/** A fresh in-memory SQLite database behind the same interface the Durable Object uses. */
export function memoryDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    sql: {
      exec<T extends SqlRow = SqlRow>(query: string, ...bindings: SqlValue[]) {
        const rows = db.prepare(query).all(...bindings) as unknown as T[];
        return { toArray: () => rows };
      },
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth += 1;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth -= 1;
      }
    },
  };
}
