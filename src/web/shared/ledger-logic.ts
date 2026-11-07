// The ledger grid's pure logic: row ids, the live row diff, the totals, the status chips and the grid models built from an
// "Ask the ledger" spec. No DOM and no AG Grid import, so it is unit-tested directly. Amounts are whole cents, like the money code.
import type { LedgerSpec } from "../../agent/ledger-ask";
import type { LedgerRowDto, LedgerStatus, PayoutBatchDto } from "../../worker/api-types";

export interface LedgerRow extends LedgerRowDto {
  /** Stable for the life of the row: its event number plus its place among the rows of that same event. The status never goes into it. */
  id: string;
}

/**
 * AG Grid's `getRowId` needs an id that does not change when a hold becomes charged or cancelled. Several rows can share one
 * event (a payout batch has one row per payee), so the id is `seq:n`, n counting the earlier rows of the same event.
 */
export function withIds(rows: readonly LedgerRowDto[]): LedgerRow[] {
  const seen = new Map<number, number>();
  return rows.map((r) => {
    const n = seen.get(r.seq) ?? 0;
    seen.set(r.seq, n + 1);
    return { ...r, id: `${r.seq}:${n}` };
  });
}

const FIELDS = ["at", "kind", "what", "who", "amountCents", "ref", "status"] as const;
const same = (a: LedgerRow, b: LedgerRow): boolean => FIELDS.every((f) => a[f] === b[f]);

export interface RowDiff {
  add: LedgerRow[];
  update: LedgerRow[];
  remove: LedgerRow[];
}

/** What changed between the rows the grid holds and the new ones: only these go to `applyTransaction`. */
export function diffRows(current: ReadonlyMap<string, LedgerRow>, next: readonly LedgerRow[]): RowDiff {
  const out: RowDiff = { add: [], update: [], remove: [] };
  const keep = new Set<string>();
  for (const row of next) {
    keep.add(row.id);
    const old = current.get(row.id);
    if (!old) out.add.push(row);
    else if (!same(old, row)) out.update.push(row);
  }
  for (const [id, old] of current) if (!keep.has(id)) out.remove.push(old);
  return out;
}

/* ---------- totals ---------- */

export type TotalKey = "held" | "charged" | "cancelled" | "refunded" | "paid";
export interface TotalLine {
  key: TotalKey;
  label: string;
  /** What the count is a count of, for the "who" cell. */
  unit: string;
  count: number;
  cents: number;
  status: LedgerStatus;
  /** Only "paid": payouts sent but not yet confirmed by PayPal. They are NOT in count or cents. */
  inFlight?: { count: number; cents: number };
}

const cents = (n: number | null): number => (n !== null && Number.isSafeInteger(n) && n > 0 ? n : 0);

/**
 * Each fan or payee is counted once, from the row that stands for them (the ledger also has an event row for the same money):
 *  held      a fan's hold row that is still On hold
 *  charged   a charge row that is still Charged (the gross PayPal took)
 *  cancelled a fan's hold row whose status is Cancelled (the void event row has no amount)
 *  refunded  a refund row
 *  paid out  a payout row that PayPal has confirmed Paid (Sent ones are shown as "in flight", not added in)
 * Totals ignore the search box and the chips: they are always the whole ledger.
 */
export function ledgerTotals(rows: readonly LedgerRowDto[]): TotalLine[] {
  const held: TotalLine = { key: "held", label: "Held now · not charged", unit: "holds", count: 0, cents: 0, status: "On hold" };
  const charged: TotalLine = { key: "charged", label: "Charged", unit: "charges", count: 0, cents: 0, status: "Charged" };
  const cancelled: TotalLine = { key: "cancelled", label: "Cancelled · nobody charged", unit: "holds", count: 0, cents: 0, status: "Cancelled" };
  const refunded: TotalLine = { key: "refunded", label: "Refunded", unit: "refunds", count: 0, cents: 0, status: "Refunded" };
  const paid: TotalLine = { key: "paid", label: "Paid out", unit: "payees", count: 0, cents: 0, status: "Paid" };
  const flight = { count: 0, cents: 0 };
  const add = (line: { count: number; cents: number }, c: number) => {
    line.count += 1;
    line.cents += c;
  };
  for (const r of rows) {
    const c = cents(r.amountCents);
    if (r.kind === "hold" && r.status === "On hold") add(held, c);
    else if (r.kind === "hold" && r.status === "Cancelled") add(cancelled, c);
    else if (r.kind === "charge" && r.status === "Charged") add(charged, c);
    else if (r.kind === "refund") add(refunded, c);
    else if (r.kind === "payout" && r.status === "Paid") add(paid, c);
    else if (r.kind === "payout" && r.status === "Sent") add(flight, c);
  }
  if (flight.count > 0) paid.inFlight = flight;
  return [held, charged, cancelled, refunded, paid];
}

