import { describe, expect, it } from "vitest";
import type { LedgerRowDto, LedgerStatus, PayoutBatchDto } from "../../src/worker/api-types";
import { batchHeading, chipOfStatuses, diffRows, ledgerTotals, specToGridModel, STATUS_CHIPS, statusesOfModel, statusFilterModel, withIds, type LedgerRow } from "../../src/web/shared/ledger-logic";

const row = (seq: number, o: Partial<LedgerRowDto> = {}): LedgerRowDto => ({ seq, at: 1000 + seq, kind: "hold", what: "Fan held a spot", who: `Fan ${seq}`, amountCents: 1500, ref: `A${seq}`, status: "On hold", ...o });

describe("withIds", () => {
  it("gives every row a stable id that does not include the status", () => {
    const a = withIds([row(3), row(2), row(1)]);
    const b = withIds([row(3, { status: "Charged" }), row(2, { status: "Cancelled" }), row(1)]);
    expect(a.map((r) => r.id)).toEqual(["3:0", "2:0", "1:0"]);
    expect(b.map((r) => r.id)).toEqual(a.map((r) => r.id));
  });

  it("separates the rows of one event (a payout batch pays several people)", () => {
    const rows = withIds([row(5, { kind: "payout", who: "Room" }), row(5, { kind: "payout", who: "Artist" }), row(4)]);
    expect(rows.map((r) => r.id)).toEqual(["5:0", "5:1", "4:0"]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });
});

describe("diffRows: what goes to applyTransaction", () => {
  const held = (...n: number[]) => new Map(withIds(n.map((i) => row(i))).map((r) => [r.id, r] as [string, LedgerRow]));

  it("adds new rows, updates changed ones and removes gone ones, and leaves the rest alone", () => {
    const current = held(1, 2, 3);
    const next = withIds([row(4), row(3, { status: "Charged" }), row(2)]);
    const d = diffRows(current, next);
    expect(d.add.map((r) => r.id)).toEqual(["4:0"]);
    expect(d.update.map((r) => [r.id, r.status])).toEqual([["3:0", "Charged"]]);
    expect(d.remove.map((r) => r.id)).toEqual(["1:0"]);
  });

  it("is empty when nothing changed", () => {
    const next = withIds([row(1), row(2)]);
    expect(diffRows(new Map(next.map((r) => [r.id, r] as [string, LedgerRow])), next)).toEqual({ add: [], update: [], remove: [] });
  });

  it("notices a payout going from Sent to Paid and a new PayPal ref", () => {
    const sent = withIds([row(9, { kind: "payout", what: "Sent to Room", status: "Sent", ref: "S-1" })]);
    const paid = withIds([row(9, { kind: "payout", what: "Paid Room", status: "Paid", ref: "B-1" })]);
    expect(diffRows(new Map(sent.map((r) => [r.id, r] as [string, LedgerRow])), paid).update).toHaveLength(1);
  });
});

describe("ledgerTotals", () => {
  const key = (t: ReturnType<typeof ledgerTotals>) => Object.fromEntries(t.map((x) => [x.key, [x.count, x.cents]]));

  it("counts each fan once: the hold row says held or cancelled, the charge row says charged", () => {
    const rows: LedgerRowDto[] = [
      row(1, { status: "Charged" }), // fan 1's hold row, now charged: NOT counted again
      row(2, { kind: "charge", what: "Charged", amountCents: 1588, status: "Charged" }),
      row(3, { status: "On hold" }),
      row(4, { amountCents: 1200, status: "Cancelled" }),
      row(5, { kind: "release", what: "Hold cancelled · nobody charged", amountCents: null, status: "Cancelled" }), // the void event: no amount, not a second cancel
      row(6, { kind: "refund", what: "Refunded", amountCents: 1588, status: "Refunded" }),
      row(7, { kind: "payout", status: "Paid", amountCents: 8000 }),
      row(8, { kind: "payout", status: "Paid", amountCents: 33000 }),
    ];
    expect(key(ledgerTotals(rows))).toEqual({ held: [1, 1500], charged: [1, 1588], cancelled: [1, 1200], refunded: [1, 1588], paid: [2, 41000] });
  });

  it("keeps payouts PayPal has not confirmed out of Paid and reports them as in flight", () => {
    const t = ledgerTotals([row(1, { kind: "payout", status: "Sent", amountCents: 10000 }), row(2, { kind: "payout", status: "Paid", amountCents: 500 })]);
    const paid = t.find((x) => x.key === "paid")!;
    expect([paid.count, paid.cents]).toEqual([1, 500]);
    expect(paid.inFlight).toEqual({ count: 1, cents: 10000 });
  });

  it("adds whole cents exactly (no float drift) and ignores bad amounts", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1, { amountCents: 1999 }));
    expect(ledgerTotals(rows)[0].cents).toBe(1_999_000);
    const odd = [row(1, { amountCents: 0.5 }), row(2, { amountCents: -300 }), row(3, { amountCents: Number.NaN }), row(4, { amountCents: null }), row(5, { amountCents: 100 })];
    expect(ledgerTotals(odd)[0]).toMatchObject({ count: 5, cents: 100 });
  });

  it("is zero for an empty ledger and for rows from an older server with no kind", () => {
    expect(key(ledgerTotals([]))).toEqual({ held: [0, 0], charged: [0, 0], cancelled: [0, 0], refunded: [0, 0], paid: [0, 0] });
    const bare: LedgerRowDto = { ...row(1), kind: undefined };
    expect(ledgerTotals([bare])[0].count).toBe(0);
  });

  it("follows a hold through its life: held, then charged, then refunded", () => {
    const step = (status: LedgerStatus, extra: LedgerRowDto[] = []) => ledgerTotals([row(1, { status }), ...extra]);
    expect(step("On hold")[0].count).toBe(1);
    const charged = step("Charged", [row(2, { kind: "charge", amountCents: 1588, status: "Charged" })]);
    expect([charged[0].count, charged[1].count]).toEqual([0, 1]);
    const refunded = step("Refunded", [row(2, { kind: "charge", amountCents: 1588, status: "Refunded" }), row(3, { kind: "refund", amountCents: 1588, status: "Refunded" })]);
    expect([refunded[1].count, refunded[3].count]).toEqual([0, 1]);
  });
});

