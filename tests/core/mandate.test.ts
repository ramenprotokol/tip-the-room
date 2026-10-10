import { describe, expect, it } from "vitest";
import { initialCampaign, reduce } from "../../src/core/campaign";
import {
  MandateDraftError,
  buildMandate,
  canonicalJSON,
  deadlineMs,
  mandateSignedEvent,
  signMandate,
  validateDraft,
  validateMandate,
  verifyMandate,
  type Mandate,
  type MandateDraft,
} from "../../src/core/mandate";

const draft: MandateDraft = {
  showId: "juniper-vale-nov-20",
  showName: "Juniper Vale",
  roomName: "Spindle Records",
  showDate: "2026-11-20",
  ticketPrice: 1500,
  feeBufferBps: 500,
  parties: [
    { role: "room", label: "Spindle Records", paypalEmail: "room@example.com", fixed: 8000 },
    { role: "opener", label: "The Low Tides", paypalEmail: "opener@example.com", fixed: 10000 },
    { role: "artist", label: "Juniper Vale", paypalEmail: "artist@example.com", minimum: 30000 },
  ],
  launchedAt: "2026-11-04T18:00:00.000Z",
  deadline: "2026-11-19T02:00:00.000Z",
};

/** Builds a Mandate without validation, so validateMandate can be tested on bad input. */
const raw = (d: MandateDraft): Mandate => ({ ...d, version: 1, threshold: 34, maxExtensions: 1, maxExtensionDays: 7 });

describe("buildMandate", () => {
  it("computes the fan target and fixes the extension limits", () => {
    const m = buildMandate(draft);
    expect(m.threshold).toBe(34);
    expect(m.version).toBe(1);
    expect(m.maxExtensions).toBe(1);
    expect(m.maxExtensionDays).toBe(7);
    expect(validateMandate(m)).toEqual([]);
  });
});

describe("validateMandate", () => {
  it("rejects a window longer than 21 days", () => {
    const m = raw({ ...draft, deadline: "2026-11-26T18:00:01.000Z", showDate: "2026-11-30" });
    expect(validateMandate(m)).toContain("The pledge window can be at most 21 days.");
  });
  it("rejects a deadline before launch, a show before the deadline, and a bad email", () => {
    const m = raw({
      ...draft,
      deadline: "2026-11-03T00:00:00.000Z",
      parties: [{ ...draft.parties[0], paypalEmail: "not-an-email" }, draft.parties[1], draft.parties[2]],
    });
    const problems = validateMandate(m);
    expect(problems).toContain("The deadline must be after the show goes live.");
    expect(problems).toContain("Add a valid PayPal email for Spindle Records.");
    const late = raw({ ...draft, showDate: "2026-11-18" });
    expect(validateMandate(late)).toContain("The show must be on or after the pledge deadline.");
  });
  it("rejects an empty show name", () => {
    expect(validateMandate(raw({ ...draft, showName: "  " }))).toContain("Give the show a name.");
  });
});

const DAY = 24 * 60 * 60 * 1000;
const PRICE = "The pledge must be more than $0.";
const SHOW_DATE = "The show must be on or after the pledge deadline.";
const DATE_FORMAT = "The show date must look like 2026-11-20.";

describe("validateDraft", () => {
  it("returns no problems for a good draft", () => {
    expect(validateDraft(draft)).toEqual([]);
  });
  it("reports a zero ticket price without throwing", () => {
    expect(validateDraft({ ...draft, ticketPrice: 0 })).toContain(PRICE);
  });
  it("reports a fee buffer out of range", () => {
    expect(validateDraft({ ...draft, feeBufferBps: 6000 })).toContain("The fee buffer must be between 0% and 50%.");
  });
  it("reports a negative fixed amount for a payee", () => {
    const parties = [{ ...draft.parties[0], fixed: -5 }, draft.parties[1], draft.parties[2]];
    expect(validateDraft({ ...draft, parties })).toContain("Spindle Records needs a fixed amount.");
  });
  it("reports an artist minimum that is not whole cents", () => {
    const parties = [draft.parties[0], draft.parties[1], { ...draft.parties[2], minimum: 10.5 }];
    expect(validateDraft({ ...draft, parties })).toContain("Juniper Vale needs a minimum in whole dollars and cents.");
  });
  it("reports blank names and ids in plain English", () => {
    const parties = [{ ...draft.parties[0], label: " " }, draft.parties[1], draft.parties[2]];
    const problems = validateDraft({ ...draft, showId: "", roomName: "", parties });
    expect(problems).toContain("This show needs an id.");
    expect(problems).toContain("Say where the show is.");
    expect(problems).toContain("A payee needs a name.");
  });
  it("accepts a deadline exactly 21 days after launch and rejects 21 days plus 1 ms", () => {
    const launch = Date.parse(draft.launchedAt);
    const ok = new Date(launch + 21 * DAY).toISOString();
    const over = new Date(launch + 21 * DAY + 1).toISOString();
    const late = "2027-01-01";
    expect(validateDraft({ ...draft, deadline: ok, showDate: late })).not.toContain("The pledge window can be at most 21 days.");
    expect(validateDraft({ ...draft, deadline: over, showDate: late })).toContain("The pledge window can be at most 21 days.");
  });
  it("compares the show date with the deadline in the show's time zone", () => {
    const base = { ...draft, showDate: "2026-11-18", deadline: "2026-11-19T02:00:00.000Z" };
    expect(validateDraft({ ...base, timeZone: "America/Los_Angeles" })).not.toContain(SHOW_DATE);
    expect(validateDraft(base)).toContain(SHOW_DATE);
    expect(validateDraft({ ...base, timeZone: "Mars/Olympus" })).toContain("Pick a real time zone.");
  });
  it("rejects show dates that are badly formed or not real", () => {
    expect(validateDraft({ ...draft, showDate: "2026-11-5" })).toContain(DATE_FORMAT);
    expect(validateDraft({ ...draft, showDate: "2026-13-45" })).toContain(DATE_FORMAT);
    expect(validateDraft({ ...draft, showDate: "2026-02-30" })).toContain(DATE_FORMAT);
  });
  it("rejects unreal launch and deadline timestamps and skips date comparisons", () => {
    const problems = validateDraft({ ...draft, deadline: "soon" });
    expect(problems).toContain("The launch time and deadline must be real dates.");
    expect(problems).not.toContain(SHOW_DATE);
  });
});

