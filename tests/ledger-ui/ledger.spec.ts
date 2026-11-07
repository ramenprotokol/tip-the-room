import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import type { LedgerRowDto } from "../../src/worker/api-types";

const SHOTS = "qa/judge-pass-grid";
mkdirSync(SHOTS, { recursive: true });

async function open(page: Page, stage: "held" | "tipped" | "paid" | "missed" = "paid") {
  await page.goto("/tests/ledger-ui/harness.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await page.evaluate((s) => window.__ledgerx.load(s), stage);
  await expect(page.locator("#ledger .ag-grid-scrolling-container .ag-row").first()).toBeVisible();
}
const totals = (page: Page) => page.locator("#ledger .ledger-total");
const totalText = async (page: Page) => (await totals(page).allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
const displayed = (page: Page) => page.evaluate(() => window.__ledgerx.grid.api.getDisplayedRowCount());
const chip = (page: Page, name: string) => page.locator(".ledger-chips .chip", { hasText: new RegExp(`^${name}$`) });

test("pinned totals block: held, charged, cancelled, refunded and paid out, with counts and dollars", async ({ page }) => {
  await open(page, "paid");
  await expect(totals(page)).toHaveCount(5);
  const t = await totalText(page);
  expect(t[0]).toContain("Held now");
  expect(t[0]).toContain("0 holds");
  expect(t[0]).toContain("$0.00");
  expect(t[1]).toContain("8 charges");
  expect(t[1]).toContain("$127.04"); // 8 x $15.88, whole cents
  expect(t[2]).toContain("0 holds");
  expect(t[3]).toContain("0 refunds");
  expect(t[4]).toContain("Paid out");
  expect(t[4]).toContain("3 payees");
  expect(t[4]).toContain("$507.04"); // 80 + 100 + 327.04
  await page.screenshot({ path: `${SHOTS}/01-ledger-totals-paid.png`, fullPage: true });
});

test("totals follow the show: held while open, cancelled when it misses", async ({ page }) => {
  await open(page, "held");
  let t = await totalText(page);
  expect(t[0]).toContain("8 holds");
  expect(t[0]).toContain("$120.00");
  await page.screenshot({ path: `${SHOTS}/02-ledger-held.png`, fullPage: true });
  await page.evaluate(() => window.__ledgerx.load("missed"));
  t = await totalText(page);
  expect(t[0]).toContain("0 holds");
  expect(t[2]).toContain("8 holds");
  expect(t[2]).toContain("$120.00");
  await page.screenshot({ path: `${SHOTS}/03-ledger-cancelled.png`, fullPage: true });
});

test("a hold becoming charged updates that row in place and flashes it: the grid is not rebuilt", async ({ page }) => {
  await open(page, "held");
  // Mark every rendered row element. A full re-render would drop the marks; a delta update keeps them.
  await page.evaluate(() => document.querySelectorAll("#ledger .ag-grid-scrolling-container .ag-row").forEach((r) => r.setAttribute("data-probe", "kept")));
  const marked = await page.locator('#ledger [data-probe="kept"]').count();
  expect(marked).toBeGreaterThan(3);
  // Fan 08 (the newest row) is charged: its hold row flips to Charged and a charge row arrives.
  await page.evaluate(() => {
    const rows = window.__ledgerx.scenario("held").rows.map((r) => (r.who === "Fan 08 · EH" ? { ...r, status: "Charged" as const } : r));
    const charge: LedgerRowDto = { seq: 99, at: Date.UTC(2026, 10, 5), kind: "charge", what: "Charged", who: "Fan 08 · EH", amountCents: 1588, ref: "2CK411900K112345", status: "Charged" };
    window.__ledgerx.rows([charge, ...rows]);
  });
  await expect(page.locator('#ledger [data-probe="kept"]').first()).toBeAttached();
  expect(await page.locator('#ledger [data-probe="kept"]').count()).toBeGreaterThanOrEqual(marked - 1);
  // The changed status cell is flashing right now (AG Grid's enableCellChangeFlash class).
  await expect(page.locator("#ledger .ag-cell-data-changed, #ledger .ag-cell-data-changed-animation").first()).toBeAttached();
  await page.screenshot({ path: `${SHOTS}/04-flash-mid-animation.png`, fullPage: true });
  // Totals moved at the same time.
  const t = await totalText(page);
  expect(t[0]).toContain("7 holds");
  expect(t[1]).toContain("1 charge");
  expect(t[1]).toContain("$15.88");
  // The flash fades and the highlight class is gone again.
  await expect(page.locator("#ledger .ag-cell-data-changed")).toHaveCount(0, { timeout: 6000 });
});

test("only changed rows are touched: an update that changes nothing re-renders nothing", async ({ page }) => {
  await open(page, "tipped");
  const before = await page.evaluate(() => {
    const api = window.__ledgerx.grid.api;
    let n = 0;
    api.addEventListener("rowDataUpdated", () => (n += 1));
    window.__ledgerx.load("tipped");
    window.__ledgerx.load("tipped");
    return n;
  });
  expect(before).toBe(0);
});

test("status chips drive the grid's filter model, and follow a filter set elsewhere", async ({ page }) => {
  await open(page, "tipped");
  const all = await displayed(page);
  expect(all).toBe(16);
  await chip(page, "Charged").click();
  expect(await displayed(page)).toBe(16);
  await chip(page, "On hold").click();
  expect(await displayed(page)).toBe(0);
  await expect(chip(page, "On hold")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => window.__ledgerx.load("missed"));
  await chip(page, "Cancelled").click();
  expect(await displayed(page)).toBe(16);
  expect(await page.evaluate(() => window.__ledgerx.grid.api.getFilterModel())).toEqual({ status: { filterType: "text", type: "equals", filter: "Cancelled" } });
  await page.screenshot({ path: `${SHOTS}/05-chip-cancelled.png`, fullPage: true });
  await chip(page, "All").click();
  expect(await page.evaluate(() => window.__ledgerx.grid.api.getFilterModel())).toEqual({});
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "true");
  // A filter set from the grid API (the column menu does the same) moves the chip.
  await page.evaluate(() => window.__ledgerx.grid.api.setFilterModel({ status: { filterType: "text", type: "equals", filter: "Cancelled" } }));
  await expect(chip(page, "Cancelled")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(page, "All")).toHaveAttribute("aria-pressed", "false");
  // The totals block never changes with a filter.
  expect(await totals(page).count()).toBe(5);
});

test("the paid out chip shows Paid and Sent payouts", async ({ page }) => {
  await open(page, "paid");
  await chip(page, "Paid out").click();
  expect(await displayed(page)).toBe(3);
});

test("the search box is the grid's quick filter: names, refs and dollar amounts", async ({ page }) => {
  await open(page, "paid");
  const search = page.getByLabel("Search the ledger");
  await search.fill("MB");
  expect(await displayed(page)).toBe(2); // fan 03 (MB): its hold row and its charge row
  await search.fill("V8PDK75HD9EW4");
  expect(await displayed(page)).toBe(3);
  await search.fill("327.04");
  expect(await displayed(page)).toBe(1);
  await search.fill("zzz-no-such-thing");
  expect(await displayed(page)).toBe(0);
  await search.fill("Juniper");
  await page.screenshot({ path: `${SHOTS}/06-search-juniper.png`, fullPage: true });
  await search.fill("");
  expect(await displayed(page)).toBe(20);
});

test("Ask the ledger: a checked model spec is applied; a refused one is not, the keywords answer", async ({ page }) => {
  await open(page, "missed");
  const input = page.getByLabel("Ask the ledger", { exact: true });
  const say = page.locator(".ledger-say");
  await page.evaluate(() => {
    window.__ledgerx.askImpl = async () => ({ spec: { statuses: ["Cancelled"], contains: null, sort: { col: "amountCents", dir: "desc" } }, source: "model" });
  });
  await input.fill("which holds were cancelled, biggest first?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(say).toContainText("Asked the model");
  await expect(say).toContainText("status: Cancelled");
  expect(await page.evaluate(() => window.__ledgerx.grid.api.getFilterModel())).toEqual({ status: { filterType: "text", type: "equals", filter: "Cancelled" } });
  expect(await displayed(page)).toBe(16);
  await page.screenshot({ path: `${SHOTS}/07-ask-ledger-model.png`, fullPage: true });

  // A malicious spec from the network: nothing in it reaches the grid; the page's own keyword matcher answers instead.
  await page.evaluate(() => {
    (window as unknown as { __touched: string[] }).__touched = [];
    const api = window.__ledgerx.grid.api;
    const real = api.setFilterModel.bind(api);
    api.setFilterModel = (m) => {
      (window as unknown as { __touched: string[] }).__touched.push(JSON.stringify(m));
      real(m);
    };
    window.__ledgerx.askImpl = async () => ({ spec: { statuses: ["Cancelled"], contains: { col: "who", text: "<img src=x onerror=alert(1)>" }, sort: { col: "secret", dir: "asc" }, action: "refund" }, source: "model" });
  });
  await input.fill("refunds please");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(say).toContainText("Matched your words");
  const touched = await page.evaluate(() => (window as unknown as { __touched: string[] }).__touched);
  expect(touched).toEqual([JSON.stringify({ status: { filterType: "text", type: "equals", filter: "Refunded" } })]);
  expect(touched.join()).not.toMatch(/img|secret|refund"/);
});

test("Ask the ledger: when the call fails, the keyword matcher takes over; nothing matches: a friendly line", async ({ page }) => {
  await open(page, "paid");
  const input = page.getByLabel("Ask the ledger", { exact: true });
  const say = page.locator(".ledger-say");
  await input.fill("biggest payouts");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(say).toContainText("Matched your words");
  expect(await displayed(page)).toBe(3);
  const first = await page.locator('#ledger .ag-grid-scrolling-container .ag-row[row-index="0"] .ag-cell[col-id="amountCents"]').innerText();
  expect(first).toBe("$327.04");
  await page.screenshot({ path: `${SHOTS}/08-ask-ledger-keywords-biggest-payouts.png`, fullPage: true });
  await input.fill("what is the weather");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(say).toContainText("couldn’t turn that into a filter");
  await page.getByRole("button", { name: "Clear" }).click();
  expect(await displayed(page)).toBe(20);
});

test("payout grid: payee, role, amount, PayPal payout item id and status, with the batch id above it", async ({ page }) => {
  await open(page, "paid");
  await expect(page.locator("[data-batch-head]")).toHaveText("Payout batch: V8PDK75HD9EW4");
  const headers = (await page.locator("#payout-grid .ag-header-cell-text").allTextContents()).map((h) => h.trim().toLowerCase());
  expect(headers).toEqual(["payee", "role", "amount", "paypal payout item id", "status"]);
  const rows = page.locator("#payout-grid .ag-grid-scrolling-container .ag-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Spindle Records");
  await expect(rows.first()).toContainText("5M4D8LP3F33X6");
  await expect(page.locator("#payout-grid .pill").first()).toHaveText("Paid");
  await page.locator("#payout-block").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/09-payout-grid.png`, fullPage: true });
});

test("payout grid waits for PayPal: Sent with no item id yet, then Paid with one, updated in place", async ({ page }) => {
  await open(page, "paid");
  await page.evaluate(() => {
    const b = window.__ledgerx.scenario("paid").batches;
    window.__ledgerx.batches([{ ...b[0], batchId: null, items: b[0].items.map((i) => ({ ...i, payoutItemId: null, status: "Sent" as const })) }]);
  });
  await expect(page.locator("[data-batch-head]")).toHaveText("Payout batch: waiting for PayPal");
  await expect(page.locator("#payout-grid")).toContainText("Waiting for PayPal");
  await page.evaluate(() => window.__ledgerx.batches(window.__ledgerx.scenario("paid").batches));
  await expect(page.locator("#payout-grid")).toContainText("9Q2A7KT4B81WZ");
});

test("ledger CSV: rows only (no totals block), formulas neutralised; payout CSV has its own columns", async ({ page }) => {
  await open(page, "paid");
  await page.evaluate(() => {
    const rows = window.__ledgerx.scenario("paid").rows;
    window.__ledgerx.rows([{ seq: 500, at: Date.UTC(2026, 10, 6), kind: "info", what: '=HYPERLINK("http://evil.example")', who: "+cmd|' /C calc'!A0", amountCents: 100, ref: "@SUM(1)", status: "Info" }, ...rows]);
  });
  const dl = page.waitForEvent("download");
  await page.locator("#csv").click();
  const file = await (await dl).path();
  const csv = readFileSync(file, "utf8");
  expect(csv).toContain("'=HYPERLINK");
  expect(csv).toContain("'+cmd");
  expect(csv).toContain("'@SUM(1)");
  expect(csv).not.toMatch(/Held now|Paid out|Cancelled · nobody/);
  expect(csv.trim().split("\n")).toHaveLength(1 + 21);
  const dl2 = page.waitForEvent("download");
  await page.locator("#payout-csv").click();
  const csv2 = readFileSync(await (await dl2).path(), "utf8");
  expect(csv2.replace(/^\uFEFF/, "").split("\n")[0].trim()).toBe('"Payee","Role","Amount","PayPal payout item id","Status"');
  expect(csv2).toContain("$327.04");
  expect(csv2).toContain("5M4D8LP3F33X6");
});

test("backend text is shown as text in the new cells too", async ({ page }) => {
  await open(page, "paid");
  await page.evaluate(() => {
    const rows = window.__ledgerx.scenario("paid").rows;
    window.__ledgerx.rows([{ seq: 600, at: Date.UTC(2026, 10, 7), kind: "info", what: '<img src=x onerror="window.__xss=1">', who: "<b>Maya</b>", amountCents: null, ref: null, status: "Info" }, ...rows]);
    const b = window.__ledgerx.scenario("paid").batches;
    window.__ledgerx.batches([{ ...b[0], items: b[0].items.map((i, n) => (n === 0 ? { ...i, label: '<img src=x onerror="window.__xss=2">' } : i)) }]);
  });
  expect(await page.locator("#ledger img, #payout-grid img, #ledger .ag-cell b").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("phone width: chips wrap, search fits, the totals block still reads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "paid");
  const box = await page.locator(".ledger-bar").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollW).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/10-phone.png`, fullPage: false });
});
