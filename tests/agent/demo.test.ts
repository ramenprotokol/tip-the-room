import { describe, expect, it } from "vitest";
import { DAY_MS } from "../../src/core/holds";
import { splitPayout } from "../../src/core/split";
import { demoSeeds, receiversFrom } from "../../src/agent/demo";
import { DEMO_GRACE_TOTAL_MAX_MS } from "../../src/agent/policy";
import { commit } from "../../src/agent/executor";
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

  const failVoids = (h: Demo) =>
    h.paypal.script("voidHold", ...Array.from({ length: 400 }, () => () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    }));

  it("a failed void keeps the copy: not deleted, re-armed with a doubling wait capped at 24 h", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    failVoids(h);
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      expect((await h.svc.tick()).expired).toBe(false);
      const at = Number(h.store.getMeta("expires_at"));
      waits.push(at - h.clock.t);
      h.clock.t = at;
    }
    expect(waits.slice(0, 5)).toEqual([HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR]);
    expect(waits.slice(5)).toEqual([24 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
    expect(h.svc.project().campaign.pledges.held).toBeGreaterThan(0);
  });

  it("re-opens a void job that ran out of tries, and deletes once the holds are released", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    await h.svc.tick();
    for (const j of h.store.jobs().filter((x) => x.kind === "void")) h.store.updateJob(j.key, { status: "failed" });
    expect(h.store.jobs().filter((x) => x.kind === "void" && x.status === "failed").length).toBeGreaterThan(0);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(false);
    expect(h.store.jobs().filter((x) => x.kind === "void" && x.status === "failed")).toHaveLength(0);
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(true);
  });

  it("deletes once every remaining hold is past its own expiry, even if voids keep failing", async () => {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    failVoids(h);
    expect((await h.svc.tick()).expired).toBe(false);
    h.clock.t = LAUNCH + 40 * DAY_MS;
    expect((await h.svc.tick()).expired).toBe(true);
  });

  it("keeps a copy while a replaced hold has no confirmed void", async () => {
    const h = await demoShow("b");
    await run(h);
    const p = h.svc.project();
    const x = [...p.pledges.values()][0];
    commit(h.store, h.clock.now(), { type: "hold_replaced", pledgeId: x.pledgeId, newPaypalPledgeId: `${x.pledgeId}-h1`, orderId: "O-new", authorizationId: "A-new", oldOrderId: x.orderId, oldAuthorizationId: x.authorizationId, authorizedAt: LAUNCH, expiresAt: LAUNCH + 29 * DAY_MS });
    h.clock.t = LAUNCH + 40 * DAY_MS;
    failVoids(h);
    expect((await h.svc.tick()).expired).toBe(false);
    expect(h.svc.project().retired.get(x.authorizationId)?.voided).toBe(false);
  });

  /** A copy past its expiry with every hold closed, so only the pending-job rule can keep it. */
  async function closedCopy() {
    const h = await demoShow("b");
    await run(h);
    h.clock.t = LAUNCH + DAY_MS;
    await h.svc.tick();
    await run(h);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    return h;
  }

  it("keeps a copy past expiry while a refund is still pending, then deletes it once done", async () => {
    const h = await closedCopy();
    h.store.putJob({ key: "refund:C-x", kind: "refund", target: "C-x", nextAt: h.clock.t + 100 * DAY_MS }, h.clock.t);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(false);
    expect(Number(h.store.getMeta("expires_at"))).toBeGreaterThan(h.clock.t);
    h.store.updateJob("refund:C-x", { status: "done" });
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(true);
  });

  it("keeps a copy past expiry while a payout is still pending", async () => {
    const h = await closedCopy();
    h.store.putJob({ key: "payout:x", kind: "payout", target: "x", nextAt: h.clock.t + 100 * DAY_MS }, h.clock.t);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(false);
  });

  it("stops waiting after the total grace cap, with a final log line", async () => {
    const h = await closedCopy();
    h.store.putJob({ key: "refund:C-x", kind: "refund", target: "C-x", nextAt: h.clock.t + 100 * DAY_MS }, h.clock.t);
    const start = h.clock.t;
    let expired = false;
    let ticks = 0;
    while (!expired && ticks < 100) {
      h.clock.t = Number(h.store.getMeta("expires_at"));
      expired = (await h.svc.tick()).expired;
      ticks += 1;
    }
    expect(expired).toBe(true);
    expect(h.clock.t - start).toBeGreaterThanOrEqual(DEMO_GRACE_TOTAL_MAX_MS);
    expect(h.clock.t - start).toBeLessThanOrEqual(DEMO_GRACE_TOTAL_MAX_MS + 24 * HOUR + HOUR);
    expect(h.store.logs().some((l) => l.did.startsWith("This demo copy is being removed"))).toBe(true);
  });

  it("a replaced hold counts only until its own expiry", async () => {
    const h = await demoShow("b");
    await run(h);
    const x = [...h.svc.project().pledges.values()][0];
    commit(h.store, h.clock.now(), { type: "hold_replaced", pledgeId: x.pledgeId, newPaypalPledgeId: `${x.pledgeId}-h1`, orderId: "O-new", authorizationId: "A-new", oldOrderId: x.orderId, oldAuthorizationId: x.authorizationId, authorizedAt: LAUNCH, expiresAt: LAUNCH + 60 * DAY_MS });
    expect(h.svc.project().retired.get(x.authorizationId)?.expiresAt).toBe(x.expiresAt);
  });

  it("releases a failed charge's leftover hold once the show is over, instead of waiting for it to lapse", async () => {
    const h = await demoShow("a");
    h.paypal.script("captureHold", (auth: string) => ({ captureId: `C-${auth}`, authorizationId: auth, status: "DECLINED" }));
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: orderId.replace("O-", "A-"), status: "CREATED" }], captures: [] }));
    h.svc.fastForward(true);
    for (let i = 0; i < 40; i++) {
      await h.svc.tick();
      h.clock.t += 120_000;
    }
    const failed = [...h.svc.project().pledges.values()].filter((x) => x.status === "capture_failed");
    expect(failed.length).toBeGreaterThan(0);
    const auth = failed[0].authorizationId;
    expect(h.svc.project().campaign.state).toBe("settled");
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(false);
    expect(h.store.job(`void:${auth}`)).toBeDefined();
    await h.svc.tick();
    expect(h.paypal.calls.filter((c) => c.op === "voidHold").map((c) => c.args[0])).toContain(auth);
    expect(h.svc.project().pledges.get(failed[0].pledgeId)?.holdClosed).toBe(true);
    h.clock.t = Number(h.store.getMeta("expires_at"));
    expect((await h.svc.tick()).expired).toBe(true);
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

