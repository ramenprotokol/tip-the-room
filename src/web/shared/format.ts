// Pure formatting and show maths shared by the pages (Node-testable: no DOM).
import type { CampaignState } from "../../core/campaign";
import { RULES } from "../../core/rules";
import type { Role } from "../../core/split";
import type { AgentLogDto, PublicParty } from "../../worker/api-types";

export const toMs = (v: string | number): number => (typeof v === "number" ? v : Date.parse(v));

interface Parts { wd: string; mon: string; day: number; hour: number; minute: number; pm: boolean }
const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    formats.set(tz, f);
  }
  return f;
}
function parts(ms: number, tz: string): Parts {
  let f: Intl.DateTimeFormat;
  try {
    f = formatFor(tz);
  } catch {
    f = formatFor("UTC");
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { wd: p.weekday, mon: p.month, day: Number(p.day), hour: Number(p.hour) % 12 || 12, minute: Number(p.minute), pm: String(p.dayPeriod).toUpperCase() === "PM" };
}
const clock = (x: Parts, minutes: boolean) => `${x.hour}${minutes || x.minute ? `:${String(x.minute).padStart(2, "0")}` : ""}${x.pm ? "pm" : "am"}`;

export type WhenStyle = "long" | "faq" | "short" | "log" | "ledger";
/** long "Thu Nov 12, 6:00pm" · faq "Thu Nov 12, 6pm" · short "Thu 6pm" · log "Mon 9:11am" · ledger "Nov 3 · 7:12pm". */
export function when(ms: number, tz: string, style: WhenStyle): string {
  const x = parts(ms, tz);
  switch (style) {
    case "long":
      return `${x.wd} ${x.mon} ${x.day}, ${clock(x, true)}`;
    case "faq":
      return `${x.wd} ${x.mon} ${x.day}, ${clock(x, false)}`;
    case "short":
      return `${x.wd} ${clock(x, false)}`;
    case "log":
      return `${x.wd} ${clock(x, true)}`;
    case "ledger":
      return `${x.mon} ${x.day} · ${clock(x, true)}`;
  }
}

/** "2026-11-20" → "Fri Nov 20". */
export function dayLabel(date: string): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  const x = parts(ms, "UTC");
  return `${x.wd} ${x.mon} ${x.day}`;
}

const RESTING_TAIL = " It still follows the money rules you signed; its notes use standard wording until then.";
/** Fallback when the show's time zone is unknown: no clock time, and never UTC/GMT on screen (spec 2c). */
export const RESTING_LINE = `The agent’s AI is resting until its free daily limit resets (within 24 hours).${RESTING_TAIL}`;

/** The next 00:00 UTC after `now`, in ms (when the free daily AI limit resets). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** "5:00 PM PDT" in the show's own zone, or null if the zone is unknown or only has a UTC/GMT name. */
function zoneClock(ms: number, tz: string): string | null {
  try {
    const out = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(ms)).replace(/\u202f/g, " ");
    return /UTC|GMT/.test(out) ? null : out;
  } catch {
    return null;
  }
}

/** The resting notice, with the reset time in the show's time zone (never UTC/GMT on screen). */
export function restingLine(now: number, tz?: string | null): string {
  const at = tz ? zoneClock(nextUtcMidnight(now), tz) : null;
  return at ? `The agent’s AI is resting until ${at} (its free daily limit).${RESTING_TAIL}` : RESTING_LINE;
}

/** Spec 5: true when the newest line the AI should have written fell back to "resting" (the daily budget is spent). */
export function aiResting(log: Pick<AgentLogDto, "seq" | "source">[]): boolean {
  let newest: Pick<AgentLogDto, "seq" | "source"> | null = null;
  for (const l of log) if (l.source !== "code" && (!newest || l.seq > newest.seq)) newest = l;
  return newest?.source === "resting";
}

/** Whole dollars, like ui.ts usd(): 31500 → "$315". */
export const dollars = (cents: number): string => "$" + Math.round(cents / 100).toLocaleString("en-US");
/** Ledger amounts: 1500 → "$15.00". */
export const money2 = (cents: number): string => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const ROLE_WORD: Record<Role, string> = { room: "Room", opener: "Opener", host: "Host", artist: "Artist" };

