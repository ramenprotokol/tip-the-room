import { describe, expect, it } from "vitest";
import { MODELS, NEURON_ESTIMATE } from "../../src/agent/ai";
import { draftFromSentence, numbersOk, paceNote, parseDraft, settlementNote, templateDraft, templateNote, templatePaceNote, type NoteFacts, type PaceFacts } from "../../src/agent/ai-jobs";
import { FakeAi, fakeBudget, json } from "./fake-ai";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SENTENCE = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";
const valid = { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPriceDollars: 15, roomDollars: 100, openerDollars: 0, hostDollars: 0, artistMinimumDollars: 200 };
const facts: PaceFacts = {
  committed: 8,
  threshold: 20,
  daysLeft: 3,
  projected: 14,
  percentElapsed: 57,
  options: [
    { id: "extend", approvalKey: "extend:1", label: "Extend 7 days", newDeadline: 1 },
    { id: "lower", approvalKey: "lower:14", label: "Lower the target to 14", newThreshold: 14 },
  ],
  extendDays: 7,
  lowerTo: 14,
};
const note: NoteFacts = { role: "room", label: "Lucky's Café", showName: "Acoustic Set", outcome: "paid", amountCents: 10000, fans: 21, ticketPriceCents: 1500 };

describe("models and budget estimates", () => {
  it("uses the 70B model for proposals and notes and the 8B model for extraction, with positive estimates", () => {
    expect(MODELS).toEqual({ big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", small: "@cf/meta/llama-3.1-8b-instruct-fp8" });
    expect(NEURON_ESTIMATE[MODELS.big]).toBeGreaterThan(0);
    expect(NEURON_ESTIMATE[MODELS.small]).toBeGreaterThan(0);
  });
});

describe("sentence → draft", () => {
  it("parses the spec's example sentence with the template", () => {
    expect(templateDraft(SENTENCE, NOW)).toEqual({ showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 });
  });
  it("rolls a date that already passed this year into next year", () => {
    expect(templateDraft("Gig at The Bar, Jan 3, $10 tickets", NOW).showDate).toBe("2027-01-03");
  });
  it("uses the template when there is no AI binding, without touching the budget", async () => {
    const b = fakeBudget();
    const r = await draftFromSentence({ ai: null, budget: b.port }, SENTENCE, NOW);
    expect(r.source).toBe("template");
    expect(b.used()).toBe(0);
  });
  it("uses the model's answer when it passes the schema check, and charges the small model's estimate", async () => {
    const ai = new FakeAi([json(valid)]);
    const b = fakeBudget();
    const r = await draftFromSentence({ ai, budget: b.port }, SENTENCE, NOW);
    expect(r).toEqual({ source: "model", value: { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 } });
    expect(ai.calls[0].model).toBe(MODELS.small);
    expect(b.used()).toBe(NEURON_ESTIMATE[MODELS.small]);
  });
  it("accepts an answer that is already an object", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([{ response: valid }]), budget: fakeBudget().port }, SENTENCE, NOW);
    expect(r.source).toBe("model");
  });
  it("falls back to the template when the answer fails the schema check", async () => {
    for (const bad of [{ ...valid, ticketPriceDollars: -5 }, { ...valid, showDate: "2026-02-30" }, { ...valid, showName: "" }, "not json", { response: 42 }]) {
      const answer = typeof bad === "string" ? { response: bad } : "response" in bad ? bad : json(bad);
      const r = await draftFromSentence({ ai: new FakeAi([answer]), budget: fakeBudget().port }, SENTENCE, NOW);
      expect(r.source).toBe("template");
    }
  });
  it("says 'resting' when the daily budget is spent, and never calls the model", async () => {
    const ai = new FakeAi([json(valid)]);
    const r = await draftFromSentence({ ai, budget: fakeBudget(0).port }, SENTENCE, NOW);
    expect(r.source).toBe("resting");
    expect(ai.calls).toHaveLength(0);
  });
  it("falls back when the model throws", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([new Error("down")]), budget: fakeBudget().port }, SENTENCE, NOW);
    expect(r.source).toBe("template");
  });
  it("rejects a draft with absurd amounts", () => {
    expect(parseDraft({ ...valid, roomDollars: 1e9 }, SENTENCE)).toBeNull();
    expect(parseDraft({ ...valid, ticketPriceDollars: 0 }, SENTENCE)).toBeNull();
  });
  it("accepts the draft only when every amount and the day come from the sentence", () => {
    expect(parseDraft(valid, SENTENCE)).not.toBeNull();
    expect(parseDraft({ ...valid, roomDollars: 900 }, SENTENCE)).toBeNull();
    expect(parseDraft({ ...valid, ticketPriceDollars: 25 }, SENTENCE)).toBeNull();
    expect(parseDraft({ ...valid, showDate: "2026-11-21" }, SENTENCE)).toBeNull();
  });
  it("uses the template when the model invents a room fee", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([json({ ...valid, roomDollars: 900 })]), budget: fakeBudget().port }, SENTENCE, NOW);
    expect(r.source).toBe("template");
    expect(r.value.room).toBe(10000);
  });
  it("ignores numbers past the first 500 characters", () => {
    const long = "x".repeat(500) + " room wants $900";
    expect(parseDraft({ ...valid, roomDollars: 900 }, long)).toBeNull();
    expect(templateDraft(long, NOW).room).toBe(0);
  });
  it("finishes fast on pathological input", () => {
    for (const s of ["Show at " + "A".repeat(5000) + "!", "Show at " + "A ".repeat(3000) + "!", "a" + " ".repeat(5000) + "$1 at"]) {
      const t0 = performance.now();
      templateDraft(s, NOW);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
});

describe("pace note", () => {
  it("accepts only numbers code computed", () => {
    const allowed = new Set(["8", "20"]);
    expect(numbersOk("8 of 20 fans", allowed)).toBe(true);
    expect(numbersOk("8 of 20 fans, about 99 more", allowed)).toBe(false);
  });
  it("has a template that passes its own number check", () => {
    const t = templatePaceNote(facts);
    expect(t).toEqual({ text: "8 of 20 fans with 3 days left. At this pace about 14 will join. You could extend the deadline 7 days, or lower the target to 14.", recommend: "extend" });
  });
  it("uses a valid model answer from the 70B model", async () => {
    const ai = new FakeAi([json({ text: "You have 8 of 20 fans and 3 days left. Extending 7 days gives fans more time.", recommend: "extend" })]);
    const r = await paceNote({ ai, budget: fakeBudget().port }, facts);
    expect(r.source).toBe("model");
    expect(r.value.recommend).toBe("extend");
    expect(ai.calls[0].model).toBe(MODELS.big);
  });
  it("rejects invented numbers and options that weren't offered", async () => {
    for (const bad of [{ text: "Only 2 days left, lower it to 5.", recommend: "lower" }, { text: "You have 8 of 20 fans.", recommend: "refund" }, { text: "x", recommend: "wait" }]) {
      const r = await paceNote({ ai: new FakeAi([json(bad)]), budget: fakeBudget().port }, facts);
      expect(r.source).toBe("template");
    }
  });
});

describe("no jargon in model text", () => {
  it("falls back to the template when the pace note uses system words", async () => {
    for (const text of ["You have 8 of 20 fans; the hold was authorized for all.", "8 of 20 fans, we will capture later.", "8 of 20 fans so the hold may be voided.", "8 of 20 fans, see sender_batch_id.", "8 of 20 fans under the mandate."]) {
      const r = await paceNote({ ai: new FakeAi([json({ text, recommend: "extend" })]), budget: fakeBudget().port }, facts);
      expect(r.source).toBe("template");
    }
  });
  it("falls back to the template when a settlement note uses system words", async () => {
    const r = await settlementNote({ ai: new FakeAi([json({ text: "The show happened with 21 fans, and Lucky's Café was paid $100 in the payout batch." })]), budget: fakeBudget().port }, note);
    expect(r).toEqual({ source: "template", value: templateNote(note) });
  });
});

describe("settlement note", () => {
  it("requires the party's real amount when the note says paid", async () => {
    const r = await settlementNote({ ai: new FakeAi([json({ text: "The show happened with 21 fans, and Lucky's Café was paid $15 for the night." })]), budget: fakeBudget().port }, note);
    expect(r).toEqual({ source: "template", value: templateNote(note) });
  });
  it("has a plain template for each outcome", () => {
    expect(templateNote(note)).toBe("Acoustic Set happened. 21 fans paid $15.00 each, and Lucky's Café was paid $100.00 under the money rules the artist signed.");
    expect(templateNote({ ...note, outcome: "called_off", amountCents: 0 })).toBe("Acoustic Set didn't reach its target, so every hold was cancelled. Nobody was charged, and Lucky's Café receives nothing.");
    expect(templateNote({ ...note, outcome: "refunded", amountCents: 0 })).toBe("Acoustic Set was called off after it tipped. Every fan is being refunded, and Lucky's Café receives nothing.");
  });
  it("uses the model when its numbers match, else the template", async () => {
    const ok = await settlementNote({ ai: new FakeAi([json({ text: "The show happened with 21 fans, and Lucky's Café was paid $100 as signed." })]), budget: fakeBudget().port }, note);
    expect(ok.source).toBe("model");
    const bad = await settlementNote({ ai: new FakeAi([json({ text: "Lucky's Café was paid $250 for the night, thanks to 21 fans." })]), budget: fakeBudget().port }, note);
    expect(bad).toEqual({ source: "template", value: templateNote(note) });
  });
});
