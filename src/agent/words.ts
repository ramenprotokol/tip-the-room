import { fansCommitted, type CampaignState } from "../core/campaign";
import type { Mandate } from "../core/mandate";
import { PayPalError } from "../paypal/errors";
import type { PledgeView, Projection } from "./project";

/** A time in the show's own time zone, e.g. "Thu, Nov 5, 6:00 PM PST" (spec 2c: never GMT on screen). */
export function showTime(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
  } catch {
    return new Date(ms).toUTCString();
  }
}

export const STATE_WORDS: Record<CampaignState, string> = {
  draft: "a draft",
  live: "waiting for fans",
  tipped: "on, and charging fans",
  paying_out: "paying everyone",
  settled: "settled, everyone's paid",
  missed: "called off, nobody paid",
  cancelled: "called off by the artist",
};

export function fanName(p: PledgeView): string {
  return `Fan ${String(p.number).padStart(2, "0")} · ${p.initials}`;
}

/** The "saw" column of the agent log. */
export function sawCounts(p: Projection): string {
  const c = p.campaign;
  return `${fansCommitted(c)} of ${c.threshold} fans · ${c.pledges.held} on hold · ${c.pledges.charged} charged · the show is ${STATE_WORDS[c.state]}`;
}

export function holdDescription(m: Mandate): string {
  return `Hold for ${m.showName} at ${m.roomName}`.slice(0, 127);
}

/**
 * Short error text for INTERNAL job notes only: PayPal's status, error name and issue codes, never its message.
 * It must never be put into a user-facing log line, ledger row or API error.
 */
export function errText(e: unknown): string {
  if (e instanceof PayPalError) {
    const issues = e.issues
      .map((i) => i.issue)
      .filter(Boolean)
      .join(",");
    return `${e.status} ${e.paypalName}${issues ? ` ${issues}` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}
