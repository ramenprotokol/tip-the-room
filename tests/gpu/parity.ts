import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { installFakeApi, type FakeApi, type SeenRequests } from "./fake-api";

export const REF_BASE = "http://127.0.0.1:5198/v2/";
export const APP_BASE = "http://127.0.0.1:5199/";
export const PROD_BASE = "http://127.0.0.1:5200/";
export const MAX_DIFF_RATIO = 0.005;
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 400, height: 860 };
/** New real controls the reference doesn't have (judge panel, error lines, call-off …): hidden in the app page for parity. */
export const APP_ONLY = "[data-app-only]";

type Viewport = { width: number; height: number };

interface MarqueeView { anim?: { t0: number } }
interface MarqueeWindow { __marquee?: { ready?: boolean; views?: MarqueeView[]; pending?: number } }

export interface Frozen {
  page: Page;
  errors: string[];
  viewCount: number;
  /** Requests the page made to the fake API (undefined when no fake API was installed). */
  seen?: SeenRequests;
  run(ms: number): Promise<void>;
  toAnim(view: number, t: number): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openFrozen(browser: Browser, url: string, viewport: Viewport, opts: { reduced?: boolean; api?: FakeApi } = {}): Promise<Frozen> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
  const seen = opts.api ? await installFakeApi(page, opts.api) : undefined;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.clock.install({ time: new Date("2026-11-16T10:19:00") });
  await page.clock.pauseAt(new Date("2026-11-16T10:19:01"));
  await page.goto(url, { waitUntil: "networkidle" });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await page.evaluate(() => Boolean((window as MarqueeWindow).__marquee?.ready));
    if (!ready) await sleep(100);
  }
  if (!ready) {
    await ctx.close();
    throw new Error(`openFrozen: window.__marquee.ready never became true within 8 s at ${url} (page not loaded, script error, or no WebGL?)`);
  }
  const viewCount = await page.evaluate(() => (window as MarqueeWindow).__marquee?.views?.length ?? 0);
  await page.clock.runFor(1200);
  const run = (ms: number) => page.clock.runFor(ms);
  const toAnim = async (view: number, t: number) => {
    const ms = await page.evaluate(([i, tt]) => {
      const v = (window as MarqueeWindow).__marquee?.views?.[i];
      return v?.anim ? v.anim.t0 + tt * 1000 - performance.now() : null;
    }, [view, t] as const);
    if (ms === null) throw new Error(`toAnim: window.__marquee.views[${view}] or its anim is missing (no WebGL, or the animation never started)`);
    if (ms > 0) await page.clock.runFor(Math.ceil(ms));
  };
  return { page, errors, viewCount, seen, run, toAnim, close: () => ctx.close() };
}

/**
 * Waits, in real time and without moving the page clock, until the app has no API call or page action in flight
 * (window.__marquee.pending is 0). The reference has no `pending`, so this returns at once there.
 */
export async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = await page.evaluate(() => (window as MarqueeWindow).__marquee?.pending ?? 0);
    if (n === 0) return;
    await sleep(25);
  }
  throw new Error("settle: the page still has API calls in flight after 5 s");
}

export async function shoot(f: Frozen, fullPage: boolean, mask: string[] = []): Promise<Buffer> {
  await f.page.evaluate(() => scrollTo(0, 0));
  await f.page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return f.page.screenshot({ fullPage, mask: ["[data-ref-only]", ...mask].map((s) => f.page.locator(s)), maskColor: "#FF00FF" });
}

// Visible text of the page, for comparing what the pixels cannot (a wrong digit, a changed sentence).
// Reads document.body.innerText with [data-ref-only] elements (and any `hide` selectors) hidden for the read.
// The odometer's visual digit strips (span.odo, aria-hidden) are hidden too: they hold the digits 0-9 over and over,
// and the real value is carried by the sibling span.sr, which stays in the text.
// Whitespace runs collapse to one space per line and blank lines are dropped.
export async function visibleText(page: Page, hide: string[] = []): Promise<string> {
  const raw = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const saved = els.map((el) => el.style.display);
    els.forEach((el) => { el.style.display = "none"; });
    const text = document.body.innerText;
    els.forEach((el, i) => { el.style.display = saved[i] ?? ""; });
    return text;
  }, ["[data-ref-only]", ".odo", ...hide].join(", "));
  return raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

export function firstTextDifference(refText: string, appText: string): string {
  const r = refText.split("\n");
  const a = appText.split("\n");
  for (let i = 0; i < Math.max(r.length, a.length); i++) {
    if (r[i] !== a[i]) return `line ${i + 1}: reference ${JSON.stringify(r[i] ?? "(missing)")} vs app ${JSON.stringify(a[i] ?? "(missing)")}`;
  }
  return "(no difference)";
}

export function diffRatio(a: Buffer, b: Buffer, diffOut?: PNG): number {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return 1;
  const out = diffOut ?? new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, out.data, A.width, A.height, { threshold: 0.1 });
  return n / (A.width * A.height);
}

async function hide(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length) await page.addStyleTag({ content: `${selectors.join(", ")}{display:none!important}` });
}

/**
 * Data fields: reference sample words the API can't carry (a show time, a description). The app element gets the
 * reference element's exact size, both are masked, and both are left out of the text check.
 */
