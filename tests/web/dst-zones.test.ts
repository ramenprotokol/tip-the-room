// Daylight-saving boundaries: every conversion uses the zone's offset at the instant converted, never the offset "now".
// The clock is pinned, so these pass on any real date. US rules: spring forward Mar 8 2026, fall back Nov 1 2026.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { templateDraft } from "../../src/agent/ai-jobs";
import { draftFields } from "../../src/agent/draft";
import { paceNumbers, paceOptions } from "../../src/agent/pace";
import { initialCampaign, reduce } from "../../src/core/campaign";
import { DAY_MS } from "../../src/core/holds";
import { mandateSignedEvent } from "../../src/core/mandate";
import { restingLine, when } from "../../src/web/shared/format";
import { parseDeadline, zonedIso } from "../../src/web/shared/start-draft";
import { testMandate } from "../agent/fixtures";

const Z = (s: string) => Date.parse(s);
const OCT = "2026-10-05T12:00:00Z";
const DEC = "2026-12-05T12:00:00Z";
const FEB = "2026-02-10T12:00:00Z";
const APR = "2026-04-10T12:00:00Z";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fall back (Nov 1 2026): offsets come from the target date, not from now", () => {
  // zone, wall deadline, expected UTC
  const cases: [string, string, string][] = [
    ["America/Chicago", "Thu Oct 29, 6:00pm", "2026-10-29T23:00:00.000Z"], // CDT -5
    ["America/Chicago", "Thu Nov 12, 6:00pm", "2026-11-13T00:00:00.000Z"], // CST -6
    ["America/New_York", "Thu Oct 29, 6:00pm", "2026-10-29T22:00:00.000Z"], // EDT -4
    ["America/New_York", "Thu Nov 12, 6:00pm", "2026-11-12T23:00:00.000Z"], // EST -5
    ["America/Los_Angeles", "Thu Oct 29, 6:00pm", "2026-10-30T01:00:00.000Z"], // PDT -7
    ["America/Los_Angeles", "Thu Nov 12, 6:00pm", "2026-11-13T02:00:00.000Z"], // PST -8
  ];
  for (const [name, now] of [["October", OCT], ["December", DEC]] as const) {
    it(`parses and shows the same instants when now is in ${name}`, () => {
      vi.setSystemTime(Z(now));
      for (const [tz, wall, utc] of cases) {
        expect(parseDeadline(wall, 2026, tz), `${tz} ${wall}`).toBe(utc);
        expect(when(Z(utc), tz, "long"), `${tz} ${utc}`).toBe(wall);
      }
    });
  }
  it("the hour of the change: 1:30am happens twice in Chicago, then 2am is CST", () => {
    vi.setSystemTime(Z(OCT));
    expect(when(Z("2026-11-01T06:30:00Z"), "America/Chicago", "log")).toBe("Sun 1:30am"); // CDT
    expect(when(Z("2026-11-01T07:30:00Z"), "America/Chicago", "log")).toBe("Sun 1:30am"); // CST
    expect(when(Z("2026-11-01T08:00:00Z"), "America/Chicago", "log")).toBe("Sun 2:00am");
  });
});

describe("spring forward (Mar 8 2026)", () => {
  const cases: [string, string, string][] = [
    ["America/Chicago", "Thu Mar 5, 6:00pm", "2026-03-06T00:00:00.000Z"], // CST -6
    ["America/Chicago", "Thu Mar 12, 6:00pm", "2026-03-12T23:00:00.000Z"], // CDT -5
    ["America/New_York", "Thu Mar 5, 6:00pm", "2026-03-05T23:00:00.000Z"], // EST -5
    ["America/New_York", "Thu Mar 12, 6:00pm", "2026-03-12T22:00:00.000Z"], // EDT -4
    ["America/Los_Angeles", "Thu Mar 5, 6:00pm", "2026-03-06T02:00:00.000Z"], // PST -8
    ["America/Los_Angeles", "Thu Mar 12, 6:00pm", "2026-03-13T01:00:00.000Z"], // PDT -7
  ];
  for (const [name, now] of [["February", FEB], ["April", APR]] as const) {
    it(`is right when now is in ${name}`, () => {
      vi.setSystemTime(Z(now));
      for (const [tz, wall, utc] of cases) {
        expect(parseDeadline(wall, 2026, tz), `${tz} ${wall}`).toBe(utc);
        expect(when(Z(utc), tz, "long"), `${tz} ${utc}`).toBe(wall);
      }
    });
  }
  it("a wall time inside the skipped hour lands on a real instant that day", () => {
    const iso = zonedIso(2026, 3, 8, 2, 30, "America/Chicago");
    expect(["2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z"]).toContain(iso);
  });
});

