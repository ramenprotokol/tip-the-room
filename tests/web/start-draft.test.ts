import { describe, expect, it } from "vitest";
import type { DraftFields } from "../../src/worker/api-types";
import { dollarsOf, fromDraft, SAFE_PATH, parseDay, parseDeadline, targetOf, toDraftFields } from "../../src/web/shared/start-draft";

const DRAFT: DraftFields = {
  showName: "Acoustic Set", roomName: "Lucky’s Café", showDate: "2026-11-20", ticketPriceCents: 1500, feeBufferBps: 500, deadline: "2026-11-12T18:00:00.000Z", timeZone: "UTC",
  parties: [{ role: "room", label: "Lucky’s Café", paypalEmail: "", fixedCents: 10000 }, { role: "artist", label: "Maya", paypalEmail: "", minimumCents: 20000 }],
};

describe("start draft", () => {
  it("shows the server draft the way the reference does", () => {
    const d = fromDraft(DRAFT);
    expect([d.name, d.room, d.date, d.price, d.deadline]).toEqual(["Acoustic Set", "Lucky’s Café", "Fri Nov 20", 15, "Thu Nov 12, 6:00pm"]);
    expect(d.payees.map((p) => [p.role, p.who, p.amount])).toEqual([["Room", "Lucky’s Café", 100], ["Opener", "", 0], ["Host", "", 0], ["You", "You", 200]]);
    expect(targetOf(d)).toBe(21);
  });

  it("reads dates and deadlines back in the show's zone", () => {
    expect(parseDay("Fri Nov 20", 2026)).toBe("2026-11-20");
    expect(parseDay("nov 20", 2026)).toBe("2026-11-20");
    expect(parseDay("2026-11-20", 2026)).toBe("2026-11-20");
    expect(parseDay("Feb 30", 2026)).toBeNull();
    expect(parseDay("soon", 2026)).toBeNull();
    expect(parseDeadline("Thu Nov 12, 6:00pm", 2026, "UTC")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseDeadline("Nov 12", 2026, "UTC")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseDeadline("Nov 12, 9:30am", 2026, "UTC")).toBe("2026-11-12T09:30:00.000Z");
    expect(parseDeadline("Thu Nov 12, 6:00pm", 2026, "America/Vancouver")).toBe("2026-11-13T02:00:00.000Z");
    expect(parseDeadline("whenever", 2026, "UTC")).toBeNull();
  });

  it("builds the signing draft, artist last, only payees with money", () => {
    const d = fromDraft(DRAFT);
    d.payees[0].email = "luckys-cafe@example.com";
    d.payees[3].email = "maya@example.com";
    d.payees[1].who = "The Low Tides";
    d.payees[1].amount = 50;
    d.payees[1].email = "tides@example.com";
    const { fields, problems } = toDraftFields(d);
    expect(problems).toEqual([]);
    expect(fields).toEqual({
      showName: "Acoustic Set", roomName: "Lucky’s Café", showDate: "2026-11-20", ticketPriceCents: 1500, feeBufferBps: 500, deadline: "2026-11-12T18:00:00.000Z", timeZone: "UTC",
      parties: [
        { role: "room", label: "Lucky’s Café", paypalEmail: "luckys-cafe@example.com", fixedCents: 10000 },
        { role: "opener", label: "The Low Tides", paypalEmail: "tides@example.com", fixedCents: 5000 },
        { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimumCents: 20000 },
      ],
    });
    expect(targetOf(d)).toBe(25);
  });

  it("lists every problem in plain words instead of signing", () => {
    const d = fromDraft(DRAFT);
    d.date = "someday";
    d.price = 0;
    const { fields, problems } = toDraftFields(d);
    expect(fields).toBeNull();
    expect(problems).toEqual(["Write the show date like Fri Nov 20.", "Add the price of a spot.", "Add a PayPal email for Lucky’s Café.", "Add a PayPal email for you."]);
  });
});

describe("typed dollars and server paths", () => {
  it("rounds typed dollars to the cent, half up, the way a person reads them", () => {
    expect(dollarsOf("100.005")).toBe(100.01);
    expect(dollarsOf("$1,200.5")).toBe(1200.5);
    expect(dollarsOf("")).toBe(0);
    expect(dollarsOf("1.2.3")).toBe(0);
    expect(dollarsOf("15")).toBe(15);
  });
  it("only lets plain show paths into links", () => {
    expect(SAFE_PATH.test("/s/abc123")).toBe(true);
    expect(SAFE_PATH.test("/s/abc123/manage")).toBe(true);
    expect(SAFE_PATH.test("javascript:alert(1)")).toBe(false);
    expect(SAFE_PATH.test("//evil.example/s/abc")).toBe(false);
    expect(SAFE_PATH.test("/s/ABC")).toBe(false);
  });
});
