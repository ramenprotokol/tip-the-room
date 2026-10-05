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