/* ---------- status chips ---------- */

export interface StatusChip {
  id: "all" | "hold" | "charged" | "cancelled" | "refunded" | "paid";
  label: string;
  statuses: LedgerStatus[];
}

export const STATUS_CHIPS: readonly StatusChip[] = [
  { id: "all", label: "All", statuses: [] },
  { id: "hold", label: "On hold", statuses: ["On hold"] },
  { id: "charged", label: "Charged", statuses: ["Charged"] },
  { id: "cancelled", label: "Cancelled", statuses: ["Cancelled"] },
  { id: "refunded", label: "Refunded", statuses: ["Refunded"] },
  { id: "paid", label: "Paid out", statuses: ["Paid", "Sent"] },
];

/** The status column's filter model for these statuses: one `equals`, or an OR of them. Empty: no filter on the column. */
export function statusFilterModel(statuses: readonly LedgerStatus[]): Record<string, unknown> | null {
  if (statuses.length === 0) return null;
  const cond = (s: LedgerStatus) => ({ filterType: "text", type: "equals", filter: s });
  return statuses.length === 1 ? cond(statuses[0]) : { filterType: "text", operator: "OR", conditions: statuses.map(cond) };
}

/** Reads a status filter model back into statuses (so the chips follow a filter set from the column menu or by Ask the ledger). */
export function statusesOfModel(model: unknown): LedgerStatus[] | null {
  if (!model || typeof model !== "object") return [];
  const m = model as { type?: unknown; filter?: unknown; operator?: unknown; conditions?: unknown };
  if (m.type === "equals" && typeof m.filter === "string") return [m.filter as LedgerStatus];
  if (m.operator === "OR" && Array.isArray(m.conditions)) {
    const out: LedgerStatus[] = [];
    for (const c of m.conditions) {
      if (!c || typeof c !== "object" || (c as { type?: unknown }).type !== "equals" || typeof (c as { filter?: unknown }).filter !== "string") return null;
      out.push((c as { filter: LedgerStatus }).filter);
    }
    return out;
  }
  return null;
}

export function chipOfStatuses(statuses: readonly LedgerStatus[] | null): StatusChip["id"] | null {
  if (statuses === null) return null;
  const key = [...statuses].sort().join("|");
  return STATUS_CHIPS.find((c) => [...c.statuses].sort().join("|") === key)?.id ?? null;
}

/* ---------- Ask the ledger → grid ---------- */

export interface SpecGridModel {
  /** For `api.setFilterModel`. Replaces every column filter, so an old filter can't hide the answer. */
  filterModel: Record<string, unknown>;
  /** For `api.applyColumnState`. */
  sort: { colId: string; sort: "asc" | "desc" } | null;
}

/** A checked spec as the two things the grid is given. The spec must already have passed `validateLedgerSpec`. */
export function specToGridModel(spec: LedgerSpec): SpecGridModel {
  const filterModel: Record<string, unknown> = {};
  const status = statusFilterModel(spec.statuses);
  if (status) filterModel.status = status;
  if (spec.contains) filterModel[spec.contains.col] = { filterType: "text", type: "contains", filter: spec.contains.text };
  return { filterModel, sort: spec.sort ? { colId: spec.sort.col, sort: spec.sort.dir } : null };
}

/* ---------- payout grid ---------- */

export interface PayoutRow {
  id: string;
  payee: string;
  role: string;
  amountCents: number;
  payoutItemId: string | null;
  status: LedgerStatus;
}

/** The batch id (or a plain word until PayPal answers) for the header above the payout grid. */
export function batchHeading(batches: readonly PayoutBatchDto[]): string {
  if (batches.length === 0) return "No payout batch yet. It is sent when the show is on.";
  return batches.map((b) => `${b.retry ? "Second try" : "Payout batch"}: ${b.batchId ?? "waiting for PayPal"}`).join("  ·  ");
}
