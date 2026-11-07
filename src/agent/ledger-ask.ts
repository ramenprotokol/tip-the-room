// "Ask the ledger": a typed question becomes a small filter-and-sort spec. The model proposes; this file checks.
// The model never sees a ledger row and the spec can only ever filter or sort the rows the page already shows:
// it has no way to name an amount to move, a PayPal call or a write. Both the Worker and the page run `validateLedgerSpec`.
import type { LedgerStatus } from "../worker/api-types";
import { askModel, MODELS, type AiDeps } from "./ai";

/** The grid's real column ids (see LedgerGrid): the only ones a spec may name. */
export const LEDGER_COLUMN_IDS = ["when", "what", "who", "amountCents", "ref", "status"] as const;
export type LedgerColumnId = (typeof LEDGER_COLUMN_IDS)[number];
/** Columns a spec may search inside (free text). Never amounts or times. */
export const LEDGER_TEXT_COLUMNS = ["what", "who", "ref"] as const;
export type LedgerTextColumn = (typeof LEDGER_TEXT_COLUMNS)[number];
/** Every status the ledger can show: the only values a spec may filter on. */
export const LEDGER_STATUS_VALUES: readonly LedgerStatus[] = ["On hold", "Charged", "Paid", "Cancelled", "Refunded", "Failed", "Pending", "Sent", "Info"];

export interface LedgerSpec {
  /** Show rows with any of these statuses. Empty: every status. */
  statuses: LedgerStatus[];
  /** Show rows whose column contains this text (case-insensitive). */
  contains: { col: LedgerTextColumn; text: string } | null;
  /** Order the rows by one column. */
  sort: { col: LedgerColumnId; dir: "asc" | "desc" } | null;
}

const SPEC_KEYS = new Set(["statuses", "contains", "sort"]);
const SEARCH_TEXT = /^[\p{L}\p{N} .,'’$#:_-]{1,40}$/u;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Accepts only a spec made entirely of allowlisted column ids, status values and short plain search text. Anything else
 * (an unknown key, a column or status not in the lists, markup, an oversized string, a wrong type) rejects the WHOLE spec: null.
 * The result is rebuilt from the checked values, never the input object itself.
 */
export function validateLedgerSpec(raw: unknown): LedgerSpec | null {
  if (!isRecord(raw)) return null;
  for (const k of Object.keys(raw)) if (!SPEC_KEYS.has(k)) return null;

  const statuses: LedgerStatus[] = [];
  if (raw.statuses !== undefined && raw.statuses !== null) {
    if (!Array.isArray(raw.statuses) || raw.statuses.length > LEDGER_STATUS_VALUES.length) return null;
    for (const s of raw.statuses) {
      const hit = LEDGER_STATUS_VALUES.find((v) => v === s);
      if (hit === undefined) return null;
      if (!statuses.includes(hit)) statuses.push(hit);
    }
  }

  let contains: LedgerSpec["contains"] = null;
  if (raw.contains !== undefined && raw.contains !== null) {
    const c = raw.contains;
    if (!isRecord(c) || Object.keys(c).some((k) => k !== "col" && k !== "text")) return null;
    const col = LEDGER_TEXT_COLUMNS.find((x) => x === c.col);
    if (col === undefined || typeof c.text !== "string") return null;
    const text = c.text.trim();
    if (!SEARCH_TEXT.test(text)) return null;
    contains = { col, text };
  }

  let sort: LedgerSpec["sort"] = null;
  if (raw.sort !== undefined && raw.sort !== null) {
    const s = raw.sort;
    if (!isRecord(s) || Object.keys(s).some((k) => k !== "col" && k !== "dir")) return null;
    const col = LEDGER_COLUMN_IDS.find((x) => x === s.col);
    if (col === undefined || (s.dir !== "asc" && s.dir !== "desc")) return null;
    sort = { col, dir: s.dir };
  }

  if (statuses.length === 0 && contains === null && sort === null) return null;
  return { statuses, contains, sort };
}

/* ---------- plain words for a spec ---------- */

const COLUMN_WORDS: Record<LedgerColumnId, string> = { when: "time", what: "what happened", who: "who", amountCents: "amount", ref: "PayPal ref", status: "status" };

/** The spec in plain English, shown next to the grid so the visitor sees what was applied. */
export function describeSpec(spec: LedgerSpec): string {
  const parts: string[] = [];
  if (spec.statuses.length) parts.push(`status: ${spec.statuses.join(" or ")}`);
  if (spec.contains) parts.push(`${COLUMN_WORDS[spec.contains.col]} contains “${spec.contains.text}”`);
  if (spec.sort) parts.push(`${spec.sort.col === "amountCents" ? (spec.sort.dir === "desc" ? "biggest" : "smallest") + " amount first" : `by ${COLUMN_WORDS[spec.sort.col]}, ${spec.sort.dir === "desc" ? "newest or highest" : "oldest or lowest"} first`}`);
  return parts.join(" · ");
}

/* ---------- the keyword matcher: used when the daily AI budget is spent, the model answers badly, or the call fails ---------- */

const STATUS_WORDS: [RegExp, LedgerStatus[]][] = [
  [/\b(cancel(?:led|ed|s)?|void(?:ed|s)?|released?|not charged)\b/, ["Cancelled"]],
  [/\b(refund(?:ed|s)?)\b/, ["Refunded"]],
  [/\b(fail(?:ed|ure|ures|s)?|declined|refused|problems?)\b/, ["Failed"]],
  [/\b(paid|payouts?|paid out|pay(?:ing)?|sent|settle(?:d|ment)?)\b/, ["Paid", "Sent"]],
  [/\b(charged?|charges|captured?|collected)\b/, ["Charged"]],
  [/\b(pending|waiting|in flight|not yet)\b/, ["Pending", "Sent"]],
];
/** "holds" is also the noun for every row about a fan ("which holds were cancelled?"), so it only means On hold when no other status word was used. */
const HOLD_WORDS = /\b(on hold|holds?|held|authori[sz]ed)\b/;

/**
 * Turns a question into a spec with plain word matching. `names` (the ledger's own `who` values) lets "Fan 03" or a payee's
 * name filter by who. Returns null when nothing in the question maps to a column or a status.
 */
export function keywordSpec(question: string, names: readonly string[] = []): LedgerSpec | null {
  const q = question.toLowerCase().slice(0, 300);
  const statuses: LedgerStatus[] = [];
  for (const [re, found] of STATUS_WORDS) {
    if (re.test(q)) for (const s of found) if (!statuses.includes(s)) statuses.push(s);
  }
  if (statuses.length === 0 && HOLD_WORDS.test(q)) statuses.push("On hold");
  let sort: LedgerSpec["sort"] = null;
  if (/\b(biggest|largest|highest|most|top|big)\b/.test(q)) sort = { col: "amountCents", dir: "desc" };
  else if (/\b(smallest|lowest|least|tiniest|small)\b/.test(q)) sort = { col: "amountCents", dir: "asc" };
  else if (/\b(oldest|earliest|first)\b/.test(q)) sort = { col: "when", dir: "asc" };
  else if (/\b(newest|latest|recent|last)\b/.test(q)) sort = { col: "when", dir: "desc" };

  let contains: LedgerSpec["contains"] = null;
  const fan = /\bfan\s*0*(\d{1,3})\b/.exec(q);
  if (fan) contains = { col: "who", text: `Fan ${fan[1].padStart(2, "0")}` };
  else {
    const hit = [...names].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length).find((n) => q.includes(n.toLowerCase()));
    if (hit && SEARCH_TEXT.test(hit)) contains = { col: "who", text: hit };
  }
  return validateLedgerSpec({ statuses, contains, sort });
}