async function equalize(ref: Page, app: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const box = await ref.evaluate((s) => {
      const all = document.querySelectorAll(s);
      const r = all[0]?.getBoundingClientRect();
      return { n: all.length, w: r?.width ?? 0, h: r?.height ?? 0 };
    }, sel);
    if (box.n !== 1) throw new Error(`data field ${sel} must match exactly one element on the reference page (found ${box.n})`);
    const appBox = await app.evaluate((s) => {
      const all = document.querySelectorAll(s);
      const r = all[0]?.getBoundingClientRect();
      return { n: all.length, w: r?.width ?? 0, h: r?.height ?? 0 };
    }, sel);
    if (appBox.n !== 1) throw new Error(`data field ${sel} must match exactly one element on the app page (found ${appBox.n})`);
    if (box.w <= 0 || box.h <= 0) {
      // Not shown in this state (e.g. the start form before "Fill it in"): fine only if the app hides it too, so nothing is masked blindly.
      if (appBox.w > 0 || appBox.h > 0) throw new Error(`data field ${sel} has an empty box on the reference page but is shown on the app page`);
      continue;
    }
    const found = await app.evaluate(([s, w, h]) => {
      const el = document.querySelector<HTMLElement>(s);
      if (!el) return false;
      Object.assign(el.style, { boxSizing: "border-box", width: `${w}px`, height: `${h}px`, overflow: "hidden" });
      return true;
    }, [sel, box.w, box.h] as const);
    if (!found) throw new Error(`data field ${sel} is missing on the app page`);
  }
}

/**
 * Every [data-app-only] element on the app page must match this page's allowlist, and the reference must have no
 * element matching it: app-only is for new real controls, never a way to hide a difference.
 */
async function checkAppOnly(ref: Page, app: Page, allowed: string[], slug: string): Promise<void> {
  const stray = await app.evaluate((sels) => Array.from(document.querySelectorAll<HTMLElement>("[data-app-only]")).filter((el) => !sels.some((s) => el.matches(s))).map((el) => el.outerHTML.slice(0, 80)), allowed);
  expect(stray, `${slug}: [data-app-only] elements outside this page's allowlist`).toEqual([]);
  if (allowed.length) {
    const inRef = await ref.evaluate((sel) => document.querySelectorAll(sel).length, allowed.join(", "));
    expect(inRef, `${slug}: the reference page must not contain any app-only element`).toBe(0);
  }
}

export type Scenario = (f: Frozen) => Promise<void>;

export interface ParityOptions {
  viewport: Viewport;
  fullPage: boolean;
  slug: string;
  expectSigns?: boolean;
  appBase?: string;
  api?: () => FakeApi;
  dataFields?: string[];
  skip?: string[];
  /** Selectors this page may tag [data-app-only] (see AppPage.appOnly). */
  appOnly: string[];
}

export async function expectParity(browser: Browser, refPath: string, appPath: string, scenario: Scenario, opts: ParityOptions): Promise<number> {
  let ref: Frozen | undefined;
  let app: Frozen | undefined;
  const fields = opts.dataFields ?? [];
  const skip = opts.skip ?? [];
  try {
    ref = await openFrozen(browser, REF_BASE + refPath, opts.viewport);
    app = await openFrozen(browser, (opts.appBase ?? APP_BASE) + appPath, opts.viewport, { api: opts.api?.() });
    if (opts.expectSigns ?? true) {
      expect(ref.viewCount, `${opts.slug}: reference rendered no signs (WebGL unavailable?), so nothing real would be compared`).toBeGreaterThan(0);
      expect(app.viewCount, `${opts.slug}: app sign count differs from the reference`).toBe(ref.viewCount);
    }
    await scenario(ref);
    await scenario(app);
    await checkAppOnly(ref.page, app.page, opts.appOnly, opts.slug);
    await hide(ref.page, skip);
    await hide(app.page, [...skip, APP_ONLY]);
    await equalize(ref.page, app.page, fields);
    const a = await shoot(ref, opts.fullPage, fields);
    const b = await shoot(app, opts.fullPage, fields);
    const refText = await visibleText(ref.page, fields);
    const appText = await visibleText(app.page, fields);
    const textEqual = refText === appText;
    const A = PNG.sync.read(a);
    const diff = new PNG({ width: A.width, height: A.height });
    const ratio = diffRatio(a, b, diff);
    const errorsFound = ref.errors.length > 0 || app.errors.length > 0;
    if (errorsFound || ratio > MAX_DIFF_RATIO || !textEqual) {
      mkdirSync("test-results/parity", { recursive: true });
      writeFileSync(`test-results/parity/${opts.slug}-ref.png`, a);
      writeFileSync(`test-results/parity/${opts.slug}-app.png`, b);
      writeFileSync(`test-results/parity/${opts.slug}-diff.png`, PNG.sync.write(diff));
      writeFileSync(`test-results/parity/${opts.slug}-ref.txt`, refText + "\n");
      writeFileSync(`test-results/parity/${opts.slug}-app.txt`, appText + "\n");
    }
    expect(app.seen?.unanswered ?? [], `${opts.slug}: the app made requests the fake API doesn't answer`).toEqual([]);
    expect(ref.errors, "reference page errors").toEqual([]);
    expect(app.errors, "app page errors").toEqual([]);
    expect(refText.length, `${opts.slug}: reference page has no visible text, so the text check would prove nothing`).toBeGreaterThan(50);
    expect(textEqual, `${opts.slug}: visible text differs, first at ${firstTextDifference(refText, appText)}`).toBe(true);
    expect(ratio, `${opts.slug}: ${(ratio * 100).toFixed(3)}% of pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    return ratio;
  } finally {
    await ref?.close();
    await app?.close();
  }
}
