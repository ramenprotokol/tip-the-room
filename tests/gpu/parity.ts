import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const REF_BASE = "http://127.0.0.1:5198/v2/";
export const APP_BASE = "http://127.0.0.1:5199/";
export const MAX_DIFF_RATIO = 0.005;
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 400, height: 860 };

type Viewport = { width: number; height: number };

interface MarqueeView { anim?: { t0: number } }
interface MarqueeWindow { __marquee?: { ready?: boolean; views?: MarqueeView[] } }

export interface Frozen {
  page: Page;
  errors: string[];
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
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => Boolean((window as MarqueeWindow).__marquee?.ready))) break;
    await sleep(100);
  }
  await page.clock.runFor(1200);
  const run = (ms: number) => page.clock.runFor(ms);
  const toAnim = async (view: number, t: number) => {
    const ms = await page.evaluate(([i, tt]) => {
      const v = (window as MarqueeWindow).__marquee?.views?.[i];
      return v?.anim ? v.anim.t0 + tt * 1000 - performance.now() : 0;
    }, [view, t] as const);
    if (ms > 0) await page.clock.runFor(Math.ceil(ms));
  };
  return { page, errors, run, toAnim, close: () => ctx.close() };
}

export async function shoot(f: Frozen, fullPage: boolean): Promise<Buffer> {
  await f.page.evaluate(() => scrollTo(0, 0));
  await sleep(300);
  return f.page.screenshot({ fullPage, mask: [f.page.locator("[data-ref-only]")], maskColor: "#FF00FF" });
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
  opts: { viewport: Viewport; fullPage: boolean; slug: string },
): Promise<number> {
  const ref = await openFrozen(browser, REF_BASE + refPath, opts.viewport);
  const app = await openFrozen(browser, APP_BASE + appPath, opts.viewport);
  try {
    await scenario(ref);
    await scenario(app);
    const a = await shoot(ref, opts.fullPage);
    const b = await shoot(app, opts.fullPage);
    expect(ref.errors, "reference page errors").toEqual([]);
    expect(app.errors, "app page errors").toEqual([]);
    const A = PNG.sync.read(a);
    const diff = new PNG({ width: A.width, height: A.height });
    const ratio = diffRatio(a, b, diff);
    if (ratio > MAX_DIFF_RATIO) {
      mkdirSync("test-results/parity", { recursive: true });
      writeFileSync(`test-results/parity/${opts.slug}-ref.png`, a);
      writeFileSync(`test-results/parity/${opts.slug}-app.png`, b);
      writeFileSync(`test-results/parity/${opts.slug}-diff.png`, PNG.sync.write(diff));
    }
    expect(ratio, `${opts.slug}: ${(ratio * 100).toFixed(3)}% of pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    return ratio;
  } finally {
    await ref.close();
    await app.close();
  }
}
