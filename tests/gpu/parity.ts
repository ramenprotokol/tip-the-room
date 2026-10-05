import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const REF_BASE = "http://127.0.0.1:5198/v2/";
export const APP_BASE = "http://127.0.0.1:5199/";
export const PROD_BASE = "http://127.0.0.1:5200/";
export const MAX_DIFF_RATIO = 0.005;
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 400, height: 860 };

type Viewport = { width: number; height: number };

interface MarqueeView { anim?: { t0: number } }
interface MarqueeWindow { __marquee?: { ready?: boolean; views?: MarqueeView[] } }

export interface Frozen {
  page: Page;
  errors: string[];
  viewCount: number;
  run(ms: number): Promise<void>;
  toAnim(view: number, t: number): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openFrozen(browser: Browser, url: string, viewport: Viewport, opts: { reduced?: boolean } = {}): Promise<Frozen> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
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
  return { page, errors, viewCount, run, toAnim, close: () => ctx.close() };
}

export async function shoot(f: Frozen, fullPage: boolean): Promise<Buffer> {
  await f.page.evaluate(() => scrollTo(0, 0));
  await f.page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return f.page.screenshot({ fullPage, mask: [f.page.locator("[data-ref-only]")], maskColor: "#FF00FF" });
}

// Visible text of the page, for comparing what the pixels cannot (a wrong digit, a changed sentence).
// Reads document.body.innerText with [data-ref-only] elements hidden for the read (they are masked in the
// screenshot too). The odometer's visual digit strips (span.odo, aria-hidden) are hidden too: they hold the
// digits 0-9 over and over, and the real value is carried by the sibling span.sr, which stays in the text.
// Whitespace runs collapse to one space per line and blank lines are dropped.
export async function visibleText(page: Page): Promise<string> {
  const raw = await page.evaluate(() => {
    const refOnly = Array.from(document.querySelectorAll<HTMLElement>("[data-ref-only], .odo"));
    const saved = refOnly.map((el) => el.style.display);
    refOnly.forEach((el) => { el.style.display = "none"; });
    const text = document.body.innerText;
    refOnly.forEach((el, i) => { el.style.display = saved[i] ?? ""; });
    return text;
  });
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

export type Scenario = (f: Frozen) => Promise<void>;

export async function expectParity(
  browser: Browser,
  refPath: string,
  appPath: string,
  scenario: Scenario,
  opts: { viewport: Viewport; fullPage: boolean; slug: string; expectSigns?: boolean; appBase?: string },
): Promise<number> {
  let ref: Frozen | undefined;
  let app: Frozen | undefined;
  try {
    ref = await openFrozen(browser, REF_BASE + refPath, opts.viewport);
    app = await openFrozen(browser, (opts.appBase ?? APP_BASE) + appPath, opts.viewport);
    if (opts.expectSigns ?? true) {
      expect(ref.viewCount, `${opts.slug}: reference rendered no signs (WebGL unavailable?), so nothing real would be compared`).toBeGreaterThan(0);
      expect(app.viewCount, `${opts.slug}: app sign count differs from the reference`).toBe(ref.viewCount);
    }
    await scenario(ref);
    await scenario(app);
    const a = await shoot(ref, opts.fullPage);
    const b = await shoot(app, opts.fullPage);
    const refText = await visibleText(ref.page);
    const appText = await visibleText(app.page);
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