describe("the same wall time round-trips across the year", () => {
  it("6pm local is 6pm local whatever the offset that day", () => {
    vi.setSystemTime(Z(OCT));
    for (const tz of ["America/Chicago", "America/New_York", "America/Los_Angeles"]) {
      for (let d = 0; d < 365; d += 3) {
        const day = new Date(Date.UTC(2026, 0, 1 + d));
        const iso = zonedIso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 18, 0, tz);
        const back = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", day: "2-digit" }).format(new Date(iso));
        expect(back, `${tz} ${day.toISOString().slice(0, 10)}`).toBe(`${String(day.getUTCDate()).padStart(2, "0")}, 18:00`);
      }
    }
  });
});

describe("the resting notice names the zone abbreviation of the reset instant", () => {
  it("is CDT before the change and CST after, whatever the real date", () => {
    vi.setSystemTime(Z(DEC));
    expect(restingLine(Z("2026-10-20T10:00:00Z"), "America/Chicago")).toContain("7:00 PM CDT");
    expect(restingLine(Z("2026-11-10T10:00:00Z"), "America/Chicago")).toContain("6:00 PM CST");
  });
});

describe("server side: the sentence deadline and the extension window", () => {
  const base = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";
  const draft = (close: string, now: number, tz: string) => {
    const sentence = `${base}, pledges close ${close}`;
    return draftFields(templateDraft(sentence, now), { sentence, timeZone: tz }, now);
  };
  const at = (day: string, hour: number) => new Date(Z(`${day}T00:00:00Z`) + hour * 3_600_000).toISOString();
  it("'pledges close' is 6pm local that day, with now in October (show in November) or November", () => {
    const rows: [string, string, string, number, number][] = [
      // now, close phrase, day, Chicago offset hours, New York offset hours
      ["2026-10-15T12:00:00Z", "Oct 29", "2026-10-29", 5, 4],
      ["2026-10-15T12:00:00Z", "Nov 2", "2026-11-02", 6, 5],
      ["2026-10-31T12:00:00Z", "Nov 2", "2026-11-02", 6, 5],
      ["2026-11-01T12:00:00Z", "Nov 12", "2026-11-12", 6, 5],
    ];
    for (const [now, close, day, chi, ny] of rows) {
      vi.setSystemTime(Z(now));
      expect(draft(close, Date.now(), "America/Chicago").deadline, `Chicago ${now} ${close}`).toBe(at(day, 18 + chi));
      expect(draft(close, Date.now(), "America/New_York").deadline, `New York ${now} ${close}`).toBe(at(day, 18 + ny));
    }
  });
  it("the extend option reads the show's day in the zone at the new deadline (Chicago, across Nov 1)", () => {
    vi.setSystemTime(Z(OCT));
    const deadline = "2026-10-29T23:00:00.000Z"; // Thu 6pm CDT
    for (const [showDate, days] of [["2026-11-01", 2], ["2026-11-03", 4]] as const) {
      const m = { ...testMandate(), showDate, timeZone: "America/Chicago", launchedAt: "2026-10-22T23:00:00.000Z", deadline };
      const live = reduce(initialCampaign(), mandateSignedEvent(m)).campaign;
      const one = { ...live, pledges: { ...live.pledges, held: 1 } };
      const ext = paceOptions(m, one, new Set(), 0, paceNumbers(m, one, Z("2026-10-26T12:00:00Z"))).find((o) => o.id === "extend");
      expect(ext?.label, showDate).toBe(`Extend ${days} days`);
      expect(ext!.newDeadline! - Z(deadline)).toBe(days * DAY_MS);
    }
  });
});
