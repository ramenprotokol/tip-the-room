import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { splitPayout } from "../../src/core/split";
import { demoSeeds, receiversFrom } from "../../src/agent/demo";
import { sha256Hex } from "../../src/agent/ids";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { PayPalError } from "../../src/paypal/errors";
import type { HarnessOptions } from "./harness";
import { makeService } from "./harness";
import { LAUNCH, SHOW } from "./fixtures";

const DEMO_KEY = "demo-key-for-tests-0123456789abc";
const HOUR = 60 * 60 * 1000;

async function demoShow(key: "a" | "b", opts: HarnessOptions = {}) {
  const h = makeService(opts);
  h.svc.ensureSchema();
  const seed = demoSeeds(receiversFrom({}))[key === "a" ? 0 : 1];
  const show = await h.svc.initDemo({ showId: `dshowtestaa${key}`, seed, demoKeyHash: await sha256Hex(DEMO_KEY) });
  return { ...h, show, seed };
}
type Demo = Awaited<ReturnType<typeof demoShow>>;

/** Ticks like the alarm would: moves the real clock to the next wake-up while it is less than an hour away. */
async function run(h: Demo, maxSteps = 300) {
  for (let i = 0; i < maxSteps; i++) {
    if ((await h.svc.tick()).expired) return;
    const next = h.svc.nextWakeAt();
    if (next === null || next > h.clock.t + HOUR) return;
    h.clock.t = Math.max(h.clock.t, next);
  }
  throw new Error("run did not settle");
}

describe("demo seeds and receivers", () => {
  it("seeds the two reference shows: 34 fans at $15 and 28 fans at $12", async () => {
    const a = await demoShow("a");
    const b = await demoShow("b");
    expect([a.show.threshold, a.show.ticketPriceCents, a.show.demo]).toEqual([34, 1500, true]);
    expect([b.show.threshold, b.show.ticketPriceCents]).toEqual([28, 1200]);
    expect(a.seed.startFans).toBe(29);
    expect(b.seed.startFans).toBe(19);
  });

  it("pays example.com receivers unless real sandbox receivers are configured", () => {
    expect(receiversFrom({})).toEqual({ room: "tip-the-room-room@example.com", opener: "tip-the-room-opener@example.com", artist: "tip-the-room-artist@example.com" });
    expect(receiversFrom({ PAYPAL_RECEIVER_ROOM: " room-sb@personal.example ", PAYPAL_RECEIVER_ARTIST: "not an email" })).toMatchObject({ room: "room-sb@personal.example", artist: "tip-the-room-artist@example.com" });
  });
});

describe("simulated fans", () => {
  it("seats the starting fans as real sandbox card holds", async () => {
    const h = await demoShow("a");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(29);
    expect([...p.pledges.values()].every((x) => x.simulated)).toBe(true);
    expect(h.paypal.count("createCardHold")).toBe(29);
    expect(h.paypal.calls.find((c) => c.op === "createCardHold")?.args[1]).toEqual(SIM_CARD);
    expect(h.store.getMeta("expires_at")).toBe(String(LAUNCH + DAY_MS));
  });

  it("makes no PayPal call while creating the copy or adding fans: they are queued as jobs", async () => {
    const h = await demoShow("a");
    h.svc.addSimFans(5);
    expect(h.paypal.calls).toHaveLength(0);
    expect(h.store.jobs().filter((j) => j.kind === "sim_hold")).toHaveLength(34);
  });

  it("spreads the fans over several turns when PayPal calls use up the subrequest budget", async () => {
    const h = await demoShow("a");
    h.paypal.fetchesPerCall = 20; // each hold costs 20 subrequests (token fetch plus retries)
    await h.svc.tick();
    expect(h.paypal.count("createCardHold")).toBeLessThanOrEqual(2);
    expect(h.store.dueJobs(h.clock.now(), 1)).toHaveLength(1);
    expect(h.svc.nextWakeAt()).toBe(h.clock.now());
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(29);
  });

  it("retries a declined fan once with a NEW pledge id, then gives up", async () => {
    const h = await demoShow("b");
    const first = h.store.jobs()[0].target;
    h.paypal.script("createCardHold", (p: { pledgeId: string }) => ({ authorizationId: `A-${p.pledgeId}`, orderId: `O-${p.pledgeId}`, amountCents: 1200, status: "DENIED", createdAt: 0, expiresAt: 0 }));
    await run(h);
    let p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(19);
    expect(p.pledges.has(`${first}-r1`)).toBe(true);
    expect(p.rejected).toBe(1);

    const g = await demoShow("b");
    const firstG = g.store.jobs()[0].target;
    for (let i = 0; i < 40; i++) {
      g.paypal.script("createCardHold", (q: { pledgeId: string; amountCents: number }) => ({ authorizationId: `A-${q.pledgeId}`, orderId: `O-${q.pledgeId}`, amountCents: q.amountCents, status: q.pledgeId.startsWith(firstG) ? "DENIED" : "CREATED", createdAt: LAUNCH, expiresAt: LAUNCH + 29 * DAY_MS }));
    }
    await run(g);
    p = g.svc.project();
    expect(p.campaign.pledges.held).toBe(18);
    expect(g.store.logs().some((l) => l.did.startsWith("Gave up on this simulated fan"))).toBe(true);
  });

  it("caps simulated fans per request and per show", async () => {
    const h = await demoShow("a");
    expect(() => h.svc.addSimFans(21)).toThrow(/between 1 and 20/);
    expect(() => h.svc.addSimFans(0)).toThrow(/between 1 and 20/);
    expect(() => h.svc.addSimFans("5")).toThrow(/between 1 and 20/);
    expect(h.svc.addSimFans(20).queued).toBe(20);
    expect(() => h.svc.addSimFans(20)).toThrow(/at most 60/);
  });

  it("counts fans that were refused or failed toward the cap (a failing PayPal cannot be hammered)", async () => {
    const h = await demoShow("b"); // 19 queued
    h.paypal.script("createCardHold", ...Array.from({ length: 200 }, () => () => {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "no");
    }));
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    expect(() => h.svc.addSimFans(20)).not.toThrow(); // 19 + 20 = 39 used
    expect(() => h.svc.addSimFans(20)).not.toThrow(); // 59 used
    expect(() => h.svc.addSimFans(2)).toThrow(/at most 60/); // the refused fans still count
  });

  it("plans a re-hold for every seated simulated fan", async () => {
    const h = await demoShow("b");
    await run(h);
    const reholds = h.store.jobs().filter((j) => j.kind === "rehold");
    expect(reholds).toHaveLength(19);
    expect(reholds[0].nextAt).toBe(LAUNCH + 27 * DAY_MS);
  });
});

