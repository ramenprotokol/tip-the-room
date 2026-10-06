import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { PayPalError } from "../../src/paypal/errors";
import { FakePayPal } from "./fake-paypal";
import { LAUNCH, signedEvent, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

async function base() {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH);
  const paypal = new FakePayPal(clock);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, LAUNCH, await signedEvent());
  return { store, clock, paypal, d };
}

async function withSimHold(expiresAt: number) {
  const h = await base();
  commit(h.store, LAUNCH, { type: "pledge_held", pledgeId: "p1", orderId: "O1", authorizationId: "A1", amountCents: 1500, authorizedAt: LAUNCH, expiresAt, initials: "JR", simulated: true });
  h.store.putJob({ key: "rehold:A1", kind: "rehold", target: "p1", nextAt: expiresAt - 2 * DAY_MS }, LAUNCH);
  return h;
}

const denied = (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1500, status: "DENIED", createdAt: 0, expiresAt: 0 });
const PAYPAL_WORDS = /UNPROCESSABLE|INSTRUMENT|DENIED|PayPal 4|debug|issue/i;

describe("re-hold before expiry", () => {
  it("does nothing before it is due, and moves the job to the due time", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.store.updateJob("rehold:A1", { nextAt: LAUNCH });
    await drain(h.d, RUNNERS);
    expect(h.paypal.count("createCardHold")).toBe(0);
    expect(h.store.job("rehold:A1")).toMatchObject({ status: "pending", nextAt: LAUNCH + DAY_MS });
  });

  it("creates a fresh hold under a new pledge id first, then voids the OLD hold; counts never change", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    await drain(h.d, RUNNERS);
    await drain(h.d, RUNNERS);
    const card = h.paypal.calls.find((c) => c.op === "createCardHold");
    expect(card?.args).toEqual([{ showId: SHOW, pledgeId: "p1-h1", amountCents: 1500, description: "Hold for Acoustic Set at Lucky's Café" }, SIM_CARD]);
    expect(h.paypal.calls.filter((c) => c.op === "voidHold").map((c) => c.args[0])).toEqual(["A1"]);
    // The fresh hold was created BEFORE the old one was voided.
    expect(h.paypal.calls.map((c) => c.op).filter((o) => o === "createCardHold" || o === "voidHold")).toEqual(["createCardHold", "voidHold"]);
    const p = h.store.projection();
    expect(p.pledges.get("p1")).toMatchObject({ authorizationId: "A-p1-h1", paypalPledgeId: "p1-h1", status: "held" });
    expect(p.retired.get("A1")).toMatchObject({ why: "replaced", voided: true });
    expect(p.campaign.pledges).toMatchObject({ held: 1, released: 0 });
    expect(h.store.events().some((s) => s.event.type === "hold_replaced")).toBe(true);
  });

  it("the next renewal uses the next pledge id (-h2), never a replayed request id", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    await drain(h.d, RUNNERS);
    // The renewed hold (from the fake) lasts 29 days from now: move there and renew again.
    h.store.putJob({ key: "rehold:A-p1-h1", kind: "rehold", target: "p1", nextAt: h.clock.t }, h.clock.t);
    h.clock.t += 28 * DAY_MS;
    await drain(h.d, RUNNERS);
    const ids = h.paypal.calls.filter((c) => c.op === "createCardHold").map((c) => (c.args[0] as { pledgeId: string }).pledgeId);
    expect(ids).toEqual(["p1-h1", "p1-h2"]);
  });

  it("keeps the old hold when PayPal refuses the renewal, and says so in plain words", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    h.paypal.script("createCardHold", denied);
    await drain(h.d, RUNNERS);
    expect(h.store.projection().pledges.get("p1")?.authorizationId).toBe("A1");
    expect(h.store.job("rehold:A1")?.status).toBe("failed");
    expect(h.paypal.count("voidHold")).toBe(0);
    for (const l of h.store.logs()) expect(`${l.saw} ${l.did}`).not.toMatch(PAYPAL_WORDS);
  });

  it("an error from PayPal fails the renewal without PayPal's words in the log", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    h.paypal.script("createCardHold", () => {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-1", [{ issue: "INSTRUMENT_DECLINED" }]);
    });
    await drain(h.d, RUNNERS);
    expect(h.store.job("rehold:A1")?.status).toBe("failed");
    for (const l of h.store.logs()) expect(`${l.saw} ${l.did}`).not.toMatch(PAYPAL_WORDS);
  });

  it("never swaps ids if the show closed while PayPal answered: the new hold is voided too", async () => {
    const h = await withSimHold(LAUNCH + 3 * DAY_MS);
    h.clock.t = LAUNCH + DAY_MS;
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => {
      commit(h.store, h.clock.now(), { type: "deadline_reached", now: LAUNCH + 30 * DAY_MS, deadline: Date.parse("2026-11-08T00:00:00Z") });
      return { authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1500, status: "CREATED", createdAt: LAUNCH, expiresAt: LAUNCH + 29 * DAY_MS };
    });
    await drain(h.d, RUNNERS);
    const p = h.store.projection();
    expect(p.pledges.get("p1")).toMatchObject({ authorizationId: "A1", status: "released" });
    expect(h.store.events().some((s) => s.event.type === "hold_replaced")).toBe(false);
    expect(h.paypal.calls.filter((c) => c.op === "voidHold").map((c) => c.args[0]).sort()).toEqual(["A-p1-h1", "A1"]);
    expect(p.retired.get("A-p1-h1")).toMatchObject({ why: "late", voided: true });
  });
});

