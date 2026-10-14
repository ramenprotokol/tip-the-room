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

test.describe("Check pace now waits for the starting fans", () => {
  const HINT = "Ready once the starting fans are seated (about a minute).";
  /** A fresh copy that starts with few fans seated. `seated.now` is the server finishing the job: later answers carry the full starting fans. */
  function fillingApi(seated = { now: false }): FakeApi {
    const base = demoApi();
    return (req) => {
      const r = base(req);
      if (!r || seated.now) return r;
      const isDemo = req.method === "POST" && (req.path === "/api/demo" || req.path.endsWith("/reset"));
      const isShow = req.method === "GET" && /^\/api\/shows\/dparityfixt[ab]$/.test(req.path);
      if (!isDemo && !isShow) return r;
      const body = structuredClone(r.body) as { shows?: PublicShow[] } & PublicShow;
      const few = (s: PublicShow) => { s.fans.committed = s.showId.endsWith("a") ? 10 : 4; s.version = "e0.l0"; };
      if (isDemo) body.shows!.forEach(few); else few(body);
      return { ...r, body };
    };
  }
  const pace = (page: Page) => page.locator("#pace");
  const hint = (page: Page) => page.locator("#pace-hint");

  test("is disabled with its hint while the shows fill, and enabled once both reach their starting fans", async ({ page }) => {
    const seated = { now: false };
    await open(page, fillingApi(seated), "");
    await expect(page.locator("#setup")).toBeVisible();
    await expect(pace(page)).toBeDisabled();
    await expect(hint(page)).toHaveText(HINT);
    await expect(hint(page)).toBeVisible();
    seated.now = true;
    await expect(pace(page)).toBeEnabled({ timeout: 25_000 });
    await expect(hint(page)).toBeHidden();
    await expect(page.locator("#setup")).toBeHidden();
    await pace(page).click();
    await expect(page.locator("[data-judge-msg]")).toContainText("The agent checked the pace.");
  });

  test("unlocks by itself after 3 minutes, however many fans are seated", async ({ page }) => {
    await page.clock.install();
    await open(page, fillingApi(), "?e2e=quiet");
    await expect(pace(page)).toBeDisabled();
    await page.clock.fastForward(170_000);
    await expect(pace(page)).toBeDisabled();
    await page.clock.fastForward(15_000);
    await expect(pace(page)).toBeEnabled();
    await expect(hint(page)).toBeHidden();
    await expect(page.locator("#setup")).toBeHidden();
  });

  test("a reused, already-seated copy never locks it", async ({ page }) => {
    await page.addInitScript((v) => { if (!localStorage.getItem("ttr:demo")) localStorage.setItem("ttr:demo", JSON.stringify(v)); }, { demoId: DEMO_ID, demoKey: "demo-key-fixture", expiresAt: Date.now() + 86_400_000 });
    await open(page, fillingApi());
    await expect(pace(page)).toBeEnabled();
    await expect(hint(page)).toBeHidden();
  });

  test("Start over locks it again for the new copy, and the label comes back after Working…", async ({ page }) => {
    const seated = { now: true };
    await open(page, fillingApi(seated), "?e2e=quiet");
    await expect(pace(page)).toBeEnabled();
    seated.now = false;
    await page.locator("#show-a [data-act=reset]").click();
    await expect(pace(page)).toBeDisabled();
    await expect(pace(page)).toHaveText("Check pace now");
    await expect(hint(page)).toBeVisible();
  });

  test("the hint and the lock are off in the pixel-comparison mode", async ({ page }) => {
    await open(page, fillingApi(), "?e2e=parity");
    await expect(pace(page)).toBeEnabled();
    await expect(hint(page)).toBeHidden();
  });
});

