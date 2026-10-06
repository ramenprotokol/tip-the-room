import { expect, test, type Page } from "@playwright/test";
import { installFakeApi } from "./fake-api";
import { PROD_BASE, settle } from "./parity";
import { PAGES, type AppPage } from "./pages";

// The parity harness only sees the dev server. This runs the built site (vite build + preview) so
// production-only problems (chunk evaluation order, minification) are caught.

interface ProdWindow { __marquee?: { ready?: boolean; views?: unknown[]; ctls?: { phase: string }[] }; gsap?: { config(): { force3D?: unknown } } }

// Opens a built page, waits for window.__marquee.ready and checks the sign count and the GSAP config.
// ui.ts sets force3D:false at module load; seeing it proves window.gsap existed when ui.ts evaluated.
async function openProdPage(page: Page, p: AppPage): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await installFakeApi(page, p.api());
  await page.goto(`${PROD_BASE}${p.prodPath}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean((window as ProdWindow).__marquee?.ready), undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as ProdWindow).__marquee?.views?.length)).toBe(p.signs);
  expect(await page.evaluate(() => (window as ProdWindow).gsap?.config().force3D)).toBe(false);
  return errors;
}

test("production build: / loads, GSAP config ran, demo keys run clean", async ({ page }) => {
  const errors = await openProdPage(page, PAGES.demo);
  const phases = () => page.evaluate(() => (window as unknown as ProdWindow).__marquee?.ctls?.map((c) => c.phase).join(","));
  await page.keyboard.press("t");
  await settle(page);
  await expect.poll(phases, { timeout: 30_000 }).toBe("tipped,open");
  await page.keyboard.press("p");
  await settle(page);
  await page.keyboard.press("m");
  await settle(page);
  await expect.poll(phases, { timeout: 30_000 }).toBe("paid,released");
  expect(errors).toEqual([]);
});

test("production build: /start loads, GSAP config ran, fill runs clean", async ({ page }) => {
  // The reference start page creates one sign (the live preview).
  const errors = await openProdPage(page, PAGES.start);
  await page.click("#fill");
  await settle(page);
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-target-sentence]")).toContainText("You need 21 fans at $15");
  expect(errors).toEqual([]);
});

test("production build: the fan page loads, GSAP config ran, approval runs clean", async ({ page }) => {
  // The reference fan page creates one sign.
  const errors = await openProdPage(page, PAGES.pledge);
  // Reference hook shapes: setInitials(string) and approve() with no arguments.
  await page.evaluate(() => {
    const m = (window as unknown as { __marquee: { setInitials(s: string): void; approve(): void } }).__marquee;
    m.setInitials("MR");
    m.approve();
  });
  await settle(page);
  await page.waitForTimeout(2000);
  await expect(page.locator("#confirm")).toBeVisible();
  await expect(page.locator("[data-confirm-bulb]")).toContainText("MR");
  expect(errors).toEqual([]);
});

test("production build: the show page loads, GSAP config ran, approve and add fans run clean", async ({ page }) => {
  // The reference artist page creates one sign.
  const errors = await openProdPage(page, PAGES.manage);
  // Reference hook shapes: approve() with no arguments and addFans(n).
  await page.evaluate(() => (window as unknown as { __marquee: { approve(): void } }).__marquee.approve());
  await settle(page);
  await page.evaluate(() => (window as unknown as { __marquee: { addFans(n: number): void } }).__marquee.addFans(5));
  await settle(page);
  await page.waitForTimeout(2500);
  await expect(page.locator("#ask")).toBeHidden();
  await expect(page.locator("[data-fans]")).toContainText("17");
  expect(errors).toEqual([]);
});
