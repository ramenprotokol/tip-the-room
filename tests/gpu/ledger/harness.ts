import "../../../src/web/shared/styles.css";
import { LedgerGrid } from "../../../src/web/shared/ledger";
import type { LedgerRowDto } from "../../../src/worker/api-types";

declare global {
  interface Window { __ledger: { grid: LedgerGrid; rows(r: LedgerRowDto[]): void } }
}

const grid = new LedgerGrid(document.getElementById("ledger")!, () => "UTC");
document.getElementById("csv")!.addEventListener("click", () => grid.csv("tip-the-room-ledger.csv"));
window.__ledger = { grid, rows: (r) => grid.setRows(r) };
document.body.dataset.ready = "1";
