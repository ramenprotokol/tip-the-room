import { DAY_MS } from "../core/holds";
import { validateDraft, type MandateDraft } from "../core/mandate";
import type { Party, Role } from "../core/split";
import { DEFAULT_FEE_BUFFER_BPS, thresholdPledges } from "../core/threshold";
import type { CreateShowRequest, DraftFields, PartyInput } from "../worker/api-types";
import type { DraftSuggestion } from "./ai-jobs";
import { ServiceError } from "./errors";

const ROLES: readonly Role[] = ["room", "opener", "host", "artist"];
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const isCents = (v: unknown): v is number | undefined => v === undefined || (typeof v === "number" && Number.isFinite(v));

/** Shape-checks the browser's draft and maps it onto Plan 1's MandateDraft. Semantic checks stay in validateDraft. */
export function toMandateDraft(showId: string, f: DraftFields, launchedAt: string): MandateDraft {
  const bad = (what: string) => new ServiceError(400, "bad_request", `The draft's ${what} is missing or the wrong shape.`);
  if (!f || typeof f !== "object") throw bad("fields");
  if (!isText(f.showName, 80)) throw bad("show name");
  if (!isText(f.roomName, 80)) throw bad("room name");
  if (!isText(f.showDate, 10)) throw bad("show date");
  if (typeof f.ticketPriceCents !== "number") throw bad("pledge amount");
  if (typeof f.feeBufferBps !== "number") throw bad("fee buffer");
  if (!isText(f.deadline, 40)) throw bad("deadline");
  if (f.timeZone !== undefined && !isText(f.timeZone, 64)) throw bad("time zone");
  if (!Array.isArray(f.parties) || f.parties.length < 1 || f.parties.length > 4) throw bad("payees");
  const parties: Party[] = f.parties.map((x: PartyInput) => {
    if (!x || typeof x !== "object" || !ROLES.includes(x.role) || !isText(x.label, 60) || !isText(x.paypalEmail, 254) || !isCents(x.fixedCents) || !isCents(x.minimumCents)) throw bad("payees");
    const party: Party = { role: x.role, label: x.label, paypalEmail: x.paypalEmail.trim() };
    if (x.fixedCents !== undefined) party.fixed = x.fixedCents;
    if (x.minimumCents !== undefined) party.minimum = x.minimumCents;
    return party;
  });
  return { showId, showName: f.showName, roomName: f.roomName, showDate: f.showDate, ticketPrice: f.ticketPriceCents, feeBufferBps: f.feeBufferBps, parties, launchedAt, deadline: f.deadline, timeZone: f.timeZone || "UTC" };
}

/** The editable draft from the model's (or template's) suggestion plus the artist's own fields. */
export function draftFields(s: DraftSuggestion, req: CreateShowRequest, now: number): DraftFields {
  const deadline = typeof req.deadline === "string" && req.deadline.length <= 40 && !Number.isNaN(Date.parse(req.deadline)) ? req.deadline : new Date(now + 7 * DAY_MS).toISOString();
  const email = (role: Role) => {
    const v = req.emails?.[role];
    return typeof v === "string" ? v.trim().slice(0, 254) : "";
  };
  const parties: PartyInput[] = [{ role: "room", label: (s.roomName || "The room").slice(0, 60), paypalEmail: email("room"), fixedCents: s.room }];
  if (s.opener > 0) parties.push({ role: "opener", label: "Opener", paypalEmail: email("opener"), fixedCents: s.opener });
  if (s.host > 0) parties.push({ role: "host", label: "Host", paypalEmail: email("host"), fixedCents: s.host });
  parties.push({ role: "artist", label: "You", paypalEmail: email("artist"), minimumCents: s.artistMinimum });
  return {
    showName: s.showName,
    roomName: s.roomName,
    showDate: s.showDate ?? new Date(Date.parse(deadline)).toISOString().slice(0, 10),
    ticketPriceCents: s.ticketPrice ?? 0,
    feeBufferBps: DEFAULT_FEE_BUFFER_BPS,
    deadline,
    timeZone: typeof req.timeZone === "string" && req.timeZone.length > 0 && req.timeZone.length <= 64 ? req.timeZone : "UTC",
    parties,
  };
}

/** Code computes the fan target (spec 3.1), even before every email is filled in. */
export function previewDraft(showId: string, f: DraftFields, now: number): { threshold: number | null; problems: string[] } {
  const problems = validateDraft(toMandateDraft(showId, f, new Date(now).toISOString()));
  let threshold: number | null;
  try {
    threshold = thresholdPledges({
      fixedCosts: f.parties.filter((x) => x.role !== "artist").map((x) => x.fixedCents ?? 0),
      artistMinimum: f.parties.find((x) => x.role === "artist")?.minimumCents ?? 0,
      ticketPrice: f.ticketPriceCents,
      feeBufferBps: f.feeBufferBps,
    });
  } catch {
    threshold = null;
  }
  return { threshold, problems };
}
