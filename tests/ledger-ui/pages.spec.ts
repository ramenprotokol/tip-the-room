// The real home page and manage page against a mocked API (page.route), served by Vite: no Worker, no PayPal.
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import type { LedgerRowDto, ManageView, PayoutBatchDto } from "../../src/worker/api-types";
import { MANAGE_FRAMES, MAYA_ID, MAYA_KEY, demoApi } from "../gpu/fixtures";

const SHOTS = "qa/judge-pass-grid";
mkdirSync(SHOTS, { recursive: true });
const CODE = "judge-pass_Z9x2Kq7LmP4w";
const BUYER = { email: "judges-only-buyer@example.com", password: "judges-only-pass" };
const fulfil = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockHome(page: Page) {
  const seen: { path: string; code: string | undefined }[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const code = req.headers()["x-judge-code"];
    seen.push({ path, code });
    if (path === "/api/judge/check") return code === CODE ? fulfil(route, 200, { ok: true, buyer: BUYER, demoCopiesPerDay: 12 }) : fulfil(route, 403, { error: { code: "forbidden", message: "That judge code doesn't match. Check it against the testing instructions on Devpost." } });
    if (path === "/api/demo") return fulfil(route, 429, { error: { code: "rate_limited", message: "Today's free demo copies are all taken: the sandbox runs on free plans, so each day has a fixed number. New ones open in about 5 hours (midnight UTC at the latest). Judges: enter your judge code in the For judges box on the home page for copies kept back for you.", retryAfterSec: 18000 } });
    return fulfil(route, 404, { error: { code: "not_found", message: "There's nothing here." } });
  });
  return seen;
}