describe("a simulated fan's hold", () => {
  function simJob(h: Awaited<ReturnType<typeof base>>, pledgeId = "s1") {
    h.store.putJob({ key: `sim:${pledgeId}`, kind: "sim_hold", target: pledgeId, nextAt: LAUNCH, note: "JR" }, LAUNCH);
  }

  it("is recorded as held only when PayPal says CREATED for the ticket price", async () => {
    const h = await base();
    simJob(h);
    await drain(h.d, RUNNERS);
    expect(h.store.projection().pledges.get("s1")).toMatchObject({ status: "held", simulated: true, initials: "JR" });
  });

  it("never records a DENIED hold as held; it retries once with a new pledge id, then gives up", async () => {
    const h = await base();
    simJob(h);
    h.paypal.script("createCardHold", denied, denied);
    await drain(h.d, RUNNERS);
    const p = h.store.projection();
    expect(p.campaign.pledges.held).toBe(0);
    expect(p.pledges.size).toBe(0);
    expect(p.rejected).toBe(2);
    expect(h.paypal.calls.filter((c) => c.op === "createCardHold").map((c) => (c.args[0] as { pledgeId: string }).pledgeId)).toEqual(["s1", "s1-r1"]);
    expect(h.paypal.count("voidHold")).toBe(0);
    expect(h.store.logs().some((l) => l.did.startsWith("Gave up on this simulated fan"))).toBe(true);
    for (const l of h.store.logs()) expect(`${l.saw} ${l.did}`).not.toMatch(PAYPAL_WORDS);
  });

  it("voids a PENDING or wrong-amount hold it will not count, and never counts it", async () => {
    const h = await base();
    simJob(h);
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1500, status: "PENDING", createdAt: 0, expiresAt: 0 }));
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 900, status: "CREATED", createdAt: 0, expiresAt: LAUNCH + 29 * DAY_MS }));
    await drain(h.d, RUNNERS);
    const p = h.store.projection();
    expect(p.campaign.pledges.held).toBe(0);
    expect(h.paypal.calls.filter((c) => c.op === "voidHold").map((c) => c.args[0])).toEqual(["A-s1", "A-s1-r1"]);
  });

  it("retries an error PayPal says is temporary with the SAME pledge id (same request id)", async () => {
    const h = await base();
    simJob(h);
    h.paypal.script("createCardHold", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    await drain(h.d, RUNNERS);
    expect(h.store.job("sim:s1")).toMatchObject({ status: "pending", attempts: 1 });
    h.clock.t += 60_000;
    await drain(h.d, RUNNERS);
    expect(h.paypal.calls.filter((c) => c.op === "createCardHold").map((c) => (c.args[0] as { pledgeId: string }).pledgeId)).toEqual(["s1", "s1"]);
    expect(h.store.projection().pledges.get("s1")?.status).toBe("held");
  });

  it("an answer we cannot read is asked again with the same request id, not abandoned as a new fan", async () => {
    const h = await base();
    simJob(h);
    h.paypal.script("createCardHold", () => {
      throw new PayPalError(502, "BAD_RESPONSE_BODY", "unreadable");
    });
    await drain(h.d, RUNNERS);
    expect(h.store.job("sim:s1")?.status).toBe("pending");
    expect(h.store.projection().rejected).toBe(0);
  });

  it("cancels a hold that lands after pledging closed", async () => {
    const h = await base();
    simJob(h);
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => {
      commit(h.store, h.clock.now(), { type: "deadline_reached", now: LAUNCH + 30 * DAY_MS, deadline: Date.parse("2026-11-08T00:00:00Z") });
      return { authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1500, status: "CREATED", createdAt: LAUNCH, expiresAt: LAUNCH + 29 * DAY_MS };
    });
    await drain(h.d, RUNNERS);
    const p = h.store.projection();
    expect(p.pledges.size).toBe(0);
    expect(p.retired.get("A-s1")).toMatchObject({ why: "late" });
    expect(h.paypal.count("voidHold")).toBe(1);
  });
});
