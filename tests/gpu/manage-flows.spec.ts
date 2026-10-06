import { expect, test, type Page } from "@playwright/test";
import type { ManageView } from "../../src/worker/api-types";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MANAGE_FRAMES, MANAGE_SCRIPTS, manageApi, MAYA, MAYA_ID, MAYA_KEY, mayaParties, showOf } from "./fixtures";
import { APP_BASE } from "./parity";

const XSS = `<img src=x onerror="window.__xss=1">`;
async function open(page: Page, api: FakeApi, hash = `#${MAYA_KEY}`) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e${hash}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const holdSpace = async (page: Page, selector: string) => {
  await page.locator(selector).focus();
  await page.keyboard.down(" ");
  await page.waitForTimeout(1800);
  await page.keyboard.up(" ");
};

test("without the private link the page explains what to do", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped), "");
  await expect(page.locator("#manage-notice")).toHaveText("This page needs your private link, the one you saved when you signed. Open that link to see your show.");
});

test("a wrong private link is refused in plain words", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped), "#not-the-right-key");
  await expect(page.locator("#manage-notice")).toHaveText("That private link doesn’t match this show. Open the link you saved when you signed.");
});

test("the key from the link is kept in the browser and removed from the address bar", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped));
  expect(await page.evaluate(() => location.hash)).toBe("");
  expect(await page.evaluate((id) => localStorage.getItem(`ttr:manage:${id}`), MAYA_ID)).toBe(MAYA_KEY);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#manage-notice")).toBeHidden();
  await expect(page.locator("h1.title")).toHaveText("Acoustic Set");
});

