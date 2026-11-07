// The home page's first screen and the agent's story: the page paints before the API answers, the per-fan lines fold into
// one row each, and the Decisions strip shows the agent acting. Playwright answers /api/ from the fake demo.
import { expect, test, type Page } from "@playwright/test";
import type { AgentLogDto, ManageView } from "../../src/worker/api-types";
import { installFakeApi, type FakeApi } from "./fake-api";
import { demoApi } from "./fixtures";
import { APP_BASE } from "./parity";

const ready = (page: Page) => expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });

/** The demo fake, with a seeding history on both shows' manage views: `n` simulated-fan lines and one ordinary line. */
function seededApi(n: number): FakeApi {
  const base = demoApi();
  const seedLines = (offset: number): AgentLogDto[] =>
    Array.from({ length: n }, (_, i) => ({ seq: 1 + offset + i, at: Date.UTC(2026, 10, 16, 10, 0, i), saw: `${i + 1} of 34 fans`, did: `Simulated Fan ${String(i + 1).padStart(2, "0")} · JR held a spot with a real sandbox card hold. Nobody is charged yet.`, rule: "rule-1-hold-only", requestId: null, resultId: null, source: "code" }));
  return (req) => {
    const r = base(req);
    if (!r || req.method !== "GET" || !req.path.endsWith("/manage")) return r;
    const body = structuredClone(r.body) as ManageView;
    const offset = req.path.includes("dparityfixta") ? 0 : 100;
    // The fake's own lines come after the seeding history (the page only shows lines newer than the ones it has).
    body.log = [...body.log.map((e) => ({ ...e, seq: e.seq + 1000 })), ...seedLines(offset)].sort((x, y) => y.seq - x.seq);
    return { ...r, body };
  };
}

test.describe("first paint", () => {
  test("the cards and the signs are on screen, with the real names, before the API has answered", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await installFakeApi(page, demoApi());
    // Hold the copy-creating answer: the page must already be showing something meaningful.
    await page.route("**/api/demo", async (route) => { await gate; await route.fallback(); });
    await page.goto(APP_BASE);
    await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
    await expect(page.locator("#show-b .title")).toHaveText("Marlow Finch");
    await expect(page.locator("body")).not.toHaveAttribute("data-booted", "1");
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator("#show-a [data-ph] text")).toHaveText("JUNIPER VALE");
    await expect(page.locator("#show-b [data-ph] text")).toHaveText("MARLOW FINCH");
    await expect(page.locator("#show-a [data-of]")).toHaveText("of 34 fans");
    await expect(page.locator("#show-b [data-of]")).toHaveText("of 28 fans");
    await expect(page.locator("#show-a [data-fans] .sr")).toHaveText("0");
    release();
    await ready(page);
    await expect(page.locator("#show-a [data-fans] .sr")).toHaveText("29");
  });
});

