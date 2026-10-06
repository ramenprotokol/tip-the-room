import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { LedgerRowDto } from "../../src/worker/api-types";
import { APP_BASE } from "./parity";

const T = (d: number, h: number, mi = 0) => Date.UTC(2026, 10, d, h, mi);
const XSS = `<img src=x onerror="window.__xss=1">`;
const ROWS: LedgerRowDto[] = [
  { seq: 1, at: T(3, 19, 12), what: "Fan held a spot", who: "Fan 01 · JR", amountCents: 1500, ref: "5UX02069M9686893E", status: "Charged" },
  { seq: 3, at: T(12, 18), what: "Paid Lucky’s Café", who: "Lucky’s Café", amountCents: 10000, ref: "7X4QKXC6L5BNA", status: "Pending" },
  { seq: 2, at: T(9, 9, 15), what: XSS, who: "<b>Maya</b>", amountCents: 31500, ref: null, status: "Info" },
  { seq: 4, at: T(4, 8, 5), what: "=HYPERLINK(\"http://evil.example\")", who: "Fan 02 · AK", amountCents: null, ref: "8AB12345CD678901E", status: "Cancelled" },
];

async function open(page: Page) {
  await page.goto(`${APP_BASE}tests/gpu/ledger/harness.html`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await page.evaluate((rows) => window.__ledger.rows(rows), ROWS);
  await expect(page.locator("#ledger .ag-row").first()).toBeVisible();
}
const firstCells = (page: Page, col: string) => page.locator(`#ledger .ag-row[row-index="0"] .ag-cell[col-id="${col}"]`);

test("themed like the reference: ink header, 48 px rows, Plex fonts, status pinned right as a pill", async ({ page }) => {
  await open(page);
  const header = page.locator("#ledger .ag-header-row .ag-grid-scrolling-cells");
  expect(await header.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(21, 17, 14)");
  const headerText = page.locator("#ledger .ag-header-cell-text").first();
  expect(await headerText.evaluate((e) => getComputedStyle(e).textTransform)).toBe("uppercase");
  expect(await headerText.evaluate((e) => getComputedStyle(e).fontFamily)).toContain("IBM Plex Mono");
  const row = page.locator("#ledger .ag-row").first();
  expect(Math.round((await row.boundingBox())!.height)).toBe(48);
  expect(await page.locator("#ledger .ag-cell").first().evaluate((e) => getComputedStyle(e).fontFamily)).toContain("IBM Plex");
  await expect(page.locator("#ledger .ag-header-cell-first-right-pinned")).toContainText("Status");
  await expect(page.locator("#ledger .ag-cell-first-right-pinned .pill").first()).toBeVisible();
  const headers = await page.locator("#ledger .ag-header-cell-text").allTextContents();
  expect(headers.map((h) => h.trim().toLowerCase())).toEqual(["when", "what happened", "who", "amount", "paypal ref", "status"]);
});

test("newest first, with times in the show's zone and cents in the amount", async ({ page }) => {
  await open(page);
  await expect(firstCells(page, "when")).toHaveText("Nov 12 · 6:00pm");
  await expect(firstCells(page, "amountCents")).toHaveText("$100.00");
  await expect(page.locator('#ledger .ag-row[row-index="0"] .ag-cell-first-right-pinned .pill')).toHaveText("Pending");
});

test("backend text is shown as text, never as markup", async ({ page }) => {
  await open(page);
  await expect(page.locator("#ledger")).toContainText(XSS);
  await expect(page.locator("#ledger")).toContainText("<b>Maya</b>");
  expect(await page.locator("#ledger img, #ledger .ag-cell b").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("sort, filter and CSV export work, and the CSV can't run spreadsheet formulas", async ({ page }) => {
  await open(page);
  await page.locator('#ledger .ag-header-cell[col-id="who"]').click();
  await expect(firstCells(page, "who")).toHaveText("<b>Maya</b>");
  await page.evaluate(() => window.__ledger.grid.api.setFilterModel({ who: { filterType: "text", type: "contains", filter: "Fan" } }));
  expect(await page.evaluate(() => window.__ledger.grid.api.getDisplayedRowCount())).toBe(2);
  await page.evaluate(() => window.__ledger.grid.api.setFilterModel(null));
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  expect(download.suggestedFilename()).toBe("tip-the-room-ledger.csv");
  const csv = readFileSync((await download.path())!, "utf8").replace(/^\uFEFF/, ""); // AG Grid adds a byte-order mark so Excel reads UTF-8
  expect(csv.split(/\r?\n/)[0]).toBe('"When","What happened","Who","Amount","PayPal ref","Status"');
  expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
  expect(csv).toContain('"Nov 12 · 6:00pm","Paid Lucky’s Café","Lucky’s Café","$100.00","7X4QKXC6L5BNA","Pending"');
});
