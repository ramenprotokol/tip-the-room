# Plan 2 · Marquee Port + Visual Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the approved Marquee reference pack (`reference/v2/`) into the app as strict-TypeScript modules and Vite pages that look **exactly** like the reference, proven by GPU screenshot-parity tests.

**Architecture:**
- `reference/v2/shared/{ui,sign}.js` become `src/web/shared/{ui,sign}.ts`, and `styles.css` is copied verbatim.
- Each reference page becomes a root Vite page (`index.html` = Try the demo, `start.html`, `pledge.html`, `manage.html`) with its inline script moved to `src/web/pages/<page>.ts`.
- **No logic, timing, constant, markup or CSS changes:** only types, imports and the few environment guards listed below.
- A Playwright harness serves the reference over a static server and the app over Vite. It freezes both with `page.clock`, runs the same steps on each, and compares screenshots with pixelmatch.
- Everything stays client-side, with sample data. Plan 5 wires real data.

**Tech Stack:**
- three **0.170.0** (exact) and GSAP **3.12.5** (exact) from npm, the same versions the reference loads from CDN.
- Google Fonts, the same `<link>` as the reference: Big Shoulders Display, Doto, IBM Plex Sans, IBM Plex Mono.
- @playwright/test, pixelmatch, pngjs, jsqr (QR decode test).

## Global Constraints