/* ---------- the model call ---------- */

const ASK_SCHEMA = {
  type: "object",
  properties: {
    statuses: { type: "array", items: { type: "string", enum: [...LEDGER_STATUS_VALUES] } },
    contains: { type: ["object", "null"], properties: { col: { type: "string", enum: [...LEDGER_TEXT_COLUMNS] }, text: { type: "string" } }, required: ["col", "text"] },
    sort: { type: ["object", "null"], properties: { col: { type: "string", enum: [...LEDGER_COLUMN_IDS] }, dir: { type: "string", enum: ["asc", "desc"] } }, required: ["col", "dir"] },
  },
  required: ["statuses", "contains", "sort"],
};

const ASK_SYSTEM =
  "You turn a question about a table of money events into a JSON filter. You only choose how to filter and sort; you never answer the question or invent data. " +
  `Columns: when, what, who, amountCents, ref, status. Statuses: ${LEDGER_STATUS_VALUES.join(", ")}. ` +
  "statuses: the statuses to show (empty list for all). contains: search text inside what, who or ref, or null. sort: a column and asc or desc, or null. " +
  "Use status Cancelled for cancelled or voided holds, Charged for charges, On hold for holds that are still held, Refunded for refunds, Paid and Sent for payouts. " +
  "Biggest or largest means sort amountCents desc; newest means sort when desc. " +
  "Example question: which holds were cancelled? Example answer: {\"statuses\":[\"Cancelled\"],\"contains\":null,\"sort\":null}. " +
  "Example question: biggest payouts. Example answer: {\"statuses\":[\"Paid\",\"Sent\"],\"contains\":null,\"sort\":{\"col\":\"amountCents\",\"dir\":\"desc\"}}. Answer with JSON only.";

export interface LedgerAnswer {
  spec: LedgerSpec | null;
  /** "model": the model's spec passed the checks. "keywords": the plain matcher answered (budget spent, model failed or its spec was refused). */
  source: "model" | "keywords";
  /** Why the keyword matcher answered, when it did. */
  why: "resting" | "unavailable" | "refused" | null;
}

export const MAX_QUESTION = 200;

/** Asks the model first (if the daily budget has room), checks its spec, and falls back to the keyword matcher. Never throws. */
export async function answerLedgerQuestion(deps: AiDeps, question: string, names: readonly string[] = []): Promise<LedgerAnswer> {
  const q = question.trim().slice(0, MAX_QUESTION);
  const answer = await askModel(deps, MODELS.small, {
    messages: [
      { role: "system", content: ASK_SYSTEM },
      { role: "user", content: q },
    ],
    max_tokens: 120,
    temperature: 0,
    response_format: { type: "json_schema", json_schema: ASK_SCHEMA },
  });
  if (answer.ok) {
    const spec = validateLedgerSpec(answer.value);
    if (spec) return { spec, source: "model", why: null };
    return { spec: keywordSpec(q, names), source: "keywords", why: "refused" };
  }
  return { spec: keywordSpec(q, names), source: "keywords", why: answer.why };
}
