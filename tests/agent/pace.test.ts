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
    expect(paceNumbers(m, one, HALF)).toEqual({ committed: 1, threshold: 3, daysLeft: 4, projected: 2, percentElapsed: 50 });
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
