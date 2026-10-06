import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { templateDraft } from "../../src/agent/ai-jobs";
import { draftFields, previewDraft, toMandateDraft } from "../../src/agent/draft";
import { ServiceError } from "../../src/agent/errors";
import type { DraftFields } from "../../src/worker/api-types";
import { SHOW } from "./fixtures";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const suggestion = templateDraft("Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200", NOW);

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
    expect(preview.problems).toContain("You needs a valid PayPal email.");
  });

  it("refuses a malformed draft with a 400", () => {
    const bad = { ...draftFields(suggestion, { sentence: "x" }, NOW), parties: "nope" } as unknown as DraftFields;
    expect(() => toMandateDraft(SHOW, bad, new Date(NOW).toISOString())).toThrow(ServiceError);
  });
});