- Repo `<repo>`, branch `plan-2-marquee-port`. Never change git config. **Never** push, deploy or publish. Never read or write outside the repo (npm cache and Playwright's browser cache excepted).
- **`reference/` is read-only.** Never edit, stage or commit anything under `reference/`.
- **Visual parity is the acceptance test.**
  - Each checkpoint: at most **0.5%** of pixels may differ (pixelmatch `threshold: 0.1`), with `[data-ref-only]` elements masked on both sides.
  - A failing parity test fails the task.
  - Never loosen the threshold, add masks, or skip checkpoints to make a test pass. Report it instead.
- **Port fidelity:**
  - Keep every statement, constant, cue time, easing, string, class name, id, `data-*` attribute and DOM order identical to the reference.
  - Allowed changes:
    - (a) TypeScript types and annotations;
    - (b) import paths (`./ui.js` → `./ui`, `shared/…` → `../shared/…`);
    - (c) the environment guards listed in a task;
    - (d) moving a page's inline `<script type="module">` into `src/web/pages/<page>.ts`, and its `<link rel="stylesheet" href="shared/styles.css">` into `import "../shared/styles.css"`.
  - Bare imports `three` and `three/addons/...` stay as written (npm three exports `./addons/*`).
- **Strict TypeScript, no `any`.** Use precise types, `unknown` plus narrowing, or non-null assertions where the reference relies on elements that are always present. If one `any` is truly unavoidable, add a one-line `eslint-disable-next-line` with a reason and list it in the report.
- `window.__marquee` hooks must keep the same names and behavior on every page. The parity harness drives the app through them.
- Commit trailer for implementer commits: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Freeze protocol, from `reference/v2/README.md`:
  1. `clock.install({ time: new Date("2026-11-16T10:19:00") })`, then `clock.pauseAt(new Date("2026-11-16T10:19:01"))`, **before** `goto`.
  2. Poll `window.__marquee.ready` with `page.evaluate` (not `waitForFunction`).
  3. `runFor(1200)`.
  4. Trigger, then step to *t* with `runFor(view.anim.t0 + t·1000 − performance.now())`.
  5. Wait about 300 ms real time, then screenshot.

---

### Task 1: Web scaffold + parity harness (proven on the reference against itself)

**Files:**
- Modify: `package.json` (deps, `test:gpu` script), `vite.config.ts`, `tsconfig.json` (include `playwright.config.ts`), `eslint.config.js` (no change expected; verify)
- Create: `playwright.config.ts`, `tests/gpu/parity.ts`, `tests/gpu/harness.spec.ts`

**Interfaces:**
- Produces, in `tests/gpu/parity.ts`:
  - `REF_BASE = "http://127.0.0.1:5198/v2/"`, `APP_BASE = "http://127.0.0.1:5199/"`, `MAX_DIFF_RATIO = 0.005`
  - `DESKTOP = { width: 1440, height: 900 }`, `PHONE = { width: 400, height: 860 }`
  - `interface Frozen { page: Page; errors: string[]; run(ms: number): Promise<void>; toAnim(view: number, t: number): Promise<void>; close(): Promise<void> }`
  - `openFrozen(browser: Browser, url: string, viewport: { width: number; height: number }, opts?: { reduced?: boolean }): Promise<Frozen>`
  - `shoot(f: Frozen, fullPage: boolean): Promise<Buffer>` (scrolls to top, masks `[data-ref-only]` with `#FF00FF`, waits 300 ms real time)
  - `diffRatio(a: Buffer, b: Buffer): number` (1 if sizes differ)
  - `type Scenario = (f: Frozen) => Promise<void>`
  - `expectParity(browser: Browser, refPath: string, appPath: string, scenario: Scenario, opts: { viewport: { width: number; height: number }; fullPage: boolean }): Promise<number>`. It runs the scenario on both, asserts both have no page errors, asserts `diffRatio <= MAX_DIFF_RATIO`, writes both PNGs and the diff image to `test-results/parity/<slug>-{ref,app,diff}.png` when it fails, and returns the ratio.

- [ ] **Step 1: Branch and install**

```bash
git checkout -b plan-2-marquee-port
npm install three@0.170.0 gsap@3.12.5
npm install -D @types/three@0.170.0 @playwright/test@^1.63.0 pixelmatch@^7.2.0 pngjs@^7.0.0 @types/pngjs jsqr
npx playwright install chromium
```
Expected: all install. If `@types/three@0.170.0` doesn't exist, use the nearest `0.170.x` and note it.

- [ ] **Step 2: `package.json` scripts.** Add `"test:gpu": "playwright test"` (keep the others).

- [ ] **Step 3: `vite.config.ts`.** Make it multi-page, and keep the reference out of Vite's dependency scan:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  server: { hmr: false, host: "127.0.0.1" },
  optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        start: resolve(root, "start.html"),
        pledge: resolve(root, "pledge.html"),
        manage: resolve(root, "manage.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});
```
`start.html`, `pledge.html` and `manage.html` don't exist yet. Create each as a minimal placeholder with the same shape as the current `index.html` (title "Tip the Room") so `npm run build` keeps working; Tasks 5–7 replace them.

- [ ] **Step 4: `playwright.config.ts`**

```ts
import { defineConfig } from "@playwright/test";

// GPU parity tests: local only (hosted CI has no GPU). The reference is served as plain static files,
// the app by Vite, so each runs exactly the code it ships.
export default defineConfig({
  testDir: "tests/gpu",
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] },
  },
  webServer: [
    {
      command: "python3 -m http.server 5198 --bind 127.0.0.1 --directory reference",
      url: "http://127.0.0.1:5198/v2/demo.html",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5199 --strictPort",
      url: "http://127.0.0.1:5199/",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
```
Add `"playwright.config.ts"` to `tsconfig.json`'s `include`.

- [ ] **Step 5: Write `tests/gpu/parity.ts`**

```ts
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
```

- [ ] **Step 6: Prove the harness on the reference against itself** with `tests/gpu/harness.spec.ts`

```ts
import { test, expect } from "@playwright/test";
import { DESKTOP, REF_BASE, diffRatio, openFrozen, shoot } from "./parity";

test("two frozen loads of the reference demo match (rest and tip 2.4)", async ({ browser }) => {
  for (const step of ["rest", "tip-2.4"] as const) {
    const shots: Buffer[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await openFrozen(browser, REF_BASE + "demo.html", DESKTOP);
      if (step === "tip-2.4") {
        await f.page.keyboard.press("t");
        await f.run(1700);
        await f.toAnim(0, 2.4);
      }
      shots.push(await shoot(f, false));
      expect(f.errors).toEqual([]);
      await f.close();
    }
    expect(diffRatio(shots[0], shots[1])).toBeLessThanOrEqual(0.005);
  }
});
```

- [ ] **Step 7: Run it**

Run: `npm run test:gpu -- tests/gpu/harness.spec.ts`
Expected: 1 passed. If two reference loads differ by more than 0.5%, stop and report BLOCKED with the measured ratios. The harness is wrong, not the reference.

- [ ] **Step 8: Check nothing else broke.** Run `npm run typecheck && npm run lint && npm test && npm run build`. All clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json playwright.config.ts start.html pledge.html manage.html tests/gpu/parity.ts tests/gpu/harness.spec.ts
git commit -m "test(gpu): Playwright parity harness (frozen clock, masked pixel diff), proven on the reference

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Port `shared/ui.js` → `src/web/shared/ui.ts`

**Files:**
- Create: `src/web/shared/ui.ts` (a port of `reference/v2/shared/ui.js`), `tests/web/ui.test.ts`

**Interfaces:**
- Produces: exactly the reference module's exports, with the same names and behavior. In order: `REDUCED`, `$`, `$$`, `clamp`, `smooth`, `easeOut3`, `easeInOut`, `backOut`, `pad2`, `usd`, `mulberry32`, `Ticker`, `tween`, `Cues`, `pop`, `enter`, `setStatus`, `countdownHTML`, `Odo`, `Snd`, `soundToggle`, `AgentLog`, `PayoutStrip`, `trackPoints2D`, `Placeholder`, `HoldButton`, `copyText`, `qrMatrix`, `drawQR`, `GRID_THEME`. Type each public signature from how the reference pages call it.
- Allowed environment guard: `REDUCED` must not crash when imported under Node (Vitest), so use `typeof matchMedia === "function" && matchMedia('(prefers-reduced-motion: reduce)').matches`. In a browser this has the same value.

- [ ] **Step 1: Write the failing test** `tests/web/ui.test.ts` (pure helpers only)

```ts
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { clamp, countdownHTML, mulberry32, pad2, qrMatrix, trackPoints2D, usd } from "../../src/web/shared/ui";

describe("ui pure helpers", () => {
  it("formats numbers like the reference", () => {
    expect(pad2(7)).toBe("07");
    expect(usd(1234.4)).toBe("$1,234");
    expect(clamp(2)).toBe(1);
    expect(clamp(-1)).toBe(0);
  });
  it("mulberry32 is deterministic", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("countdownHTML renders days, hours, minutes and seconds", () => {
    const html = countdownHTML(200460);
    expect(html).toContain("02");
    expect(typeof html).toBe("string");
  });
  it("trackPoints2D returns n points", () => {
    expect(trackPoints2D(600, 200, 24, 34)).toHaveLength(34);
  });
  it("qrMatrix encodes text that jsQR decodes back", () => {
    for (const text of ["https://tiptheroom.example/s/acoustic-set-nov20", "Café 12 of 21"]) {
      const m = qrMatrix(text);
      const scale = 6;
      const margin = 4;
      const size = (m.length + margin * 2) * scale;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const mx = Math.floor(x / scale) - margin;
          const my = Math.floor(y / scale) - margin;
          const dark = mx >= 0 && my >= 0 && mx < m.length && my < m.length && Boolean(m[my][mx]);
          const i = (y * size + x) * 4;
          const v = dark ? 0 : 255;
          data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
      }
      expect(jsQR(data, size, size)?.data).toBe(text);
    }
  });
});
```
Before relying on the `countdownHTML`, `trackPoints2D` and `qrMatrix` assertions, check their real signatures and return shapes in `reference/v2/shared/ui.js`. Adapt the test to the reference's actual API (for example, if `qrMatrix` returns `{ size, get(x, y) }`), never the other way round. Note any adaptation in the report.

- [ ] **Step 2: Run, and see it fail**

Run: `npx vitest run tests/web/ui.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Port.** Copy `reference/v2/shared/ui.js` to `src/web/shared/ui.ts`, then add types, apply the `REDUCED` guard, and fix imports. Follow the port-fidelity rule.

- [ ] **Step 4: Run, and see it pass.** Run `npx vitest run tests/web/ui.test.ts`, then `npm run typecheck && npm run lint && npm test`. All clean.

- [ ] **Step 5: Commit**

```bash
git add src/web/shared/ui.ts tests/web/ui.test.ts
git commit -m "feat(web): port Marquee shared UI module to TypeScript

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Port `shared/sign.js` → `src/web/shared/sign.ts` + styles

**Files:**
- Create: `src/web/shared/sign.ts` (a port of `reference/v2/shared/sign.js`), `src/web/shared/styles.css` (byte-for-byte copy of `reference/v2/shared/styles.css`), `tests/web/sign.test.ts`

**Interfaces:**
- Produces: the same exports as the reference: `TIP`, `PAYOUT`, `MISS`, `PLEDGE`, `BONUS`, `REDUCED_T`, `SignHost`, `SignView`, plus any other exports the reference has. Same constructor and method signatures as the pages use.
- Imports: `three` and `three/addons/…` exactly as the reference writes them; `./ui` for helpers.

- [ ] **Step 1: Write the failing test** `tests/web/sign.test.ts` (it locks the cue tables to the reference's values)

```ts
import { describe, expect, it } from "vitest";
import { BONUS, MISS, PAYOUT, PLEDGE, REDUCED_T, TIP } from "../../src/web/shared/sign";

describe("choreography cue tables match the reference", () => {
  it("has the reference timings", () => {
    expect(TIP).toEqual({ flare: 0.62, pop: 1.0, gather: 1.78, itson: 2.38, swap: 3.1, done: 4.3 });
    expect(PAYOUT).toEqual({ stream: 0.5, paid: 1.6, done: 2.6 });
    expect(MISS).toEqual({ wave: 0.9, release: 0.12, msg: 2.05, done: 3.1 });
    expect(PLEDGE).toEqual({ step: 0.24, land: 0.38, dur: 0.5 });
    expect(BONUS).toEqual({ step: 0.3, dur: 0.6 });
    expect(REDUCED_T).toEqual({ tip: 0.7, payout: 0.7, miss: 1.3 });
  });
});
```
If importing `sign.ts` under Node fails at module top level (for example because it touches `document`, `window` or WebGL when imported), the allowed guard is to move only that top-level browser access behind a `typeof window !== "undefined"` check, with identical browser behavior. Report it.

- [ ] **Step 2: Run, and see it fail.** Run `npx vitest run tests/web/sign.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Port.** Copy `reference/v2/shared/sign.js` to `src/web/shared/sign.ts` and add types (three's classes from `@types/three`). Shader source strings must stay byte-identical. Copy `styles.css` byte for byte (`cp reference/v2/shared/styles.css src/web/shared/styles.css`; confirm with `cmp`).

- [ ] **Step 4: Run, and see it pass.** Run `npx vitest run tests/web/sign.test.ts`, then `npm run typecheck && npm run lint && npm test`. All clean. Confirm `cmp reference/v2/shared/styles.css src/web/shared/styles.css` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/web/shared/sign.ts src/web/shared/styles.css tests/web/sign.test.ts
git commit -m "feat(web): port Marquee sign renderer to TypeScript; copy shared styles

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Port the demo page → `index.html` + `src/web/pages/demo.ts`, with parity

**Files:**
- Modify: `index.html` (replace the placeholder with the reference markup)
- Create: `src/web/pages/demo.ts`, `tests/gpu/demo.spec.ts`
- Delete: `src/main.ts` and `tests/smoke.test.ts` (the placeholder app name). In `README.md`, leave the content unchanged.

**Interfaces:**
- Consumes: `src/web/shared/ui.ts`, `src/web/shared/sign.ts`, `src/web/shared/styles.css`.
- Produces: the app's `/` behaves exactly like `reference/v2/demo.html`, including keys T/P/M/R and `window.__marquee` (`ready`, `views`, `ctls`).

- [ ] **Step 1: Write the failing parity test** `tests/gpu/demo.spec.ts`

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Scenario } from "./parity";

const tipTo = (t: number): Scenario => async (f) => {
  await f.page.keyboard.press("t");
  await f.run(1700);
  await f.toAnim(0, t);
};
const payoutTo = (t: number): Scenario => async (f) => {
  await f.page.keyboard.press("t");
  await f.run(1700);
  await f.toAnim(0, 4.8);
  await f.run(500);
  await f.page.keyboard.press("p");
  await f.run(1250);
  await f.toAnim(0, t);
};
const missTo = (t: number): Scenario => async (f) => {
  await f.page.keyboard.press("m");
  await f.run(1250);
  await f.toAnim(1, t);
};

const cases: Array<{ slug: string; scenario: Scenario; viewport: typeof DESKTOP; fullPage: boolean }> = [
  { slug: "demo-rest", scenario: async () => {}, viewport: DESKTOP, fullPage: true },
  { slug: "demo-tip-0.7", scenario: tipTo(0.7), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-2.4", scenario: tipTo(2.4), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-3.1", scenario: tipTo(3.1), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-4.8", scenario: tipTo(4.8), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-1.0", scenario: payoutTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-2.6", scenario: payoutTo(2.6), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-1.0", scenario: missTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-3.2", scenario: missTo(3.2), viewport: DESKTOP, fullPage: true },
  { slug: "demo-phone-rest", scenario: async () => {}, viewport: PHONE, fullPage: true },
];

for (const c of cases) {
  test(`parity: ${c.slug}`, async ({ browser }) => {
    await expectParity(browser, "demo.html", "", c.scenario, { viewport: c.viewport, fullPage: c.fullPage, slug: c.slug });
  });
}
```

- [ ] **Step 2: Run it, and see it fail.** Run `npm run test:gpu -- tests/gpu/demo.spec.ts`. Expected: FAIL (the app's `/` is still the placeholder).

- [ ] **Step 3: Port the page.**
  - `index.html` = `reference/v2/demo.html`, with exactly these changes:
    - (a) remove the `<script type="importmap">`;
    - (b) remove the `<link rel="stylesheet" href="shared/styles.css">`;
    - (c) replace the inline `<script type="module">…</script>` with `<script type="module" src="/src/web/pages/demo.ts"></script>`.
  - Keep the Google Fonts `<link>` tags, the GSAP `<script>` tag if the reference loads it from CDN (or import `gsap` in `demo.ts` if the shared modules import it; follow what the reference does and note it), every element, and every `data-ref-only` element.
  - `src/web/pages/demo.ts` = the inline script, starting with `import "../shared/styles.css";`, with typed code and fixed imports (`../shared/ui`, `../shared/sign`).
  - Delete `src/main.ts` and `tests/smoke.test.ts`.

- [ ] **Step 4: Run parity until it passes.** Run `npm run test:gpu -- tests/gpu/demo.spec.ts`. Expected: 10 passed. If a checkpoint fails, open `test-results/parity/<slug>-diff.png`, find the cause (usually a missed attribute, a load-order difference, or a GSAP or font difference) and fix the **port**, never the test. After two failed fix attempts on the same checkpoint, report BLOCKED with the ratios and diff paths.

- [ ] **Step 5: Run the other checks.** Run `npm run typecheck && npm run lint && npm test && npm run build`. All clean.

- [ ] **Step 6: Commit**

```bash
git add index.html src/web/pages/demo.ts tests/gpu/demo.spec.ts
git rm src/main.ts tests/smoke.test.ts
git commit -m "feat(web): Try the demo page ported from the Marquee reference with visual parity

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Port the Start a show page → `start.html` + `src/web/pages/start.ts`, with parity

**Files:**
- Modify: `start.html`
- Create: `src/web/pages/start.ts`, `tests/gpu/start.spec.ts`

**Interfaces:**
- Consumes: `src/web/shared/*`, and from `src/core`: `thresholdPledges`, `DEFAULT_FEE_BUFFER_BPS`, `dollarsToCents`.
- Produces: `/start.html` matches `reference/v2/start.html`. `window.__marquee` offers `ready`, `views`, `fill`, `setEmails`, `holdTo`, `sign`.
- **One allowed logic change:** wherever the reference computes the fan target (`ceil((fixed + minimum) × 1.05 / price)`), call the core's `thresholdPledges({ fixedCosts, artistMinimum, ticketPrice, feeBufferBps: DEFAULT_FEE_BUFFER_BPS })`, converting dollars with `dollarsToCents`. The displayed numbers must not change (Maya's sample: 21).

- [ ] **Step 1: Write the failing parity test** `tests/gpu/start.spec.ts`, mirroring the reference screenshot steps

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Scenario } from "./parity";

const filled: Scenario = async (f) => {
  await f.page.click("#fill");
  await f.run(900);
};
const live: Scenario = async (f) => {
  await filled(f);
  await f.page.evaluate(() => (window as unknown as { __marquee: { setEmails(): void } }).__marquee.setEmails());
  await f.run(400);
  await f.page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());
  await f.run(1600);
};

for (const [slug, scenario, viewport] of [
  ["start-initial", async () => {}, DESKTOP],
  ["start-filled", filled, DESKTOP],
  ["start-live", live, DESKTOP],
  ["start-phone-filled", filled, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, "start.html", "start.html", scenario, { viewport, fullPage: true, slug });
  });
}
```
If the reference's `#fill`, `setEmails` or `sign` behave differently from the `scratchpad` screenshot script, follow `reference/v2/start.html` and `reference/v2/README.md`, and note it.

