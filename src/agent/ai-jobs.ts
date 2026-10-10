import { dollarsToCents, formatUSD, type Cents } from "../core/money";
import type { Role } from "../core/split";
import { centsToValue } from "../paypal/amount";
import { askModel, MODELS, type AiDeps, type AiResult, type ModelAnswer } from "./ai";
import type { AiSource, ProposalOption, ProposalOptionId } from "./events";

const fallbackSource = (a: ModelAnswer): AiSource => (!a.ok && a.why === "resting" ? "resting" : "template");
const pad = (n: number) => String(n).padStart(2, "0");

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Every number in `text` (commas ignored) must be one code computed. Stops a model inventing figures. */
export function numbersOk(text: string, allowed: ReadonlySet<string>): boolean {
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    if (!allowed.has(m[0].replace(/,/g, ""))) return false;
  }
  return true;
}

function digitsIn(...texts: string[]): string[] {
  return texts.flatMap((t) => [...t.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
}

function moneyForms(c: Cents): string[] {
  const v = centsToValue(c);
  return c % 100 === 0 ? [v, String(c / 100)] : [v];
}

/* ---------- 1 · sentence → draft (small model; code computes the threshold) ---------- */

export interface DraftSuggestion {
  showName: string;
  roomName: string;
  showDate: string | null;
  ticketPrice: Cents | null;
  room: Cents;
  opener: Cents;
  host: Cents;
  artistMinimum: Cents;
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    showName: { type: "string" },
    roomName: { type: "string" },
    showDate: { type: ["string", "null"] },
    ticketPriceDollars: { type: ["number", "null"] },
    roomDollars: { type: "number" },
    openerDollars: { type: "number" },
    hostDollars: { type: "number" },
    artistMinimumDollars: { type: "number" },
  },
  required: ["showName", "roomName", "showDate", "ticketPriceDollars", "roomDollars", "openerDollars", "hostDollars", "artistMinimumDollars"],
};

const DRAFT_SYSTEM =
  "You turn one sentence about a small live show into JSON. Use only facts in the sentence. " +
  "Money is in US dollars as plain numbers. Use 0 for a missing amount, and null for a missing showDate or ticketPriceDollars. " +
  "showDate is YYYY-MM-DD. roomName is the venue. roomDollars is what the venue (cafe, bar, room) wants, openerDollars what the opener wants, hostDollars what a host wants. ticketPriceDollars is the price of one ticket, never a payout. artistMinimumDollars is what the artist says they need. Answer with JSON only.";

/** Longest sentence any draft path looks at. Slicing first keeps every regex input small. */
export const MAX_SENTENCE = 500;
const JARGON = /authori[sz]|captur|void|payout batch|sender_|mandate/i;
/** Wording the pace prompt no longer asks for; seeing it means the model is talking about the artist, not to them. */
const STALE_WORDING = /on hold|the artist/i;

/** Schema check for the model's draft. Null means "use the template". Every non-zero amount and the day must appear in the sentence. */
export function parseDraft(raw: unknown, sentence: string): DraftSuggestion | null {
  const written = new Set(digitsIn(sentence.slice(0, MAX_SENTENCE)).map(Number));
  const inSentence = (c: Cents | null) => c === null || c === 0 || written.has(c / 100);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, allowEmpty: boolean) => (typeof v === "string" && v.trim().length <= 80 && (allowEmpty || v.trim().length > 0) ? v.trim() : null);
  const dollars = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? dollarsToCents(v) : null);
  const showName = text(r.showName, false);
  const roomName = text(r.roomName, true);
  const showDate = r.showDate === null ? null : typeof r.showDate === "string" && isIsoDate(r.showDate) ? r.showDate : undefined;
  const ticketPrice = r.ticketPriceDollars === null ? null : dollars(r.ticketPriceDollars, 1000);
  const room = dollars(r.roomDollars, 100_000);
  const opener = dollars(r.openerDollars, 100_000);
  const host = dollars(r.hostDollars, 100_000);
  const artistMinimum = dollars(r.artistMinimumDollars, 100_000);
  if (showName === null || roomName === null || showDate === undefined) return null;
  if (r.ticketPriceDollars !== null && (ticketPrice === null || ticketPrice === 0)) return null;
  if (room === null || opener === null || host === null || artistMinimum === null) return null;
  if (![ticketPrice, room, opener, host, artistMinimum].every(inSentence)) return null;
  if (showDate !== null && !new Set(digitsIn(withoutDeadline(sentence.slice(0, MAX_SENTENCE))).map(Number)).has(Number(showDate.slice(8)))) return null;
  return { showName, roomName, showDate, ticketPrice, room, opener, host, artistMinimum };
}

