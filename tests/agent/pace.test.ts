import { describe, expect, it } from "vitest";
import { initialCampaign, reduce } from "../../src/core/campaign";
import { DAY_MS } from "../../src/core/holds";
import { mandateSignedEvent } from "../../src/core/mandate";
import { duePaceCheck, paceCheckTimes, paceNumbers, paceOptions } from "../../src/agent/pace";
import { DEADLINE, LAUNCH, testMandate } from "./fixtures";

const m = testMandate();
const live = reduce(initialCampaign(), mandateSignedEvent(m)).campaign;
const HALF = LAUNCH + 3.5 * DAY_MS;
const LATE = DEADLINE - 3 * DAY_MS;

describe("pace checks", () => {
  it("are at 50% of the window and 72 hours before the deadline", () => {
    expect(paceCheckTimes(m, live)).toEqual([HALF, LATE]);
  });
  it("drop the 72-hour check when it would be before launch", () => {
    expect(paceCheckTimes(m, { ...live, deadline: LAUNCH + 2 * DAY_MS })[1]).toBeNull();
  });
  it("run only the latest due check and mark earlier ones done", () => {
    expect(duePaceCheck(m, live, new Set(), HALF - 1)).toEqual({ run: null, mark: [] });
    expect(duePaceCheck(m, live, new Set(), HALF)).toEqual({ run: 1, mark: [] });
    expect(duePaceCheck(m, live, new Set(), LATE)).toEqual({ run: 2, mark: [1] });
    expect(duePaceCheck(m, live, new Set([2]), LATE)).toEqual({ run: null, mark: [1] });
    expect(duePaceCheck(m, live, new Set(), DEADLINE)).toEqual({ run: null, mark: [] });
  });
  it("project the final count linearly", () => {
    const one = { ...live, pledges: { ...live.pledges, held: 1 } };
    expect(paceNumbers(m, one, HALF)).toEqual({ committed: 1, threshold: 3, daysLeft: 3, hoursLeft: 84, projected: 2, percentElapsed: 50 });
  });
  it("round the time left down like the page countdown, and give hours under a day", () => {
    const one = { ...live, pledges: { ...live.pledges, held: 1 } };
    expect(paceNumbers(m, one, DEADLINE - 25 * 3_600_000)).toMatchObject({ daysLeft: 1, hoursLeft: 25 });
    expect(paceNumbers(m, one, DEADLINE - DAY_MS)).toMatchObject({ daysLeft: 1, hoursLeft: 24 });
    expect(paceNumbers(m, one, DEADLINE - 5 * 3_600_000 - 1)).toMatchObject({ daysLeft: 0, hoursLeft: 5 });
    expect(paceNumbers(m, one, DEADLINE + 1)).toMatchObject({ daysLeft: 0, hoursLeft: 0 });
  });
  it("offer only guard-approved options: extend within 21 days, lower no further than the fixed costs", () => {
    const one = { ...live, pledges: { ...live.pledges, held: 1 } };
    const options = paceOptions(m, one, new Set(), 0, paceNumbers(m, one, HALF));
    expect(options).toEqual([
      { id: "extend", approvalKey: `extend:${DEADLINE + 7 * DAY_MS}`, label: "Extend 7 days", newDeadline: DEADLINE + 7 * DAY_MS },
      { id: "lower", approvalKey: "lower:2", label: "Lower the target to 2", newThreshold: 2 },
    ]);
    const extended = { ...one, extensionsUsed: 1 };
    expect(paceOptions(m, extended, new Set(), 0, paceNumbers(m, extended, HALF)).map((o) => o.id)).toEqual(["lower"]);
  });
});

describe("an extension never reaches the show", () => {
  const ext = (showDate: string, timeZone = "UTC", campaign = live) => {
    const mm = { ...m, showDate, timeZone };
    return paceOptions(mm, { ...campaign, pledges: { ...campaign.pledges, held: 1 } }, new Set(), 0, paceNumbers(mm, campaign, HALF)).find((o) => o.id === "extend");
  };
  it("stops the day before the show: a show 3 days after the deadline gets 2 days, never 7", () => {
    expect(ext("2026-11-11")).toMatchObject({ label: "Extend 2 days", newDeadline: DEADLINE + 2 * DAY_MS });
  });
  it("offers no extension when the show is the day after the deadline, or the same day", () => {
    expect(ext("2026-11-09")).toBeUndefined();
    expect(ext("2026-11-08")).toBeUndefined();
  });
  it("says 1 day, singular, when only one day fits", () => {
    expect(ext("2026-11-10")).toMatchObject({ label: "Extend 1 day", newDeadline: DEADLINE + DAY_MS });
  });
  it("keeps the full 7 days when the show is far enough away", () => {
    expect(ext("2026-11-20")).toMatchObject({ label: "Extend 7 days", newDeadline: DEADLINE + 7 * DAY_MS });
    expect(ext("2026-11-16")).toMatchObject({ label: "Extend 7 days" }); // the new deadline's day is Nov 15, before the show
    expect(ext("2026-11-15")).toMatchObject({ label: "Extend 6 days" });
  });
  it("reads the show's day in the show's time zone, like the mandate does", () => {
    // 2026-11-08T00:00Z is Nov 7, 4pm in Los Angeles, so the last allowed local day before a Nov 10 show is Nov 9: 2 days.
    expect(ext("2026-11-10", "America/Los_Angeles")).toMatchObject({ label: "Extend 2 days" });
    expect(ext("2026-11-10", "UTC")).toMatchObject({ label: "Extend 1 day" });
  });
  it("never offers an extension on or after the show date for any show date", () => {
    for (let day = 8; day <= 30; day++) {
      const showDate = `2026-11-${String(day).padStart(2, "0")}`;
      const o = ext(showDate);
      if (o) expect(new Date(o.newDeadline!).toISOString().slice(0, 10) < showDate).toBe(true);
    }
  });
});

