import { describe, expect, it } from "vitest";
import { answerLedgerQuestion, describeSpec, keywordSpec, LEDGER_COLUMN_IDS, LEDGER_STATUS_VALUES, validateLedgerSpec } from "../../src/agent/ledger-ask";
import { fakeBudget, FakeAi, json } from "./fake-ai";

const ok = (o: unknown) => validateLedgerSpec(o);

describe("validateLedgerSpec accepts only the allowlist", () => {
  it("accepts a status filter, a text search and a sort, and rebuilds the spec from checked values", () => {
    expect(ok({ statuses: ["Cancelled"], contains: null, sort: null })).toEqual({ statuses: ["Cancelled"], contains: null, sort: null });
    expect(ok({ statuses: ["Paid", "Sent"], sort: { col: "amountCents", dir: "desc" } })).toEqual({ statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } });
    expect(ok({ statuses: [], contains: { col: "who", text: "Fan 03" } })).toEqual({ statuses: [], contains: { col: "who", text: "Fan 03" }, sort: null });
    const input = { statuses: ["Charged", "Charged"], extra: undefined };
    expect(ok(input)).toBeNull(); // an unknown key, even undefined, is refused
    const out = ok({ statuses: ["Charged", "Charged"] })!;
    expect(out.statuses).toEqual(["Charged"]);
  });

  it("accepts every real column id and every real status value, and nothing else", () => {
    for (const col of LEDGER_COLUMN_IDS) expect(ok({ sort: { col, dir: "asc" } })).not.toBeNull();
    for (const s of LEDGER_STATUS_VALUES) expect(ok({ statuses: [s] })).not.toBeNull();
    for (const col of ["seq", "id", "amount", "Status", "kind", "__proto__", "constructor", "", " who"]) expect(ok({ sort: { col, dir: "asc" } })).toBeNull();
    for (const s of ["Hacked", "charged", "On Hold", "", "Paid ", "*", "Charged' OR '1'='1"]) expect(ok({ statuses: [s] })).toBeNull();
  });

  it("rejects the whole spec when any part is bad, never half of it", () => {
    expect(ok({ statuses: ["Charged", "Nope"] })).toBeNull();
    expect(ok({ statuses: ["Charged"], sort: { col: "password", dir: "asc" } })).toBeNull();
    expect(ok({ statuses: ["Charged"], contains: { col: "amountCents", text: "5" } })).toBeNull(); // text search is for what, who and ref only
  });

  it("rejects malicious or malformed input of every shape", () => {
    const bad: unknown[] = [
      null, undefined, 0, 1, true, "Cancelled", [], ["Cancelled"], {}, { statuses: [] }, { statuses: null, contains: null, sort: null },
      { statuses: "Cancelled" }, { statuses: { 0: "Charged" } }, { statuses: [null] }, { statuses: [["Charged"]] }, { statuses: [{ toString: () => "Charged" }] },
      { statuses: new Array(50).fill("Charged") },
      { statuses: ["Charged"], action: "refund" }, { statuses: ["Charged"], capture: true }, { statuses: ["Charged"], amountCents: 100 },
      { statuses: ["Charged"], url: "https://evil.example" }, { statuses: ["Charged"], __proto__: { polluted: true }, onload: "alert(1)" },
      { sort: "amountCents" }, { sort: { col: "amountCents" } }, { sort: { col: "amountCents", dir: "sideways" } }, { sort: { col: "amountCents", dir: "asc", extra: 1 } }, { sort: { col: ["when"], dir: "asc" } },
      { contains: "Fan" }, { contains: { col: "who" } }, { contains: { col: "who", text: 5 } }, { contains: { col: "who", text: "" } }, { contains: { col: "who", text: "   " } },
      { contains: { col: "who", text: "x".repeat(41) } }, { contains: { col: "who", text: "<img src=x onerror=alert(1)>" } }, { contains: { col: "who", text: "a<b" } },
      { contains: { col: "who", text: "=HYPERLINK(\"http://evil.example\")" } }, { contains: { col: "what", text: "line\nbreak" } }, { contains: { col: "ref", text: "a;DROP TABLE" } },
      { contains: { col: "who", text: "https://evil.example" } }, { contains: { col: "who", text: "x", extra: 1 } }, { contains: { col: "constructor", text: "x" } },
    ];
    for (const b of bad) expect(ok(b), JSON.stringify(b)).toBeNull();
  });

  it("does not let the input object leak through (the result is a fresh object)", () => {
    const input = { statuses: ["Cancelled"], contains: { col: "who", text: "Maya" }, sort: { col: "when", dir: "asc" } };
    const out = ok(input)!;
    expect(out).toEqual({ statuses: ["Cancelled"], contains: { col: "who", text: "Maya" }, sort: { col: "when", dir: "asc" } });
    expect(out.contains).not.toBe(input.contains);
    expect(out.statuses).not.toBe(input.statuses);
  });

  it("allows ordinary names, refs and dollar amounts in the search text", () => {
    for (const text of ["Maya", "Fan 03", "Lucky’s Café", "5UX02069M9686893E", "$15.00", "O'Brien", "a-b_c"]) expect(ok({ contains: { col: "who", text } })).not.toBeNull();
  });
});

