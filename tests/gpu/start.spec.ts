import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

const P = PAGES.start;
const filled: Scenario = async (f) => {
  await f.page.click("#fill");
  await settle(f.page);
  await f.run(900);
};
const live: Scenario = async (f) => {
  await filled(f);
  await f.page.evaluate(() => (window as unknown as { __marquee: { setEmails(): void } }).__marquee.setEmails());
  await f.run(400);
  await f.page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());
  await settle(f.page);
  await f.run(1600);
};

for (const [slug, scenario, viewport] of [
  ["start-initial", async () => {}, DESKTOP],
  ["start-filled", filled, DESKTOP],
  ["start-live", live, DESKTOP],
  ["start-phone-filled", filled, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: P.api, dataFields: P.dataFields, skip: P.skip, appOnly: P.appOnly });
  });
}