- [ ] **Step 2: Run it, and see it fail.** Run `npm run test:gpu -- tests/gpu/start.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Port the page**, with the same rules as Task 4 Step 3, plus the one allowed `thresholdPledges` change.

- [ ] **Step 4: Run parity until it passes.** Expected: 4 passed. Then run `npm run typecheck && npm run lint && npm test && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add start.html src/web/pages/start.ts tests/gpu/start.spec.ts
git commit -m "feat(web): Start a show page ported with visual parity; fan target from the money core

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Port the Fan page → `pledge.html` + `src/web/pages/pledge.ts`, with parity

**Files:**
- Modify: `pledge.html`
- Create: `src/web/pages/pledge.ts`, `tests/gpu/pledge.spec.ts`

**Interfaces:**
- Produces: `/pledge.html` matches `reference/v2/pledge.html`. `window.__marquee` offers `ready`, `views`, `approve`, `setFans`, `setInitials`. The "Simulate PayPal approval" link stays and stays `data-ref-only`; Plan 5 replaces it with the real PayPal button.

- [ ] **Step 1: Write the failing parity test** `tests/gpu/pledge.spec.ts`. Use these checkpoints: `pledge-initial` (full page, desktop), `pledge-on-hold` (call `setInitials("MR")`, then `approve()`, run 1500 ms, full page), and `pledge-phone-initial` (full page, phone). Use the same `expectParity` pattern as Task 5, with `"pledge.html"` for both paths. Check the exact `setInitials` and `approve` call shapes in `reference/v2/pledge.html` first.

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Scenario } from "./parity";