describe("check pace now (demo)", () => {
  it("moves show B to three quarters of its window and proposes a fix for being behind", async () => {
    const h = await demoShow("b");
    await run(h);
    const before = h.svc.clockOffset();
    const show = await h.svc.checkPaceNow();
    expect(show.state).toBe("live");
    expect(h.svc.clockOffset()).toBeGreaterThan(before);
    const p = h.svc.project();
    const launched = Date.parse(p.mandate!.launchedAt);
    expect(h.svc.now()).toBe(launched + Math.floor((p.campaign.deadline - launched) * 0.75));
    const proposals = h.svc.manageView().proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].options.map((o) => o.id)).toEqual(["extend", "lower"]);
    expect(proposals[0].options[0].label).toBe("Extend 7 days");
    expect(proposals[0].options[0].newDeadline).toMatch(/Z$/);
    expect(proposals[0].options[0].newThreshold).toBeNull();
    expect(proposals[0].options[1]).toMatchObject({ label: "Lower the target to 25", newThreshold: 25, newDeadline: null });
    expect(h.store.logs().some((l) => l.did.startsWith("Proposed:"))).toBe(true);
    expect(h.store.logs().some((l) => l.did.startsWith("Demo: skipped ahead"))).toBe(true);
  });

  it("finds show A on pace and changes nothing", async () => {
    const h = await demoShow("a");
    await run(h);
    await h.svc.checkPaceNow();
    expect(h.svc.manageView().proposals).toHaveLength(0);
    expect(h.store.logs().some((l) => l.did === "On pace. Nothing to change.")).toBe(true);
  });

  it("does not propose twice", async () => {
    const h = await demoShow("b");
    await run(h);
    await h.svc.checkPaceNow();
    await h.svc.checkPaceNow();
    expect(h.svc.manageView().proposals).toHaveLength(1);
    expect(h.store.logs().at(-1)?.did).toBe("The pace was already checked. Nothing new to propose.");
  });

  it("leaves a show that is over alone", async () => {
    const h = await demoShow("b");
    await run(h);
    h.svc.fastForward(false);
    const show = await h.svc.checkPaceNow();
    expect(show.state).toBe("missed");
    expect(h.svc.manageView().proposals).toHaveLength(0);
  });

  it("is refused on a real show", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: "x" });
    await expect(h.svc.checkPaceNow()).rejects.toThrow(/only in the demo/);
  });
});

describe("decline a proposal", () => {
  it("logs 'not now', changes nothing, and refuses unknown or approved proposals", async () => {
    const h = await demoShow("b");
    await run(h);
    await h.svc.checkPaceNow();
    const id = h.svc.manageView().proposals[0].proposalId;
    const res = h.svc.declineProposal(id);
    expect(res.proposalId).toBe(id);
    expect(res.show.threshold).toBe(28);
    expect(h.store.logs().at(-1)?.did).toBe('You said not now to "Extend 7 days" or "Lower the target to 25". Nothing changes.');
    expect(() => h.svc.declineProposal("nope")).toThrow(/no such proposal/);
    await h.svc.approve(id, { option: "lower" });
    expect(() => h.svc.declineProposal(id)).toThrow(/already approved/);
  });

  it("saying not now twice logs once, and is refused once the show is no longer live", async () => {
    const h = await demoShow("b");
    await run(h);
    await h.svc.checkPaceNow();
    const id = h.svc.manageView().proposals[0].proposalId;
    const before = h.store.logs().length;
    h.svc.declineProposal(id);
    h.svc.declineProposal(id);
    expect(h.store.logs().length).toBe(before + 1);
    h.svc.fastForward(false);
    expect(() => h.svc.declineProposal(id)).toThrow(expect.objectContaining({ status: 409 }));
  });
});
