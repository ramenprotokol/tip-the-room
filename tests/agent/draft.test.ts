import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { templateDraft } from "../../src/agent/ai-jobs";
import { draftFields, previewDraft, toMandateDraft } from "../../src/agent/draft";
import { ServiceError } from "../../src/agent/errors";
import type { DraftFields } from "../../src/worker/api-types";
import { SHOW } from "./fixtures";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const suggestion = templateDraft("Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200", NOW);

describe("deadline written in the sentence", () => {
  const BASE = "Acoustic set at Lucky's Café, Oct 20, $15 tickets, café wants $100, opener gets $60, I need $200";
  const fields = (sentence: string, now = NOW, timeZone = "America/Chicago") => draftFields(templateDraft(sentence, now), { sentence, timeZone }, now);
  const OCT = Date.parse("2026-10-10T12:00:00Z");

  it("reads the exact example: show Oct 20, pledges close Oct 16 at 6pm local", () => {
    const f = fields(`${BASE}, pledges close Oct 16`, OCT);
    expect(f.showDate).toBe("2026-10-20");
    expect(f.deadline).toBe("2026-10-16T23:00:00.000Z");
  });
  it("understands 'deadline' and 'by' too", () => {
    for (const phrase of ["deadline Oct 16", "pledges close Oct 16", "by Oct 16"]) {
      const f = fields(`${BASE}, ${phrase}`, OCT);
      expect(f.showDate, phrase).toBe("2026-10-20");
      expect(f.deadline, phrase).toBe("2026-10-16T23:00:00.000Z");
    }
  });
  it("never takes the show date from the deadline's date, whichever comes first", () => {
    const f = fields("Pledges close Oct 16. Acoustic set at Lucky's Café, Oct 20, $15 tickets, café wants $100, I need $200", OCT);
    expect(f.showDate).toBe("2026-10-20");
    expect(f.deadline).toBe("2026-10-16T23:00:00.000Z");
    expect(templateDraft("Acoustic set at Lucky's Café, $15 tickets, café wants $100, I need $200, pledges close Oct 16", OCT).showDate).toBeNull();
  });
  it("uses the default instead of a deadline in the past, past 21 days, or after the show", () => {
    const week = new Date(OCT + 7 * DAY_MS).toISOString();
    expect(fields(`${BASE}, pledges close Oct 9`, OCT).deadline).toBe(week);
    expect(fields(`Acoustic set at Lucky's Café, Dec 30, $15 tickets, café wants $100, I need $200, pledges close Dec 20`, OCT).deadline).toBe(week);
    expect(fields(`${BASE}, pledges close Oct 25`, OCT).deadline).toBe(week);
  });
  it("rolls into next year", () => {
    const dec = Date.parse("2026-12-28T12:00:00Z");
    const f = fields("Acoustic set at Lucky's Café, Jan 10, $15 tickets, café wants $100, I need $200, pledges close Jan 3", dec, "UTC");
    expect(f.showDate).toBe("2027-01-10");
    expect(f.deadline).toBe("2027-01-03T18:00:00.000Z");
  });
  it("keeps the 7-day default when the sentence has no deadline, and an explicit deadline wins", () => {
    expect(fields(BASE, OCT).deadline).toBe(new Date(OCT + 7 * DAY_MS).toISOString());
    const sentence = `${BASE}, pledges close Oct 16`;
    expect(draftFields(templateDraft(sentence, OCT), { sentence, deadline: "2026-10-14T18:00:00.000Z" }, OCT).deadline).toBe("2026-10-14T18:00:00.000Z");
  });
});

describe("draft fields", () => {
  it("builds the editable draft with the artist's emails and a 7-day default deadline", () => {
    expect(draftFields(suggestion, { sentence: "x", emails: { room: " room@example.com ", artist: "maya@example.com" } }, NOW)).toEqual({
      showName: "Acoustic set",
      roomName: "Lucky's Café",
      showDate: "2026-11-20",
      ticketPriceCents: 1500,
      feeBufferBps: 500,
      deadline: new Date(NOW + 7 * DAY_MS).toISOString(),
      timeZone: "UTC",
      parties: [
        { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixedCents: 10000 },
        { role: "artist", label: "You", paypalEmail: "maya@example.com", minimumCents: 20000 },
      ],
    });
  });

  it("previews the fan target in code, even with emails missing", () => {
    const withEmails = draftFields(suggestion, { sentence: "x", emails: { room: "room@example.com", artist: "maya@example.com" } }, NOW);
    expect(previewDraft(SHOW, withEmails, NOW)).toEqual({ threshold: 21, problems: [] });
    const noEmails = draftFields(suggestion, { sentence: "x" }, NOW);
    const preview = previewDraft(SHOW, noEmails, NOW);
    expect(preview.threshold).toBe(21);
    expect(preview.problems).toContain("Add a valid PayPal email for You.");
  });

  it("refuses a malformed draft with a 400", () => {
    const bad = { ...draftFields(suggestion, { sentence: "x" }, NOW), parties: "nope" } as unknown as DraftFields;
    expect(() => toMandateDraft(SHOW, bad, new Date(NOW).toISOString())).toThrow(ServiceError);
  });
});
