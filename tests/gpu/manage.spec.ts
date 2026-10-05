import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, type Frozen, type Scenario } from "./parity";

interface ManageHooks { approve(): void; addFans(n: number): void; skip(): void; reset(): void; decline(): void }
type ManageWindow = { __marquee: ManageHooks };

const approve = (f: Frozen) => f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.approve());
const decline = (f: Frozen) => f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.decline());
const addFans = (f: Frozen, n: number) => f.page.evaluate((count) => (window as unknown as ManageWindow).__marquee.addFans(count), n);
const skip = (f: Frozen) => f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.skip());

const tipped: Scenario = async (f) => {
  await approve(f);
  await f.run(800);
  await addFans(f, 5);
  await f.run(1800);
  await addFans(f, 5);
  await f.run(6700);
};
const paid: Scenario = async (f) => {
  await tipped(f);
  await skip(f);
  await f.run(4450);
};
const calledOff: Scenario = async (f) => {
  await decline(f);
  await skip(f);
  await f.run(4850);
};

for (const [slug, scenario, viewport] of [
  ["manage-initial", async () => {}, DESKTOP],
  ["manage-tipped", tipped, DESKTOP],
  ["manage-paid", paid, DESKTOP],
  ["manage-called-off", calledOff, DESKTOP],
  ["manage-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, "manage.html", "manage.html", scenario, { viewport, fullPage: true, slug });
  });
}
