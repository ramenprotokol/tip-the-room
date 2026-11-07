import { describe, expect, it } from "vitest";
import { commit, drain, type ExecDeps } from "../../src/agent/executor";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { RUNNERS } from "../../src/agent/runners";
import { Store } from "../../src/agent/store";
import { ledgerRows, payoutBatches } from "../../src/agent/views";
import { ledgerTotals } from "../../src/web/shared/ledger-logic";
import { FakePayPal } from "./fake-paypal";
import { DEADLINE, held, LAUNCH, signedEvent, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

async function tippedShow(fans = 3) {
  const store = new Store(memoryDb());
  store.migrate();
  const clock = new TestClock(LAUNCH + 1000);
  const paypal = new FakePayPal(clock);
  const d: ExecDeps = { store, paypal, clock, showId: SHOW, card: SIM_CARD };
  commit(store, clock.now(), await signedEvent());
  for (let i = 1; i <= fans; i++) commit(store, clock.now(), held(i));
  await drain(d, RUNNERS);
  return { store, clock, d };
}

async function settle(h: Awaited<ReturnType<typeof tippedShow>>) {
  h.clock.t = DEADLINE;
  commit(h.store, DEADLINE, { type: "deadline_reached", now: DEADLINE, deadline: DEADLINE });
  const end = h.clock.t + 6 * 3600_000;
  for (let i = 0; i < 100; i++) {
    await drain(h.d, RUNNERS);
    const next = h.store.nextJobAt();
    if (next === undefined || next > end) return;
    h.clock.t = Math.max(h.clock.t, next);
  }
}

describe("ledger rows know what they are, and the totals count each fan once", () => {
  it("a show that tipped and paid: 3 charges, no holds left, 2 payees paid, and the hold rows are not counted again", async () => {
    const h = await tippedShow();
    await settle(h);
    const rows = ledgerRows(h.store.events(), h.store.projection(), SHOW);
    expect(rows.every((r) => r.kind !== undefined)).toBe(true);
    const totals = Object.fromEntries(ledgerTotals(rows).map((t) => [t.key, [t.count, t.cents]]));
    expect(totals.held).toEqual([0, 0]);
    expect(totals.charged[0]).toBe(3);
    expect(totals.charged[1]).toBe(rows.filter((r) => r.kind === "charge").reduce((s, r) => s + (r.amountCents ?? 0), 0));
    expect(totals.paid[0]).toBe(2);
    expect(totals.paid[1]).toBe(rows.filter((r) => r.kind === "payout").reduce((s, r) => s + (r.amountCents ?? 0), 0));
    // The three fans also have a hold row each (status Charged); those must not be counted as a second charge.
    expect(rows.filter((r) => r.kind === "hold")).toHaveLength(3);
  });

  it("holds that have not tipped yet are Held, in whole cents", async () => {
    const h = await tippedShow(2); // one short of the target: nobody is charged
    const rows = ledgerRows(h.store.events(), h.store.projection(), SHOW);
    expect(ledgerTotals(rows).find((x) => x.key === "held")).toMatchObject({ count: 2, cents: 2 * 1500 });
    expect(ledgerTotals(rows).find((x) => x.key === "charged")).toMatchObject({ count: 0, cents: 0 });
  });
});

describe("payoutBatches", () => {
  it("lists each payee with PayPal's batch id, payout item id and status, matching the signed split", async () => {
    const h = await tippedShow();
    await settle(h);
    const batches = payoutBatches(h.store.projection(), SHOW);
    expect(batches).toHaveLength(1);
    const b = batches[0];
    expect(b.batchId).toMatch(/^B-/);
    expect(b.retry).toBe(false);
    expect(b.items.map((i) => i.role).sort()).toEqual(["artist", "room"]);
    for (const i of b.items) {
      expect(i.status).toBe("Paid");
      expect(i.payoutItemId).toBe(`PI-${b.batchId}-${i.role}`);
    }
    const sent = h.store.projection().payouts[0].lines;
    expect(b.items.map((i) => [i.role, i.amountCents]).sort()).toEqual(sent.map((l) => [l.role, l.amount]).sort());
  });

  it("is empty before any payout is sent", async () => {
    const h = await tippedShow();
    expect(payoutBatches(h.store.projection(), SHOW)).toEqual([]);
  });
});
