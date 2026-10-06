import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

const P = PAGES.demo;
const press = async (f: Parameters<Scenario>[0], key: string) => {
  await f.page.keyboard.press(key);
  await settle(f.page);
};
const tipTo = (t: number): Scenario => async (f) => {
  await press(f, "t");
  await f.run(1700);
  await f.toAnim(0, t);
};
const payoutTo = (t: number): Scenario => async (f) => {
  await press(f, "t");
  await f.run(1700);
  await f.toAnim(0, 4.8);
  await f.run(500);
  await press(f, "p");
  await f.run(1250);
  await f.toAnim(0, t);
};
const missTo = (t: number): Scenario => async (f) => {
  await press(f, "m");
  await f.run(1250);
  await f.toAnim(1, t);
};

const cases: Array<{ slug: string; scenario: Scenario; viewport: typeof DESKTOP; fullPage: boolean }> = [
  { slug: "demo-rest", scenario: async () => {}, viewport: DESKTOP, fullPage: true },
  { slug: "demo-tip-0.7", scenario: tipTo(0.7), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-2.4", scenario: tipTo(2.4), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-3.1", scenario: tipTo(3.1), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-4.8", scenario: tipTo(4.8), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-1.0", scenario: payoutTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-2.6", scenario: payoutTo(2.6), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-1.0", scenario: missTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-3.2", scenario: missTo(3.2), viewport: DESKTOP, fullPage: true },
  { slug: "demo-phone-rest", scenario: async () => {}, viewport: PHONE, fullPage: true },
];

for (const c of cases) {
  test(`parity: ${c.slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, c.scenario, { viewport: c.viewport, fullPage: c.fullPage, slug: c.slug, api: P.api, dataFields: P.dataFields, skip: P.skip, appOnly: P.appOnly });
  });
}
