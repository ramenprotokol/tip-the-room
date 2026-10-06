import type { RuleId } from "../core/rules";
import { eventKey, type AiSource, type LedgerEvent } from "./events";
import { applyEvent, emptyProjection, type Projection } from "./project";
import type { SqlDb, SqlValue } from "./sql";

/** An event names an authorization, pledge or capture the ledger has no record of. Nothing was written. */
export class UnknownLedgerReference extends Error {
  constructor(type: string, ref: string) {
    super(`Cannot record ${type}: the ledger has no record of ${ref}`);
    this.name = "UnknownLedgerReference";
  }
}

export interface StoredEvent {
  seq: number;
  key: string;
  at: number;
  event: LedgerEvent;
}

export type JobKind = "capture" | "void" | "refund" | "reconcile" | "payout" | "payout_retry" | "payout_poll" | "sim_hold" | "rehold";
export type JobStatus = "pending" | "done" | "failed" | "skipped" | "blocked";

export interface Job {
  key: string;
  kind: JobKind;
  /** The PayPal id or pledge id the job acts on. */
  target: string;
  status: JobStatus;
  attempts: number;
  nextAt: number;
  note: string;
  createdAt: number;
}

export interface NewJob {
  key: string;
  kind: JobKind;
  target: string;
  nextAt: number;
  note?: string;
}

/** One agent-log line: what it saw, what it proposed or did, which rule allowed it, and PayPal's request/result ids. */
export interface LogEntry {
  at: number;
  saw: string;
  did: string;
  rule: RuleId | null;
  requestId: string | null;
  resultId: string | null;
  source: AiSource | "code";
}

export interface LoggedEntry extends LogEntry {
  seq: number;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, next_at)",
  "CREATE TABLE IF NOT EXISTS agent_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, saw TEXT NOT NULL, did TEXT NOT NULL, rule TEXT, request_id TEXT, result_id TEXT, source TEXT NOT NULL)",
];

type JobRow = { key: string; kind: string; target: string; status: string; attempts: number; next_at: number; note: string; created_at: number };
const JOB_COLUMNS = "key, kind, target, status, attempts, next_at, note, created_at";

function toJob(r: JobRow): Job {
  return { key: r.key, kind: r.kind as JobKind, target: r.target, status: r.status as JobStatus, attempts: r.attempts, nextAt: r.next_at, note: r.note, createdAt: r.created_at };
}

/**
 * The campaign's storage. Events are append-only: there is no update or delete for them.
 * The projection is cached in memory and advanced with new events only.
 */
export class Store {
  private cache: Projection = emptyProjection();
  private cacheSeq = 0;

  constructor(private readonly db: SqlDb) {}

  migrate(): void {
    for (const statement of SCHEMA) this.db.sql.exec(statement);
  }

