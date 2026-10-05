import type { Cents } from "./money";
import { DAY_MS, MAX_CAMPAIGN_DAYS, MAX_EXTENSION_DAYS } from "./holds";
import { artistMinimum, fixedTotal, type Party } from "./split";
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

export function buildMandate(draft: MandateDraft): Mandate {
  const threshold = thresholdPledges({
    fixedCosts: draft.parties.filter((p) => p.role !== "artist").map((p) => p.fixed ?? 0),
    artistMinimum: artistMinimum(draft.parties),
    ticketPrice: draft.ticketPrice,
    feeBufferBps: draft.feeBufferBps,
  });
  return { ...draft, version: 1, threshold, maxExtensions: 1, maxExtensionDays: MAX_EXTENSION_DAYS as 7 };
}

export function validateMandate(m: Mandate): string[] {
  const problems: string[] = [];
  if (!m.showName.trim()) problems.push("Give the show a name.");
  if (!m.roomName.trim()) problems.push("Say where the show is.");
  if (!Number.isInteger(m.ticketPrice) || m.ticketPrice <= 0) problems.push("The pledge must be more than $0.");
  if (m.parties.filter((p) => p.role === "artist").length !== 1) problems.push("The split needs exactly one artist.");
  for (const p of m.parties) {
    if (!EMAIL.test(p.paypalEmail)) problems.push(`${p.label} needs a valid PayPal email.`);
    if (p.role !== "artist" && (p.fixed === undefined || !Number.isInteger(p.fixed) || p.fixed < 0)) {
      problems.push(`${p.label} needs a fixed amount.`);
    }
  }
  const launched = Date.parse(m.launchedAt);
  const deadline = Date.parse(m.deadline);
  if (Number.isNaN(launched) || Number.isNaN(deadline)) {
    problems.push("The launch time and deadline must be real dates.");
  } else {
    if (deadline <= launched) problems.push("The deadline must be after the show goes live.");
    if (deadline - launched > MAX_CAMPAIGN_DAYS * DAY_MS) problems.push("The pledge window can be at most 21 days.");
    if (m.showDate < m.deadline.slice(0, 10)) problems.push("The show must be on or after the pledge deadline.");
  }
  if (m.threshold < 1) problems.push("The fan target must be at least 1.");
  if (fixedTotal(m.parties) < 0) problems.push("Amounts cannot be negative.");
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

export async function verifyMandate(s: SignedMandate): Promise<boolean> {
  return (await sha256Hex(canonicalJSON(s.mandate))) === s.hash;
}
