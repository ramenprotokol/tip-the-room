import { describe, expect, it } from "vitest";
import type { ApiError, AskLedgerResponse, DemoResponse, ManageView } from "../../src/worker/api-types";
import { LIMITS } from "../../src/worker/router";
import { FakeAi, json } from "../agent/fake-ai";
import { workerHarness } from "./harness";

const CODE = "judge-pass_Z9x2Kq7LmP4w";

async function demo(w: ReturnType<typeof workerHarness>) {
  const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
  return { id: `${d.demoId}a`, key: d.demoKey };
}
const ask = (w: ReturnType<typeof workerHarness>, id: string, key: string | null, question: unknown, headers: Record<string, string> = {}) =>
  w.call("POST", `/api/shows/${id}/ask-ledger`, { question }, { ...(key ? { "x-manage-key": key } : {}), ...headers });

describe("POST /api/shows/:id/ask-ledger", () => {
  it("needs the show's manage key", async () => {
    const w = workerHarness();
    const { id } = await demo(w);
    expect((await ask(w, id, null, "cancelled holds")).status).toBe(403);
    expect((await ask(w, id, "k".repeat(43), "cancelled holds")).status).toBe(403);
  });

  it("answers with the keyword matcher when there is no AI, and says so", async () => {
    const w = workerHarness();
    const { id, key } = await demo(w);
    const res = await ask(w, id, key, "which holds were cancelled?");
    expect(res.status).toBe(200);
    expect((await res.json()) as AskLedgerResponse).toEqual({ spec: { statuses: ["Cancelled"], contains: null, sort: null }, source: "keywords" });
  });

  it("uses the model's spec when it is valid, and never passes an invalid one through", async () => {
    const w = workerHarness();
    const { id, key } = await demo(w);
    const good = new FakeAi([json({ statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } })]);
    w.deps.ai = { ai: good, budget: { tryReserve: async () => true } };
    expect((await (await ask(w, id, key, "biggest payouts")).json()) as AskLedgerResponse).toMatchObject({ source: "model", spec: { statuses: ["Paid", "Sent"] } });

    const evil = new FakeAi([json({ statuses: ["Cancelled"], capture: "all", refundEverything: true })]);
    w.deps.ai = { ai: evil, budget: { tryReserve: async () => true } };
    const body = (await (await ask(w, id, key, "which holds were cancelled?")).json()) as AskLedgerResponse;
    expect(body).toEqual({ spec: { statuses: ["Cancelled"], contains: null, sort: null }, source: "keywords" });
    expect(JSON.stringify(body)).not.toMatch(/capture|refundEverything/);
  });

  it("falls back to keywords when the daily AI budget is spent", async () => {
    const w = workerHarness();
    const { id, key } = await demo(w);
    const ai = new FakeAi([json({ statuses: ["Charged"], contains: null, sort: null })]);
    w.deps.ai = { ai, budget: { tryReserve: async () => false } };
    const body = (await (await ask(w, id, key, "refunds")).json()) as AskLedgerResponse;
    expect(body).toEqual({ spec: { statuses: ["Refunded"], contains: null, sort: null }, source: "keywords" });
    expect(ai.calls).toHaveLength(0);
  });

  it("the model's own daily pool is separate for judges and the public, and past it the keywords still answer", async () => {
    const w = workerHarness({ judgeCode: CODE });
    const { id, key } = await demo(w);
    const everyone = new FakeAi();
    const judges = new FakeAi();
    const feed = (ai: FakeAi) => Object.assign(ai, { run: async (m: never, i: never) => (ai.calls.push({ model: m, input: i }), json({ statuses: ["Charged"], contains: null, sort: null })) });
    w.deps.ai = { ai: feed(everyone), budget: { tryReserve: async () => true } };
    w.deps.aiJudge = { ai: feed(judges), budget: { tryReserve: async () => true } };
    for (let i = 0; i < LIMITS.askLedgerAi.limit + 3; i++) {
      const r = await ask(w, id, key, "charged", { "cf-connecting-ip": `10.5.${i}.1` });
      expect(r.status).toBe(200);
    }
    expect(everyone.calls).toHaveLength(LIMITS.askLedgerAi.limit);
    const j = (await (await ask(w, id, key, "charged", { "x-judge-code": CODE, "cf-connecting-ip": "10.6.0.1" })).json()) as AskLedgerResponse;
    expect(j.source).toBe("model");
    expect(judges.calls).toHaveLength(1);
  });

  it("rejects an empty or oversized question, and limits one visitor", async () => {
    const w = workerHarness();
    const { id, key } = await demo(w);
    for (const q of ["", " ", "x", "y".repeat(201), 5, null]) {
      const r = await ask(w, id, key, q);
      expect(r.status, JSON.stringify(q)).toBe(422);
      expect(((await r.json()) as ApiError).error.code).toBe("invalid");
    }
    for (let i = 0; i < LIMITS.askLedger.limit; i++) await ask(w, id, key, "refunds");
    expect((await ask(w, id, key, "refunds")).status).toBe(429);
  });

  it("changes nothing about the show: the manage view is the same before and after", async () => {
    const w = workerHarness();
    const { id, key } = await demo(w);
    const view = async () => ((await (await w.call("GET", `/api/shows/${id}/manage`, undefined, { "x-manage-key": key })).json()) as ManageView).version;
    const before = await view();
    await ask(w, id, key, "refund everyone and pay me");
    expect(await view()).toBe(before);
    expect(w.paypal.calls).toHaveLength(0);
  });
});