test("every backend string is shown as text: log, proposal, attention, ledger", async ({ page }) => {
  const f = MANAGE_FRAMES.initial;
  const bad: ManageView = {
    ...f,
    log: [{ ...f.log[0], seq: 99, did: XSS, saw: XSS }, ...f.log],
    proposals: [{ ...f.proposals[0], explanation: XSS }],
    attention: [XSS],
    ledger: [{ seq: 1, at: f.now, what: XSS, who: XSS, amountCents: 1500, ref: XSS, status: "On hold" }],
  };
  await open(page, manageApi([bad]));
  await expect(page.locator("#log")).toContainText(XSS);
  await expect(page.locator("#ask-explain")).toHaveText(XSS);
  await expect(page.locator("#attention")).toHaveText(XSS);
  await expect(page.locator("#ledger")).toContainText(XSS);
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("the other option is offered too, and a refused approval says why and resets the button", async ({ page }) => {
  const two: ManageView = { ...MANAGE_FRAMES.initial, proposals: [{ ...MANAGE_FRAMES.initial.proposals[0], options: [...MANAGE_FRAMES.initial.proposals[0].options, { id: "lower", label: "Lower the target to 17", newDeadline: null, newThreshold: 17 }] }] };
  const base = manageApi([two]);
  await open(page, (req) => (req.path.endsWith("/approve") ? apiError(409, "conflict", "That change can't be applied any more.") : base(req)));
  await expect(page.locator("#ask-alt button")).toHaveText("Or: Lower the target to 17");
  await expect(page.locator("#ask-q b")).toHaveText("Extend the deadline 4 days, to Mon Nov 16, 6pm?");
  await holdSpace(page, "#approve");
  await expect(page.locator("[data-ask-msg]")).toHaveText("That change can't be applied any more.");
  await expect(page.locator("[data-approve-label]")).toHaveText("Hold to approve");
});

test("Not now records it on the server and keeps the card hidden after a reload", async ({ page }) => {
  const seen = await open(page, manageApi(MANAGE_SCRIPTS.calledOff));
  await page.click("#decline");
  await expect(page.locator("#ask")).toBeHidden();
  await expect(page.locator("#log")).toContainText("You said not now.");
  expect(seen.some((r) => r.path === `/api/shows/${MAYA_ID}/proposals/pace1/decline`)).toBe(true);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#ask")).toBeHidden();
});

test("a tipped show can be called off with a hold", async ({ page }) => {
  const cancelled: ManageView = { ...MANAGE_FRAMES.tipped, show: showOf(MAYA, { fans: 21, state: "cancelled", version: 9 }), version: "e9.l9" };
  const seen = await open(page, manageApi([MANAGE_FRAMES.tipped, cancelled]));
  await expect(page.locator("#calloff")).toBeVisible();
  await holdSpace(page, "#calloff-btn");
  await expect(page.locator("[data-word]")).toHaveText("Called off", { timeout: 15_000 });
  expect(seen.some((r) => r.path === `/api/shows/${MAYA_ID}/call-off`)).toBe(true);
  await expect(page.locator("#calloff")).toBeHidden();
});

test("attention lines and unconfirmed payouts are said honestly", async ({ page }) => {
  const pending: ManageView = { ...MANAGE_FRAMES.paid, parties: mayaParties("pending", true), attention: ["The payout couldn't be sent. It's waiting for your OK."] };
  await open(page, manageApi([pending]));
  await expect(page.locator("#attention")).toHaveText("The payout couldn't be sent. It's waiting for your OK.");
  await expect(page.locator("[data-word]")).toHaveText("Payouts sent");
  await expect(page.locator("[data-sentence]")).toContainText("PayPal is still confirming them.");
});

test("a failed payout is named plainly, never called \"still confirming\"", async ({ page }) => {
  const parties = mayaParties("paid", true).map((p, i) => (i === 1 ? { ...p, payoutStatus: "failed" as const } : p));
  await open(page, manageApi([{ ...MANAGE_FRAMES.paid, parties, attention: ["Maya’s payout didn’t go through."] }]));
  await expect(page.locator("[data-word]")).toHaveText("A payout didn’t go through");
  await expect(page.locator("[data-fans-sub]")).toHaveText("A payout didn’t go through");
  await expect(page.locator("[data-sentence]")).toHaveText("A payout didn’t go through. Lucky’s Café got $100 and you didn’t get $215.");
  await expect(page.locator("[data-sentence]")).not.toContainText("confirming");
});

test("before anything is sent the page says paying, not payouts sent", async ({ page }) => {
  const planned: ManageView = { ...MANAGE_FRAMES.paid, show: showOf(MAYA, { fans: 21, state: "paying_out", version: 6 }), parties: mayaParties("planned", false) };
  await open(page, manageApi([planned]));
  await expect(page.locator("[data-word]")).toHaveText("Paying everyone");
  await expect(page.locator("[data-fans-sub]")).toHaveText("Paying everyone");
  await expect(page.locator("[data-sentence]")).toContainText("Paying everyone:");
  await expect(page.locator("[data-sentence]")).not.toContainText("Payouts sent");
});

test("a refused Not now keeps the card and says why", async ({ page }) => {
  const base = manageApi(MANAGE_SCRIPTS.calledOff);
  const seen = await open(page, (req) => (req.path.endsWith("/decline") ? apiError(500, "internal", "Something went wrong on our side.") : base(req)));
  await page.click("#decline");
  await expect(page.locator("[data-ask-msg]")).toHaveText("Something went wrong on our side.");
  await expect(page.locator("#ask")).toBeVisible();
  expect(seen.some((r) => r.path.endsWith("/decline"))).toBe(true);
  await expect(page.locator("#decline")).toBeEnabled();
});

test("any fragment, even one that isn't a key, is removed from the address bar", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped), "#oops!");
  expect(await page.evaluate(() => location.hash)).toBe("");
  await expect(page.locator("#manage-notice")).toHaveText("This page needs your private link, the one you saved when you signed. Open that link to see your show.");
});

test("the ledger is the AG Grid with every money move and a CSV button", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped));
  await expect(page.locator("[data-note]")).toHaveText("Newest first. Sort or filter any column.");
  await expect(page.locator("#ledger .ag-row").first()).toBeVisible();
  await expect(page.locator('#ledger .ag-row[row-index="0"] .ag-cell[col-id="who"]')).toHaveText("Fan 12 · BF");
  await expect(page.locator("#ledger")).toContainText("SAMPLE-AUTH-012");
  await expect(page.locator("#csv")).toBeVisible();
});
