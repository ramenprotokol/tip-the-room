// Opens the deployed site in Chromium, mounts the real PayPal v6 button on show A's fan page, opens its popup, and
// lists every CSP violation and every origin the page itself requested. Run: node --import tsx scripts/csp-probe.ts https://<site>
// Read-only apart from one public demo copy and one unapproved order (bounded by the normal limits, they expire). Never deploys.
import { chromium } from "@playwright/test";
import { extraHostsFromEnv, liveOrigin } from "./lib/live";

const site = liveOrigin(process.argv[2], extraHostsFromEnv());
if (!site || !site.startsWith("https://")) {
  console.error("usage: csp-probe.ts https://<site origin>  (an allowed host: *.pages.dev, *.workers.dev or LIVE_ALLOWED_HOSTS)");
  process.exit(2);
}
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const origins = new Set<string>();
const violations: string[] = [];
page.on("request", (r) => {
  try {
    origins.add(new URL(r.url()).origin);
  } catch {
    // data: and blob: URLs
  }
});
page.on("console", (m) => {
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
await page.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => console.log(`Refused to load (CSP ${e.violatedDirective}): ${e.blockedURI}`));
});
await page.goto(`${site}/`);
await page.locator('body[data-ready="1"]').waitFor({ timeout: 90_000 });
const href = await page.locator("#pledge-a").getAttribute("href");
if (!href) throw new Error("the demo page has no fan-page link");
await page.goto(new URL(href, site).toString());
await page.locator('body[data-ready="1"]').waitFor({ timeout: 90_000 });
const button = page.locator("#pp-slot paypal-button");
await button.waitFor({ timeout: 60_000 });
const popupWait = page.waitForEvent("popup", { timeout: 30_000 }).catch(() => null);
await button.click();
const popup = await popupWait;
if (popup) {
  await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
  console.log(`popup opened at ${new URL(popup.url()).origin}`);
  await popup.close();
} else console.log("no popup opened (check the button by hand)");
await page.waitForTimeout(3000);
console.log("origins the page requested:");
for (const o of [...origins].sort()) console.log(`  ${o}`);
console.log(violations.length ? `CSP violations (${violations.length}):` : "CSP violations: none");
for (const v of violations) console.log(`  ${v.slice(0, 300)}`);
await browser.close();
process.exit(violations.length ? 1 : 0);