/** "a", "a and b", "a, b and c". */
export function andList(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Cents per party in signed order: fixed parties first, each capped by what's left; the artist gets the rest. */
export function planSplit(split: Pick<PublicParty, "role" | "fixedCents">[], grossCents: number): number[] {
  let rest = Math.max(0, grossCents);
  return split.map((p) => {
    const v = p.role === "artist" ? rest : Math.min(p.fixedCents ?? 0, rest);
    rest -= v;
    return v;
  });
}

/** "Money rules: Room $80 → Opener $100 → Artist gets the rest". */
export function rulesLine(split: PublicParty[]): string {
  const fixed = split.filter((p) => p.role !== "artist").map((p) => `${ROLE_WORD[p.role]} ${dollars(p.fixedCents ?? 0)}`);
  return `Money rules: ${[...fixed, "Artist gets the rest"].join(" → ")}`;
}

/** The agent log's small print: what it saw · which rule · PayPal request and result ids. */
export function fineLine(d: Pick<AgentLogDto, "saw" | "rule" | "requestId" | "resultId">): string {
  const rule = d.rule && RULES[d.rule] ? `money rule ${RULES[d.rule].number}` : "";
  return [d.saw, rule, d.requestId ?? "", d.resultId ?? ""].filter((s) => typeof s === "string" && s.trim() !== "").join(" · ");
}

export interface Seg {
  text: string;
  cls: "" | "b" | "w-ask" | "w-held" | "w-paid" | "w-rel";
}
type Rule = [RegExp, Seg["cls"], boolean];
/** Status phrases the log highlights (the reference's bold and coloured words). The flag marks rules that only match at the very start. */
const LOG_RULES: Rule[] = [
  [/^Pace check:/, "w-ask", true],
  [/^[^]*?It[’']s on!/, "b", true],
  [/charged right away/, "b", false],
  [/Your show is live\./, "b", false],
  [/The new deadline is [^]*?(?:am|pm)\./, "b", false],
  [/\d+ fans are on hold/, "b", false],
  [/nobody has been charged/, "w-held", false],
  [/Paid [^]*$/, "w-paid", false],
  [/Every hold was cancelled\.[^]*$/, "w-rel", false],
];
const ASK_RULES: Rule[] = [[/\b\d+ of \d+\b/, "b", false]];

function highlight(text: string, rules: Rule[]): Seg[] {
  const out: Seg[] = [];
  let rest = String(text ?? "");
  let first = true;
  while (rest) {
    let best: { i: number; len: number; cls: Seg["cls"] } | null = null;
    for (const [re, cls, startOnly] of rules) {
      if (startOnly && !first) continue;
      const m = re.exec(rest);
      if (m && m[0].length > 0 && (!best || m.index < best.i)) best = { i: m.index, len: m[0].length, cls };
    }
    if (!best) {
      out.push({ text: rest, cls: "" });
      break;
    }
    if (best.i > 0) out.push({ text: rest.slice(0, best.i), cls: "" });
    out.push({ text: rest.slice(best.i, best.i + best.len), cls: best.cls });
    rest = rest.slice(best.i + best.len);
    first = false;
  }
  return out;
}
export const emphasis = (text: string): Seg[] => highlight(text, LOG_RULES);
/** The proposal card bolds the first "N of M". */
export const askEmphasis = (text: string): Seg[] => highlight(text, ASK_RULES);

export type End = "live" | "tipped" | "paid" | "missed" | "cancelled";
/** Where the sign is heading for a campaign state. */
export function endOf(state: CampaignState): End {
  switch (state) {
    case "tipped":
      return "tipped";
    case "paying_out":
    case "settled":
      return "paid";
    case "missed":
      return "missed";
    case "cancelled":
      return "cancelled";
    default:
      return "live";
  }
}

/** "Everyone's paid" only when PayPal confirmed every payout; otherwise the page says "Payouts sent". */
export function payoutsConfirmed(parties: { payoutStatus: string }[]): boolean {
  return parties.length > 0 && parties.every((p) => p.payoutStatus === "paid" || p.payoutStatus === "none");
}

/** What the money did after the deadline: all paid, a payout failed, nothing sent yet (planned), or still waiting on PayPal. */
export type PayState = "confirmed" | "failed" | "waiting" | "planned";
export function payState(parties: { payoutStatus: string }[]): PayState {
  if (parties.some((p) => p.payoutStatus === "failed")) return "failed";
  if (payoutsConfirmed(parties)) return "confirmed";
  return parties.some((p) => p.payoutStatus === "planned") ? "planned" : "waiting";
}

/** The show's own clock: the server's `now` plus the time since it arrived. */
export class ShowClock {
  private base: number;
  private at: number;
  constructor(now: string | number, at: number = Date.now()) {
    const b = toMs(now);
    this.base = Number.isFinite(b) ? b : at;
    this.at = at;
  }
  now(at: number = Date.now()): number {
    return this.base + (at - this.at);
  }
  /** Adopts the server's clock only after a big jump (a demo fast-forward), so a slow answer can't nudge a running countdown. */
  sync(now: string | number, at: number = Date.now()): void {
    const b = toMs(now);
    if (Number.isFinite(b) && Math.abs(b - this.now(at)) > 60_000) {
      this.base = b;
      this.at = at;
    }
  }
}

export function remainSec(deadline: string | number, c: ShowClock | null, at: number = Date.now()): number {
  if (!c) return 0;
  const d = toMs(deadline);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - c.now(at)) / 1000)) : 0;
}
