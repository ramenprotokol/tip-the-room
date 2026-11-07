// The settlement ledger (spec §4): AG Grid Community, themed with the reference's GRID_THEME.
// Escaping: AG Grid writes values as text; the only renderer (Status) returns a DOM element built with textContent.
//
// AG Grid Community features used (every one verified in ag-grid-community 36.2.0, none needs Enterprise):
//   getRowId + applyTransaction ({add, update, remove}) + enableCellChangeFlash / flashCells  live delta updates
//   pinnedBottomRowData        a pinned totals block      quickFilterText  the search box
//   setFilterModel / getFilterModel / onFilterChanged  the status chips      applyColumnState   "Ask the ledger" sorting
//   exportDataAsCsv (with processCellCallback)           a second grid for the payout batch
import { AllCommunityModule, ModuleRegistry, createGrid, themeQuartz, type ColDef, type GridApi, type ICellRendererParams, type ValueFormatterParams } from "ag-grid-community";
import { keywordSpec, validateLedgerSpec, describeSpec, type LedgerSpec } from "../../agent/ledger-ask";
import type { LedgerRowDto, LedgerStatus, PayoutBatchDto } from "../../worker/api-types";
import { money2, ROLE_WORD, when } from "./format";
import { chipOfStatuses, diffRows, ledgerTotals, specToGridModel, STATUS_CHIPS, statusFilterModel, statusesOfModel, withIds, type LedgerRow, type PayoutRow, type TotalLine } from "./ledger-logic";
import { GRID_THEME } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

// The reference page's rendered ledger is the source of truth where the static CSS and GRID_THEME disagree: 16 px cell text
// (GRID_THEME says 15), and the odd-row and pinned-cell backgrounds, which the stylesheet sets with exact colours.
// The one addition is the flash a changed cell makes: the sign's bulb yellow.
export const ledgerTheme = themeQuartz.withParams({ ...GRID_THEME, fontSize: 16, valueChangeValueHighlightBackgroundColor: "rgba(226, 167, 60, 0.7)" });

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

const text = (p: ValueFormatterParams) => (p.value == null ? "" : String(p.value));
const statusCell = (p: ICellRendererParams<unknown, LedgerStatus>) => (p.value ? pill(p.value) : document.createTextNode(""));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", content = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (content) n.textContent = content;
  return n;
}

/** What "Ask the ledger" gets back from the Worker. The page checks `spec` again with validateLedgerSpec before using it. */
export interface AskReply {
  spec: unknown;
  source: "model" | "keywords";
}
export interface LedgerOptions {
  /** Search box, status chips, the totals block and "Ask the ledger". Off for the pixel-parity pages, which keep the plain grid. */
  extras?: boolean;
  /** Sends the question to the Worker. Absent or failing: the keyword matcher answers on the page. */
  ask?: (question: string) => Promise<AskReply>;
}

const TOTAL_ROW_HEIGHT = 40;

export class LedgerGrid {
  readonly api: GridApi<LedgerRow>;
  private readonly tz: () => string;
  private readonly rows = new Map<string, LedgerRow>();
  private loaded = false;
  private totalsJson = "";
  private chips: { id: string; btn: HTMLButtonElement }[] = [];
  private say: HTMLElement | null = null;
  private search: HTMLInputElement | null = null;