test("home page at the daily cap: a clear message at the top, the page still works, and the judges box explains", async ({ page }) => {
  await mockHome(page);
  await page.goto("/");
  const notice = page.locator("[data-cap-notice]");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("free demo copies are all taken");
  await expect(notice).toContainText("Nothing is broken");
  await expect(page.locator("#judge")).toBeVisible();
  await expect(page.locator("[data-judge-msg]")).toContainText("judge code");
  await expect(page.getByRole("link", { name: "Start your own show" }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/11-home-cap-reached.png`, fullPage: false });
});

test("home page at the cap: the cards say there is no copy, the judge buttons stay off, and a judge pass brings a copy back with no reload", async ({ page }) => {
  const demo = demoApi();
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const code = req.headers()["x-judge-code"];
    if (path === "/api/judge/check") return code === CODE ? fulfil(route, 200, { ok: true, buyer: BUYER, demoCopiesPerDay: 12 }) : fulfil(route, 403, { error: { code: "forbidden", message: "nope" } });
    if (path === "/api/demo" && code !== CODE) return fulfil(route, 429, { error: { code: "rate_limited", message: "Today's free demo copies are all taken: the sandbox runs on free plans, so each day has a fixed number.", retryAfterSec: 18000 } });
    const raw = req.postData();
    const reply = demo({ method: req.method(), path, body: raw ? JSON.parse(raw) : null, key: req.headers()["x-manage-key"] ?? null });
    return reply ? fulfil(route, reply.status ?? 200, reply.body) : fulfil(route, 404, { error: { code: "not_found", message: "There's nothing here." } });
  });
  await page.goto("/");
  await expect(page.locator("[data-cap-notice]")).toBeVisible();
  for (const card of ["#show-a", "#show-b"]) {
    await expect(page.locator(`${card} [data-fans-sub]`)).toContainText("No demo copy right now");
    await expect(page.locator(`${card} [data-fans-sub]`)).not.toContainText("Seating");
    for (const act of ["add", "ff", "reset"]) await expect(page.locator(`${card} [data-act=${act}]`)).toBeDisabled();
  }
  await expect(page.locator("#pace")).toBeDisabled();
  await expect(page.locator("#pace-hint")).toBeVisible();
  await expect(page.locator("#pace-hint")).toContainText("Needs a demo copy");
  await page.screenshot({ path: `${SHOTS}/13-home-no-copy.png`, fullPage: false });

  const box = page.locator("[data-judge-pass]");
  await box.getByLabel("Judge code").fill(CODE);
  await box.getByRole("button", { name: "Use judge pass" }).click();
  await expect(page.locator("[data-cap-notice]")).toBeHidden();
  await expect(page.locator("#show-a [data-fans-sub]")).not.toContainText("No demo copy right now");
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
  await expect(page.locator("#show-a [data-act=ff]")).toBeEnabled();
  await expect(page.locator("#show-a [data-act=reset]")).toBeEnabled();
});

test("judge pass: a wrong code is refused with a message; the right code shows the judges-only login and is kept out of the URL", async ({ page }) => {
  const seen = await mockHome(page);
  await page.goto("/");
  const box = page.locator("[data-judge-pass]");
  await expect(box.getByLabel("Judge code")).toBeVisible();
  await expect(page.locator("[data-judge-creds]")).toContainText("public-buyer@example.com");

  await box.getByLabel("Judge code").fill("wrong-code-1234");
  await box.getByRole("button", { name: "Use judge pass" }).click();
  await expect(box).toContainText("That judge code doesn't match");
  await expect(page.locator("[data-judge-creds]")).toContainText("public-buyer@example.com");
  expect(await page.evaluate(() => localStorage.getItem("ttr:judge"))).toBeNull();

  await box.getByLabel("Judge code").fill("short");
  await box.getByRole("button", { name: "Use judge pass" }).click();
  await expect(box).toContainText("doesn’t look like a judge code");

  await box.getByLabel("Judge code").fill(CODE);
  await box.getByRole("button", { name: "Use judge pass" }).click();
  await expect(box).toContainText("Judge pass active");
  const creds = page.locator("[data-judge-creds]");
  await expect(creds).toContainText("judges-only sandbox buyer");
  await expect(creds).toContainText(BUYER.email);
  await expect(creds).toContainText(BUYER.password);
  await expect(creds).not.toContainText("public-buyer@example.com");
  await page.locator("#judge").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/12-judge-pass-active.png` });

  // The code travels in a header, never in the address bar, and is kept in this browser.
  expect(page.url()).not.toContain(CODE);
  expect(page.url()).not.toContain("judge=");
  expect(await page.evaluate(() => localStorage.getItem("ttr:judge"))).toBe(CODE);
  expect(seen.filter((s) => s.path === "/api/judge/check").map((s) => s.code)).toContain(CODE);

  // A reload keeps the pass (the stored code is checked again) and later demo calls carry the header.
  await page.reload();
  await expect(page.locator("[data-judge-pass]")).toContainText("Judge pass active");
  const demoCalls = seen.filter((s) => s.path === "/api/demo");
  expect(demoCalls.at(-1)?.code).toBe(CODE);

  // Remove the pass: back to the public login and no stored code.
  await page.getByRole("button", { name: "Remove judge pass" }).click();
  await expect(page.locator("[data-judge-creds]")).toContainText("public-buyer@example.com");
  expect(await page.evaluate(() => localStorage.getItem("ttr:judge"))).toBeNull();
});

test("an old ?judge= link no longer gives a judge pass", async ({ page }) => {
  const seen = await mockHome(page);
  await page.goto(`/?judge=${CODE}`);
  await expect(page.locator("[data-cap-notice]")).toBeVisible();
  expect(seen.filter((s) => s.path === "/api/demo").every((s) => s.code === undefined)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("ttr:judge"))).toBeNull();
});

const rows = (): LedgerRowDto[] => {
  const out: LedgerRowDto[] = [];
  let seq = 0;
  for (let i = 1; i <= 21; i++) out.push({ seq: ++seq, at: Date.UTC(2026, 10, 3 + (i % 6), 10 + (i % 9)), kind: "hold", what: "Fan held a spot", who: `Fan ${String(i).padStart(2, "0")} · AB`, amountCents: 1500, ref: `SAMPLE-AUTH-${i}`, status: "Charged" });
  for (let i = 1; i <= 21; i++) out.push({ seq: ++seq, at: Date.UTC(2026, 10, 9, 9, i), kind: "charge", what: "Charged", who: `Fan ${String(i).padStart(2, "0")} · AB`, amountCents: 1588, ref: `CAP-${i}`, status: "Charged" });
  const lines: [string, number, string][] = [["Lucky’s Café", 10000, "5M4D8LP3F33X6"], ["Maya", 23348, "9Q2A7KT4B81WZ"]];
  for (const [who, amountCents] of lines) out.push({ seq: seq + 1, at: Date.UTC(2026, 10, 12, 18), kind: "payout", what: `Paid ${who}`, who, amountCents, ref: "V8PDK75HD9EW4", status: "Paid" });
  return out.reverse();
};
const batches = (): PayoutBatchDto[] => [{ batchId: "V8PDK75HD9EW4", senderBatchId: `payout-${MAYA_ID}`, status: "SUCCESS", retry: false, items: [
  { role: "room", label: "Lucky’s Café", amountCents: 10000, payoutItemId: "5M4D8LP3F33X6", transactionId: "TX1", status: "Paid" },
  { role: "artist", label: "Maya", amountCents: 23348, payoutItemId: "9Q2A7KT4B81WZ", transactionId: "TX2", status: "Paid" },
] }];