describe("strict timestamps", () => {
  const REAL = "The launch time and deadline must be real dates.";
  it("rejects a timestamp with no offset", () => {
    expect(validateDraft({ ...draft, deadline: "2026-11-19T02:00:00" })).toContain(REAL);
    expect(validateDraft({ ...draft, launchedAt: "2026-11-04T18:00:00" })).toContain(REAL);
  });
  it("rejects a timestamp whose calendar date is not real", () => {
    expect(validateDraft({ ...draft, deadline: "2026-02-30T00:00:00Z" })).toContain(REAL);
  });
  it("accepts a timestamp with a numeric offset", () => {
    expect(validateDraft({ ...draft, deadline: "2026-11-19T02:00:00-08:00" })).not.toContain(REAL);
  });
});

describe("payout order and roles", () => {
  const ROLE = "Each payee must be the room, an opener, a host or the artist.";
  const ORDER = "Payees must be listed as room, opener, host, then the artist.";
  it("rejects an unknown role", () => {
    const parties = [{ ...draft.parties[0], role: "venue" as never }, draft.parties[1], draft.parties[2]];
    expect(validateDraft({ ...draft, parties })).toContain(ROLE);
  });
  it("rejects payees out of order", () => {
    const parties = [draft.parties[1], draft.parties[0], draft.parties[2]];
    expect(validateDraft({ ...draft, parties })).toContain(ORDER);
  });
  it("rejects the artist listed before another payee", () => {
    const parties = [draft.parties[0], draft.parties[2], draft.parties[1]];
    expect(validateDraft({ ...draft, parties })).toContain(ORDER);
  });
  it("accepts room, opener, host, artist in order", () => {
    const host = { role: "host" as const, label: "Host", paypalEmail: "host@example.com", fixed: 100 };
    const parties = [draft.parties[0], draft.parties[1], host, draft.parties[2]];
    expect(validateDraft({ ...draft, parties })).not.toContain(ORDER);
  });
});

describe("mandate and campaign helpers", () => {
  it("normalises the time zone to UTC when none is given", () => {
    expect(buildMandate(draft).timeZone).toBe("UTC");
    expect(buildMandate({ ...draft, timeZone: "America/Los_Angeles" }).timeZone).toBe("America/Los_Angeles");
  });
  it("turns a mandate into a signed event that makes a live campaign", () => {
    const m = buildMandate(draft);
    expect(deadlineMs(m)).toBe(Date.parse(draft.deadline));
    const event = mandateSignedEvent(m);
    expect(event).toEqual({ type: "mandate_signed", threshold: m.threshold, deadline: Date.parse(draft.deadline) });
    const { campaign } = reduce(initialCampaign(), event);
    expect(campaign.state).toBe("live");
    expect(campaign.threshold).toBe(m.threshold);
    expect(campaign.deadline).toBe(Date.parse(draft.deadline));
  });
});

describe("buildMandate with a bad draft", () => {
  it("throws a MandateDraftError with plain-English problems, never a RangeError", () => {
    let caught: unknown;
    try {
      buildMandate({ ...draft, ticketPrice: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MandateDraftError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as MandateDraftError).problems).toContain(PRICE);
    expect((caught as MandateDraftError).message).toContain(PRICE);
  });
});

describe("canonicalJSON", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, 1], c: true } })).toBe('{"a":{"c":true,"d":[3,1]},"b":1}');
  });
});

describe("signMandate / verifyMandate", () => {
  it("hashes the canonical mandate with SHA-256 and detects tampering", async () => {
    const signed = await signMandate(buildMandate(draft), "2026-11-04T18:05:00.000Z");
    expect(signed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMandate(signed)).toBe(true);
    const tampered = { ...signed, mandate: { ...signed.mandate, threshold: 20 } };
    expect(await verifyMandate(tampered)).toBe(false);
  });
  it("detects a changed PayPal email after signing", async () => {
    const signed = await signMandate(buildMandate(draft), "2026-11-04T18:05:00.000Z");
    const parties = signed.mandate.parties.map((p, i) => (i === 0 ? { ...p, paypalEmail: "thief@example.com" } : p));
    expect(await verifyMandate({ ...signed, mandate: { ...signed.mandate, parties } })).toBe(false);
  });
  it("produces the same hash regardless of key order", async () => {
    const m = buildMandate(draft);
    const reordered = JSON.parse(JSON.stringify(m, Object.keys(m).reverse()));
    const a = await signMandate(m, "x");
    const b = await signMandate({ ...reordered, parties: m.parties }, "x");
    expect(a.hash).toBe(b.hash);
  });
});