/** "pledges close Oct 16", "deadline Oct 16", "by Oct 16": the date belongs to the pledge deadline, never to the show. */
export const DEADLINE_PHRASE = /\b(?:pledges?\s+(?:close|end)|deadline(?:\s+is)?|by)\s*:?\s*(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

/** The sentence without its deadline phrase, so the show date can't be read from it. */
export const withoutDeadline = (sentence: string): string => sentence.replace(new RegExp(DEADLINE_PHRASE.source, "gi"), " ");

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AMOUNT = String.raw`(\d+(?:\.\d{1,2})?)`;

/** "Oct", "16" → the next such day on or after today (UTC) as YYYY-MM-DD, or null if it isn't a real date. */
export function monthDayIso(monthName: string, dayText: string, now: number): string | null {
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  const day = Number(dayText);
  const today = new Date(now);
  let year = today.getUTCFullYear();
  if (Date.UTC(year, month, day) < Date.UTC(year, today.getUTCMonth(), today.getUTCDate())) year += 1;
  const iso = `${year}-${pad(month + 1)}-${pad(day)}`;
  return isIsoDate(iso) ? iso : null;
}

/** Deterministic fallback: the same patterns the Start page's preview used, returning cents. */
export function templateDraft(sentence: string, now: number): DraftSuggestion {
  const t = sentence.slice(0, MAX_SENTENCE).replace(/[’]/g, "'");
  const num = (re: RegExp): number | null => {
    const m = re.exec(t);
    return m ? Number(m[1]) : null;
  };
  const cents = (n: number | null): Cents => (n === null || !Number.isFinite(n) || n < 0 || n > 100_000 ? 0 : dollarsToCents(n));
  const price =
    num(new RegExp(String.raw`\$${AMOUNT}\s*(?:tickets?|a ticket|each|a spot|per (?:ticket|person|fan))`, "i")) ??
    num(new RegExp(String.raw`tickets?\s*(?:are|at)?\s*\$${AMOUNT}`, "i"));
  const room = num(new RegExp(String.raw`(?:caf[eé]|room|venue|bar|shop|store|place)\s+(?:wants|needs|gets|charges)\s+\$${AMOUNT}`, "i"));
  const opener = num(new RegExp(String.raw`opener\s+(?:wants|needs|gets)\s+\$${AMOUNT}`, "i"));
  const host = num(new RegExp(String.raw`host\s+(?:wants|needs|gets)\s+\$${AMOUNT}`, "i"));
  const me = num(new RegExp(String.raw`\bI\s+(?:need|want|get)\s+\$${AMOUNT}`, "i"));
  let showDate: string | null = null;
  const dm = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(withoutDeadline(t));
  if (dm) {
    showDate = monthDayIso(dm[1], dm[2], now);
  }
  const roomName = (/\bat\s+([A-Z][\w'é&.-]*(?:\s[A-Z][\w'é&.-]*)*)(?=\s+on\b|,|$)/.exec(t)?.[1] ?? "").trim().slice(0, 80);
  const showName = (/^\s*([^,]+?)\s+at\s+/i.exec(t)?.[1] ?? "").trim().slice(0, 80) || "My show";
  return {
    showName,
    roomName,
    showDate,
    ticketPrice: price !== null && price > 0 && price <= 1000 ? dollarsToCents(price) : null,
    room: cents(room),
    opener: cents(opener),
    host: cents(host),
    artistMinimum: cents(me),
  };
}