  constructor(host: HTMLElement, tz: () => string, private readonly opts: LedgerOptions = {}) {
    this.tz = tz;
    const columnDefs: ColDef<LedgerRow>[] = [
      { field: "at", colId: "when", headerName: "When", width: 156, sort: "desc", comparator: byTimeThenSeq, cellClass: "when", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" && !p.node?.rowPinned ? when(p.value, this.tz(), "ledger") : ""), getQuickFilterText: (p) => (typeof p.value === "number" ? when(p.value, this.tz(), "ledger") : "") },
      { field: "what", headerName: "What happened", flex: 1, minWidth: 240, tooltipField: "what", filter: "agTextColumnFilter", valueFormatter: text, enableCellChangeFlash: true },
      { field: "who", headerName: "Who", width: 140, filter: "agTextColumnFilter", valueFormatter: text },
      { field: "amountCents", headerName: "Amount", width: 112, type: "rightAligned", cellClass: "num", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? money2(p.value) : ""), getQuickFilterText: (p) => (typeof p.value === "number" ? `${money2(p.value)} ${p.value / 100}` : ""), enableCellChangeFlash: true },
      { field: "ref", headerName: "PayPal ref", width: 200, cellClass: "ref", filter: "agTextColumnFilter", valueFormatter: text },
      { field: "status", headerName: "Status", width: 140, pinned: "right", filter: "agTextColumnFilter", filterParams: { maxNumConditions: 9 }, enableCellChangeFlash: true, cellRenderer: statusCell },
      // Hidden: the headers stay the six the page shows. Ties on the time sort by this inside the When comparator (one sorted column, so AG Grid shows no sort-order number).
      { field: "seq", colId: "seq", hide: true, filter: false },
    ];
    const extras = opts.extras === true;
    if (extras) this.buildBar(host);
    host.classList.toggle("has-totals", extras);
    this.api = createGrid<LedgerRow>(host, {
      theme: ledgerTheme,
      loadThemeGoogleFonts: false,
      columnDefs,
      rowData: [],
      // The row id never changes when a hold becomes charged or cancelled, so AG Grid updates that row in place (and flashes it).
      getRowId: (p) => p.data.id,
      defaultColDef: { sortable: true, resizable: true },
      enableBrowserTooltips: true,
      enableCellTextSelection: true,
      ensureDomOrder: true,
      suppressColumnVirtualisation: true,
      suppressRowTransform: true,
      animateRows: false,
      cellFlashDuration: 900,
      cellFadeDuration: 1400,
      // Never put data in this template: AG Grid writes it as HTML.
      overlayNoRowsTemplate: "<span>No money has moved yet.</span>",
      ...(extras
        ? {
            pinnedBottomRowData: [],
            getRowHeight: (p) => (p.node.rowPinned ? TOTAL_ROW_HEIGHT : undefined),
            getRowClass: (p) => (p.node.rowPinned ? "ledger-total" : undefined),
            onFilterChanged: () => this.syncChips(),
          }
        : {}),
    });
  }

  /** Applies the newest rows as a delta: only rows that were added, changed or removed are touched, and changed cells flash. */
  setRows(next: LedgerRowDto[]): void {
    const rows = withIds(next);
    const diff = diffRows(this.rows, rows);
    if (!this.loaded) {
      this.api.setGridOption("rowData", rows);
      this.loaded = true;
    } else if (diff.add.length + diff.update.length + diff.remove.length > 0) {
      const res = this.api.applyTransaction({ add: diff.add, update: diff.update, remove: diff.remove });
      // A row that arrives after the first load is a new money move: flash its status so the eye finds it.
      if (res && res.add.length > 0) this.api.flashCells({ rowNodes: res.add, columns: ["status"] });
    }
    this.rows.clear();
    for (const r of rows) this.rows.set(r.id, r);
    if (this.opts.extras) this.setTotals(rows);
  }

  private setTotals(rows: readonly LedgerRowDto[]): void {
    const lines = ledgerTotals(rows);
    const json = JSON.stringify(lines);
    if (json === this.totalsJson) return;
    this.totalsJson = json;
    this.api.setGridOption("pinnedBottomRowData", lines.map(totalRow));
  }

  csv(fileName: string): void {
    this.api.exportDataAsCsv({
      fileName,
      skipPinnedBottom: true, // the totals block is a display, not ledger rows
      processCellCallback: (p) => {
        const id = p.column.getColId();
        const v = p.value;
        if (id === "when") return typeof v === "number" ? when(v, this.tz(), "ledger") : "";
        if (id === "amountCents") return typeof v === "number" ? money2(v) : "";
        return csvSafe(v == null ? "" : String(v));
      },
    });
  }

  /* ---------- search, chips and Ask the ledger ---------- */

