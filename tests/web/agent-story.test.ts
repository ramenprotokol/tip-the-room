import { describe, expect, it } from "vitest";
import { buildDecisions, firstCents, groupKind, groupSummary, KIND_WORD, money, paceNeeds, paceReady, ruleLabel, type StoryEntry } from "../../src/web/shared/agent-story";
import type { RuleId } from "../../src/core/rules";

let seq = 0;
function line(tag: string, did: string, rule: RuleId | null = null, extra: Partial<StoryEntry> = {}): StoryEntry & { tag: string } {
  seq += 1;
  return { tag, seq, at: 1_000 * seq, saw: "", did, rule, requestId: null, resultId: null, ...extra };
}
const seed = (tag: string, n: number) => line(tag, `Simulated Fan ${String(n).padStart(2, "0")} · JR held a spot with a real sandbox card hold. Nobody is charged yet.`, "rule-1-hold-only");
const charge = (tag: string, n: number, amount = "$15.00") => line(tag, `Charged Fan ${String(n).padStart(2, "0")} · JR ${amount}. After PayPal's fee, $14.12 came in.`, "rule-2-capture-at-tip", { resultId: `CAP${n}` });
const cancel = (tag: string, n: number, rule: RuleId = "rule-3-void-on-miss") => line(tag, `Cancelled Fan ${String(n).padStart(2, "0")} · JR's hold. Nobody was charged.`, rule);

describe("which log lines fold into one row", () => {
  it("folds a simulated fan's hold, a charge and a cancelled hold, and nothing else", () => {
    expect(groupKind(seed("a", 1))).toBe("seed");
    expect(groupKind(charge("a", 1))).toBe("charge");
    expect(groupKind(cancel("a", 1))).toBe("cancel");
    expect(groupKind({ did: "Fan 03 · AK held a spot. PayPal is holding $15.00; nobody is charged yet." })).toBeNull();
    expect(groupKind({ did: "Proposed: Lower the target to 25 or Extend 7 days. Waiting for the artist." })).toBeNull();
    expect(groupKind({ did: "Sent the payouts exactly as signed: Room $80.00." })).toBeNull();
    expect(groupKind({ did: "Needs attention: Fan 01 · JR's charge went through at PayPal, but this show's record already says otherwise." })).toBeNull();
  });

  it("reads the first dollar amount in cents", () => {
    expect(firstCents("Charged Fan 03 · JR $15.00. After PayPal's fee, $14.12 came in.")).toBe(1500);
    expect(firstCents("Charged Fan 03 · JR $1,250.50.")).toBe(125050);
    expect(firstCents("whole $8 only")).toBe(800);
    expect(firstCents("no money here")).toBe(0);
    expect(money(51000)).toBe("$510.00");
  });

  it("words the seeding summary: progress, finished, fans added later, and the show page that does not know the start", () => {
    expect(groupSummary("seed", { count: 26, cents: 0 }, 29)).toBe("26 of 29 starting fans held a spot (real PayPal sandbox card holds)");
    expect(groupSummary("seed", { count: 29, cents: 0 }, 29)).toBe("29 of 29 starting fans held a spot (real PayPal sandbox card holds)");
    expect(groupSummary("seed", { count: 34, cents: 0 }, 29)).toBe("29 starting fans and 5 added fans held a spot (real PayPal sandbox card holds)");
    expect(groupSummary("seed", { count: 30, cents: 0 }, 29)).toBe("29 starting fans and 1 added fan held a spot (real PayPal sandbox card holds)");
    expect(groupSummary("seed", { count: 1, cents: 0 })).toBe("1 simulated fan held a spot (real PayPal sandbox card holds)");
    expect(groupSummary("seed", { count: 12, cents: 0 })).toBe("12 simulated fans held a spot (real PayPal sandbox card holds)");
  });

  it("words the charge and cancel summaries with counts and the total", () => {
    expect(groupSummary("charge", { count: 36, cents: 54000 })).toContain("36 holds charged, $540.00 in all");
    expect(groupSummary("charge", { count: 1, cents: 1500 })).toContain("1 hold charged, $15.00 in all");
    expect(groupSummary("cancel", { count: 28, cents: 0 })).toContain("28 holds cancelled, nobody charged");
  });
});

