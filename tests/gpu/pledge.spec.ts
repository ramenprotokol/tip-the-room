import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Scenario } from "./parity";

interface PledgeWindow { __marquee: { setInitials(s: string): void; approve(): void } }

// Hook call shapes match reference/v2/pledge.html: setInitials(string) and approve() (no arguments).
const onHold: Scenario = async (f) => {
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.setInitials("MR"));
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.approve());
  await f.run(1500);
};

for (const [slug, scenario, viewport] of [
  ["pledge-initial", async () => {}, DESKTOP],
  ["pledge-on-hold", onHold, DESKTOP],
  ["pledge-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, "pledge.html", "pledge.html", scenario, { viewport, fullPage: true, slug });
  });
}