describe("fast-forward", () => {
  it("tops show A up to its target plus 2 (36 fans), charges everyone, then pays out at the jumped deadline", async () => {
    const h = await demoShow("a");
    await run(h);
    const before = h.svc.fastForward(true);
    expect(before.state).toBe("live");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.state).toBe("settled");
    expect(p.campaign.pledges.charged).toBe(36);
    expect(p.collectedNet).toBe(36 * 1412);
    expect(h.paypal.count("sendPayouts")).toBe(1);
    expect(h.paypal.calls.find((c) => c.op === "sendPayouts")?.args[1]).toEqual(splitPayout(36 * 1412, p.mandate!.parties).lines);
    expect(p.payouts[0].senderBatchId).toBe("payout-dshowtestaaa");
  });

  it("does not top up a show that already has target + 2 fans", async () => {
    const h = await demoShow("a");
    h.svc.addSimFans(7); // 29 + 7 = 36 queued
    await run(h);
    const before = h.store.jobs().filter((j) => j.kind === "sim_hold").length;
    h.svc.fastForward(true);
    expect(h.store.jobs().filter((j) => j.kind === "sim_hold")).toHaveLength(before);
    await run(h);
    expect(h.svc.project().campaign.pledges.charged).toBe(36);
  });

  it("never queues more than the per-show cap when topping up", async () => {
    const h = await demoShow("a");
    h.svc.addSimFans(20);
    h.svc.addSimFans(11); // 60 used; target 36 is already covered
    h.svc.fastForward(true);
    expect(h.store.jobs().filter((j) => j.kind === "sim_hold").length).toBeLessThanOrEqual(60);
  });

  it("makes show B miss and voids every hold", async () => {
    const h = await demoShow("b");
    await run(h);
    expect(h.svc.fastForward(false).state).toBe("missed");
    await run(h);
    const p = h.svc.project();
    expect(p.campaign.pledges).toMatchObject({ held: 0, released: 19 });
    expect(p.notes?.length).toBe(3);
  });
});

describe("expiry", () => {
  it("voids a live copy's holds at 24 h, waits for the voids, then expires", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    expect(await h.svc.tick()).toEqual({ expired: false });
    expect(h.svc.project().campaign.state).toBe("missed");
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect(await h.svc.tick()).toEqual({ expired: true });
  });

  it("the alarm is armed for the expiry, in real time, even after the demo clock jumped", async () => {
    const h = await demoShow("b");
    await run(h);
    h.svc.fastForward(false);
    await run(h);
    expect(h.svc.nextWakeAt()).toBe(LAUNCH + DAY_MS);
  });

  it("reset retires a copy: it ends at once and deletes itself within the hour", async () => {
    const h = await demoShow("b");
    await run(h);
    expect(h.svc.retire()).toEqual({ retired: true });
    expect(h.svc.project().campaign.state).toBe("missed");
    expect(Number(h.store.getMeta("expires_at"))).toBeLessThanOrEqual(h.clock.t + HOUR);
    await run(h);
    h.clock.t += HOUR;
    expect(await h.svc.tick()).toEqual({ expired: true });
  });

  it("waits at most three extra hours for stuck money steps, then expires", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    h.paypal.script("voidHold", ...Array.from({ length: 200 }, () => () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    }));
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      results.push((await h.svc.tick()).expired);
      h.clock.t = Number(h.store.getMeta("expires_at"));
    }
    expect(results).toEqual([false, false, false, true]);
  });

  it("refuses demo controls on a real show", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: "x" });
    expect(() => h.svc.addSimFans(1)).toThrow(/only in the demo/);
    expect(() => h.svc.fastForward(true)).toThrow(/only in the demo/);
    expect(() => h.svc.retire()).toThrow(/only in the demo/);
  });
});
