import { describe, expect, it, vi } from "vitest";
import { RULES } from "../../src/core/rules";
import { dispatch } from "../../src/agent/dispatch";
import { commit } from "../../src/agent/executor";
import { sha256Hex } from "../../src/agent/ids";
import { PayPalError } from "../../src/paypal/errors";
import { MAX_ORDERS_PER_SHOW, ORDER_OPEN_MS } from "../../src/agent/policy";
import { DRAFT, makeService, pledge, SIGN_TOKEN, signedService } from "./harness";
import { DEADLINE, SHOW } from "./fixtures";

describe("init and sign", () => {
  it("signs with the one-time token, returns the manage key once and stores only its hash", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    const r = await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
    expect(r.threshold).toBe(3);
    expect(r.manageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.store.getMeta("manage_key_hash")).toBe(await sha256Hex(r.manageKey));
    expect(h.store.getMeta("sign_token_hash")).toBeUndefined();
    expect(JSON.stringify(h.store.events())).not.toContain(r.manageKey);
    expect(r.show.state).toBe("live");
    expect(r.sharePath).toBe(`/s/${SHOW}`);
    await expect(h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT })).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a wrong sign token", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await expect(h.svc.sign({ signToken: "not-the-token", draft: DRAFT })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(h.svc.project().mandate).toBeNull();
  });

  it("returns plain-English problems for a draft that breaks the rules", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    const err = await h.svc.sign({ signToken: SIGN_TOKEN, draft: { ...DRAFT, deadline: "2026-12-01T00:00:00Z" } }).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: "invalid" });
    expect(err.problems).toContain("The pledge window can be at most 21 days.");
  });

  it("refuses to create the same show twice", async () => {
    const h = await signedService();
    expect(() => h.svc.init({ showId: SHOW, signTokenHash: "x" })).toThrow(/already exists/);
  });
});

describe("public view", () => {
  it("shows the pledge page's numbers and never a PayPal email", async () => {
    const h = await signedService();
    const v = h.svc.publicView();
    expect(JSON.stringify(v)).not.toContain("@");
    expect(v).toMatchObject({ threshold: 3, status: "Waiting for fans", fans: { committed: 0, more: 3 }, ticketPriceCents: 1500, paypalClientId: "test-client-id", demo: false });
  });
});