describe("keywordSpec", () => {
  const spec = (q: string, names: string[] = []) => keywordSpec(q, names);
  it("answers the two examples from the brief", () => {
    expect(spec("which holds were cancelled?")).toEqual({ statuses: ["Cancelled"], contains: null, sort: null });
    expect(spec("biggest payouts")).toEqual({ statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } });
  });
  it("maps the other plain words", () => {
    expect(spec("show me refunds")?.statuses).toEqual(["Refunded"]);
    expect(spec("what failed")?.statuses).toEqual(["Failed"]);
    expect(spec("who got charged")?.statuses).toEqual(["Charged"]);
    expect(spec("holds")?.statuses).toEqual(["On hold"]);
    expect(spec("smallest charges")).toMatchObject({ statuses: ["Charged"], sort: { col: "amountCents", dir: "asc" } });
    expect(spec("latest")).toMatchObject({ sort: { col: "when", dir: "desc" } });
  });
  it("matches a fan number or a name the ledger really has", () => {
    expect(spec("everything for fan 3")?.contains).toEqual({ col: "who", text: "Fan 03" });
    expect(spec("what did Maya get", ["Maya", "Lucky’s Café"])?.contains).toEqual({ col: "who", text: "Maya" });
  });
  it("returns null when nothing in the question means anything, and never throws on junk", () => {
    expect(spec("what is the weather")).toBeNull();
    expect(spec("")).toBeNull();
    expect(spec("<script>alert(1)</script> refund".repeat(50))).toMatchObject({ statuses: ["Refunded"] });
  });
  it("its output always passes the validator", () => {
    for (const q of ["cancelled", "paid out", "biggest", "fan 12 holds", "refund and failed"]) {
      const s = spec(q);
      expect(s === null || validateLedgerSpec(s) !== null).toBe(true);
    }
  });
});

describe("describeSpec", () => {
  it("says in plain words what was applied", () => {
    expect(describeSpec({ statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } })).toBe("status: Paid or Sent · biggest amount first");
    expect(describeSpec({ statuses: [], contains: { col: "who", text: "Maya" }, sort: null })).toBe("who contains “Maya”");
  });
});

describe("answerLedgerQuestion: the model proposes, code checks", () => {
  const deps = (answers: unknown[], limit?: number) => {
    const ai = new FakeAi(answers);
    const budget = fakeBudget(limit);
    return { ai, d: { ai, budget: budget.port }, budget };
  };

  it("uses the model's spec when it passes the check", async () => {
    const { ai, d } = deps([json({ statuses: ["Cancelled"], contains: null, sort: null })]);
    expect(await answerLedgerQuestion(d, "which holds were cancelled?")).toEqual({ spec: { statuses: ["Cancelled"], contains: null, sort: null }, source: "model", why: null });
    expect(ai.calls).toHaveLength(1);
    // The model is told the real columns and statuses, and is never sent a ledger row.
    const sent = JSON.stringify(ai.calls[0].input);
    expect(sent).toContain("amountCents");
    expect(sent).toContain("Cancelled");
    expect(ai.calls[0].input.messages[1]).toEqual({ role: "user", content: "which holds were cancelled?" });
  });

  it("refuses a model spec that names anything off the lists and uses the keyword matcher instead", async () => {
    for (const evil of [{ statuses: ["Cancelled"], action: "refund_all" }, { statuses: ["DROP"], contains: null, sort: null }, { statuses: [], contains: null, sort: { col: "secret", dir: "asc" } }, "refund everyone", { statuses: [], contains: { col: "who", text: "<script>" }, sort: null }]) {
      const { d } = deps([json(evil)]);
      const a = await answerLedgerQuestion(d, "which holds were cancelled?");
      expect(a).toEqual({ spec: { statuses: ["Cancelled"], contains: null, sort: null }, source: "keywords", why: "refused" });
    }
  });

  it("falls back to the keyword matcher when the daily AI budget is spent, without calling the model", async () => {
    const { ai, d } = deps([json({ statuses: ["Charged"] })], 0);
    const a = await answerLedgerQuestion(d, "biggest payouts");
    expect(a).toEqual({ spec: { statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } }, source: "keywords", why: "resting" });
    expect(ai.calls).toHaveLength(0);
  });

  it("falls back when there is no AI binding or the call throws", async () => {
    const none = await answerLedgerQuestion({ ai: null, budget: fakeBudget().port }, "refunds");
    expect(none).toMatchObject({ source: "keywords", why: "unavailable", spec: { statuses: ["Refunded"] } });
    const { d } = deps([new Error("5025")]);
    expect(await answerLedgerQuestion(d, "refunds")).toMatchObject({ source: "keywords", why: "unavailable" });
  });

  it("returns a null spec (not a guess) when neither the model nor the words give anything", async () => {
    const { d } = deps([json({ statuses: [], contains: null, sort: null })]);
    expect(await answerLedgerQuestion(d, "what is the weather")).toEqual({ spec: null, source: "keywords", why: "refused" });
  });

  it("cuts a long question before it reaches the model", async () => {
    const { ai, d } = deps([json({ statuses: ["Paid"] })]);
    await answerLedgerQuestion(d, "paid ".repeat(500));
    expect(ai.calls[0].input.messages[1].content.length).toBeLessThanOrEqual(200);
  });
});