describe("the Decisions strip", () => {
  it("is empty while the log is only seeding lines", () => {
    expect(buildDecisions([line("a", "Seeded Juniper Vale: 34 fans needed."), seed("a", 1), seed("a", 2), seed("b", 1)])).toEqual([]);
  });

  it("lists the pace proposal with the rule that let the agent ask, then the approval", () => {
    const d = buildDecisions([
      line("b", "Demo: skipped ahead to three quarters of the way to the deadline for a pace check."),
      line("b", "Proposed: Lower the target to 25 or Extend 7 days. Waiting for the artist.", "rule-5-ask-first"),
      line("b", 'The artist approved "Lower the target to 25". This is allowed: the artist said yes.', "rule-5-ask-first"),
    ]);
    expect(d.map((x) => x.kind)).toEqual(["proposed", "approved"]);
    expect(d[0].text).toBe("Behind pace. Proposed: Lower the target to 25 or Extend 7 days. Waiting for the artist.");
    expect(d[0].rule).toBe(5);
    expect(d[1].text).toBe('The artist approved "Lower the target to 25". The agent applied it.');
    expect(d[1].rule).toBe(5);
    expect(ruleLabel("rule-5-ask-first")).toBe("Money rule 5 · ask the artist first");
  });

  it('records "not now" as the artist, not "You", and a show that was on pace', () => {
    const d = buildDecisions([
      line("b", 'You said not now to "Lower the target to 25" or "Extend 7 days". Nothing changes.'),
      line("a", "On pace. Nothing to change."),
    ]);
    expect(d[0].kind).toBe("notnow");
    expect(d[0].text).toBe('The artist said not now to "Lower the target to 25" or "Extend 7 days". Nothing changes.');
    expect(d[0].rule).toBeNull();
    expect(d[1]).toMatchObject({ kind: "checked", rule: null });
  });

  it("names the tip with the fan count from what the agent saw, and the rule that charges every hold", () => {
    const d = buildDecisions([line("a", "The show reached its target. Charging every hold now.", "rule-2-capture-at-tip", { saw: "34 of 34 fans · 34 on hold · 0 charged · the show is on" })]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "tipped", text: "34 of 34 fans. The show reached its target. Charging every hold now.", rule: 2 });
    const lower = buildDecisions([line("b", "The lower target is already met. Charging every hold now.", "rule-2-capture-at-tip")]);
    expect(lower[0].text).toBe("The lower target is already met. Charging every hold now.");
  });

  it('collapses 36 charge lines into one "Charged 36 holds, $540.00" row that keeps its place', () => {
    const entries = [line("a", "The show reached its target. Charging every hold now.", "rule-2-capture-at-tip"), ...Array.from({ length: 36 }, (_, i) => charge("a", i + 1)), line("a", "Wrote a plain-English settlement note for each of the 3 people involved.")];
    const d = buildDecisions(entries);
    expect(d.map((x) => x.kind)).toEqual(["tipped", "charged"]);
    expect(d[1].text).toBe("Charged 36 holds, $540.00. Every fan who held a spot was charged at once.");
    expect(d[1].rule).toBe(2);
    // While the charges are still coming in, the same row counts up.
    expect(buildDecisions(entries.slice(0, 4))[1].text).toContain("Charged 3 holds, $45.00");
    expect(buildDecisions(entries.slice(0, 2))[1].text).toContain("Charged 1 hold, $15.00");
  });

  it("names the payout batch with its PayPal batch id and who got what, and a retry apart", () => {
    const d = buildDecisions([
      line("a", "Sent the payouts exactly as signed: Spindle Records $80.00 · The Low Tides $100.00 · Juniper Vale $352.00.", "rule-4-pay-the-split", { requestId: "tttr-batch", resultId: "5UXKQ2XYZ1234" }),
      line("a", "Tried once more for the payouts that failed: The Low Tides $100.00.", "rule-4-pay-the-split", { resultId: "7RETRY99" }),
    ]);
    expect(d[0]).toMatchObject({ kind: "paid", ref: "5UXKQ2XYZ1234", rule: 3, text: "One payout batch to PayPal: Spindle Records $80.00 · The Low Tides $100.00 · Juniper Vale $352.00." });
    expect(d[1]).toMatchObject({ kind: "paid", ref: "7RETRY99", text: "Tried the failed payouts again: The Low Tides $100.00." });
    expect(KIND_WORD.paid).toBe("Paid out");
  });

  it('collapses a missed show into the miss and "Cancelled 28 holds", counting only holds the miss rule cancelled', () => {
    const d = buildDecisions([
      line("b", "The deadline passed at 24 of 28 fans. Cancelling every hold; nobody pays.", "rule-3-void-on-miss"),
      ...Array.from({ length: 24 }, (_, i) => cancel("b", i + 1)),
      cancel("b", 99, "rule-1-hold-only"),
    ]);
    expect(d.map((x) => x.kind)).toEqual(["missed", "cancelled"]);
    expect(d[1].text).toBe("Cancelled 24 holds. Nobody was charged.");
    expect(d[1].rule).toBe(4);
  });

  it("keeps two shows apart, in the order things happened", () => {
    const d = buildDecisions([charge("a", 1), cancel("b", 1), charge("a", 2), cancel("b", 2), cancel("b", 3)]);
    expect(d.map((x) => `${x.tag}:${x.kind}`)).toEqual(["a:charged", "b:cancelled"]);
    expect(d[0].text).toContain("Charged 2 holds, $30.00");
    expect(d[1].text).toContain("Cancelled 3 holds");
  });
});

describe("Check pace now unlocks when the pace check can say something real", () => {
  const show = (key: string, name: string, committed: number, target: number, starting: number, state = "live") => ({ key, name, state, committed, target, starting });
  it("needs the starting fans, but never more than being on pace at three quarters takes", () => {
    expect(paceNeeds({ target: 34, starting: 29 })).toBe(26);
    expect(paceNeeds({ target: 28, starting: 19 })).toBe(19);
    expect(paceNeeds({ target: 10, starting: 29 })).toBe(8);
  });

  it("waits for Marlow's 19 and Juniper's 26, and names the progress", () => {
    const r = paceReady([show("a", "Juniper Vale", 12, 34, 29), show("b", "Marlow Finch", 19, 28, 19)]);
    expect(r.ready).toBe(false);
    expect(r.waiting).toBe("Unlocks in about 30 seconds, once the starting fans are seated (Juniper Vale 12 of 26).");
    const both = paceReady([show("a", "Juniper Vale", 12, 34, 29), show("b", "Marlow Finch", 7, 28, 19)]);
    expect(both.waiting).toContain("Juniper Vale 12 of 26, Marlow Finch 7 of 19");
  });

  it("is ready at 26 and 19, well before the last starting fans, and for a show that is no longer open", () => {
    expect(paceReady([show("a", "Juniper Vale", 26, 34, 29), show("b", "Marlow Finch", 19, 28, 19)])).toEqual({ ready: true, waiting: "" });
    expect(paceReady([show("a", "Juniper Vale", 0, 34, 29, "paying_out"), show("b", "Marlow Finch", 19, 28, 19)]).ready).toBe(true);
  });
});