type Hooks = { __marquee: { setInitials(s: string): void; approve(): void } };
const onHold: Scenario = async (f) => {
  await f.page.evaluate(() => (window as unknown as Hooks).__marquee.setInitials("MR"));
  await f.page.evaluate(() => (window as unknown as Hooks).__marquee.approve());
  await f.run(1500);
};

for (const [slug, scenario, viewport] of [
  ["pledge-initial", async () => {}, DESKTOP],
  ["pledge-on-hold", onHold, DESKTOP],
  ["pledge-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, "pledge.html", "pledge.html", scenario, { viewport, fullPage: true, slug });
  });
}
```

- [ ] **Step 2: Run it, and see it fail.** Then **Step 3: port** (same rules as Task 4). Then **Step 4: run parity until 3 pass**, and run the other checks.

- [ ] **Step 5: Commit**

```bash
git add pledge.html src/web/pages/pledge.ts tests/gpu/pledge.spec.ts
git commit -m "feat(web): Fan page ported from the Marquee reference with visual parity

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Port Maya's show page → `manage.html` + `src/web/pages/manage.ts`, with parity

**Files:**
- Modify: `manage.html`
- Create: `src/web/pages/manage.ts`, `tests/gpu/manage.spec.ts`

**Interfaces:**
- Produces: `/manage.html` matches `reference/v2/manage.html`. `window.__marquee` offers `ready`, `views`, `addFans`, `skip`, `reset`, `approve`, `decline`, `holdTo`.
- The ledger stays the reference's static, AG Grid-shaped table. Plan 5 swaps in real AG Grid, themed with `GRID_THEME`.

