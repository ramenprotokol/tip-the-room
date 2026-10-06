import { test } from "@playwright/test";
import { DESKTOP, PROD_BASE, expectParity } from "./parity";
import { PAGES } from "./pages";

// The same pixel and text comparison as the dev parity specs, but the app side is the built site
// (vite build + preview, test hooks on with ?e2e), so minification or chunk-order problems that change the look show up here.
for (const p of [PAGES.demo, PAGES.start, PAGES.pledge, PAGES.manage]) {
  const slug = `${p.name === "demo" ? "demo-rest" : `${p.name}-initial`}`;
  test(`prod parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, p.refPath, p.prodPath, async () => {}, { viewport: DESKTOP, fullPage: true, slug: `prod-${slug}`, appBase: PROD_BASE, api: p.api, dataFields: p.dataFields, skip: p.skip, appOnly: p.appOnly });
  });
}
