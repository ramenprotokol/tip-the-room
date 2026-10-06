// Summarises a log of `wrangler tail --format json` (live) or .wrangler/worker-check.log (local):
// Durable Object invocations and rows written (the "do_rows" lines), and the status of every PayPal webhook delivery.
// Run: node --import tsx scripts/tail-report.ts <log file> [demo copies in the run]
import { readFileSync } from "node:fs";

const [file, copiesArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: tail-report.ts <log file> [demo copies in the run]");
  process.exit(2);
}
const text = readFileSync(file, "utf8");

// 1. Durable Object rows and requests.
const byOp = new Map<string, { calls: number; rows: number }>();
let calls = 0;
let rows = 0;
for (const m of text.matchAll(/do_rows do=(campaign|quota) kind=(fetch|alarm) op=([a-z_]+) rows=(\d+)/g)) {
  const k = `${m[1]} ${m[2]} ${m[3]}`;
  const n = Number(m[4]);
  const e = byOp.get(k) ?? { calls: 0, rows: 0 };
  e.calls += 1;
  e.rows += n;
  byOp.set(k, e);
  calls += 1;
  rows += n;
}
console.log(`Durable Objects: ${calls} invocations, ${rows} rows written`);
for (const [k, e] of [...byOp].sort((a, b) => b[1].rows - a[1].rows)) {
  console.log(`  ${k.padEnd(34)} ${String(e.calls).padStart(6)} calls ${String(e.rows).padStart(8)} rows`);
}

// 2. Tail events (JSON objects, possibly pretty-printed): time span and webhook statuses.
function objects(s: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(s.slice(start, i + 1)));
        } catch {
          // not an event
        }
        start = -1;
      }
    }
  }
  return out;
}
type TailEvent = { eventTimestamp?: number; event?: { request?: { url?: string }; response?: { status?: number } } };
const events = objects(text) as TailEvent[];
const times = events.map((e) => e.eventTimestamp).filter((t): t is number => typeof t === "number");
if (times.length > 1) {
  const hours = (times.reduce((a, b) => Math.max(a, b)) - times.reduce((a, b) => Math.min(a, b))) / 3_600_000;
  if (hours > 0) console.log(`Span ${hours.toFixed(2)} h -> ${(calls / hours).toFixed(0)} DO invocations/h, ${(rows / hours).toFixed(0)} rows/h`);
}
const hooks = new Map<number, number>();
for (const e of events) {
  const url = e.event?.request?.url ?? "";
  if (!url.includes("/api/webhooks/paypal")) continue;
  const status = e.event?.response?.status ?? 0;
  hooks.set(status, (hooks.get(status) ?? 0) + 1);
}
console.log(hooks.size ? `Webhooks: ${[...hooks].map(([s, n]) => `${n} x ${s}`).join(", ")}` : "Webhooks: none in this log");

// 3. Budget estimate.
const copies = Number(copiesArg ?? "0");
if (copies > 0 && rows > 0) {
  const per = Math.ceil(rows / copies);
  console.log(`~${per} rows per demo copy -> ${Math.floor((100_000 * 0.8) / per)} copies/day fit in 80% of the 100,000 rows/day free limit`);
}