  private buildBar(grid: HTMLElement): void {
    const bar = el("div", "ledger-bar");
    const search = el("input", "ledger-search");
    search.type = "search";
    search.placeholder = "Search: a name, a PayPal ref, an amount";
    search.setAttribute("aria-label", "Search the ledger");
    search.autocomplete = "off";
    search.maxLength = 60;
    search.addEventListener("input", () => this.api.setGridOption("quickFilterText", search.value));
    this.search = search;

    const chips = el("div", "ledger-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "Filter by status");
    for (const c of STATUS_CHIPS) {
      const b = el("button", "chip", c.label);
      b.type = "button";
      b.setAttribute("aria-pressed", c.id === "all" ? "true" : "false");
      b.addEventListener("click", () => this.setStatusChip(c.statuses));
      chips.append(b);
      this.chips.push({ id: c.id, btn: b });
    }

    bar.append(search, chips);
    if (this.opts.ask !== undefined) bar.append(this.buildAsk());
    grid.parentElement?.insertBefore(bar, grid);
  }

  private buildAsk(): HTMLElement {
    const form = el("form", "ledger-ask");
    form.setAttribute("role", "search");
    const input = el("input", "ledger-search");
    input.type = "text";
    input.maxLength = 200;
    input.placeholder = "Ask the ledger: “which holds were cancelled?” or “biggest payouts”";
    input.setAttribute("aria-label", "Ask the ledger");
    input.autocomplete = "off";
    const go = el("button", "btn btn-ghost ask-go", "Ask");
    go.type = "submit";
    const clear = el("button", "linkish ask-clear", "Clear");
    clear.type = "button";
    clear.hidden = true;
    const say = el("p", "ledger-say");
    say.setAttribute("aria-live", "polite");
    this.say = say;
    clear.addEventListener("click", () => {
      this.clearAsk();
      input.value = "";
      clear.hidden = true;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      go.disabled = true;
      void this.ask(q).finally(() => {
        go.disabled = false;
        clear.hidden = false;
      });
    });
    const wrap = el("div", "ledger-ask-wrap");
    const row = el("div", "ledger-ask-row");
    row.append(input, go, clear);
    form.append(row);
    wrap.append(form, say);
    return wrap;
  }

  /** Sends the question out, checks what comes back, and only then touches the grid. A refused spec is never applied. */
  async ask(question: string): Promise<{ spec: LedgerSpec | null; source: "model" | "keywords" }> {
    let spec: LedgerSpec | null = null;
    let source: "model" | "keywords" = "keywords";
    if (this.opts.ask) {
      try {
        const reply = await this.opts.ask(question);
        spec = validateLedgerSpec(reply.spec); // the page never trusts the network either
        if (spec) source = reply.source === "model" ? "model" : "keywords";
      } catch {
        spec = null;
      }
    }
    if (!spec) {
      spec = keywordSpec(question, [...this.rows.values()].map((r) => r.who));
      source = "keywords";
    }
    if (!spec) {
      this.setSay("I couldn’t turn that into a filter. Try “cancelled holds”, “biggest payouts” or a fan’s name.");
      return { spec: null, source };
    }
    this.applySpec(spec);
    this.setSay(`${source === "model" ? "Asked the model" : "Matched your words"} · showing ${describeSpec(spec)}`);
    return { spec, source };
  }

  /** The two grid calls an allowlisted spec can make: the filter model and the sort. Nothing else in the grid is reachable from a spec. */
  applySpec(spec: LedgerSpec): void {
    const model = specToGridModel(spec);
    if (this.search) this.search.value = "";
    this.api.setGridOption("quickFilterText", "");
    this.api.setFilterModel(model.filterModel);
    this.api.applyColumnState({ state: model.sort ? [{ colId: model.sort.colId, sort: model.sort.sort }] : defaultSort(), defaultState: { sort: null } });
  }

  clearAsk(): void {
    this.api.setFilterModel(null);
    this.api.setGridOption("quickFilterText", "");
    if (this.search) this.search.value = "";
    this.api.applyColumnState({ state: defaultSort(), defaultState: { sort: null } });
    this.setSay("");
  }

  private setSay(t: string): void {
    if (this.say) this.say.textContent = t;
  }

  private setStatusChip(statuses: LedgerStatus[]): void {
    const model = { ...(this.api.getFilterModel() as Record<string, unknown>) };
    const status = statusFilterModel(statuses);
    if (status) model.status = status;
    else delete model.status;
    this.api.setFilterModel(model);
  }

  /** The chips follow the status filter, whoever set it (a chip, the column menu or Ask the ledger). */
  private syncChips(): void {
    const model = (this.api.getFilterModel() as Record<string, unknown>).status;
    const active = model === undefined ? "all" : chipOfStatuses(statusesOfModel(model));
    for (const c of this.chips) c.btn.setAttribute("aria-pressed", String(c.id === active));
  }

  destroy(): void {
    this.api.destroy();
  }
}

/** Time first; rows with the same time (a payout batch's lines) fall back to the event order. */
const byTimeThenSeq = (a: unknown, b: unknown, na: { data?: { seq?: number } } | null, nb: { data?: { seq?: number } } | null): number =>
  (Number(a ?? 0) - Number(b ?? 0)) || ((na?.data?.seq ?? 0) - (nb?.data?.seq ?? 0));
const defaultSort = () => [
  { colId: "when", sort: "desc" as const },
];

/** A pinned totals line as a grid row: it reuses the ledger's own columns, so the numbers line up with the rows above. */
function totalRow(t: TotalLine): LedgerRow {
  const flight = t.inFlight ? `+ ${money2(t.inFlight.cents)} sent, PayPal not confirmed yet` : "";
  return { id: `total:${t.key}`, seq: 0, at: 0, kind: "info", what: t.label, who: `${t.count} ${t.count === 1 ? t.unit.replace(/s$/, "") : t.unit}`, amountCents: t.cents, ref: flight || null, status: t.status };
}

/* ---------- the payout batch grid ---------- */

const payoutRows = (batches: readonly PayoutBatchDto[]): PayoutRow[] =>
  batches.flatMap((b) =>
    b.items.map((i) => ({
      id: `${b.senderBatchId}:${i.role}`,
      payee: b.retry ? `${i.label} (second try)` : i.label,
      role: ROLE_WORD[i.role],
      amountCents: i.amountCents,
      payoutItemId: i.payoutItemId,
      status: i.status,
    })),
  );

/** The second grid: who PayPal was told to pay, how much, PayPal's item id and where each stands. Its own CSV. */
export class PayoutGrid {
  readonly api: GridApi<PayoutRow>;
  private loaded = false;
  private readonly rows = new Map<string, PayoutRow>();

