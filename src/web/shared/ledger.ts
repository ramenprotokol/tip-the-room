// The settlement ledger (spec §4): AG Grid Community, themed with the reference's GRID_THEME.
// Escaping: AG Grid writes values as text; the only renderer (Status) returns a DOM element built with textContent.
import { AllCommunityModule, ModuleRegistry, createGrid, themeQuartz, type ColDef, type GridApi, type ICellRendererParams, type ValueFormatterParams } from "ag-grid-community";
import type { LedgerRowDto, LedgerStatus } from "../../worker/api-types";
import { money2, when } from "./format";
import { GRID_THEME } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

// The reference page's rendered ledger is the source of truth where the static CSS and GRID_THEME disagree: 16 px cell text
// (GRID_THEME says 15), and the odd-row and pinned-cell backgrounds, which the stylesheet sets with exact colours.
export const ledgerTheme = themeQuartz.withParams({ ...GRID_THEME, fontSize: 16 });

const PILL: Record<LedgerStatus, string> = { "On hold": "on-hold", Charged: "charged", Paid: "paid", Cancelled: "cancelled", Refunded: "refunded", Failed: "failed", Pending: "pending", Sent: "pending", Info: "info" };

export function pill(status: LedgerStatus): HTMLElement {
  const s = document.createElement("span");
  s.className = `pill ${PILL[status] ?? "info"}`;
  const dot = document.createElement("i");
  dot.setAttribute("aria-hidden", "true");
  s.append(dot, document.createTextNode(String(status)));
  return s;
}

/** Spreadsheet apps run cells that start with = + - @ (or a tab/CR) as formulas: prefix them with an apostrophe. */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export class LedgerGrid {
  readonly api: GridApi<LedgerRowDto>;
  private readonly tz: () => string;

  constructor(el: HTMLElement, tz: () => string) {
    this.tz = tz;
    const text = (p: ValueFormatterParams<LedgerRowDto>) => (p.value == null ? "" : String(p.value));
    const columnDefs: ColDef<LedgerRowDto>[] = [
      { field: "at", colId: "when", headerName: "When", width: 156, sort: "desc", cellClass: "when", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? when(p.value, this.tz(), "ledger") : "") },
      { field: "what", headerName: "What happened", flex: 1, minWidth: 240, tooltipField: "what", filter: "agTextColumnFilter", valueFormatter: text },
      { field: "who", headerName: "Who", width: 140, filter: "agTextColumnFilter", valueFormatter: text },
      { field: "amountCents", headerName: "Amount", width: 112, type: "rightAligned", cellClass: "num", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? money2(p.value) : "") },
      { field: "ref", headerName: "PayPal ref", width: 200, cellClass: "ref", filter: "agTextColumnFilter", valueFormatter: text },
      { field: "status", headerName: "Status", width: 140, pinned: "right", filter: "agTextColumnFilter", cellRenderer: (p: ICellRendererParams<LedgerRowDto, LedgerStatus>) => (p.value ? pill(p.value) : document.createTextNode("")) },
    ];
    this.api = createGrid<LedgerRowDto>(el, {
      theme: ledgerTheme,
      loadThemeGoogleFonts: false,
      columnDefs,
      rowData: [],
      defaultColDef: { sortable: true, resizable: true },
      enableBrowserTooltips: true,
      enableCellTextSelection: true,
      ensureDomOrder: true,
      suppressColumnVirtualisation: true,
      suppressRowTransform: true,
      animateRows: false,
      // Never put data in this template: AG Grid writes it as HTML.
      overlayNoRowsTemplate: "<span>No money has moved yet.</span>",
    });
  }

  setRows(rows: LedgerRowDto[]): void {
    this.api.setGridOption("rowData", rows);
  }

  csv(fileName: string): void {
    this.api.exportDataAsCsv({
      fileName,
      processCellCallback: (p) => {
        const id = p.column.getColId();
        const v = p.value;
        if (id === "when") return typeof v === "number" ? when(v, this.tz(), "ledger") : "";
        if (id === "amountCents") return typeof v === "number" ? money2(v) : "";
        return csvSafe(v == null ? "" : String(v));
      },
    });
  }

  destroy(): void {
    this.api.destroy();
  }
}