  /** True once this storage holds a show (an unknown id must never create tables). */
  exists(): boolean {
    try {
      return this.getMeta("show_id") !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Runs fn atomically. On any error the cached projection is dropped: SQLite rolls back the AUTOINCREMENT
   * counter too, so a rolled-back event's seq is reused and the cache could otherwise stay ahead of the table.
   */
  transaction<T>(fn: () => T): T {
    try {
      return this.db.transaction(fn);
    } catch (e) {
      this.resetProjection();
      throw e;
    }
  }

  getMeta(key: string): string | undefined {
    return this.db.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  deleteMeta(key: string): void {
    this.db.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  hasEvent(key: string): boolean {
    return this.db.sql.exec("SELECT 1 AS x FROM events WHERE key = ?", key).toArray().length > 0;
  }

  /** Appends once per deterministic key. Returns false (and writes nothing) when the key already exists. */
  appendEvent(at: number, event: LedgerEvent): boolean {
    const key = eventKey(event);
    if (this.hasEvent(key)) return false;
    this.assertKnownReference(event);
    this.db.sql.exec("INSERT INTO events (key, at, type, data) VALUES (?, ?, ?, ?)", key, at, event.type, JSON.stringify(event));
    return true;
  }

  /** An event about a hold or pledge we never recorded would use up its key and be ignored: refuse it before writing. */
  private assertKnownReference(e: LedgerEvent): void {
    this.advance();
    const p = this.cache;
    switch (e.type) {
      case "capture_ok":
      case "capture_failed":
        if (!p.pledgeByAuth.has(e.authorizationId)) throw new UnknownLedgerReference(e.type, e.authorizationId);
        break;
      case "void_ok":
        if (!p.pledgeByAuth.has(e.authorizationId) && !p.retired.has(e.authorizationId)) throw new UnknownLedgerReference(e.type, e.authorizationId);
        break;
      case "hold_replaced":
        if (!p.pledges.has(e.pledgeId)) throw new UnknownLedgerReference(e.type, e.pledgeId);
        break;
      case "refund_ok":
        if (!p.pledgeByCapture.has(e.captureId)) throw new UnknownLedgerReference(e.type, e.captureId);
        break;
      default:
        break;
    }
  }

  events(): StoredEvent[] {
    return this.eventsAfter(0);
  }

  eventsAfter(seq: number): StoredEvent[] {
    return this.db.sql
      .exec<{ seq: number; key: string; at: number; data: string }>("SELECT seq, key, at, data FROM events WHERE seq > ? ORDER BY seq", seq)
      .toArray()
      .map((r) => ({ seq: r.seq, key: r.key, at: r.at, event: JSON.parse(r.data) as LedgerEvent }));
  }

  /** The current state, rebuilt from the events (incrementally). Returns a copy: mutating it never touches the cache. */
  projection(): Projection {
    this.advance();
    return structuredClone(this.cache);
  }

  private advance(): void {
    try {
      for (const s of this.eventsAfter(this.cacheSeq)) {
        applyEvent(this.cache, s);
        this.cacheSeq = s.seq;
      }
    } catch (e) {
      this.resetProjection();
      throw e;
    }
  }

  /** Forget the cached state (after a rolled-back transaction); the next projection() replays every event. */
  resetProjection(): void {
    this.cache = emptyProjection();
    this.cacheSeq = 0;
  }

  /** Inserts a pending job once per key. Returns false when the key already exists (whatever its status). */
  putJob(job: NewJob, now: number): boolean {
    if (this.job(job.key)) return false;
    this.db.sql.exec(
      "INSERT INTO jobs (key, kind, target, status, attempts, next_at, note, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)",
      job.key,
      job.kind,
      job.target,
      job.nextAt,
      (job.note ?? "").slice(0, 500),
      now,
    );
    return true;
  }

  job(key: string): Job | undefined {
    const row = this.db.sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE key = ?`, key).toArray()[0];
    return row ? toJob(row) : undefined;
  }

  jobs(): Job[] {
    return this.db.sql.exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY rowid`).toArray().map(toJob);
  }

  dueJobs(now: number, limit: number): Job[] {
    return this.db.sql
      .exec<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'pending' AND next_at <= ? ORDER BY next_at, rowid LIMIT ?`, now, limit)
      .toArray()
      .map(toJob);
  }

  hasPending(kinds: JobKind[]): boolean {
    if (kinds.length === 0) return false;
    const marks = kinds.map(() => "?").join(", ");
    return this.db.sql.exec(`SELECT 1 AS x FROM jobs WHERE status = 'pending' AND kind IN (${marks}) LIMIT 1`, ...kinds).toArray().length > 0;
  }

  nextJobAt(): number | undefined {
    const t = this.db.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM jobs WHERE status = 'pending'").toArray()[0]?.t;
    return t === null || t === undefined ? undefined : t;
  }

  updateJob(key: string, patch: { status?: JobStatus; attempts?: number; nextAt?: number; note?: string }): void {
    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.attempts !== undefined) {
      sets.push("attempts = ?");
      values.push(patch.attempts);
    }
    if (patch.nextAt !== undefined) {
      sets.push("next_at = ?");
      values.push(patch.nextAt);
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      values.push(patch.note.slice(0, 500));
    }
    if (sets.length === 0) return;
    this.db.sql.exec(`UPDATE jobs SET ${sets.join(", ")} WHERE key = ?`, ...values, key);
  }

  log(entry: LogEntry): void {
    this.db.sql.exec(
      "INSERT INTO agent_log (at, saw, did, rule, request_id, result_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at,
      entry.saw.slice(0, 600),
      entry.did.slice(0, 600),
      entry.rule,
      entry.requestId,
      entry.resultId,
      entry.source,
    );
  }

  logs(): LoggedEntry[] {
    return this.db.sql
      .exec<{ seq: number; at: number; saw: string; did: string; rule: string | null; request_id: string | null; result_id: string | null; source: string }>(
        "SELECT seq, at, saw, did, rule, request_id, result_id, source FROM agent_log ORDER BY seq",
      )
      .toArray()
      .map((r) => ({ seq: r.seq, at: r.at, saw: r.saw, did: r.did, rule: r.rule as RuleId | null, requestId: r.request_id, resultId: r.result_id, source: r.source as LogEntry["source"] }));
  }
}