  constructor(host: HTMLElement) {
    const columnDefs: ColDef<PayoutRow>[] = [
      { field: "payee", headerName: "Payee", flex: 1, minWidth: 160, filter: "agTextColumnFilter", valueFormatter: text },
      { field: "role", headerName: "Role", width: 120, filter: "agTextColumnFilter", valueFormatter: text },
      { field: "amountCents", headerName: "Amount", width: 120, type: "rightAligned", cellClass: "num", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? money2(p.value) : ""), enableCellChangeFlash: true },
      { field: "payoutItemId", headerName: "PayPal payout item id", width: 230, cellClass: "ref", filter: "agTextColumnFilter", valueFormatter: (p) => (p.value == null ? "Waiting for PayPal" : String(p.value)), enableCellChangeFlash: true },
      { field: "status", headerName: "Status", width: 140, pinned: "right", filter: "agTextColumnFilter", enableCellChangeFlash: true, cellRenderer: statusCell },
    ];
    this.api = createGrid<PayoutRow>(host, {
      theme: ledgerTheme,
      loadThemeGoogleFonts: false,
      columnDefs,
      rowData: [],
      getRowId: (p) => p.data.id,
      defaultColDef: { sortable: true, resizable: true },
      enableCellTextSelection: true,
      ensureDomOrder: true,
      suppressColumnVirtualisation: true,
      suppressRowTransform: true,
      animateRows: false,
      cellFlashDuration: 900,
      cellFadeDuration: 1400,
      domLayout: "autoHeight",
      overlayNoRowsTemplate: "<span>Nobody has been paid yet.</span>",
    });
  }

  setBatches(batches: readonly PayoutBatchDto[]): void {
    const rows = payoutRows(batches);
    if (!this.loaded) {
      this.api.setGridOption("rowData", rows);
      this.loaded = true;
    } else {
      const add = rows.filter((r) => !this.rows.has(r.id));
      const update = rows.filter((r) => {
        const o = this.rows.get(r.id);
        return o !== undefined && (o.payee !== r.payee || o.amountCents !== r.amountCents || o.payoutItemId !== r.payoutItemId || o.status !== r.status || o.role !== r.role);
      });
      const keep = new Set(rows.map((r) => r.id));
      const remove = [...this.rows.values()].filter((r) => !keep.has(r.id));
      if (add.length + update.length + remove.length > 0) this.api.applyTransaction({ add, update, remove });
    }
    this.rows.clear();
    for (const r of rows) this.rows.set(r.id, r);
  }

  csv(fileName: string): void {
    this.api.exportDataAsCsv({ fileName, processCellCallback: (p) => (p.column.getColId() === "amountCents" ? (typeof p.value === "number" ? money2(p.value) : "") : csvSafe(p.value == null ? "" : String(p.value))) });
  }

  destroy(): void {
    this.api.destroy();
  }
}
