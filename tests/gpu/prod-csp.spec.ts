import { expect, test } from "@playwright/test";
import { contentSecurityPolicy } from "../../src/web/build/pages";
import { installFakeApi } from "./fake-api";
import { PROD_BASE } from "./parity";
import { PAGES } from "./pages";

// vite preview doesn't send dist/_headers, so this test adds the same CSP to every page and checks nothing is refused.
for (const p of Object.values(PAGES)) {
  test(`CSP allows everything ${p.name} needs`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await installFakeApi(page, p.api());
    await page.route((url) => url.origin === new URL(PROD_BASE).origin && !url.pathname.startsWith("/api/"), async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": contentSecurityPolicy("") } });
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => { ((window as unknown as { __csp: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`); });
    });
    await page.goto(PROD_BASE + p.prodPath);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    expect(violations).toEqual([]);
  });
}
