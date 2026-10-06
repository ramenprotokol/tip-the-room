import { expect, test } from "@playwright/test";
import { installFakeApi } from "./fake-api";
import { PAGES } from "./pages";

const NOHOOKS = "http://127.0.0.1:5201/";

// The real site: no window.__marquee even with ?e2e, no reference-only controls, and no API call that a visitor didn't cause.
for (const p of Object.values(PAGES)) {
  test(`production build without hooks: ${p.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const seen = await installFakeApi(page, p.api());
    await page.goto(NOHOOKS + p.prodPath.replace("e2e=parity", "e2e"));
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    expect(await page.evaluate(() => typeof (window as unknown as { __marquee?: unknown }).__marquee)).toBe("undefined");
    const raw = await (await page.request.get(NOHOOKS + p.prodPath.replace("e2e=parity", "e2e"))).text();
    expect(raw).not.toContain("data-ref-only");
    expect(raw).not.toContain("Simulate PayPal approval");
    expect(await page.locator("[data-ref-only]").count()).toBe(0);
    expect(await page.locator("#simulate").count()).toBe(0);
    // The reference test keys (t/p/m/r) are dev-only: on the real site they do nothing.
    for (const k of ["t", "p", "m", "r"]) await page.keyboard.press(k);
    await page.waitForTimeout(500);
    const posts = seen.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual(p.name === "demo" ? ["/api/demo"] : []);
    expect(errors).toEqual([]);
  });
}

test("the 404 page is built and plain", async ({ page }) => {
  await page.goto(`${NOHOOKS}404.html`);
  await expect(page.locator("h1")).toHaveText("There’s nothing here");
  await expect(page.locator('a[href="/start"]')).toBeVisible();
});