export async function draftFromSentence(deps: AiDeps, sentence: string, now: number): Promise<AiResult<DraftSuggestion>> {
  const answer = await askModel(deps, MODELS.small, {
    messages: [
      { role: "system", content: DRAFT_SYSTEM },
      { role: "user", content: `Today is ${new Date(now).toISOString().slice(0, 10)}. Sentence: ${sentence.slice(0, MAX_SENTENCE)}` },
    ],
    max_tokens: 256,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: DRAFT_SCHEMA },
  });
  if (answer.ok) {
    const value = parseDraft(answer.value, sentence);
    if (value) return { value, source: "model" };
  }
  return { value: templateDraft(sentence, now), source: fallbackSource(answer) };
}

/* ---------- 2 · pace check: explain code's numbers and options (70B) ---------- */

export interface PaceFacts {
  committed: number;
  threshold: number;
  daysLeft: number;
  hoursLeft: number;
  projected: number;
  percentElapsed: number;
  /** Already guard-approved options (needsApproval), computed by code. */
  options: ProposalOption[];
  extendDays: number | null;
  lowerTo: number | null;
}

export interface PaceNote {
  text: string;
  recommend: ProposalOptionId | "wait";
}

/** The time left as the page countdown reads it: whole days rounded down, whole hours once under a day. */
export function timeLeftPhrase(f: Pick<PaceFacts, "daysLeft" | "hoursLeft">): string {
  if (f.daysLeft >= 1) return `${f.daysLeft} day${f.daysLeft === 1 ? "" : "s"} left`;
  if (f.hoursLeft >= 1) return `${f.hoursLeft} hour${f.hoursLeft === 1 ? "" : "s"} left`;
  return "less than an hour left";
}

const PACE_SCHEMA = { type: "object", properties: { text: { type: "string" }, recommend: { type: "string" } }, required: ["text", "recommend"] };
const PACE_SYSTEM =
  "You help an artist whose small show needs more fans. Speak to the artist as 'you'. In 1 to 3 short, plain sentences, explain the numbers given and name each option offered in plain words. " +
  "Use ONLY the numbers provided. No jargon. Then set recommend to one option id, or \"wait\". Answer with JSON only.";

function paceAllowed(f: PaceFacts): Set<string> {
  const nums = [f.committed, f.threshold, f.daysLeft >= 1 ? f.daysLeft : f.hoursLeft, f.projected, f.percentElapsed, Math.max(0, f.threshold - f.committed)];
  if (f.extendDays !== null) nums.push(f.extendDays);
  if (f.lowerTo !== null) nums.push(f.lowerTo);
  return new Set(nums.map(String));
}

export function parsePaceNote(raw: unknown, f: PaceFacts): PaceNote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || r.text.trim().length < 10 || r.text.length > 400) return null;
  const ids: string[] = ["wait", ...f.options.map((o) => o.id)];
  if (typeof r.recommend !== "string" || !ids.includes(r.recommend)) return null;
  if (JARGON.test(r.text) || STALE_WORDING.test(r.text) || !numbersOk(r.text, paceAllowed(f))) return null;
  return { text: r.text.trim(), recommend: r.recommend as ProposalOptionId | "wait" };
}

