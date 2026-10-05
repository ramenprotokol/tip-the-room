import { describe, expect, it } from "vitest";
import { buildMandate, canonicalJSON, signMandate, validateMandate, verifyMandate, type MandateDraft } from "../../src/core/mandate";

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
    const m = buildMandate({ ...draft, deadline: "2026-11-26T18:00:01.000Z", showDate: "2026-11-30" });
    expect(validateMandate(m)).toContain("The pledge window can be at most 21 days.");
  });
  it("rejects a deadline before launch, a show before the deadline, and a bad email", () => {
    const m = buildMandate({
      ...draft,
      deadline: "2026-11-03T00:00:00.000Z",
      parties: [{ ...draft.parties[0], paypalEmail: "not-an-email" }, draft.parties[1], draft.parties[2]],
    });
    const problems = validateMandate(m);
    expect(problems).toContain("The deadline must be after the show goes live.");
    expect(problems).toContain("Spindle Records needs a valid PayPal email.");
    const late = buildMandate({ ...draft, showDate: "2026-11-18" });
    expect(validateMandate(late)).toContain("The show must be on or after the pledge deadline.");
  });
  it("rejects an empty show name", () => {
    expect(validateMandate(buildMandate({ ...draft, showName: "  " }))).toContain("Give the show a name.");
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
  it("produces the same hash regardless of key order", async () => {
    const m = buildMandate(draft);
    const reordered = JSON.parse(JSON.stringify(m, Object.keys(m).reverse()));
    const a = await signMandate(m, "x");
    const b = await signMandate({ ...reordered, parties: m.parties }, "x");
    expect(a.hash).toBe(b.hash);
  });
});
