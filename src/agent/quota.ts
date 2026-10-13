import type { SqlDb } from "./sql";

/** Workers AI free tier is 10,000 neurons/day; we stop at 8,000 to stay clear of it. */
export const DAILY_NEURON_BUDGET = 8000;
/** The public's share of that: the rest is kept for shows made through a judge link. */
export const PUBLIC_NEURON_BUDGET = 5000;

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

/** What the router needs from the Quota Durable Object. */
export interface QuotaPort {
  hit(key: string, limit: number, windowMs: number): Promise<RateResult>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** One singleton store for the AI budget and the per-visitor rate limits (fixed windows). */
export class Quota {
  constructor(private readonly db: SqlDb) {}

  migrate(): void {
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS ai_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL)");
    this.db.sql.exec("CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL)");
  }

  neuronsUsed(now: number): number {
    return this.db.sql.exec<{ used: number }>("SELECT used FROM ai_budget WHERE day = ?", utcDay(now)).toArray()[0]?.used ?? 0;
  }

  /** Reserves `cost` neurons for today if that stays within `limit`. Hard limit: never goes over. */
  reserveNeurons(now: number, cost: number, limit = DAILY_NEURON_BUDGET): boolean {
    if (!Number.isInteger(cost) || cost <= 0) throw new RangeError("cost must be a positive whole number of neurons");
    return this.db.transaction(() => {
      const day = utcDay(now);
      const used = this.neuronsUsed(now);
      if (used + cost > limit) return false;
      this.db.sql.exec("INSERT INTO ai_budget (day, used) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET used = excluded.used", day, used + cost);
      this.db.sql.exec("DELETE FROM ai_budget WHERE day < ?", day);
      return true;
    });
  }

  hit(key: string, limit: number, windowMs: number, now: number): RateResult {
    return this.db.transaction(() => {
      const row = this.db.sql.exec<{ window_start: number; count: number }>("SELECT window_start, count FROM rate WHERE key = ?", key).toArray()[0];
      const fresh = row === undefined || now - row.window_start >= windowMs;
      const start = row === undefined || fresh ? now : row.window_start;
      const count = row === undefined || fresh ? 0 : row.count;
      if (count >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
      this.db.sql.exec("INSERT INTO rate (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count", key, start, count + 1);
      this.db.sql.exec("DELETE FROM rate WHERE window_start < ?", now - 2 * DAY_MS);
      return { ok: true, retryAfterSec: 0 };
    });
  }
}

export type QuotaOp = { op: "reserve"; neurons: number; judge?: boolean } | { op: "hit"; key: string; limit: number; windowMs: number } | { op: "used"; judge?: boolean };

export function quotaDispatch(q: Quota, op: QuotaOp, now: number): unknown {
  switch (op.op) {
    case "reserve":
      return { ok: q.reserveNeurons(now, op.neurons, op.judge === true ? DAILY_NEURON_BUDGET : PUBLIC_NEURON_BUDGET) };
    case "hit":
      return q.hit(op.key, op.limit, op.windowMs, now);
    case "used": {
      // The view of one kind of visitor: the public one unless `judge`, so "resting" is true for the caller asking.
      const used = q.neuronsUsed(now);
      const limit = op.judge === true ? DAILY_NEURON_BUDGET : PUBLIC_NEURON_BUDGET;
      return { used, limit, restingUntil: used >= limit ? new Date(nextUtcMidnight(now)).toISOString() : null };
    }
  }
}