describe("orders and authorize", () => {
  it("creates a PayPal order for a pledge with plain initials", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: " jr " });
    expect(o.amountCents).toBe(1500);
    expect(h.paypal.calls[0]).toEqual({ op: "createPledgeOrder", args: [{ showId: SHOW, pledgeId: o.pledgeId, amountCents: 1500, description: "Hold for Acoustic Set at Lucky's Café" }] });
    expect(h.svc.project().orders.get(o.orderId)).toMatchObject({ initials: "JR", resolved: false });
  });

  it("refuses initials that aren't 1 to 3 letters, before calling PayPal", async () => {
    const h = await signedService();
    for (const bad of ["J1", "", "ABCD", 5]) await expect(h.svc.createOrder({ initials: bad as string })).rejects.toMatchObject({ status: 422 });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("holds the pledge once PayPal authorizes the order we created", async () => {
    const h = await signedService();
    const r = await pledge(h.svc);
    expect(r).toMatchObject({ status: "held", tipped: false, show: { fans: { committed: 1, held: 1, more: 2 }, bulbs: [{ initials: "AB", status: "held" }] } });
    expect(h.store.logs().at(-1)).toMatchObject({ rule: "rule-1-hold-only", requestId: `authorize:O-${r.pledgeId}`, resultId: `A-${r.pledgeId}` });
  });

  it("refuses an order id this show didn't create, and never calls PayPal", async () => {
    const h = await signedService();
    await expect(h.svc.authorize("5O190127TN364715T")).rejects.toMatchObject({ status: 404 });
    expect(h.paypal.count("authorizeOrder")).toBe(0);
  });

  it("refuses a malformed order id before anything else", async () => {
    const h = await signedService();
    await expect(h.svc.authorize("../../v1/oauth2")).rejects.toMatchObject({ status: 400 });
    expect(h.paypal.calls).toHaveLength(0);
  });

  it("is idempotent: authorizing the same order twice asks PayPal once", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    await h.svc.authorize(o.orderId);
    const again = await h.svc.authorize(o.orderId);
    expect(again.status).toBe("held");
    expect(h.paypal.count("authorizeOrder")).toBe(1);
    expect(h.svc.project().campaign.pledges.held).toBe(1);
  });

  it("rejects a hold for the wrong amount and queues it to be cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-wrong", orderId, amountCents: 100, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    const p = h.svc.project();
    expect(p.campaign.pledges.held).toBe(0);
    expect(p.retired.get("A-wrong")).toMatchObject({ why: "rejected" });
    expect(h.store.job("void:A-wrong")?.status).toBe("pending");
  });

  it("rejects a hold whose custom_id belongs to another pledge", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-other", orderId, amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:someone-else` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("never counts a DENIED hold and has nothing to cancel", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-denied", orderId, amountCents: 1500, status: "DENIED", createdAt: 0, expiresAt: 1 }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.store.job("void:A-denied")).toBeUndefined();
  });

  it("refuses to authorize after the deadline, without asking PayPal", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.clock.t = DEADLINE + 1;
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.paypal.count("authorizeOrder")).toBe(0);
    expect(h.svc.project().campaign.state).toBe("missed");
  });

  it("cancels a hold that lands after pledging closed while PayPal was answering", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => {
      h.clock.t = DEADLINE + 1;
      return { authorizationId: "A-late", orderId, amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` };
    });
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    const p = h.svc.project();
    expect(p.retired.get("A-late")).toMatchObject({ why: "late" });
    expect(h.store.job("void:A-late")?.status).toBe("pending");
    expect(p.campaign.pledges.held).toBe(0);
  });

  it("tips on the pledge that reaches the target and persists capture jobs without running them", async () => {
    const h = await signedService();
    await pledge(h.svc, "AA");
    await pledge(h.svc, "BB");
    const third = await pledge(h.svc, "CC");
    expect(third.tipped).toBe(true);
    expect(h.store.jobs().filter((j) => j.kind === "capture" && j.status === "pending")).toHaveLength(3);
    expect(h.paypal.count("captureHold")).toBe(0);
    expect(h.store.logs().some((l) => l.rule === "rule-2-capture-at-tip")).toBe(true);
  });

  it("an order nobody authorized within ORDER_OPEN_MS can't be authorized later, and nothing is asked of PayPal's authorize", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.clock.t += ORDER_OPEN_MS;
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.paypal.count("authorizeOrder")).toBe(0);
    expect(h.paypal.count("getOrderPayments")).toBe(1);
    expect(h.svc.project().orders.get(o.orderId)?.resolved).toBe(true);
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("an abandoned order that PayPal did hold is refused and its hold queued to be cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.clock.t += ORDER_OPEN_MS + 1;
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-stray", status: "CREATED" }], captures: [] }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.store.job("void:A-stray")?.status).toBe("pending");
  });

  it("when PayPal can't say what an abandoned order holds, the order stays open for a later look", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.clock.t += ORDER_OPEN_MS;
    h.paypal.script("getOrderPayments", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.svc.project().orders.get(o.orderId)?.resolved).toBe(false);
  });

  it("abandoned orders stop counting toward the per-show order cap", async () => {
    const h = await signedService();
    for (let i = 0; i < MAX_ORDERS_PER_SHOW; i += 1) await h.svc.createOrder({ initials: "AB" });
    await expect(h.svc.createOrder({ initials: "AB" })).rejects.toMatchObject({ status: 409 });
    h.clock.t += ORDER_OPEN_MS;
    await expect(h.svc.createOrder({ initials: "AB" })).resolves.toHaveProperty("orderId");
  });

  it("an order authorized in time still counts after ORDER_OPEN_MS", async () => {
    const h = await signedService();
    for (let i = 0; i < MAX_ORDERS_PER_SHOW - 1; i += 1) await h.svc.createOrder({ initials: "AB" });
    await pledge(h.svc);
    h.clock.t += ORDER_OPEN_MS;
    // 499 abandoned orders no longer count; the held one does.
    for (let i = 0; i < MAX_ORDERS_PER_SHOW - 1; i += 1) await h.svc.createOrder({ initials: "AB" });
    await expect(h.svc.createOrder({ initials: "AB" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("manage view", () => {
  it("needs the manage key", async () => {
    const h = await signedService();
    await expect(h.svc.checkKey(null)).rejects.toMatchObject({ status: 403 });
    await expect(h.svc.checkKey("a-wrong-key-that-is-long-enough")).rejects.toMatchObject({ status: 403 });
    await expect(h.svc.checkKey(h.manageKey)).resolves.toBeUndefined();
  });

  it("shows ledger rows newest first, the agent log with rule titles, and the parties with emails", async () => {
    const h = await signedService();
    await pledge(h.svc);
    const v = h.svc.manageView();
    expect(v.ledger[0]).toMatchObject({ what: "Fan held a spot", who: "Fan 01 · AB", amountCents: 1500, status: "On hold" });
    expect(v.parties.map((p) => [p.paypalEmail, p.payoutStatus])).toEqual([
      ["room@example.com", "planned"],
      ["maya@example.com", "planned"],
    ]);
    expect(v.log[0].ruleTitle).toBe(RULES["rule-1-hold-only"].title);
    expect(v.attention).toEqual([]);
  });
});

describe("dispatch", () => {
  it("answers 404 for a show that doesn't exist, without creating storage", async () => {
    const h = makeService();
    expect(await dispatch(h.svc, { op: "public" })).toEqual({ ok: false, status: 404, error: { code: "not_found", message: "There's no show here." } });
    expect(h.store.exists()).toBe(false);
  });

  it("turns refusals into plain replies", async () => {
    const h = await signedService();
    expect(await dispatch(h.svc, { op: "authorize", orderId: "5O190127TN364715T" })).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    h.paypal.script("createPledgeOrder", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    expect(await dispatch(h.svc, { op: "order", body: { initials: "AB" } })).toMatchObject({ ok: false, status: 502, error: { code: "paypal_error" } });
    expect(await dispatch(h.svc, { op: "manage", manageKey: null })).toMatchObject({ ok: false, status: 403 });
    expect(await dispatch(h.svc, { op: "manage", manageKey: h.manageKey })).toMatchObject({ ok: true });
  });
});

describe("hardening", () => {
  it("checks the sign token before it looks at the draft", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    await expect(h.svc.sign({ signToken: "not-the-token", draft: { ...DRAFT, showName: "" } })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses to create a show under a malformed id or token hash", async () => {
    const h = makeService();
    expect(await dispatch(h.svc, { op: "init", showId: "../x", signTokenHash: await sha256Hex(SIGN_TOKEN) })).toMatchObject({ ok: false, status: 400 });
    expect(await dispatch(h.svc, { op: "init", showId: SHOW, signTokenHash: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(h.store.exists()).toBe(false);
    expect(await dispatch(h.svc, { op: "init", showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) })).toMatchObject({ ok: true });
  });

  it("never shows a job's internal note: needs-attention lines are plain words", async () => {
    const h = await signedService();
    for (const who of ["AA", "BB", "CC"]) await pledge(h.svc, who);
    h.store.updateJob("capture:A-" + h.svc.project().pledges.keys().next().value, { status: "failed", note: "402 INSTRUMENT_DECLINED secret-detail" });
    const v = h.svc.manageView();
    expect(v.attention).toEqual(["A fan's charge didn't go through. We stopped trying, so it needs a look."]);
    expect(JSON.stringify(v)).not.toMatch(/INSTRUMENT_DECLINED|secret-detail/);
  });

  it("keeps PayPal's wording out of the agent log and the API error when a hold is refused", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-denied", orderId, amountCents: 1500, status: "DENIED", createdAt: 0, expiresAt: 1 }));
    const err = await h.svc.authorize(o.orderId).catch((e) => e);
    expect(err.message).not.toMatch(/DENIED/);
    expect(JSON.stringify(h.store.logs())).not.toMatch(/DENIED/);
  });

  it("queues a PENDING hold to be cancelled instead of counting it", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-pend", orderId, amountCents: 1500, status: "PENDING", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    expect(h.store.job("void:A-pend")?.status).toBe("pending");
  });

  it("refuses a hold PayPal answered for a different order", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => ({ authorizationId: "A-x", orderId: "O-other", amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1 }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("when PayPal's answer was unreadable and the hold can't be read in full, queues it to be cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("getAuthorization", () => {
      throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "no body");
    });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "PayPal returned no order");
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-ghost", status: "CREATED" }], captures: [] }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 502 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    expect(h.store.job("void:A-ghost")?.status).toBe("pending");
    expect(h.svc.project().orders.get(o.orderId)?.resolved).toBe(true);
  });

  it("an unreadable authorize answer whose hold is the right one counts as the fan's pledge (no second hold needed)", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "PayPal returned no order");
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-found", status: "CREATED" }], captures: [] }));
    const r = await h.svc.authorize(o.orderId);
    expect(r.status).toBe("held");
    expect(h.svc.project().campaign.pledges.held).toBe(1);
    expect(h.store.job("void:A-found")).toBeUndefined();
    // A retry of the same order now answers from our records.
    expect((await h.svc.authorize(o.orderId)).pledgeId).toBe(r.pledgeId);
    expect(h.paypal.count("authorizeOrder")).toBe(1);
  });

  it("ORDER_ALREADY_AUTHORIZED (our earlier answer was lost) records the existing hold instead of refusing", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "already", undefined, [{ issue: "ORDER_ALREADY_AUTHORIZED" }]);
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-prior", status: "CREATED" }], captures: [] }));
    expect((await h.svc.authorize(o.orderId)).status).toBe("held");
    expect(h.svc.project().pledgeByAuth.get("A-prior")).toBe(o.pledgeId);
  });

  it("a recovered hold for the wrong amount is refused and cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(502, "BAD_RESPONSE_BODY", "odd");
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-odd", status: "CREATED" }], captures: [] }));
    h.paypal.script("getAuthorization", (authorizationId: string, orderId: string) => ({ authorizationId, orderId, amountCents: 100, status: "CREATED", createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("didn't match this show") });
    expect(h.store.job("void:A-odd")?.status).toBe("pending");
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("a recovered hold whose order custom_id is another pledge is refused and cancelled", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "already", undefined, [{ issue: "ORDER_ALREADY_AUTHORIZED" }]);
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", customId: `${SHOW}:pother`, authorizations: [{ id: "A-other", status: "CREATED" }], captures: [] }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.store.job("void:A-other")?.status).toBe("pending");
    expect(h.svc.project().campaign.pledges.held).toBe(0);
  });

  it("ORDER_ALREADY_AUTHORIZED with no live hold (voided or expired) ends the order with a final 409", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "already", undefined, [{ issue: "ORDER_ALREADY_AUTHORIZED" }]);
    });
    h.paypal.script("getOrderPayments", (orderId: string) => ({ orderId, status: "COMPLETED", authorizations: [{ id: "A-gone", status: "VOIDED" }], captures: [] }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.svc.project().orders.get(o.orderId)?.resolved).toBe(true);
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 409 });
    expect(h.paypal.count("authorizeOrder")).toBe(1);
  });

  it("leaves the order open when PayPal can't be reached, so the fan can try again", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(503, "SERVICE_UNAVAILABLE", "busy");
    });
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 502 });
    expect(h.svc.project().orders.get(o.orderId)?.resolved).toBe(false);
    expect((await h.svc.authorize(o.orderId)).status).toBe("held");
  });

  it("refuses an order id PayPal returns that we could not safely use later", async () => {
    const h = await signedService();
    h.paypal.script("createPledgeOrder", () => ({ orderId: "../bad" }));
    await expect(h.svc.createOrder({ initials: "AB" })).rejects.toMatchObject({ status: 502 });
    expect(h.svc.project().orders.size).toBe(0);
  });

  it("stops taking orders after the deadline and closes the show", async () => {
    const h = await signedService();
    h.clock.t = DEADLINE + 1;
    await expect(h.svc.createOrder({ initials: "AB" })).rejects.toMatchObject({ status: 409 });
    expect(h.paypal.calls).toHaveLength(0);
    expect(h.svc.publicView().status).toBe("Called off · nobody paid");
  });
});

describe("task 6 review fixes", () => {
  it("signs atomically: if the signing event can't be written the sign token survives and a retry works", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
    const spy = vi.spyOn(h.store, "appendEvent").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT })).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(h.store.getMeta("sign_token_hash")).toBe(await sha256Hex(SIGN_TOKEN));
    expect(h.store.getMeta("manage_key_hash")).toBeUndefined();
    expect(h.svc.project().mandate).toBeNull();
    const r = await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
    expect(r.show.state).toBe("live");
  });

  it("rejects a hold that carries no custom id", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => ({ authorizationId: "A-nocustom", orderId, amountCents: 1500, status: "CREATED", createdAt: 0, expiresAt: 1 }));
    await expect(h.svc.authorize(o.orderId)).rejects.toMatchObject({ status: 422 });
    expect(h.svc.project().campaign.pledges.held).toBe(0);
    expect(h.store.job("void:A-nocustom")?.status).toBe("pending");
  });

  it("logs 'held a spot' only when this call wrote the event (a racing duplicate stays quiet)", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", (orderId: string) => {
      const hold = { authorizationId: `A-${o.pledgeId}`, orderId, amountCents: 1500, status: "CREATED" as const, createdAt: 0, expiresAt: 1, customId: `${SHOW}:${o.pledgeId}` };
      // The other call wins the race and records the hold first.
      commit(h.store, h.clock.now(), { type: "pledge_held", pledgeId: o.pledgeId, orderId, authorizationId: hold.authorizationId, amountCents: 1500, authorizedAt: 0, expiresAt: 1, initials: "AB", simulated: false });
      return hold;
    });
    const r = await h.svc.authorize(o.orderId);
    expect(r.status).toBe("held");
    expect(h.svc.project().campaign.pledges.held).toBe(1);
    expect(h.store.logs().filter((l) => l.did.includes("held a spot"))).toHaveLength(0);
  });

  it("ends the unreadable-answer recovery message with a plain 'please try again'", async () => {
    const h = await signedService();
    const o = await h.svc.createOrder({ initials: "AB" });
    h.paypal.script("authorizeOrder", () => {
      throw new PayPalError(502, "EMPTY_RESPONSE_BODY", "none");
    });
    const err = await h.svc.authorize(o.orderId).catch((e) => e);
    expect(err.message).toMatch(/please try again\.$/);
  });

  it("words a failed charge softly in the ledger", async () => {
    const h = await signedService();
    const ids: string[] = [];
    for (const who of ["AA", "BB", "CC"]) ids.push((await pledge(h.svc, who)).pledgeId);
    commit(h.store, h.clock.now(), { type: "capture_failed", authorizationId: `A-${ids[0]}`, reason: "declined" });
    expect(h.svc.manageView().ledger.some((r) => r.what === "Charge didn't go through · PayPal shows no payment")).toBe(true);
  });
});
