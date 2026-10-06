import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Frozen, type Scenario } from "./parity";
import { MANAGE_SCRIPTS, manageApi } from "./fixtures";
import { PAGES } from "./pages";

interface ManageHooks { approve(): void; addFans(n: number): void; skip(): void; reset(): void; decline(): void }
type ManageWindow = { __marquee: ManageHooks };
const P = PAGES.manage;

const approve = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.approve()); await settle(f.page); };
const decline = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.decline()); await settle(f.page); };
const addFans = async (f: Frozen, n: number) => { await f.page.evaluate((count) => (window as unknown as ManageWindow).__marquee.addFans(count), n); await settle(f.page); };
const skip = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.skip()); await settle(f.page); };

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

for (const [slug, scenario, viewport, frames] of [
  ["manage-initial", async () => {}, DESKTOP, MANAGE_SCRIPTS.tipped],
  ["manage-tipped", tipped, DESKTOP, MANAGE_SCRIPTS.tipped],
  ["manage-paid", paid, DESKTOP, MANAGE_SCRIPTS.paid],
  ["manage-called-off", calledOff, DESKTOP, MANAGE_SCRIPTS.calledOff],
  ["manage-phone-initial", async () => {}, PHONE, MANAGE_SCRIPTS.tipped],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: () => manageApi([...frames]), dataFields: P.dataFields, skip: P.skip });
  });
}
