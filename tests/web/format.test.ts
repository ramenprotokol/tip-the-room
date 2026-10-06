import { describe, expect, it } from "vitest";
import { RULES, type RuleId } from "../../src/core/rules";
import { andList, askEmphasis, dayLabel, dollars, emphasis, endOf, fineLine, money2, payoutsConfirmed, payState, planSplit, remainSec, rulesLine, ShowClock, when } from "../../src/web/shared/format";

const T = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h, mi);
const text = (segs: { text: string; cls: string }[]) => segs.map((s) => (s.cls ? `[${s.cls}:${s.text}]` : s.text)).join("");

describe("dates in the show's time zone", () => {
  it("formats like the reference pages", () => {
    expect(when(T(11, 12, 18), "UTC", "long")).toBe("Thu Nov 12, 6:00pm");
    expect(when(T(11, 12, 18), "UTC", "faq")).toBe("Thu Nov 12, 6pm");
    expect(when(T(11, 12, 18), "UTC", "short")).toBe("Thu 6pm");
    expect(when(T(11, 9, 9, 11), "UTC", "log")).toBe("Mon 9:11am");
    expect(when(T(11, 3, 19, 12), "UTC", "ledger")).toBe("Nov 3 · 7:12pm");
    expect(when(T(11, 12, 18, 30), "UTC", "short")).toBe("Thu 6:30pm");
    expect(when(T(11, 12, 12), "UTC", "long")).toBe("Thu Nov 12, 12:00pm");
    expect(when(T(11, 12, 0), "UTC", "long")).toBe("Thu Nov 12, 12:00am");
    expect(when(T(11, 13, 2), "America/Vancouver", "long")).toBe("Thu Nov 12, 6:00pm");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(when(T(11, 12, 18), "Not/AZone", "long")).toBe("Thu Nov 12, 6:00pm");
  });
  it("labels a show date", () => {
    expect(dayLabel("2026-11-20")).toBe("Fri Nov 20");
    expect(dayLabel("nope")).toBe("nope");
  });
});

describe("money", () => {
  it("rounds whole dollars like usd() and shows cents in the ledger", () => {
    expect(dollars(31500)).toBe("$315");
    expect(dollars(123456)).toBe("$1,235");
    expect(money2(1500)).toBe("$15.00");
    expect(money2(123456)).toBe("$1,234.56");
  });
  it("splits in signed order, artist gets the rest", () => {
    const split = [{ role: "room" as const, fixedCents: 8000 }, { role: "opener" as const, fixedCents: 10000 }, { role: "artist" as const, fixedCents: null }];
    expect(planSplit(split, 51000)).toEqual([8000, 10000, 33000]);
    expect(planSplit(split, 12000)).toEqual([8000, 4000, 0]);
  });
  it("writes the money rules line", () => {
    expect(rulesLine([{ role: "room", label: "x", fixedCents: 8000, minimumCents: null }, { role: "opener", label: "y", fixedCents: 10000, minimumCents: null }, { role: "artist", label: "z", fixedCents: null, minimumCents: 30000 }])).toBe("Money rules: Room $80 → Opener $100 → Artist gets the rest");
    expect(andList(["room", "opener", "artist"])).toBe("room, opener and artist");
    expect(andList(["you"])).toBe("you");
  });
});

