import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { DEMO_ID, DEMO_KEY, demoApi } from "./fixtures";
import { APP_BASE } from "./parity";
import type { PublicShow } from "../../src/worker/api-types";

async function open(page: Page, api: FakeApi = demoApi()) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}?e2e=quiet`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const fans = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);
/** Pre-fills the saved demo copy before the page's own script runs. */
const saved = (page: Page, d: { demoId: string; demoKey: string; expiresAt: number }) =>
  page.addInitScript((v) => { if (!localStorage.getItem("ttr:demo")) localStorage.setItem("ttr:demo", JSON.stringify(v)); }, d);

test("the judge panel prints the sandbox login sentence and links to the demo shows", async ({ page }) => {
  await open(page);
  await expect(page.locator("#judge")).toBeVisible();
  await expect(page.locator("[data-judge-creds]")).toHaveText("Sandbox buyer login coming soon");
  await expect(page.locator("#pledge-a")).toHaveAttribute("href", `/s/${DEMO_ID}a`);
  await expect(page.locator("#pledge-a")).toHaveText("Hold a spot on Juniper Vale");
  await expect(page.locator("#manage-b")).toHaveAttribute("href", `/s/${DEMO_ID}b/manage#${DEMO_KEY}`);
  await expect(page.locator("#log li")).toHaveCount(1);
  await expect(page.locator("#log")).toContainText("Watching 2 shows. 48 fans are on hold and nobody has been charged.");
});

test("Check pace now shows the agent's proposal for the show that is behind", async ({ page }) => {
  const seen = await open(page);
  await page.click("#pace");
  await expect(page.locator("#log")).toContainText("Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist.");
  await expect(page.locator("#log")).toContainText("On pace. Nothing to change.");
  await expect(page.locator("[data-judge-msg]")).toHaveText("The agent checked the pace. Marlow Finch is behind, so it asked the artist first. Open the show page to answer.");
  expect(seen.some((r) => r.path === `/api/demo/${DEMO_ID}/pace` && r.key === DEMO_KEY)).toBe(true);
});

test("Add fans asks the API for that show and the new bulbs land", async ({ page }) => {
  const seen = await open(page);
  await page.locator("#show-b [data-act=add]").click();
  await expect(fans(page, "b")).toHaveText("24", { timeout: 10_000 });
  expect(seen.find((r) => r.path.endsWith("/fans"))?.body).toEqual({ show: "b", count: 5 });
  await expect(page.locator("#log")).toContainText("5 more fans joined Marlow Finch. PayPal is holding their $60.");
});

test("Skip to the deadline on a show that is short calls it off", async ({ page }) => {
  const seen = await open(page);
  await page.locator("#show-b [data-act=ff]").click();
  await expect(page.locator("#show-b [data-word]")).toHaveText("Called off", { timeout: 10_000 });
  expect(seen.find((r) => r.path.endsWith("/fast-forward"))?.body).toEqual({ show: "b" });
  await expect(page.locator("#log")).toContainText("Marlow Finch ended at 19 of 28. Every hold was cancelled. Nobody paid.");
});

test("a show called off after it tipped says refunding: no countdown spin, no miss, never \"nobody paid\"", async ({ page }) => {
  await open(page, demoApi("paid", { callOff: true }));
  const a = page.locator("#show-a");
  await a.locator("[data-act=add]").click();
  await expect(a.locator("[data-word]")).toHaveText("It’s on!", { timeout: 15_000 });
  await expect(a.locator("[data-act=ff]")).toBeEnabled({ timeout: 15_000 });
  const words: string[] = [];
  await page.exposeFunction("__word", (w: string) => words.push(w));
  await page.evaluate(() => { new MutationObserver(() => (window as unknown as { __word: (w: string) => void }).__word(document.querySelector("#show-a [data-word]")?.textContent ?? "")).observe(document.querySelector("#show-a [data-status]")!, { subtree: true, childList: true, characterData: true }); });
  await a.locator("[data-act=ff]").click();
  await expect(a.locator("[data-status]")).toContainText("refunding everyone", { timeout: 10_000 });
  await expect(a.locator("[data-word]")).toHaveText("Called off");
  await expect(a.locator("[data-money-sub]")).toHaveText("Called off. Every fan who was charged is getting $15 back.");
  await expect(a.locator("[data-fans-sub]")).toHaveText("Called off · refunding");
  await expect(a.locator("[data-clock]")).not.toHaveClass(/zero/);
  expect(words).not.toContain("Deadline passed");
  await expect(a).not.toContainText("nobody paid");
});

test("Start over gets a fresh copy, and a saved copy is reused on reload", async ({ page }) => {
  const seen = await open(page);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("ttr:demo"))) ?? "null")).toMatchObject({ demoId: DEMO_ID, demoKey: DEMO_KEY });
  await page.locator("#show-a [data-act=reset]").click();
  await expect(page.locator("[data-judge-msg]")).toHaveText("A fresh pair of sample shows is ready.");
  expect(seen.some((r) => r.path === `/api/demo/${DEMO_ID}/reset`)).toBe(true);
  const before = seen.filter((r) => r.path === "/api/demo").length;
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  expect(seen.filter((r) => r.path === "/api/demo").length).toBe(before);
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
});

