import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MAYA_ID, MAYA_KEY, startApi } from "./fixtures";
import { APP_BASE } from "./parity";

async function open(page: Page, api: FakeApi) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}start?e2e`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
async function fillDraft(page: Page) {
  await page.click("#fill");
  await expect(page.locator("#draft")).toBeVisible();
  await page.fill("#mail-0", "luckys-cafe@example.com");
  await page.fill("#mail-3", "maya@example.com");
}
const sign = (page: Page) => page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());

test("signing sends the edited draft, then shows the share link and the private link once, and keeps the key", async ({ page }) => {
  const seen = await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-name", "Late Set");
  await sign(page);
  await expect(page.locator("#live")).toBeVisible();
  const body = seen.find((r) => r.path.endsWith("/sign"))?.body as { signToken: string; draft: { showName: string; showDate: string; deadline: string; parties: { role: string; paypalEmail: string }[] } };
  expect(body.signToken).toBe("sign-token-fixture-0123456789");
  expect(body.draft.showName).toBe("Late Set");
  expect([body.draft.showDate, body.draft.deadline]).toEqual(["2026-11-20", "2026-11-12T18:00:00.000Z"]);
  expect(body.draft.parties.map((p) => [p.role, p.paypalEmail])).toEqual([["room", "luckys-cafe@example.com"], ["artist", "maya@example.com"]]);
  await expect(page.locator("#share-url")).toHaveText(`https://tiptheroom.example/s/${MAYA_ID}`);
  await expect(page.locator("#manage-url")).toHaveText(`https://tiptheroom.example/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  await expect(page.locator("#open-manage")).toHaveAttribute("href", `/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  expect(await page.evaluate((id) => localStorage.getItem(`ttr:manage:${id}`), MAYA_ID)).toBe(MAYA_KEY);
});

test("typed values are shown as text, never as markup", async ({ page }) => {
  await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-room", `<img src=x onerror="window.__xss=1">`);
  await expect(page.locator("[data-split]")).toContainText(`<img src=x onerror="window.__xss=1"> gets $100`);
  await expect(page.locator("#rules")).toContainText(`<img src=x onerror="window.__xss=1"> is paid $100`);
  expect(await page.locator("#rules img, [data-split] img, #paylist img").count()).toBe(0);
  expect(await page.locator("#rules b").count()).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("the server's problems are listed and the sign button resets", async ({ page }) => {
  await open(page, startApi({ sign: apiError(422, "invalid", "Please check the draft.", { problems: ["The deadline must be within 21 days of launch."] }) }));
  await fillDraft(page);
  await sign(page);
  await expect(page.locator("[data-start-msg]")).toHaveText("Please check the draft.");
  await expect(page.locator("#problems")).toHaveText("The deadline must be within 21 days of launch.");
  await expect(page.locator("[data-sign-label]")).toHaveText("Hold to sign the money rules");
  await expect(page.locator("#live")).toBeHidden();
});

test("an unreadable date is caught before anything is sent", async ({ page }) => {
  const seen = await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-date", "someday");
  await sign(page);
  await expect(page.locator("#problems")).toHaveText("Write the show date like Fri Nov 20.");
  expect(seen.some((r) => r.path.endsWith("/sign"))).toBe(false);
});

test("a refused sentence is explained in plain words", async ({ page }) => {
  await open(page, startApi({ create: apiError(422, "invalid", "Describe the show in one sentence (5 to 500 characters).") }));
  await page.fill("#sentence", "hi");
  await page.click("#fill");
  await expect(page.locator("[data-start-msg]")).toHaveText("Describe the show in one sentence (5 to 500 characters).");
  await expect(page.locator("#draft")).toBeHidden();
});

test("the real start page doesn't call itself a sample", async ({ page }) => {
  await open(page, startApi());
  await expect(page.locator(".mode")).toHaveText("Start a show");
});