- [ ] **Step 1: Write the failing parity test** `tests/gpu/manage.spec.ts`. Its checkpoints follow the reference screenshot steps:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Scenario } from "./parity";

type Hooks = { __marquee: { approve(): void; addFans(n: number): void; skip(): void; reset(): void; decline(): void } };
const call = (f: Parameters<Scenario>[0], fn: (h: Hooks["__marquee"]) => void) =>
  f.page.evaluate(`(${fn.toString()})(window.__marquee)`);

const tipped: Scenario = async (f) => {
  await call(f, (m) => m.approve());
  await f.run(800);
  await call(f, (m) => m.addFans(5));
  await f.run(1800);
  await call(f, (m) => m.addFans(5));
  await f.run(6700);
};
const paid: Scenario = async (f) => {
  await tipped(f);
  await call(f, (m) => m.skip());
  await f.run(4450);
};
const calledOff: Scenario = async (f) => {
  await call(f, (m) => m.decline());
  await call(f, (m) => m.skip());
  await f.run(4850);
};

for (const [slug, scenario, viewport] of [
  ["manage-initial", async () => {}, DESKTOP],
  ["manage-tipped", tipped, DESKTOP],
  ["manage-paid", paid, DESKTOP],
  ["manage-called-off", calledOff, DESKTOP],
  ["manage-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, "manage.html", "manage.html", scenario, { viewport, fullPage: true, slug });
  });
}
```
`call` passes the hook function as source text so it runs inside the page. If you prefer typed `page.evaluate` callbacks like Task 5, that is fine. Keep the step timings identical to the reference script.

- [ ] **Step 2: Run it, and see it fail.** Then **Step 3: port** (same rules as Task 4). Then **Step 4: run parity until 5 pass**, and run the other checks.

- [ ] **Step 5: Commit**

```bash
git add manage.html src/web/pages/manage.ts tests/gpu/manage.spec.ts
git commit -m "feat(web): artist's show page ported from the Marquee reference with visual parity

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Routes, fallbacks check, and the full parity run

