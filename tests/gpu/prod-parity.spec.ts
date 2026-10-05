import { test } from "@playwright/test";
import { DESKTOP, PROD_BASE, expectParity } from "./parity";

// The same pixel and text comparison as the dev parity specs, but the app side is the built site
// (vite build + preview), so minification or chunk-order problems that change the look show up here.
for (const [slug, refPath, appPath] of [
  ["demo-rest", "demo.html", ""],
  ["start-initial", "start.html", "start.html"],
  ["pledge-initial", "pledge.html", "pledge.html"],
  ["manage-initial", "manage.html", "manage.html"],
] as const) {
  test(`prod parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, refPath, appPath, async () => {}, { viewport: DESKTOP, fullPage: true, slug: `prod-${slug}`, appBase: PROD_BASE });
  });
}
