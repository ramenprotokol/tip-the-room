// The AG Grid ledger against the reference's hand-made ledger table, at rest, at the SAME 0.5% threshold as every
// other parity test (owner rule: pixel-perfect). Only this spec's pass lets PAGES.manage.skip hide the ledger section
// in the main manage parity tests. Compares the region's box size AND its pixels, and its visible text.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import type { LedgerRowDto } from "../../src/worker/api-types";
import { installFakeApi } from "./fake-api";
import { MANAGE_FRAMES, MANAGE_SCRIPTS, manageApi, MAYA_ID, MAYA_KEY } from "./fixtures";
import { APP_BASE, DESKTOP, MAX_DIFF_RATIO, PHONE, diffRatio, openFrozen } from "./parity";

// The rows are the manage fixtures' first frame: the reference's twelve "Fan held a spot" rows (STAMPS, INITIALS, SAMPLE-AUTH-nnn, $15, On hold).
const ROWS: LedgerRowDto[] = MANAGE_FRAMES.initial.ledger;

const settleFonts = async (page: Page) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); };

async function region(page: Page, selector: string) {
  const el = page.locator(selector);
  await el.scrollIntoViewIfNeeded();
  await settleFonts(page);
  const box = await el.evaluate((e) => { const r = e.getBoundingClientRect(); return { width: r.width, height: r.height, x: r.x, y: r.y }; });
  const text = (await el.innerText()).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  return { png: await el.screenshot(), box, text };
}

async function compare(browser: Browser, viewport: { width: number; height: number }, slug: string, target: "harness" | "manage") {
  const ref = await openFrozen(browser, "http://127.0.0.1:5198/v2/manage.html", viewport);
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  try {
    if (target === "harness") {
      await page.goto(`${APP_BASE}tests/gpu/ledger/harness.html`, { waitUntil: "networkidle" });
      await page.evaluate((rows) => window.__ledger.rows(rows), ROWS);
    } else {
      // The real manage page, answered by the fake API, in parity mode (the grid is the one the artist sees).
      await installFakeApi(page, manageApi(MANAGE_SCRIPTS.tipped));
      await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e=parity#${MAYA_KEY}`, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    }
    await expect(page.locator("#ledger .ag-row").first()).toBeVisible();
    const a = await region(ref.page, 'section[aria-labelledby="h-ledger"] .ag-root-wrapper');
    // Sub-pixel alignment: the reference ledger sits at a fractional y on its page; give the harness the same fraction
    // so both regions rasterise on the same pixel grid (measurement alignment only, no threshold involved).
    const refY = a.box.y;
    await page.evaluate((y) => {
      const main = document.querySelector("main")!;
      const here = document.getElementById("ledger")!.getBoundingClientRect().top + scrollY;
      const q = 2; // 2 css px = 3 device pixels at the locked 1.5 scale factor, so css and device fractions both match
      main.style.paddingTop = `${(((y - here) % q) + q) % q}px`;
    }, refY + await ref.page.evaluate(() => scrollY));
    const b = await region(page, "#ledger");
    const A = PNG.sync.read(a.png);
    const diff = new PNG({ width: A.width, height: A.height });
    const sameBox = Math.abs(a.box.width - b.box.width) < 0.5 && Math.abs(a.box.height - b.box.height) < 0.5;
    const ratio = sameBox && A.width === PNG.sync.read(b.png).width && A.height === PNG.sync.read(b.png).height ? diffRatio(a.png, b.png, diff) : 1;
    mkdirSync("test-results/parity", { recursive: true });
    const B = PNG.sync.read(b.png);
    const note = `${slug}: png ${A.width}x${A.height} vs ${B.width}x${B.height}, ratio ${(ratio * 100).toFixed(3)}%, reference box ${a.box.width}x${a.box.height}, app box ${b.box.width}x${b.box.height}, ref at ${a.box.x},${a.box.y}, app at ${b.box.x},${b.box.y}`;
    if (ratio > MAX_DIFF_RATIO || !sameBox) {
      writeFileSync(`test-results/parity/${slug}-ref.png`, a.png);
      writeFileSync(`test-results/parity/${slug}-app.png`, b.png);
      writeFileSync(`test-results/parity/${slug}-diff.png`, PNG.sync.write(diff));
    }
    console.log(note);
    expect(errors).toEqual([]);
    expect(ref.errors).toEqual([]);
    expect({ w: b.box.width, h: b.box.height }, `${slug}: ledger box size differs (${note})`).toEqual({ w: a.box.width, h: a.box.height });
    expect(b.text, `${slug}: ledger text differs`).toBe(a.text);
    expect(ratio, note).toBeLessThanOrEqual(MAX_DIFF_RATIO);
  } finally {
    await ref.close();
    await ctx.close();
  }
}

test("ledger parity: desktop", async ({ browser }) => { await compare(browser, DESKTOP, "ledger-desktop", "harness"); });
test("ledger parity: phone", async ({ browser }) => { await compare(browser, PHONE, "ledger-phone", "harness"); });
test("ledger parity on the real manage page: desktop", async ({ browser }) => { await compare(browser, DESKTOP, "ledger-manage-desktop", "manage"); });
test("ledger parity on the real manage page: phone", async ({ browser }) => { await compare(browser, PHONE, "ledger-manage-phone", "manage"); });