**Files:**
- Create: `public/_redirects`, `tests/gpu/fallbacks.spec.ts`
- Modify: `README.md` (a "Develop" section listing the `test:gpu` command)

**Interfaces:**
- Cloudflare Pages rewrites (200, not redirects): `/s/:id/manage` → `/manage.html`, `/s/:id` → `/pledge.html`. `/start` serves `start.html` automatically.

- [ ] **Step 1: Write `public/_redirects`**

```
/s/:id/manage  /manage.html  200
/s/:id         /pledge.html  200
```

- [ ] **Step 2: Write the failing fallback test** `tests/gpu/fallbacks.spec.ts`. For each app page (`""`, `start.html`, `pledge.html`, `manage.html`):
  - Under `reducedMotion: "reduce"`, the page reaches `__marquee.ready` with no page errors.
  - With WebGL disabled (a new context with launch arg `--disable-webgl`, or `page.addInitScript` that makes `HTMLCanvasElement.prototype.getContext` return `null` for `"webgl"`/`"webgl2"`), the page still reaches `ready` and shows the flat placeholder sign (`.placeholder` or whatever element the reference's `Placeholder` class renders; check `ui.js`) with no page errors.

```ts
import { test, expect } from "@playwright/test";
import { APP_BASE, DESKTOP, openFrozen } from "./parity";

const pages = ["", "start.html", "pledge.html", "manage.html"];

for (const p of pages) {
  test(`reduced motion: ${p || "demo"}`, async ({ browser }) => {
    const f = await openFrozen(browser, APP_BASE + p, DESKTOP, { reduced: true });
    expect(await f.page.evaluate(() => Boolean((window as unknown as { __marquee?: { ready?: boolean } }).__marquee?.ready))).toBe(true);
    expect(f.errors).toEqual([]);
    await f.close();
  });
  test(`no WebGL: ${p || "demo"}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    await ctx.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === "webgl" || type === "webgl2") return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof HTMLCanvasElement.prototype.getContext;
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(APP_BASE + p, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean((window as unknown as { __marquee?: { ready?: boolean } }).__marquee?.ready), null, { timeout: 15_000 });
    expect(errors).toEqual([]);
    await ctx.close();
  });
}
```

- [ ] **Step 3: Run the whole GPU suite.** Run `npm run test:gpu`. Expected: harness 1, demo 10, start 4, pledge 3, manage 5, fallbacks 8, all passing.

- [ ] **Step 4: Check the build output.** Run `npm run typecheck && npm run lint && npm test && npm run build`. Confirm `dist/` contains `index.html`, `start.html`, `pledge.html`, `manage.html` and `_redirects`.

- [ ] **Step 5: README `Develop` section**, appended:

```markdown
## Visual parity

The Marquee look is locked to `reference/v2/`. `npm run test:gpu` (local, needs a GPU) freezes the reference and the app at the same moments and fails if more than 0.5% of pixels differ.
```

- [ ] **Step 6: Commit**

```bash
git add public/_redirects tests/gpu/fallbacks.spec.ts README.md
git commit -m "feat(web): Pages routes for show links; reduced-motion and no-WebGL checks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes (controller)

- **Spec coverage:**
  - 2d (Marquee look, exact match, fixes already in the reference) → Tasks 3–7 plus parity.
  - 2b (three surfaces plus the demo) → Tasks 4–7.
  - 2c (plain English) is carried verbatim by the port.
  - 9 (visual parity checkpoints) → Tasks 1 and 4–8.
  - 7 (page routes) → Task 8.
- **Deliberately not here:** real PayPal (Plan 3), the agent and backend (Plan 4), real AG Grid and live data wiring (Plan 5).
- **Fonts:** the app loads the same Google Fonts `<link>` as the reference, so glyphs match exactly. This replaces the spec's earlier `@fontsource` note.