test("a refused demo is explained in plain words", async ({ page }) => {
  await open(page, (req) => (req.path === "/api/demo" ? apiError(429, "rate_limited", "Too many tries. Please wait a moment and try again.") : undefined));
  await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
});

test("a saved copy that has run out is dropped and a fresh one is started", async ({ page }) => {
  await saved(page, { demoId: DEMO_ID, demoKey: DEMO_KEY, expiresAt: Date.now() - 60_000 });
  const seen = await open(page);
  expect(seen.filter((r) => r.method === "POST" && r.path === "/api/demo").length).toBe(1);
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
});

test("a saved copy the server no longer knows (404) is dropped and a fresh one is started", async ({ page }) => {
  await saved(page, { demoId: "dgonegone", demoKey: "gone-key-fixture", expiresAt: Date.now() + 3_600_000 });
  const seen = await open(page);
  expect(seen.some((r) => r.path === "/api/shows/dgonegonea")).toBe(true);
  expect(seen.filter((r) => r.method === "POST" && r.path === "/api/demo").length).toBe(1);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("ttr:demo"))) ?? "null")).toMatchObject({ demoId: DEMO_ID });
});

test("demo controls run one at a time", async ({ page }) => {
  const seen = await open(page);
  await page.evaluate(() => {
    const q = (s: string) => document.querySelector<HTMLButtonElement>(s)!;
    q("#show-b [data-act=add]").click();
    q("#show-b [data-act=add]").click();
    q("#show-a [data-act=ff]").click();
    q("#pace").click();
    q("#show-a [data-act=reset]").click();
  });
  await expect(fans(page, "b")).toHaveText("24", { timeout: 10_000 });
  expect(seen.filter((r) => r.method === "POST" && r.path.startsWith(`/api/demo/${DEMO_ID}/`)).map((r) => r.path.split("/").pop())).toEqual(["fans"]);
});

test("a rate-limited control says so in plain words and the buttons come back", async ({ page }) => {
  const base = demoApi();
  await open(page, (req) => (req.path.endsWith("/fans") ? apiError(429, "rate_limited", "Too many tries. Please wait a moment and try again.") : base(req)));
  await page.locator("#show-a [data-act=add]").click();
  await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
  await expect(page.locator("#show-a [data-act=add]")).toBeEnabled();
  await expect(page.locator("#pace")).toBeEnabled();
});

test("a payout that failed is named plainly on the demo", async ({ page }) => {
  await open(page, demoApi("failed"));
  await page.locator("#show-a [data-act=add]").click();
  await expect(fans(page, "a")).toHaveText("34", { timeout: 15_000 });
  await page.locator("#show-a [data-act=ff]").click();
  await expect(page.locator("#show-a [data-word]")).toHaveText("A payout didn’t go through", { timeout: 20_000 });
  await expect(page.locator("#show-a [data-fans-sub]")).toHaveText("A payout didn’t go through");
  await expect(page.locator("#show-a [data-money-sub]")).toHaveText("Sent in one PayPal batch. One payout didn’t go through.");
  await expect(page.locator("#show-a [data-word]")).not.toHaveText("Payouts sent");
});

test("polling: a lost demo copy gets a fresh pair, and a refusal is not hammered", async ({ page }) => {
  const base = demoApi();
  let gone = false, refuse = false;
  const api: FakeApi = (req) => {
    if (gone && req.method === "GET" && req.path === `/api/shows/${DEMO_ID}a`) return apiError(404, "not_found", "There's nothing here.");
    if (refuse && req.method === "POST" && req.path === "/api/demo") return apiError(429, "rate_limited", "Too many tries. Please wait a moment and try again.", { retryAfterSec: 30 });
    return base(req);
  };
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}?e2e`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  const demoPosts = () => seen.filter((r) => r.method === "POST" && r.path === "/api/demo").length;
  expect(demoPosts()).toBe(1);
  gone = true;
  await expect.poll(demoPosts, { timeout: 10_000 }).toBe(2);
  await expect(page.locator("[data-judge-msg]")).toHaveText("That demo copy has ended, so here is a fresh pair of sample shows.");
  refuse = true;
  await expect.poll(demoPosts, { timeout: 10_000 }).toBe(3);
  await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
  await page.waitForTimeout(12_000);
  expect(demoPosts()).toBe(3);
});

test("polling: an older or equal answer does not move a demo show; a newer one applies", async ({ page }) => {
  const base = demoApi();
  const first = base({ method: "GET", path: `/api/shows/${DEMO_ID}a`, body: null, key: null })!.body as PublicShow;
  let polled: PublicShow | null = null;
  const api: FakeApi = (req) => (polled && req.method === "GET" && req.path === `/api/shows/${DEMO_ID}a` ? { body: polled } : base(req));
  await installFakeApi(page, api);
  await page.goto(`${APP_BASE}?e2e`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  await expect(fans(page, "a")).toHaveText("29");
  polled = { ...first, fans: { ...first.fans, committed: 5 }, version: "e0.l0" };
  await page.waitForTimeout(9_000);
  await expect(fans(page, "a")).toHaveText("29");
  polled = { ...first, fans: { ...first.fans, committed: 31 }, version: "e90.l90" };
  await expect(fans(page, "a")).toHaveText("31", { timeout: 15_000 });
});
