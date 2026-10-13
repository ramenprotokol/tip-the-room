import { describe, expect, it } from "vitest";
import { MODELS, NEURON_ESTIMATE } from "../../src/agent/ai";
import { draftFromSentence, numbersOk, paceNote, parseDraft, settlementNote, templateDraft, templateNote, templatePaceNote, timeLeftPhrase, type NoteFacts, type PaceFacts } from "../../src/agent/ai-jobs";
import { readFileSync } from "node:fs";
import { FakeAi, fakeBudget, json } from "./fake-ai";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const SENTENCE = "Acoustic set at Lucky's Café, Nov 20, $15 tickets, café wants $100, I need $200";
const valid = { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPriceDollars: 15, roomDollars: 100, openerDollars: 0, hostDollars: 0, artistMinimumDollars: 200 };
const facts: PaceFacts = {
  committed: 8,
  threshold: 20,
  daysLeft: 3,
  hoursLeft: 77,
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
  it("uses the 70B model for proposals and notes and the 3B model for extraction, with positive estimates", () => {
    expect(MODELS).toEqual({ big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", small: "@cf/meta/llama-3.2-3b-instruct" });
    expect(NEURON_ESTIMATE[MODELS.big]).toBeGreaterThan(0);
    expect(NEURON_ESTIMATE[MODELS.small]).toBeGreaterThan(0);
  });
});

/** Real Workers AI output (redacted), recorded 2026-10-06 against the live service. */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

describe("real Workers AI output", () => {
  it("turns the recorded small-model answer (response is already an object) into a model draft", async () => {
    const real = fixture("workers-ai-draft-3b.json");
    expect(typeof real.response).toBe("object");
    const sentence = "Jazz night at Blue Door Cafe on Nov 14, tickets $15, the cafe wants $200, opener wants $100, I need $300";
    const r = await draftFromSentence({ ai: new FakeAi([real]), budget: fakeBudget().port }, sentence, Date.UTC(2026, 9, 6));
    expect(r).toEqual({ source: "model", value: { showName: "Jazz night", roomName: "Blue Door Cafe", showDate: "2026-11-14", ticketPrice: 1500, room: 20000, opener: 10000, host: 0, artistMinimum: 30000 } });
  });
  it("the draft call asks for json_schema, which the old small model (llama-3.1-8b-instruct-fp8) rejected with code 5025", async () => {
    const rejected = fixture("workers-ai-json-schema-rejected.json");
    expect(rejected.errors[0].code).toBe(5025);
    const ai = new FakeAi([json({})]);
    await draftFromSentence({ ai, budget: fakeBudget().port }, "x", 0);
    expect(ai.calls[0].input.response_format?.type).toBe("json_schema");
    expect(ai.calls[0].model).not.toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
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

describe("the model's roles are checked against the sentence's own words", () => {
  const LIVE = "Acoustic set at Lucky's Café on Nov 20, $15 tickets, the café wants $100 and I need $200";
  const right = { ...valid, showDate: "2026-11-20" };
  it("refuses the misread seen live (the $200 given to a host, the artist $0) and drafts from the sentence instead", async () => {
    const misread = { ...right, hostDollars: 200, artistMinimumDollars: 0 };
    expect(parseDraft(misread, LIVE)).toBeNull();
    const r = await draftFromSentence({ ai: new FakeAi([json(misread)]), budget: fakeBudget().port }, LIVE, NOW);
    expect(r.source).toBe("template");
    expect(r.value).toMatchObject({ artistMinimum: 20000, host: 0, room: 10000 });
  });
  it("keeps the correct answer for the same sentence as the model's", async () => {
    const r = await draftFromSentence({ ai: new FakeAi([json(right)]), budget: fakeBudget().port }, LIVE, NOW);
    expect(r).toEqual({ source: "model", value: { showName: "Acoustic set", roomName: "Lucky's Café", showDate: "2026-11-20", ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 } });
  });
  it("refuses a role whose amount differs from what the sentence says for it, price included", () => {
    expect(parseDraft({ ...right, artistMinimumDollars: 100, roomDollars: 200 }, LIVE)).toBeNull();
    expect(parseDraft({ ...right, roomDollars: 0 }, LIVE)).toBeNull();
    expect(parseDraft({ ...right, ticketPriceDollars: 200 }, LIVE)).toBeNull();
  });
  it("needs a host word for a host amount and an opener word for an opener amount", () => {
    const noWords = "Acoustic set at Lucky's Café on Nov 20, $15 tickets, $50, $100 and $200";
    expect(parseDraft({ ...right, roomDollars: 100, hostDollars: 50, artistMinimumDollars: 200 }, noWords)).toBeNull();
    expect(parseDraft({ ...right, roomDollars: 100, openerDollars: 50, artistMinimumDollars: 200 }, noWords)).toBeNull();
    expect(parseDraft({ ...right, roomDollars: 100, hostDollars: 50, artistMinimumDollars: 200 }, `${noWords}, our MC gets $50`)).not.toBeNull();
    expect(parseDraft({ ...right, roomDollars: 100, openerDollars: 50, artistMinimumDollars: 200 }, `${noWords}, the support act gets $50`)).not.toBeNull();
  });
  it("refuses two roles with the same amount unless the sentence writes it that many times", () => {
    const once = "Show at Lucky's Café on Nov 20, $15 tickets, $100 for the room and the opener, I need $300";
    expect(parseDraft({ ...right, roomDollars: 100, openerDollars: 100, artistMinimumDollars: 300 }, once)).toBeNull();
    const twice = "Show at Lucky's Café on Nov 20, $15 tickets, the café wants $100, the opener wants $100, I need $300";
    expect(parseDraft({ ...right, roomDollars: 100, openerDollars: 100, artistMinimumDollars: 300 }, twice)).not.toBeNull();
  });
  it("still accepts a sane answer when the sentence has no role words to check it against", () => {
    const loose = "Acoustic set at Lucky's Café on Nov 20, tickets for 15, 100 for the room, 200 for me";
    expect(parseDraft(right, loose)).not.toBeNull();
  });
  it("leaves the template's own output as it was", () => {
    expect(templateDraft(LIVE, NOW)).toMatchObject({ ticketPrice: 1500, room: 10000, opener: 0, host: 0, artistMinimum: 20000 });
  });
});

describe("show date and pledge deadline", () => {
  it("rejects a model show date that only matches the deadline's day", () => {
    const sentence = "Acoustic set at Lucky's Café, $15 tickets, café wants $100, I need $200, pledges close Oct 16";
    expect(parseDraft({ ...valid, showDate: "2026-10-16" }, sentence)).toBeNull();
    expect(parseDraft({ ...valid, showDate: null }, sentence)).not.toBeNull();
    expect(parseDraft({ ...valid, showDate: "2026-10-20" }, `${sentence}, show Oct 20`)).not.toBeNull();
  });
  it("leaves the deadline's date out of the template show date", () => {
    expect(templateDraft("Set at Lucky's Café, pledges close Oct 16, Oct 20, $15 tickets", NOW).showDate).toBe("2026-10-20");
    expect(templateDraft("Set at Lucky's Café, $15 tickets, deadline Oct 16", NOW).showDate).toBeNull();
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
  it("falls back to the template when the note talks about the artist or holds instead of to you", async () => {
    for (const text of ["The artist has 8 fans, needs 20, and has 3 days left.", "You are on hold for 57 percent of the time, with 8 of 20 fans.", "8 of 20 fans. The Artist could extend 7 days."]) {
      const r = await paceNote({ ai: new FakeAi([json({ text, recommend: "extend" })]), budget: fakeBudget().port }, facts);
      expect(r.source).toBe("template");
    }
  });
  it("sends the model a labelled time left and the share of the pledge window passed", async () => {
    const ai = new FakeAi([json({ text: "You have 8 of 20 fans and 3 days left.", recommend: "wait" })]);
    await paceNote({ ai, budget: fakeBudget().port }, facts);
    const sent = JSON.parse(ai.calls[0].input.messages.at(-1)!.content as string);
    expect(sent).toMatchObject({ timeLeft: "3 days left", percentOfPledgeWindowPassed: 57 });
    expect(sent).not.toHaveProperty("percentOfTimeUsed");
  });
  it("speaks the time left like the page countdown: days rounded down, hours under a day", () => {
    expect(timeLeftPhrase({ daysLeft: 2, hoursLeft: 49 })).toBe("2 days left");
    expect(timeLeftPhrase({ daysLeft: 1, hoursLeft: 24 })).toBe("1 day left");
    expect(timeLeftPhrase({ daysLeft: 0, hoursLeft: 5 })).toBe("5 hours left");
    expect(timeLeftPhrase({ daysLeft: 0, hoursLeft: 1 })).toBe("1 hour left");
    expect(timeLeftPhrase({ daysLeft: 0, hoursLeft: 0 })).toBe("less than an hour left");
  });
  it("allows the hours figure, not the days figure, once under a day", async () => {
    const soon = { ...facts, daysLeft: 0, hoursLeft: 5 };
    expect(templatePaceNote(soon).text).toContain("with 5 hours left.");
    const ok = await paceNote({ ai: new FakeAi([json({ text: "You have 8 of 20 fans and 5 hours left.", recommend: "wait" })]), budget: fakeBudget().port }, soon);
    expect(ok.source).toBe("model");
    const bad = await paceNote({ ai: new FakeAi([json({ text: "You have 8 of 20 fans and 3 hours left.", recommend: "wait" })]), budget: fakeBudget().port }, soon);
    expect(bad.source).toBe("template");
  });
  it("allows the count of offered options, and only that count", async () => {
    const ok = await paceNote({ ai: new FakeAi([json({ text: "You have 8 of 20 fans and 2 options: extend or lower.", recommend: "extend" })]), budget: fakeBudget().port }, facts);
    expect(ok.source).toBe("model");
    const bad = await paceNote({ ai: new FakeAi([json({ text: "You have 8 of 20 fans and 4 options: extend or lower.", recommend: "extend" })]), budget: fakeBudget().port }, facts);
    expect(bad.source).toBe("template");
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

describe("no links, markup or handles in model text", () => {
  const links = ["Visit https://evil.example now.", "See www.evil.example for more.", "Join at evil.com/win today.", "Mail me at bob@evil.example", "Pay at pay-me.io please.", "Use <b>bold</b> words.", "Go to site.org/now or else.", "Read more: HTTP://x.example."];
  it("falls back to the template for a pace note that carries one", async () => {
    for (const extra of links) {
      const text = `You have 8 of 20 fans and 3 days left. ${extra}`;
      const r = await paceNote({ ai: new FakeAi([json({ text, recommend: "extend" })]), budget: fakeBudget().port }, facts);
      expect(r.source, extra).toBe("template");
    }
  });
  it("falls back to the template for a settlement note that carries one", async () => {
    for (const extra of links) {
      const text = `The show happened with 21 fans, and Lucky's Café was paid $100 for the night. ${extra}`;
      const r = await settlementNote({ ai: new FakeAi([json({ text })]), budget: fakeBudget().port }, note);
      expect(r, extra).toEqual({ source: "template", value: templateNote(note) });
    }
  });
  it("still accepts ordinary sentences with money and full stops", async () => {
    const pace = await paceNote({ ai: new FakeAi([json({ text: "You have 8 of 20 fans and 3 days left. Extending 7 days gives fans more time.", recommend: "extend" })]), budget: fakeBudget().port }, facts);
    expect(pace.source).toBe("model");
    const text = "The show happened with 21 fans, and Lucky's Café was paid $100.00 for the night. Thank you, everyone.";
    const r = await settlementNote({ ai: new FakeAi([json({ text })]), budget: fakeBudget().port }, note);
    expect(r).toEqual({ source: "model", value: text });
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
