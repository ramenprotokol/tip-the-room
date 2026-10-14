// Three rough edges on the demo page: the sign's payout plates and the payout box follow the real payout state, the home
// feed shows the artist's approval, and "Check pace now" waits for the starting fans.
import { expect, test, type Page } from "@playwright/test";
import type { ManageParty, ManageView, PublicShow } from "../../src/worker/api-types";
import { installFakeApi, type FakeApi } from "./fake-api";
import { DEMO_ID, MANAGE_FRAMES, MAYA, MAYA_ID, MAYA_KEY, demoApi, manageApi, mayaParties, pledgeApi, showOf } from "./fixtures";
import { APP_BASE } from "./parity";

type Payout = ManageParty["payoutStatus"];
const A_ID = `${DEMO_ID}a`;

async function open(page: Page, api: FakeApi, query = "", base = APP_BASE) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${base}${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const word = (page: Page) => page.locator("#show-a [data-word]");
const plates = (page: Page) => page.evaluate(() => (window as unknown as { __marquee: { views: { smalls: { word: string }[] }[] } }).__marquee.views[0].smalls.map((s) => s.word));
const stageLabel = (page: Page) => page.locator("#show-a [data-stage]").getAttribute("aria-label");

test.describe("the payout plates say what the payout is really doing", () => {
  /** Once show A has ended, its payouts are in whatever state `state.status` says; each change bumps the version so the page re-reads. */
  function payingApi() {
    const state = { status: "planned" as Payout, bump: 0 };
    const base = demoApi("planned");
    const api: FakeApi = (req) => {
      const r = base(req);
      if (!r || req.method !== "GET" || !(req.path === `/api/shows/${A_ID}` || req.path === `/api/shows/${A_ID}/manage`)) return r;
      const body = structuredClone(r.body) as PublicShow & ManageView;
      const show = req.path.endsWith("/manage") ? body.show : body;
      if (show.state !== "settled") return r;
      const v = `e${50 + state.bump}.l${50 + state.bump}`;
      show.version = v;
      if (req.path.endsWith("/manage")) { body.version = v; body.parties.forEach((p) => { p.payoutStatus = state.status; }); }
      return { ...r, body };
    };
    return { api, state };
  }
  async function skipA(page: Page) {
    await page.locator("#show-a [data-act=add]").click();
    await expect(page.locator("#show-a [data-act=add]")).toBeEnabled({ timeout: 15_000 });
    await expect(word(page)).toHaveText("It’s on!", { timeout: 15_000 });
    await page.locator("#show-a [data-act=ff]").click();
    await expect(word(page)).not.toHaveText("It’s on!", { timeout: 20_000 });
  }

  test("PAYING while the payouts are planned, then SENT, then PAID, on the plates, the sign's description, the card and the box", async ({ page }) => {
    const { api, state } = payingApi();
    await open(page, api);
    await skipA(page);
    await expect(word(page)).toHaveText("Paying everyone", { timeout: 20_000 });
    await expect.poll(() => plates(page)).toEqual(["PAYING", "PAYING", "PAYING"]);
    await expect.poll(() => stageLabel(page), { timeout: 20_000 }).toContain("nothing has been sent yet");
    expect(await stageLabel(page)).not.toContain("everyone has been paid");
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Planned", "Planned", "Planned"]);

    state.status = "pending"; state.bump = 1;
    await expect(word(page)).toHaveText("Payouts sent", { timeout: 20_000 });
    await expect.poll(() => plates(page), { timeout: 20_000 }).toEqual(["SENT", "SENT", "SENT"]);
    await expect.poll(() => stageLabel(page), { timeout: 20_000 }).toContain("PayPal is confirming");
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Sent", "Sent", "Sent"]);

    state.status = "paid"; state.bump = 2;
    await expect(word(page)).toHaveText("Everyone’s paid", { timeout: 20_000 });
    await expect.poll(() => plates(page), { timeout: 20_000 }).toEqual(["PAID", "PAID", "PAID"]);
    await expect.poll(() => stageLabel(page), { timeout: 20_000 }).toContain("everyone has been paid");
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Paid", "Paid", "Paid"]);
  });

  test("a failed payout says FAILED on the plates and in the sign's description", async ({ page }) => {
    const base = demoApi("failed");
    await open(page, base);
    await skipA(page);
    await expect(word(page)).toHaveText("A payout didn’t go through", { timeout: 20_000 });
    await expect.poll(() => plates(page)).toEqual(["FAILED", "FAILED", "FAILED"]);
    await expect.poll(() => stageLabel(page), { timeout: 20_000 }).toContain("a payout did not go through");
  });

  test("a reload while the payouts are still planned fills the payout box, not its before-the-show text", async ({ page }) => {
    const { api } = payingApi();
    await open(page, api);
    await skipA(page);
    await expect(word(page)).toHaveText("Paying everyone", { timeout: 20_000 });
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(word(page)).toHaveText("Paying everyone");
    await expect(page.locator("#payout [data-pay-note]")).toContainText("One PayPal payout, in money-rule order");
    await expect(page.locator("#payout [data-pay-note]")).not.toContainText("Fills at the deadline");
    await expect(page.locator("#payout [data-tag]")).toHaveText(["Planned", "Planned", "Planned"]);
    await expect(page.locator("#payout [data-amt] .sr").first()).not.toHaveText("0");
    await expect.poll(() => plates(page)).toEqual(["PAYING", "PAYING", "PAYING"]);
  });

  test("the legend under the page says the payouts, not everyone's paid", async ({ page }) => {
    await open(page, demoApi());
    await expect(page.locator(".key")).toContainText("Signs drop below = the payouts");
    await expect(page.locator(".key")).not.toContainText("everyone's paid");
  });

  test("in the pixel-comparison mode the legend and the plates keep the reference's words", async ({ page }) => {
    await open(page, demoApi(), "?e2e=parity");
    await expect(page.locator(".key")).toContainText("Signs drop below = everyone's paid");
    expect(await plates(page)).toEqual(["PAID", "PAID", "PAID"]);
  });
});

test.describe("the same words on the artist's page and the fan page", () => {
  const manageWith = async (page: Page, status: Payout, state: "paying_out" | "settled") => {
    const frame = { ...MANAGE_FRAMES.paid, show: showOf(MAYA, { fans: 21, state, version: 7 }), version: "e7.l7", parties: mayaParties(status, true) };
    await installFakeApi(page, manageApi([frame]));
    await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e#${MAYA_KEY}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  };
  const okPlates = (page: Page) => plates(page);

  for (const [status, state, expected, sentence] of [["planned", "paying_out", "PAYING", "nothing has been sent yet"], ["pending", "settled", "SENT", "PayPal is confirming"], ["paid", "settled", "PAID", "everyone has been paid"]] as const) {
    test(`the show page's plates say ${expected} while the payouts are ${status}`, async ({ page }) => {
      await manageWith(page, status, state);
      await expect.poll(() => okPlates(page)).toEqual([expected, expected]);
      await expect.poll(() => page.locator("[data-stage]").getAttribute("aria-label")).toContain(sentence);
      await expect(page.locator(".key")).toContainText("Signs drop below = the payouts");
    });
  }

  test("the show page's plates follow a payout that changes from planned to sent", async ({ page }) => {
    const planned = { ...MANAGE_FRAMES.paid, show: showOf(MAYA, { fans: 21, state: "paying_out", version: 7 }), version: "e7.l7", parties: mayaParties("planned", true) };
    const sent = { ...MANAGE_FRAMES.paid, show: showOf(MAYA, { fans: 21, state: "settled", version: 8 }), version: "e8.l8", parties: mayaParties("pending", true) };
    let current = planned;
    const base = `/api/shows/${MAYA_ID}`;
    await installFakeApi(page, (req) => (req.method === "GET" && req.path === `${base}/manage` ? { body: current } : req.method === "GET" && req.path === base ? { body: current.show } : undefined));
    await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e#${MAYA_KEY}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect.poll(() => plates(page)).toEqual(["PAYING", "PAYING"]);
    current = sent;
    await expect.poll(() => plates(page), { timeout: 30_000 }).toEqual(["SENT", "SENT"]);
  });

  for (const [state, expected] of [["paying_out", "PAYING"], ["settled", "SENT"]] as const) {
    test(`the fan page's plates say ${expected} when the show is ${state}, never PAID`, async ({ page }) => {
      await installFakeApi(page, pledgeApi({ show: showOf(MAYA, { fans: 21, state }) }));
      await page.goto(`${APP_BASE}s/${MAYA_ID}?e2e`);
      await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
      await expect.poll(() => plates(page)).toEqual([expected, expected]);
    });
  }
});

test.describe("the home feed shows the artist's approval", () => {
  const B_ID = `${DEMO_ID}b`;
  const LINE = "The artist approved \"Extend 7 days\". The artist approved this extension.";
  /** After "Check pace now" show B has a question; `state.approved` is the artist answering it on the show page. */
  function approvingApi() {
    const state = { approved: false };
    const base = demoApi();
    const api: FakeApi = (req) => {
      const r = base(req);
      if (!state.approved || !r || req.method !== "GET" || !(req.path === `/api/shows/${B_ID}` || req.path === `/api/shows/${B_ID}/manage`)) return r;
      const body = structuredClone(r.body) as PublicShow & ManageView;
      const show = req.path.endsWith("/manage") ? body.show : body;
      show.version = "e90.l90";
      if (req.path.endsWith("/manage")) {
        body.version = "e90.l90";
        body.log.unshift({ seq: 90, at: Date.UTC(2026, 10, 17, 9, 0), saw: "19 of 28 fans", did: LINE, rule: "rule-5-ask-first", requestId: null, resultId: null, source: "template" });
        body.proposals.forEach((p) => { p.approved = "extend"; });
      }
      return { ...r, body };
    };
    return { api, state };
  }
  const feed = (page: Page) => page.locator("#log li");

  test("appears live, while the page is open, once the artist has answered", async ({ page }) => {
    const { api, state } = approvingApi();
    await open(page, api);
    await page.locator("#pace").click();
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeVisible();
    state.approved = true;
    await expect(feed(page).filter({ hasText: LINE })).toHaveCount(1, { timeout: 25_000 });
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeHidden();
  });

  test("is still there after a reload", async ({ page }) => {
    const { api, state } = approvingApi();
    await open(page, api);
    await page.locator("#pace").click();
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeVisible();
    state.approved = true;
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(feed(page).filter({ hasText: LINE })).toHaveCount(1);
    await expect(page.locator("#log li").filter({ hasText: "Proposed: Extend 7 days" })).toHaveCount(1);
  });
});
