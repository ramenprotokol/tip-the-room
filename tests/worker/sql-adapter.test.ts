import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cfDb, type StorageLike } from "../../src/worker/do/sql-adapter";

/** A fake of ctx.storage: node:sqlite with transactionSync that does NOT support nesting, like the worst case. */
function fakeStorage(): StorageLike {
  const db = new DatabaseSync(":memory:");
  let open = false;
  return {
    sql: { exec: (q, ...b) => ({ toArray: () => db.prepare(q).all(...b) }) },
    transactionSync<T>(fn: () => T): T {
      if (open) throw new Error("nested transactionSync is not allowed in this fake");
      open = true;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        open = false;
      }
    },
  };
}

function setup() {
  const db = cfDb(fakeStorage());
  db.sql.exec("CREATE TABLE t (n INTEGER)");
  const count = () => (db.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM t").toArray()[0] as { c: number }).c;
  return { db, count };
}

describe("cfDb transactions", () => {
  it("runs a nested transaction and commits once", () => {
    const { db, count } = setup();
    db.transaction(() => {
      db.sql.exec("INSERT INTO t VALUES (1)");
      db.transaction(() => db.sql.exec("INSERT INTO t VALUES (2)"));
    });
    expect(count()).toBe(2);
  });

  it("rolls the whole thing back when the inner level throws", () => {
    const { db, count } = setup();
    expect(() =>
      db.transaction(() => {
        db.sql.exec("INSERT INTO t VALUES (1)");
        db.transaction(() => {
          db.sql.exec("INSERT INTO t VALUES (2)");
          throw new Error("boom");
        });
      }),
    ).toThrow("boom");
    expect(count()).toBe(0);
  });

  it("works again after a rollback", () => {
    const { db, count } = setup();
    expect(() => db.transaction(() => { throw new Error("x"); })).toThrow();
    db.transaction(() => db.sql.exec("INSERT INTO t VALUES (1)"));
    expect(count()).toBe(1);
  });
});