describe("agent log", () => {
  it("numbers rules like the page list and joins the small print", () => {
    expect(fineLine({ saw: "1 PayPal payout batch · 2 items", rule: "rule-4-pay-the-split", requestId: null, resultId: null })).toBe("1 PayPal payout batch · 2 items · money rule 3");
    expect(fineLine({ saw: "voided 12 PayPal authorizations", rule: "rule-3-void-on-miss", requestId: null, resultId: null })).toBe("voided 12 PayPal authorizations · money rule 4");
    expect(fineLine({ saw: "x", rule: null, requestId: "capture-p1", resultId: "3C1234567X" })).toBe("x · capture-p1 · 3C1234567X");
  });
  it("shows the server's rule number for every rule id", () => {
    for (const id of Object.keys(RULES) as RuleId[]) {
      expect(fineLine({ saw: "x", rule: id, requestId: null, resultId: null })).toBe(`x · money rule ${RULES[id].number}`);
    }
  });
  it("emphasises the same words the reference does", () => {
    expect(text(emphasis("You signed the money rules. Your show is live."))).toBe("You signed the money rules. [b:Your show is live.]");
    expect(text(emphasis("Pace check: 12 of 21 with 3 days left. I asked you about the deadline."))).toBe("[w-ask:Pace check:] 12 of 21 with 3 days left. I asked you about the deadline.");
    expect(text(emphasis("You approved it. The new deadline is Mon Nov 16, 6pm. Fans see it now."))).toBe("You approved it. [b:The new deadline is Mon Nov 16, 6pm.] Fans see it now.");
    expect(text(emphasis("Your show reached 21 fans. It’s on! Everyone was charged at once: $315."))).toBe("[b:Your show reached 21 fans. It’s on!] Everyone was charged at once: $315.");
    expect(text(emphasis("Deadline reached. Paid Lucky’s Café $100, then you $215."))).toBe("Deadline reached. [w-paid:Paid Lucky’s Café $100, then you $215.]");
    expect(text(emphasis("Your show ended at 12 of 21. Every hold was cancelled. Nobody paid."))).toBe("Your show ended at 12 of 21. [w-rel:Every hold was cancelled. Nobody paid.]");
    expect(text(emphasis("5 more fans joined after it tipped, and were charged right away: $75."))).toBe("5 more fans joined after it tipped, and were [b:charged right away]: $75.");
    expect(text(emphasis("Watching 2 shows. 48 fans are on hold and nobody has been charged."))).toBe("Watching 2 shows. [b:48 fans are on hold] and [w-held:nobody has been charged].");
    expect(text(emphasis("5 more fans held a spot. PayPal is holding their $75."))).toBe("5 more fans held a spot. PayPal is holding their $75.");
    expect(text(emphasis("<img src=x onerror=alert(1)>"))).toBe("<img src=x onerror=alert(1)>");
    expect(text(askEmphasis("Lucky’s Café is at 12 of 21 with 3 days left. At this pace it lands near 17."))).toBe("Lucky’s Café is at [b:12 of 21] with 3 days left. At this pace it lands near 17.");
  });
});

describe("show state", () => {
  it("maps campaign states to the end the page animates toward", () => {
    expect(["draft", "live", "tipped", "paying_out", "settled", "missed", "cancelled"].map((s) => endOf(s as never))).toEqual(["live", "live", "tipped", "paid", "paid", "missed", "cancelled"]);
  });
  it("calls payouts confirmed only when every party is paid", () => {
    expect(payoutsConfirmed([{ payoutStatus: "paid" }, { payoutStatus: "none" }])).toBe(true);
    expect(payoutsConfirmed([{ payoutStatus: "paid" }, { payoutStatus: "pending" }])).toBe(false);
    expect(payoutsConfirmed([])).toBe(false);
  });
  it("counts down on the show's clock and re-bases only on a big jump", () => {
    const c = new ShowClock(T(11, 9, 9), 1_000_000);
    expect(remainSec(T(11, 12, 18), c, 1_000_000)).toBe(291600);
    expect(remainSec(T(11, 12, 18), c, 1_003_000)).toBe(291597);
    c.sync(T(11, 9, 9), 1_005_000);
    expect(c.now(1_005_000)).toBe(T(11, 9, 9) + 5000);
    c.sync(T(11, 12, 18, 1), 1_005_000);
    expect(remainSec(T(11, 12, 18), c, 1_005_000)).toBe(0);
    expect(remainSec(T(11, 12, 18), null)).toBe(0);
  });
});

describe("payState", () => {
  const ps = (...s: string[]) => s.map((payoutStatus) => ({ payoutStatus }));
  it("names what the money did after the deadline", () => {
    expect(payState(ps("paid", "none"))).toBe("confirmed");
    expect(payState(ps("paid", "failed"))).toBe("failed");
    expect(payState(ps("planned", "pending"))).toBe("planned");
    expect(payState(ps("paid", "pending"))).toBe("waiting");
    expect(payState([])).toBe("waiting");
  });
});
