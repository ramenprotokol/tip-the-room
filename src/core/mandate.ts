import type { Cents } from "./money";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "./holds";
import type { CampaignEvent } from "./campaign";
import { artistMinimum, type Party } from "./split";
import { thresholdPledges } from "./threshold";

export interface MandateDraft {
  showId: string;
  showName: string;
  roomName: string;
  /** Calendar date of the show, YYYY-MM-DD. */
  showDate: string;
  ticketPrice: Cents;
  feeBufferBps: number;
  /** Payout order: room, opener, host (any of them optional), then exactly one artist. */
  parties: Party[];
  /** ISO timestamp when pledging opens. */
  launchedAt: string;
  /** ISO timestamp when pledging closes. */
  deadline: string;
  /** IANA time zone the show happens in, e.g. "America/Los_Angeles". Defaults to "UTC". */
  timeZone?: string;
}

export interface Mandate extends MandateDraft {
  version: 1;
  threshold: number;
  maxExtensions: 1;
  maxExtensionDays: 7;
}

export interface SignedMandate {
  mandate: Mandate;
  /** SHA-256 hex digest of canonicalJSON(mandate). */
  hash: string;
  signedAt: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Thrown by buildMandate when the form has problems; every message is plain English. */
export class MandateDraftError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join(" "));
    this.name = "MandateDraftError";
  }
}

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isStrictTimestamp(text: string): boolean {
  return typeof text === "string" && ISO_TIMESTAMP.test(text) && isRealDate(text.slice(0, 10)) && !Number.isNaN(Date.parse(text));
}

const ROLE_ORDER: readonly string[] = ["room", "opener", "host", "artist"];

/** Plain-English problems with a draft. Pure checks only: never throws, never does threshold math. */
export function validateDraft(draft: MandateDraft): string[] {
  const problems: string[] = [];
  if (!draft.showName?.trim()) problems.push("Give the show a name.");
  if (!draft.roomName?.trim()) problems.push("Say where the show is.");
  if (!draft.showId?.trim()) problems.push("This show needs an id.");
  if (!Number.isInteger(draft.ticketPrice) || draft.ticketPrice <= 0) problems.push("The pledge must be more than $0.");
  if (!Number.isInteger(draft.feeBufferBps) || draft.feeBufferBps < 0 || draft.feeBufferBps > 5000) {
    problems.push("The fee buffer must be between 0% and 50%.");
  }
  const parties = draft.parties ?? [];
  if (parties.filter((p) => p.role === "artist").length !== 1) problems.push("The split needs exactly one artist.");
  const ranks = parties.map((p) => ROLE_ORDER.indexOf(p.role));
  if (ranks.some((r) => r === -1)) problems.push("Each payee must be the room, an opener, a host or the artist.");
  else if (ranks.some((r, i) => i > 0 && r < ranks[i - 1])) problems.push("Payees must be listed as room, opener, host, then the artist.");
  for (const p of parties) {
    const named = Boolean(p.label?.trim());
    const label = named ? p.label : "A payee";
    if (!named) problems.push(`${label} needs a name.`);
    if (!EMAIL.test(p.paypalEmail ?? "")) problems.push(`${label} needs a valid PayPal email.`);
    if (p.role !== "artist") {
      if (!Number.isInteger(p.fixed) || (p.fixed as number) < 0) problems.push(`${label} needs a fixed amount.`);
    } else if (p.minimum !== undefined && (!Number.isInteger(p.minimum) || p.minimum < 0)) {
      problems.push(`${label} needs a minimum in whole dollars and cents.`);
    }
  }

  const showDateOk = isRealDate(draft.showDate ?? "");
  if (!showDateOk) problems.push("The show date must look like 2026-11-20.");

  const launched = Date.parse(draft.launchedAt);
  const deadline = Date.parse(draft.deadline);
  const timestampsOk = isStrictTimestamp(draft.launchedAt) && isStrictTimestamp(draft.deadline);
  if (!timestampsOk) {
    problems.push("The launch time and deadline must be real dates.");
    return problems;
  }
  if (deadline <= launched) problems.push("The deadline must be after the show goes live.");
  if (deadline - launched > MAX_CAMPAIGN_DAYS * DAY_MS) {
    problems.push(`The pledge window can be at most ${MAX_CAMPAIGN_DAYS} days.`);
  }
  if (showDateOk) {
    let deadlineDay: string | undefined;
    try {
      deadlineDay = new Intl.DateTimeFormat("en-CA", {
        timeZone: draft.timeZone ?? "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(deadline));
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      problems.push("Pick a real time zone.");
    }
    if (deadlineDay !== undefined && draft.showDate < deadlineDay) {
      problems.push("The show must be on or after the pledge deadline.");
    }
  }
  return problems;
}

export function buildMandate(draft: MandateDraft): Mandate {
  const problems = validateDraft(draft);
  if (problems.length > 0) throw new MandateDraftError(problems);
  const threshold = thresholdPledges({
    fixedCosts: draft.parties.filter((p) => p.role !== "artist").map((p) => p.fixed ?? 0),
    artistMinimum: artistMinimum(draft.parties),
    ticketPrice: draft.ticketPrice,
    feeBufferBps: draft.feeBufferBps,
  });
  return { ...draft, timeZone: draft.timeZone ?? "UTC", version: 1, threshold, maxExtensions: 1, maxExtensionDays: MAX_EXTENSION_DAYS };
}

/** The mandate's deadline as epoch milliseconds, the form the campaign reducer uses. */
export function deadlineMs(m: Mandate): number {
  return Date.parse(m.deadline);
}

/** The event that takes a campaign from draft to live once the artist signs this mandate. */
export function mandateSignedEvent(m: Mandate): CampaignEvent {
  return { type: "mandate_signed", threshold: m.threshold, deadline: deadlineMs(m) };
}

export function validateMandate(m: Mandate): string[] {
  const problems = validateDraft(m);
  if (!Number.isInteger(m.threshold) || m.threshold < 1) problems.push("The fan target must be at least 1.");
  return problems;
}

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signMandate(m: Mandate, signedAt: string): Promise<SignedMandate> {
  return { mandate: m, hash: await sha256Hex(canonicalJSON(m)), signedAt };
}

/**
 * Only checks that the mandate matches its own hash. Enforcement must compare against
 * the hash stored when the artist signed, never the hash carried inside the SignedMandate.
 */
export async function verifyMandate(s: SignedMandate): Promise<boolean> {
  return (await sha256Hex(canonicalJSON(s.mandate))) === s.hash;
}
