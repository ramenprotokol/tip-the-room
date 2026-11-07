import "../../src/web/shared/styles.css";
import { LedgerGrid, PayoutGrid } from "../../src/web/shared/ledger";
import { batchHeading } from "../../src/web/shared/ledger-logic";
import type { LedgerRowDto, LedgerStatus, PayoutBatchDto } from "../../src/worker/api-types";

type Stage = "held" | "tipped" | "paid" | "missed";
const T0 = Date.UTC(2026, 10, 3, 19, 0);
const NAMES = ["Fan 01 · JR", "Fan 02 · AK", "Fan 03 · MB", "Fan 04 · LO", "Fan 05 · TS", "Fan 06 · PD", "Fan 07 · NV", "Fan 08 · EH"];

/** The rows the server would send for a small show (8 fans at $15, net of fees $14.12), at four moments of its life. */
export function scenario(stage: Stage): { rows: LedgerRowDto[]; batches: PayoutBatchDto[] } {
  const rows: LedgerRowDto[] = [];
  let seq = 0;
  const fanStatus: LedgerStatus = stage === "held" ? "On hold" : stage === "missed" ? "Cancelled" : "Charged";
  NAMES.forEach((who, i) => rows.push({ seq: ++seq, at: T0 + i * 3_600_000, kind: "hold", what: "Fan held a spot", who, amountCents: 1500, ref: `5UX02069M968${i}893E`, status: fanStatus }));
  if (stage === "tipped" || stage === "paid") {
    NAMES.forEach((who, i) => rows.push({ seq: ++seq, at: T0 + 30 * 3_600_000, kind: "charge", what: "Charged", who, amountCents: 1588, ref: `2CK41190${i}K112345`, status: "Charged" }));
  }
  if (stage === "missed") {
    NAMES.forEach((who, i) => rows.push({ seq: ++seq, at: T0 + 30 * 3_600_000, kind: "release", what: "Hold cancelled · nobody charged", who, amountCents: null, ref: `5UX02069M968${i}893E`, status: "Cancelled" }));
  }
  let batches: PayoutBatchDto[] = [];
  if (stage === "paid") {
    rows.push({ seq: ++seq, at: T0 + 31 * 3_600_000, kind: "info", what: "Deadline reached", who: "Everyone", amountCents: null, ref: null, status: "Info" });
    const lines = [
      { role: "room" as const, label: "Spindle Records", amountCents: 8000, id: "5M4D8LP3F33X6" },
      { role: "opener" as const, label: "The Low Tides", amountCents: 10000, id: "9Q2A7KT4B81WZ" },
      { role: "artist" as const, label: "Juniper Vale", amountCents: 32704, id: "3H6V1NC8R50YD" },
    ];
    for (const l of lines) rows.push({ seq: seq + 1, at: T0 + 32 * 3_600_000, kind: "payout", what: `Paid ${l.label}`, who: l.label, amountCents: l.amountCents, ref: "V8PDK75HD9EW4", status: "Paid" });
    batches = [{ batchId: "V8PDK75HD9EW4", senderBatchId: "payout-s1", status: "SUCCESS", retry: false, items: lines.map((l) => ({ role: l.role, label: l.label, amountCents: l.amountCents, payoutItemId: l.id, transactionId: null, status: "Paid" as const })) }];
  }
  return { rows: rows.reverse(), batches };
}

declare global {
  interface Window {
    __ledgerx: { grid: LedgerGrid; payout: PayoutGrid; load(stage: Stage): void; rows(r: LedgerRowDto[]): void; batches(b: PayoutBatchDto[]): void; scenario: typeof scenario; askImpl: (q: string) => Promise<{ spec: unknown; source: "model" | "keywords" }> };
  }
}

const host = document.getElementById("ledger")!;
const grid = new LedgerGrid(host, () => "UTC", { extras: true, ask: (q) => window.__ledgerx.askImpl(q) });
const payout = new PayoutGrid(document.getElementById("payout-grid")!);
const head = document.querySelector("[data-batch-head]")!;
document.getElementById("csv")!.addEventListener("click", () => grid.csv("ledger.csv"));
document.getElementById("payout-csv")!.addEventListener("click", () => payout.csv("payouts.csv"));
const setBatches = (b: PayoutBatchDto[]) => {
  head.textContent = batchHeading(b);
  payout.setBatches(b);
};
window.__ledgerx = {
  grid,
  payout,
  scenario,
  askImpl: () => Promise.reject(new Error("no worker in this harness")),
  load: (stage) => {
    const s = scenario(stage);
    grid.setRows(s.rows);
    setBatches(s.batches);
  },
  rows: (r) => grid.setRows(r),
  batches: setBatches,
};
document.body.dataset.ready = "1";