describe("status chips and the filter model", () => {
  it("has the six chips from the brief, in order", () => {
    expect(STATUS_CHIPS.map((c) => c.label)).toEqual(["All", "On hold", "Charged", "Cancelled", "Refunded", "Paid out"]);
  });

  it("builds an equals filter for one status and an OR for several, and reads them back", () => {
    expect(statusFilterModel([])).toBeNull();
    expect(statusFilterModel(["Charged"])).toEqual({ filterType: "text", type: "equals", filter: "Charged" });
    const paid = statusFilterModel(["Paid", "Sent"]);
    expect(paid).toMatchObject({ operator: "OR" });
    expect(statusesOfModel(paid)).toEqual(["Paid", "Sent"]);
    expect(statusesOfModel(statusFilterModel(["Cancelled"]))).toEqual(["Cancelled"]);
    expect(statusesOfModel({ filterType: "text", type: "contains", filter: "Can" })).toBeNull();
  });

  it("lights the chip that matches the filter, and none for a filter no chip makes", () => {
    expect(chipOfStatuses(statusesOfModel(statusFilterModel(["Paid", "Sent"])))).toBe("paid");
    expect(chipOfStatuses(["Refunded"])).toBe("refunded");
    expect(chipOfStatuses([])).toBe("all");
    expect(chipOfStatuses(["Failed"])).toBeNull();
    expect(chipOfStatuses(null)).toBeNull();
  });
});

describe("specToGridModel", () => {
  it("turns a checked spec into the filter model and sort the grid is given", () => {
    const m = specToGridModel({ statuses: ["Cancelled"], contains: { col: "who", text: "Fan 03" }, sort: { col: "amountCents", dir: "desc" } });
    expect(m.filterModel).toEqual({ status: { filterType: "text", type: "equals", filter: "Cancelled" }, who: { filterType: "text", type: "contains", filter: "Fan 03" } });
    expect(m.sort).toEqual({ colId: "amountCents", sort: "desc" });
    expect(specToGridModel({ statuses: [], contains: null, sort: null })).toEqual({ filterModel: {}, sort: null });
  });
});

describe("batchHeading", () => {
  const batch = (o: Partial<PayoutBatchDto> = {}): PayoutBatchDto => ({ batchId: "ABC123", senderBatchId: "payout-s1", status: "SUCCESS", retry: false, items: [], ...o });
  it("shows the PayPal batch id, the second try, and a plain line before anything is sent", () => {
    expect(batchHeading([])).toMatch(/No payout batch yet/);
    expect(batchHeading([batch()])).toBe("Payout batch: ABC123");
    expect(batchHeading([batch(), batch({ batchId: "XYZ9", retry: true })])).toBe("Payout batch: ABC123  ·  Second try: XYZ9");
    expect(batchHeading([batch({ batchId: null })])).toBe("Payout batch: waiting for PayPal");
  });
});
