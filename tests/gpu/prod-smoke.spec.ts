import { expect, test } from "@playwright/test";

// The parity harness only sees the dev server. This runs the built site (vite build + preview) so
// production-only problems (chunk evaluation order, minification) are caught.
const PROD_BASE = "http://127.0.0.1:5200/";

interface ProdWindow { __marquee?: { ready?: boolean; views?: unknown[] }; gsap?: { config(): { force3D?: unknown } } }

test("production build: / loads, GSAP config ran, demo keys run clean", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await page.goto(PROD_BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean((window as ProdWindow).__marquee?.ready), undefined, { timeout: 20_000 });

  expect(await page.evaluate(() => (window as ProdWindow).__marquee?.views?.length)).toBe(2);
  // ui.ts sets force3D:false at module load; seeing it proves window.gsap existed when ui.ts evaluated.
  expect(await page.evaluate(() => (window as ProdWindow).gsap?.config().force3D)).toBe(false);

  await page.keyboard.press("t");
  await page.waitForTimeout(8000);
  await page.keyboard.press("p");
  await page.keyboard.press("m");
  await page.waitForTimeout(6000);

  expect(errors).toEqual([]);
});

test("production build: /start.html loads, GSAP config ran, fill runs clean", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await page.goto(`${PROD_BASE}start.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean((window as ProdWindow).__marquee?.ready), undefined, { timeout: 20_000 });

  // The reference start page creates one sign (the live preview).
  expect(await page.evaluate(() => (window as ProdWindow).__marquee?.views?.length)).toBe(1);
  expect(await page.evaluate(() => (window as ProdWindow).gsap?.config().force3D)).toBe(false);

  await page.click("#fill");
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-target-sentence]")).toContainText("You need 21 fans at $15");

  expect(errors).toEqual([]);
});
