import { expect, test, type Page } from "@playwright/test";
import { APP_BASE, DESKTOP, openFrozen, settle, type Frozen } from "./parity";
import { installFakeApi } from "./fake-api";
import { PAGES } from "./pages";

// Reduced motion and no-WebGL: every flow on every page must still complete, with no page errors.
// Without WebGL the flat SVG sign (svg.ph[data-ph], drawn by Placeholder in ui.ts) is the only sign,
// and SignHost.create() returns null, so window.__marquee.views stays empty.

interface FallbackWindow {
  __marquee?: { ready?: boolean; views?: unknown[]; host?: unknown; ctls?: { phase: string }[] };
}

const pages = [PAGES.demo, PAGES.start, PAGES.pledge, PAGES.manage].map((p) => ({ path: p.appPath, name: p.name, signs: p.signs, api: p.api }));

type Hooks = Record<string, (...args: unknown[]) => unknown>;
const call = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(([f, a]) => (window as unknown as { __marquee: Hooks }).__marquee[f as string]!(...(a as unknown[])), [fn, args] as const);

// How many of the flat sign's bulbs carry a given state class (s-empty, s-held, s-lit, s-off) on sign n.
const bulbs = (page: Page, sign: number, state: string) => page.locator("svg.ph[data-ph]").nth(sign).locator(`circle.${state}`).count();
const signText = (page: Page, sign: number) => page.locator("svg.ph[data-ph]").nth(sign).locator("text.name").textContent();

// Runs one real flow on the page and checks its end state on the flat sign (and the page text).
// `tick` advances time: the frozen reduced-motion pages need clock.runFor, the real-time pages just wait.
async function runFlow(page: Page, name: string, tick: (ms: number) => Promise<void>): Promise<void> {
  if (name === "demo") {
    // T tips the first show; M calls the second one off.
    await page.keyboard.press("t");
    await settle(page);
    await page.keyboard.press("m");
    await settle(page);
    await expect.poll(async () => { await tick(500); return page.evaluate(() => (window as unknown as FallbackWindow).__marquee?.ctls?.map((c) => c.phase).join(",")); }, { timeout: 30_000 }).toBe("tipped,released");
    expect(await bulbs(page, 0, "s-lit")).toBeGreaterThan(0);
    expect(await bulbs(page, 0, "s-empty")).toBe(0);
    expect(await signText(page, 1)).toBe("CALLED OFF · $0");
  } else if (name === "start") {
    await page.click("#fill");
    await settle(page);
    await tick(1500);
    await expect(page.locator("[data-target-sentence]")).toContainText("You need 21 fans at $15");
    expect(await bulbs(page, 0, "s-empty")).toBe(21);
  } else if (name === "pledge") {
    expect(await bulbs(page, 0, "s-held")).toBe(12);
    await call(page, "approve");
    await settle(page);
    await expect.poll(async () => { await tick(500); return page.locator("#confirm").isVisible(); }, { timeout: 15_000 }).toBe(true);
    expect(await bulbs(page, 0, "s-held")).toBe(13);
  } else {
    await call(page, "approve");
    await settle(page);
    await tick(1500);
    await call(page, "addFans", 5);
    await settle(page);
    await tick(2500);
    await expect(page.locator("[data-fans]")).toContainText("17");
    expect(await bulbs(page, 0, "s-held")).toBe(17);
    await call(page, "addFans", 5);
    await settle(page);
    await expect.poll(async () => { await tick(500); return bulbs(page, 0, "s-lit"); }, { timeout: 30_000 }).toBe(21);
  }
}

for (const p of pages) {
  test(`reduced motion: ${p.name} completes its flow`, async ({ browser }) => {
    const f: Frozen = await openFrozen(browser, APP_BASE + p.path, DESKTOP, { reduced: true, api: p.api() });
    try {
      expect(await f.page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
      expect(f.viewCount, "WebGL signs still render under reduced motion").toBe(p.signs);
      await runFlow(f.page, p.name, (ms) => f.run(ms));
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test(`no WebGL: ${p.name} shows the flat sign and completes its flow`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    try {
      await ctx.addInitScript(() => {
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") return null;
          return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof HTMLCanvasElement.prototype.getContext;
      });
      const page = await ctx.newPage();
      await installFakeApi(page, p.api());
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
      await page.goto(APP_BASE + p.path, { waitUntil: "networkidle" });
      await page.waitForFunction(() => Boolean((window as unknown as FallbackWindow).__marquee?.ready), undefined, { timeout: 15_000 });

      // No 3D layer: no views, no host, no canvas inside any stage.
      expect(await page.evaluate(() => (window as unknown as FallbackWindow).__marquee?.views?.length)).toBe(0);
      expect(await page.evaluate(() => (window as unknown as FallbackWindow).__marquee?.host ?? null)).toBeNull();
      expect(await page.locator("[data-stage] canvas").count()).toBe(0);

      // The flat sign is drawn for every sign on the page: frame, bulbs and a name.
      const flat = page.locator("svg.ph[data-ph]");
      expect(await flat.count()).toBe(p.signs);
      for (let i = 0; i < p.signs; i++) {
        expect(await flat.nth(i).locator("rect").count()).toBe(2);
        expect(await flat.nth(i).locator("circle").count()).toBeGreaterThan(0);
        expect(((await signText(page, i)) ?? "").length).toBeGreaterThan(0);
        await expect(flat.nth(i)).toBeVisible();
      }

      await runFlow(page, p.name, (ms) => page.waitForTimeout(ms));
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
}