test.describe("a calm confirmation once the artist has approved a change", () => {
  const B_ID = `${DEMO_ID}b`;
  const CONFIRM = "The artist approved “Extend 7 days”. Marlow Finch’s agent applied it.";
  type Mode = "none" | "open" | "approved" | "openOverOlderApproved";
  /** What show B's view says about its proposals; the demo fake supplies the real question after Check pace now. */
  function modeApi(state: { mode: Mode }): FakeApi {
    const base = demoApi();
    return (req) => {
      const r = base(req);
      if (!r || req.method !== "GET" || state.mode === "none") return r;
      if (req.path === `/api/shows/${B_ID}`) return { ...r, body: { ...(r.body as PublicShow), version: `e${70 + state.mode.length}.l${70 + state.mode.length}` } }; // the poll sees a newer show
      if (req.path !== `/api/shows/${B_ID}/manage`) return r;
      const body = structuredClone(r.body) as ManageView;
      const q = body.proposals[0];
      if (!q) return r; // no question yet
      if (state.mode === "approved") q.approved = "extend";
      if (state.mode === "openOverOlderApproved") body.proposals.push({ ...q, proposalId: "older", approved: "extend" });
      body.version = `e${70 + state.mode.length}.l${70 + state.mode.length}`;
      body.show.version = body.version;
      return { ...r, body };
    };
  }
  const card = (page: Page) => page.locator("#show-b [data-ask-done]");
  const step2 = (page: Page) => page.locator("#judge [data-judge-done]");
  const red = (page: Page) => page.locator("#show-b [data-ask-pointer]");
  async function askAndReload(page: Page, state: { mode: Mode }, mode: Mode) {
    await open(page, modeApi(state));
    await page.locator("#pace").click();
    await expect(red(page)).toBeVisible();
    state.mode = mode;
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  }

  test("approved: the confirmation is on the card and in step 2, live and after a reload, and the red pointer is gone", async ({ page }) => {
    const state = { mode: "none" as Mode };
    await open(page, modeApi(state));
    await page.locator("#pace").click();
    await expect(red(page)).toBeVisible();
    await expect(card(page)).toBeHidden();
    state.mode = "approved";
    await expect(card(page)).toHaveText(CONFIRM, { timeout: 25_000 });
    await expect(step2(page)).toContainText(CONFIRM);
    await expect(red(page)).toBeHidden();
    await expect(page.locator("#show-a [data-ask-done]")).toBeHidden();
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(card(page)).toHaveText(CONFIRM);
    await expect(step2(page)).toContainText(CONFIRM);
    await expect(red(page)).toBeHidden();
  });

  test("an open question shows the red pointer and no confirmation", async ({ page }) => {
    await open(page, modeApi({ mode: "open" }));
    await page.locator("#pace").click();
    await expect(red(page)).toBeVisible();
    await expect(card(page)).toBeHidden();
    await expect(step2(page)).toBeHidden();
  });

  test("an open question wins over an older approved one", async ({ page }) => {
    const state = { mode: "none" as Mode };
    await askAndReload(page, state, "openOverOlderApproved");
    await expect(red(page)).toBeVisible();
    await expect(card(page)).toBeHidden();
    await expect(step2(page)).toBeHidden();
  });

  test("with no question at all neither shows", async ({ page }) => {
    await open(page, demoApi());
    await expect(red(page)).toBeHidden();
    await expect(card(page)).toBeHidden();
    await expect(step2(page)).toBeHidden();
    await expect(page.locator("#show-a [data-ask-done]")).toBeHidden();
  });

  test("not in the pixel-comparison mode", async ({ page }) => {
    const state = { mode: "approved" as Mode };
    await open(page, modeApi(state), "?e2e=parity");
    await page.locator("#pace").click();
    await expect(page.locator("[data-judge-msg]")).toContainText("The agent checked the pace.");
    await expect(card(page)).toBeHidden();
    await expect(step2(page)).toBeHidden();
  });
});