test.describe("what the agent did", () => {
  test("folds the simulated fans' lines into one row per show that opens on click", async ({ page }) => {
    await installFakeApi(page, seededApi(12));
    await page.goto(APP_BASE);
    await ready(page);
    const rows = page.locator("#log li.fold[data-fold=seed]");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("12 of 29 starting fans held a spot (real PayPal sandbox card holds)");
    await expect(rows.nth(1)).toContainText("12 of 19 starting fans held a spot (real PayPal sandbox card holds)");
    // 24 lines are in the page, but none is showing until the row is opened.
    await expect(page.locator("#log .fold-lines li")).toHaveCount(24);
    await expect(page.locator("#log .fold-lines li").first()).toBeHidden();
    await rows.nth(0).locator("summary").click();
    await expect(page.locator("#log .fold-lines li").first()).toBeVisible();
    await expect(rows.nth(0).locator(".fold-lines li")).toHaveCount(12);
    // The top level of the log no longer holds a wall of identical lines.
    expect(await page.locator("#log > li:not(.fold)").count()).toBeLessThan(8);
  });

  test("pins a Decisions strip above the log, empty at first, and Check pace now puts the proposal in it with its money rule", async ({ page }) => {
    await installFakeApi(page, seededApi(12));
    await page.goto(APP_BASE);
    await ready(page);
    const strip = page.locator("#decisions");
    await expect(strip).toBeVisible();
    await expect(strip.locator("[data-decisions-empty]")).toBeVisible();
    await expect(strip.locator("[data-decisions-list] li")).toHaveCount(0);
    // It sits above the log and is on screen without scrolling the log.
    const boxes = await Promise.all([strip.boundingBox(), page.locator("#log").boundingBox()]);
    expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);

    await page.locator("#pace").click();
    const rows = strip.locator("[data-decisions-list] li");
    await expect(rows.filter({ hasText: "Proposed" })).toHaveCount(1);
    await expect(rows.first()).toContainText("Behind pace. Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist.");
    await expect(rows.first()).toContainText("Money rule 5 · ask the artist first");
    await expect(rows.first()).toContainText("Marlow Finch");
    await expect(strip.locator("[data-decisions-empty]")).toBeHidden();
    // Juniper Vale was on pace: that is a decision too, and it names no money rule because it moves no money.
    await expect(rows.filter({ hasText: "on pace" })).toHaveCount(1);
    // The newest decision is also said beside the judge's buttons, with a way down to the strip.
    await expect(page.locator("[data-latest]")).toContainText("Marlow Finch: Behind pace. Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist. (Money rule 5 · ask the artist first)");
    await expect(page.locator("[data-latest] a")).toHaveAttribute("href", "#decisions");
  });

  test("the strip and the folds are off in the pixel-comparison mode", async ({ page }) => {
    await installFakeApi(page, seededApi(12));
    await page.goto(`${APP_BASE}?e2e=parity`);
    await ready(page);
    await expect(page.locator("#decisions")).toBeHidden();
    await expect(page.locator("#log li.fold")).toHaveCount(0);
  });
});

test.describe("Check pace now", () => {
  /** Show A at `a` fans and show B at `b`, as a fresh copy that is still seating. */
  function seating(a: number, b: number, done = { now: false }): FakeApi {
    const base = demoApi();
    return (req) => {
      const r = base(req);
      if (!r || done.now) return r;
      const isDemo = req.method === "POST" && req.path === "/api/demo";
      const isShow = req.method === "GET" && /^\/api\/shows\/dparityfixt[ab]$/.test(req.path);
      if (!isDemo && !isShow) return r;
      const body = structuredClone(r.body) as { shows?: { showId: string; version: string; fans: { committed: number } }[] } & { showId: string; version: string; fans: { committed: number } };
      const few = (s: { showId: string; version: string; fans: { committed: number } }) => { s.fans.committed = s.showId.endsWith("a") ? a : b; s.version = "e0.l0"; };
      if (isDemo) body.shows!.forEach(few); else few(body);
      return { ...r, body };
    };
  }

  test("unlocks at 26 and 19 seated, before the last starting fans, and the hint says what it is waiting for", async ({ page }) => {
    const done = { now: false };
    await installFakeApi(page, seating(25, 19, done));
    await page.goto(APP_BASE);
    await ready(page);
    await expect(page.locator("#pace")).toBeDisabled();
    await expect(page.locator("#pace-hint")).toHaveText("Unlocks in about 30 seconds, once the starting fans are seated (Juniper Vale 25 of 26).");
    done.now = true;
    await expect(page.locator("#pace")).toBeEnabled({ timeout: 25_000 });
    await expect(page.locator("#pace-hint")).toBeHidden();
  });

  test("26 of Juniper's 29 and all 19 of Marlow's are enough", async ({ page }) => {
    await installFakeApi(page, seating(26, 19));
    await page.goto(APP_BASE);
    await ready(page);
    await expect(page.locator("#pace")).toBeEnabled();
    await expect(page.locator("#pace-hint")).toBeHidden();
  });
});

test.describe("the payout panel", () => {
  test("shows the planned split as soon as the show is on, not $0 Waiting while the charges settle", async ({ page }) => {
    await installFakeApi(page, demoApi());
    await page.goto(APP_BASE);
    await ready(page);
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Waiting", "Waiting", "Waiting"]);
    await page.locator("#show-a [data-act=add]").click();
    await expect(page.locator("#show-a [data-word]")).toHaveText("It’s on!", { timeout: 15_000 });
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Planned", "Planned", "Planned"]);
    await expect(page.locator("#payout [data-pay-note]")).toContainText("Planned from the $510 charged, before PayPal’s fee");
    await expect(page.locator("#payout [data-pay-note]")).toContainText("Paid in one PayPal payout at the deadline.");
  });
});
