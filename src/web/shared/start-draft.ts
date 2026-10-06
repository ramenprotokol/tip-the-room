// The editable draft on the Start page: from the server's DraftFields to the form, and back for signing.
import { dollarsToCents, thresholdPledges } from "../../core";
import type { DraftFields, PartyInput } from "../../worker/api-types";
import { dayLabel, when } from "./format";

export type PayeeRole = "Room" | "Opener" | "Host" | "You";
export interface PayeeRow { role: PayeeRole; who: string; /** dollars */ amount: number; optional?: boolean; me?: boolean; email: string }
export interface Draft {
  name: string;
  room: string;
  /** "Fri Nov 20" */
  date: string;
  /** dollars */
  price: number;
  /** "Thu Nov 12, 6:00pm" in timeZone */
  deadline: string;
  payees: PayeeRow[];
  feeBufferBps: number;
  timeZone: string;
  artistLabel: string;
  year: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function fromDraft(d: DraftFields): Draft {
  const by = (r: PartyInput["role"]) => d.parties.find((p) => p.role === r);
  const room = by("room"), opener = by("opener"), host = by("host"), artist = by("artist");
  const dollars = (c?: number) => (c ?? 0) / 100;
  const dl = Date.parse(d.deadline);
  return {
    name: d.showName,
    room: d.roomName,
    date: d.showDate ? dayLabel(d.showDate) : "",
    price: dollars(d.ticketPriceCents),
    deadline: Number.isFinite(dl) ? when(dl, d.timeZone, "long") : "",
    feeBufferBps: d.feeBufferBps,
    timeZone: d.timeZone,
    artistLabel: artist?.label || "You",
    year: Number(d.showDate.slice(0, 4)) || new Date().getUTCFullYear(),
    payees: [
      { role: "Room", who: room?.label || d.roomName, amount: dollars(room?.fixedCents), email: room?.paypalEmail ?? "" },
      { role: "Opener", who: opener?.label ?? "", amount: dollars(opener?.fixedCents), optional: true, email: opener?.paypalEmail ?? "" },
      { role: "Host", who: host?.label ?? "", amount: dollars(host?.fixedCents), optional: true, email: host?.paypalEmail ?? "" },
      { role: "You", who: "You", amount: dollars(artist?.minimumCents), me: true, email: artist?.paypalEmail ?? "" },
    ],
  };
}

/** Code, not the model, computes the target (spec §3.1): the money core's thresholdPledges. 0 means "add a price". */
export function targetOf(d: Draft): number {
  if (!(d.price > 0)) return 0;
  try {
    const fixedCosts = d.payees.filter((p) => !p.me).map((p) => dollarsToCents(+p.amount || 0));
    const artistMinimum = dollarsToCents(+(d.payees.find((p) => p.me)?.amount ?? 0) || 0);
    return thresholdPledges({ fixedCosts, artistMinimum, ticketPrice: dollarsToCents(d.price), feeBufferBps: d.feeBufferBps });
  } catch {
    return 0;
  }
}

function validDate(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

/** "Fri Nov 20", "Nov 20", "Nov 20, 2026" or "2026-11-20" → "2026-11-20". */
export function parseDay(text: string, year: number): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return validDate(+t.slice(0, 4), +t.slice(5, 7), +t.slice(8, 10));
  const m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(t);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  return mo ? validDate(m[3] ? +m[3] : year, mo, +m[2]) : null;
}

function wallAsUtc(ms: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** A wall-clock time in `tz` as an ISO instant. */
export function zonedIso(y: number, mo: number, d: number, h: number, mi: number, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - (wallAsUtc(guess, zone) - guess);
  t = guess - (wallAsUtc(t, zone) - t);
  return new Date(t).toISOString();
}

/** "Thu Nov 12, 6:00pm", "Nov 12, 9:30am" or "Nov 12" (6pm) in the show's zone → ISO. */
export function parseDeadline(text: string, year: number, tz: string): string | null {
  const m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i.exec(text.trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  const day = mo ? validDate(year, mo, +m[2]) : null;
  if (!day) return null;
  let hour = 18, minute = 0;
  if (m[3]) {
    hour = (+m[3] % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
    minute = m[4] ? +m[4] : 0;
    if (+m[3] > 12 || minute > 59) return null;
  }
  return zonedIso(year, mo, +m[2], hour, minute, tz);
}

/** The draft to sign, or every problem in plain words. Payees with no money are left out; the artist is always last. */
export function toDraftFields(d: Draft): { fields: DraftFields | null; problems: string[] } {
  const problems: string[] = [];
  const showDate = parseDay(d.date, d.year);
  const deadline = parseDeadline(d.deadline, d.year, d.timeZone);
  if (!d.name.trim()) problems.push("Add a show name.");
  if (!d.room.trim()) problems.push("Add the room.");
  if (!showDate) problems.push("Write the show date like Fri Nov 20.");
  if (!(d.price > 0)) problems.push("Add the price of a spot.");
  if (!deadline) problems.push("Write the deadline like Thu Nov 12, 6:00pm.");
  const parties: PartyInput[] = [];
  try {
    for (const p of d.payees) {
      if (!p.me && !(p.amount > 0)) continue;
      const who = p.me ? "you" : p.who.trim() || p.role;
      if (!EMAIL.test(p.email.trim())) problems.push(`Add a PayPal email for ${who}.`);
      if (p.me) parties.push({ role: "artist", label: d.artistLabel, paypalEmail: p.email.trim(), minimumCents: dollarsToCents(p.amount || 0) });
      else parties.push({ role: p.role === "Room" ? "room" : p.role === "Opener" ? "opener" : "host", label: p.who.trim() || (p.role === "Room" ? d.room.trim() : p.role), paypalEmail: p.email.trim(), fixedCents: dollarsToCents(p.amount) });
    }
  } catch {
    problems.push("Check the amounts: use whole dollars and cents.");
  }
  if (problems.length || !showDate || !deadline) return { fields: null, problems };
  return { fields: { showName: d.name.trim(), roomName: d.room.trim(), showDate, ticketPriceCents: dollarsToCents(d.price), feeBufferBps: d.feeBufferBps, deadline, timeZone: d.timeZone, parties }, problems: [] };
}