test("manage page: the ledger shows totals, chips, search and Ask; the payout grid shows the batch; Ask goes through the Worker and is checked", async ({ page }) => {
  const view: ManageView = { ...MANAGE_FRAMES.paid, ledger: rows(), payouts: batches() };
  const asked: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === `/api/shows/${MAYA_ID}/manage`) return fulfil(route, 200, view);
    if (path === `/api/shows/${MAYA_ID}`) return fulfil(route, 200, view.show);
    if (path === `/api/shows/${MAYA_ID}/ask-ledger`) {
      asked.push({ key: req.headers()["x-manage-key"], body: req.postDataJSON() });
      // A hostile answer: the page must not apply it.
      if ((req.postDataJSON() as { question: string }).question.includes("evil")) return fulfil(route, 200, { spec: { statuses: ["Paid"], sort: { col: "nope", dir: "asc" }, action: "refund" }, source: "model" });
      return fulfil(route, 200, { spec: { statuses: ["Paid", "Sent"], contains: null, sort: { col: "amountCents", dir: "desc" } }, source: "model" });
    }
    return fulfil(route, 404, { error: { code: "not_found", message: "nothing" } });
  });
  await page.goto(`/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  await expect(page.locator("#ledger .ag-grid-scrolling-container .ag-row").first()).toBeVisible();
  await expect(page.locator("#ledger .ledger-total")).toHaveCount(5);
  await expect(page.locator("#ledger .ledger-total").nth(1)).toContainText("21 charges");
  await expect(page.locator("#ledger .ledger-total").nth(4)).toContainText("$333.48");
  await expect(page.locator("[data-batch-head]")).toHaveText("Payout batch: V8PDK75HD9EW4");
  await expect(page.locator("#payout-grid .ag-grid-scrolling-container .ag-row")).toHaveCount(2);

  await page.getByLabel("Ask the ledger", { exact: true }).fill("biggest payouts");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ledger-say")).toContainText("Asked the model");
  expect(asked).toHaveLength(1);
  expect((asked[0] as { key: string }).key).toBe(MAYA_KEY);
  await expect(page.locator('#ledger .ag-grid-scrolling-container .ag-row[row-index="0"] .ag-cell[col-id="amountCents"]')).toHaveText("$233.48");
  await page.locator("#ledger").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/13-manage-page-ask-ledger.png`, fullPage: true });

  // A refused spec from the Worker's answer is never applied: the page falls back to its own keywords.
  await page.getByLabel("Ask the ledger", { exact: true }).fill("evil refunds");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ledger-say")).toContainText("Matched your words");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

  await page.getByRole("button", { name: "Download the payouts as CSV" }).isVisible();
});

test("manage page with no ledger API ask: the keyword matcher still answers when the Worker call fails", async ({ page }) => {
  const view: ManageView = { ...MANAGE_FRAMES.paid, ledger: rows(), payouts: batches() };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/shows/${MAYA_ID}/manage`) return fulfil(route, 200, view);
    if (path === `/api/shows/${MAYA_ID}`) return fulfil(route, 200, view.show);
    return fulfil(route, 429, { error: { code: "rate_limited", message: "Too many tries. Please wait a moment and try again." } });
  });
  await page.goto(`/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  await expect(page.locator("#ledger .ag-grid-scrolling-container .ag-row").first()).toBeVisible();
  await page.getByLabel("Ask the ledger", { exact: true }).fill("which holds were cancelled?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(page.locator(".ledger-say")).toContainText("Matched your words · showing status: Cancelled");
});
