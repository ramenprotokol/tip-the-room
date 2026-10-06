import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

interface PledgeWindow { __marquee: { setInitials(s: string): void; approve(): void } }
const P = PAGES.pledge;

// Hook call shapes match reference/v2/pledge.html: setInitials(string) and approve() (no arguments).
const onHold: Scenario = async (f) => {
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.setInitials("MR"));
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.approve());
  await settle(f.page);
  await f.run(1500);
};

for (const [slug, scenario, viewport] of [
  ["pledge-initial", async () => {}, DESKTOP],
  ["pledge-on-hold", onHold, DESKTOP],
  ["pledge-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: P.api, dataFields: P.dataFields, skip: P.skip, appOnly: P.appOnly });
  });
}
