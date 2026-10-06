import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MAYA, MAYA_ID, PLEDGE_ORDER, pledgeApi, showOf } from "./fixtures";
import { APP_BASE } from "./parity";

const SDK = "https://www.sandbox.paypal.com/web-sdk/v6/core";
const XSS = `<img src=x onerror="window.__xss=1">`;
// Stands in for PayPal's v6 SDK: same entry points, the popup answers with window.__ppMode (approve | cancel | error).
const STUB = `
customElements.define("paypal-button", class extends HTMLElement { connectedCallback() { this.textContent = "PayPal"; this.style.cssText = "display:block;min-height:44px;background:#ffc439;cursor:pointer"; } });
window.paypal = { createInstance: async (o) => { window.__ppClientId = o.clientId; return {
  findEligibleMethods: async () => ({ isEligible: (m) => m === "paypal" }),
  createPayPalOneTimePaymentSession: (cb) => ({ start: async (opts, order) => {
    let orderId; try { ({ orderId } = await order); } catch (e) { cb.onError(e); return; }
    const mode = window.__ppMode || "approve";
    if (mode === "open") return new Promise(() => {});
    if (mode === "approve") await cb.onApprove({ orderId });
    else if (mode === "cancel") cb.onCancel({ orderId });
    else cb.onError(new Error("closed"));
  } }) }; } };`;

async function open(page: Page, api: FakeApi, query = "?e2e&paypal=test-client") {
  await page.route(SDK, (r) => r.fulfill({ contentType: "application/javascript", body: STUB }));
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}s/${MAYA_ID}${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const authorizePaths = (seen: { path: string }[]) => seen.map((r) => r.path).filter((p) => p.endsWith("/authorize"));

test("the PayPal button replaces the placeholder, and an approved popup puts the fan on hold", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await expect(page.locator("#pp-slot")).toHaveClass(/is-rendered/);
  await expect(page.locator("#pp-slot")).not.toContainText("renders here");
  expect(await page.evaluate(() => (window as unknown as { __ppClientId: string }).__ppClientId)).toBe("test-client");
  await page.fill("#initials", "m.r");
  await page.locator("paypal-button").click();
  await expect(page.locator("#confirm")).toBeVisible();
  await expect(page.locator("[data-confirm-bulb]")).toHaveText("Your bulb is the one marked MR.");
  expect(seen.find((r) => r.path.endsWith("/orders"))?.body).toEqual({ initials: "MR" });
  expect(authorizePaths(seen)).toEqual([`/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}/authorize`]);
});

test("a cancelled popup places no hold and says so", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await page.evaluate(() => { (window as unknown as { __ppMode: string }).__ppMode = "cancel"; });
  await page.locator("paypal-button").click();
  await expect(page.locator("[data-pledge-msg]")).toHaveText("No hold was placed. You can try again whenever you like.");
  await expect(page.locator("#pledge-card")).toBeVisible();
  expect(authorizePaths(seen)).toEqual([]);
});

test("after a 502 the fan sees plain words, and the next try creates a NEW order", async ({ page }) => {
  const seen = await open(page, pledgeApi({ authorize: (n) => (n === 1 ? apiError(502, "paypal_error", "PayPal didn't answer as expected. Nothing was charged.") : undefined) }));
  await page.locator("paypal-button").click();
  await expect(page.locator("[data-pledge-msg]")).toHaveText("PayPal didn't answer as expected. Nothing was charged. Please try again.");
  await page.locator("paypal-button").click();
  await expect(page.locator("#confirm")).toBeVisible();
  expect(authorizePaths(seen)).toEqual([`/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}/authorize`, `/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}2/authorize`]);
});

test("show data is shown as text, never as markup", async ({ page }) => {
  await open(page, pledgeApi({ show: { ...showOf(MAYA, { fans: 12 }), showName: XSS, roomName: XSS } }));
  await expect(page.locator("#show-title")).toHaveText(XSS);
  await expect(page.locator(".row-top .eyebrow")).toContainText(XSS);
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("an unknown show says so in plain words", async ({ page }) => {
  await open(page, () => undefined);
  await expect(page.locator("#notice")).toBeVisible();
  await expect(page.locator("#notice")).toHaveText("There’s no show at this link. Check the link with whoever sent it.");
  await expect(page.locator("#pledge-card")).toBeHidden();
});

test("a show that is over takes no pledges", async ({ page }) => {
  await open(page, pledgeApi({ show: showOf(MAYA, { fans: 12, state: "missed" }) }));
  await expect(page.locator("#notice")).toHaveText("Pledging has closed for this show.");
  await expect(page.locator("#pledge-card")).toBeHidden();
  await expect(page.locator("[data-word]")).toHaveText("Called off");
});

test("when the artist changes the target and deadline, every fact and the bulb count follow the next poll", async ({ page }) => {
  const inner = pledgeApi();
  let changed = false;
  const api: FakeApi = (req) => (req.method === "GET" && req.path === `/api/shows/${MAYA_ID}`
    ? { body: changed ? showOf(MAYA, { fans: 12, threshold: 25, deadline: Date.UTC(2026, 10, 14, 18), version: 2 }) : showOf(MAYA, { fans: 12 }) }
    : inner(req));
  await open(page, api);
  await expect(page.locator("[data-of]")).toHaveText("of 21 fans");
  expect(await page.locator("[data-ph] circle").count()).toBe(21);
  const before = await page.locator(".stat.clock dt").textContent();
  changed = true;
  await page.evaluate(() => (window as unknown as { __marquee: { poll(): void } }).__marquee.poll());
  await expect(page.locator("[data-of]")).toHaveText("of 25 fans");
  await expect(page.locator(".stat.clock dt")).not.toHaveText(before ?? "");
  await expect(page.locator(".stat.clock dt")).toContainText("Nov 14");
  await expect(page.locator("[data-pledge-text]")).toContainText("if 25 fans join by");
  await expect(page.locator("[data-faq-when]")).toContainText("Only once 25 fans");
  await expect(page.locator("[data-fans-sub]")).toHaveText("13 more to make it happen");
  expect(await page.locator("[data-ph] circle").count()).toBe(25);
});

test("a second click while an order is being made does not start a second order", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await page.evaluate(() => {
    const btn = document.querySelector("paypal-button") as HTMLElement;
    btn.click();
    btn.click();
  });
  await expect(page.locator("#confirm")).toBeVisible();
  expect(seen.filter((r) => r.path.endsWith("/orders")).length).toBe(1);
});

test("a second click while the PayPal window is open never starts a second order, and shows no false error", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await page.evaluate(() => { (window as unknown as { __ppMode: string }).__ppMode = "open"; });
  const button = page.locator("paypal-button");
  await button.click();
  await expect.poll(() => seen.filter((r) => r.path.endsWith("/orders")).length).toBe(1);
  await button.click();
  await button.click();
  await page.waitForTimeout(300);
  expect(seen.filter((r) => r.path.endsWith("/orders")).length).toBe(1);
  await expect(page.locator("[data-pledge-msg]")).toHaveText("");
});