export function templatePaceNote(f: PaceFacts): PaceNote {
  const first = `${f.committed} of ${f.threshold} fans with ${timeLeftPhrase(f)}. At this pace about ${f.projected} will join.`;
  const choices: string[] = [];
  if (f.extendDays !== null) choices.push(`extend the deadline ${f.extendDays} day${f.extendDays === 1 ? "" : "s"}`);
  if (f.lowerTo !== null) choices.push(`lower the target to ${f.lowerTo}`);
  return {
    text: choices.length ? `${first} You could ${choices.join(", or ")}.` : `${first} Nothing needs changing yet.`,
    recommend: f.extendDays !== null ? "extend" : f.lowerTo !== null ? "lower" : "wait",
  };
}

export async function paceNote(deps: AiDeps, f: PaceFacts): Promise<AiResult<PaceNote>> {
  const answer = await askModel(deps, MODELS.big, {
    messages: [
      { role: "system", content: PACE_SYSTEM },
      { role: "user", content: JSON.stringify({ fans: f.committed, target: f.threshold, timeLeft: timeLeftPhrase(f), percentOfPledgeWindowPassed: f.percentElapsed, projectedFans: f.projected, options: f.options.map((o) => ({ id: o.id, label: o.label })) }) },
    ],
    max_tokens: 200,
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: PACE_SCHEMA },
  });
  if (answer.ok) {
    const value = parsePaceNote(answer.value, f);
    if (value) return { value, source: "model" };
  }
  return { value: templatePaceNote(f), source: fallbackSource(answer) };
}

/* ---------- 3 · plain-English settlement note per party (70B) ---------- */

export interface NoteFacts {
  role: Role;
  label: string;
  showName: string;
  outcome: "paid" | "called_off" | "refunded";
  amountCents: Cents;
  fans: number;
  ticketPriceCents: Cents;
}

const NOTE_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const NOTE_SYSTEM =
  "Write one or two plain sentences for the named person about how a small show's money settled. " +
  "Use only the facts and numbers given. No jargon: say 'on hold', 'charged', 'cancelled', 'refunded'. Answer with JSON only.";

export function templateNote(f: NoteFacts): string {
  switch (f.outcome) {
    case "paid":
      return `${f.showName} happened. ${f.fans} fans paid ${formatUSD(f.ticketPriceCents)} each, and ${f.label} was paid ${formatUSD(f.amountCents)} under the money rules the artist signed.`;
    case "called_off":
      return `${f.showName} didn't reach its target, so every hold was cancelled. Nobody was charged, and ${f.label} receives nothing.`;
    case "refunded":
      return `${f.showName} was called off after it tipped. Every fan is being refunded, and ${f.label} receives nothing.`;
  }
}

export function parseNote(raw: unknown, f: NoteFacts): string | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (raw as Record<string, unknown>).text;
  if (typeof text !== "string" || text.trim().length < 20 || text.length > 400) return null;
  const allowed = new Set([String(f.fans), ...moneyForms(f.amountCents), ...moneyForms(f.ticketPriceCents), ...digitsIn(f.showName, f.label)]);
  if (JARGON.test(text) || !numbersOk(text, allowed)) return null;
  if (f.outcome === "paid" && /\bpaid\b/i.test(text) && !digitsIn(text).some((d) => moneyForms(f.amountCents).includes(d))) return null;
  return text.trim();
}

export async function settlementNote(deps: AiDeps, f: NoteFacts): Promise<AiResult<string>> {
  const answer = await askModel(deps, MODELS.big, {
    messages: [
      { role: "system", content: NOTE_SYSTEM },
      { role: "user", content: JSON.stringify({ person: f.label, role: f.role, show: f.showName, outcome: f.outcome, theirAmount: formatUSD(f.amountCents), fans: f.fans, pricePerFan: formatUSD(f.ticketPriceCents) }) },
    ],
    max_tokens: 160,
    temperature: 0.3,
    response_format: { type: "json_schema", json_schema: NOTE_SCHEMA },
  });
  if (answer.ok) {
    const value = parseNote(answer.value, f);
    if (value) return { value, source: "model" };
  }
  return { value: templateNote(f), source: fallbackSource(answer) };
}