test.describe("a show that ended without paying out keeps its fan count after a reload", () => {
  const MARLOW = { showId: `${DEMO_ID}b`, showName: "Marlow Finch", roomName: "Elm St house", showDate: "2026-11-22", price: 1200, threshold: 28, deadline: Date.UTC(2026, 10, 20, 18), launchedAt: Date.UTC(2026, 10, 15, 12), now: Date.UTC(2026, 10, 20, 18, 5), split: [{ role: "room" as const, label: "Elm St house", fixedCents: 6000, minimumCents: null }, { role: "opener" as const, label: "The opener", fixedCents: 4000, minimumCents: null }, { role: "artist" as const, label: "Marlow Finch", fixedCents: null, minimumCents: 22000 }] };
  /** The demo fake with show B replaced by an ended show the way the server reports it: nothing held or charged any more. */
  function endedApi(state: "missed" | "cancelled", extra: Partial<PublicShow["fans"]> = {}): FakeApi {
    const base = demoApi();
    const ended = { ...showOf(MARLOW, { fans: 19, state, threshold: 25, version: 9 }) };
    ended.fans = { ...ended.fans, ...extra };
    return (req) => {
      if (req.method === "GET" && req.path === `/api/shows/${MARLOW.showId}`) return { body: ended };
      if (req.method === "GET" && req.path === `/api/shows/${MARLOW.showId}/manage`) { const v = base(req); return v && { ...v, body: { ...(v.body as ManageView), show: ended, version: ended.version } }; }
      return base(req);
    };
  }
  const saved = (page: Page) => page.addInitScript((v) => localStorage.setItem("ttr:demo", JSON.stringify(v)), { demoId: DEMO_ID, demoKey: "demo-key-fixture", expiresAt: Date.now() + 86_400_000 });
  const b = (page: Page, sel: string) => page.locator(`#show-b ${sel}`);

  test("home page: a missed show reads 19 of 25 fans, 6 short, $228 released back to 19 fans", async ({ page }) => {
    await saved(page);
    await open(page, endedApi("missed"), "?e2e=quiet");
    await expect(b(page, "[data-fans] .sr")).toHaveText("19");
    await expect(b(page, "[data-of]")).toHaveText("of 25 fans");
    await expect(b(page, "[data-fans-sub]")).toHaveText("Called off · 6 short");
    await expect(b(page, "[data-money-sub]")).toHaveText("$228 released back to 19 fans · nobody paid");
  });

  test("home page: a show called off after the tip keeps its count and its refund wording", async ({ page }) => {
    await saved(page);
    await open(page, endedApi("cancelled", { refunded: 19, charged: 0, released: 0 }), "?e2e=quiet");
    await expect(b(page, "[data-fans] .sr")).toHaveText("19");
    await expect(b(page, "[data-fans-sub]")).toHaveText("Called off · refunding");
    await expect(b(page, "[data-money-sub]")).toHaveText("Called off. Every fan who was charged is getting $12 back.");
  });

  test("home page: a refund still in progress counts the charged and the refunded together", async ({ page }) => {
    await saved(page);
    await open(page, endedApi("cancelled", { refunded: 14, charged: 5, committed: 5, released: 0 }), "?e2e=quiet");
    await expect(b(page, "[data-fans] .sr")).toHaveText("19");
  });

  test("home page: live, tipped and paid shows are unchanged", async ({ page }) => {
    await saved(page);
    await open(page, demoApi(), "?e2e=quiet");
    await expect(page.locator("#show-a [data-fans] .sr")).toHaveText("29");
    await expect(page.locator("#show-b [data-fans] .sr")).toHaveText("19");
    await expect(page.locator("#show-a [data-fans-sub]")).toHaveText("5 more to make it happen");
  });

  test("the artist's show page and the fan page read the same for a missed show", async ({ page }) => {
    const ended = showOf({ ...MAYA, showId: MAYA_ID }, { fans: 12, state: "missed", threshold: 21, version: 9 });
    expect(ended.fans.committed).toBe(0);
    await installFakeApi(page, manageApi([{ ...MANAGE_FRAMES.initial, show: ended, version: ended.version, proposals: [] }]));
    await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e#${MAYA_KEY}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(page.locator("[data-fans] .sr")).toHaveText("12");
    await expect(page.locator("[data-fans-sub]")).toHaveText("Called off · 9 short");
    await expect(page.locator("[data-sentence]")).toContainText("Called off. Every hold was cancel");
    const fan = await page.context().newPage();
    await installFakeApi(fan, pledgeApi({ show: ended }));
    await fan.goto(`${APP_BASE}s/${MAYA_ID}?e2e`);
    await expect(fan.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(fan.locator("[data-fans] .sr")).toHaveText("12");
    await expect(fan.locator("[data-fans-sub]")).toHaveText("Called off · 9 short");
  });
});
