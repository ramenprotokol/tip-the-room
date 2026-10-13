// The home page and start page explain themselves to a first-time judge (links, notes, button states, copyable login).
// All run against the fake API; the new text is app-only, so the pixel-comparison runs (?e2e=parity) must not show it.
import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { DEMO_ID, DEMO_KEY, demoApi } from "./fixtures";
import { APP_BASE } from "./parity";

const NOHOOKS = "http://127.0.0.1:5201/";

async function open(page: Page, api: FakeApi = demoApi(), query = "?e2e=quiet", base = APP_BASE) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${base}${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const fans = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);

test("the header links to Start your own show and to the judges box, on a phone too", async ({ page }) => {
  await open(page);
  const links = page.locator("#hdr-links a");
  await expect(links).toHaveText(["Start your own show", "Judges: start here ↓"]);
  await expect(links.nth(0)).toHaveAttribute("href", "/start");
  await expect(links.nth(1)).toHaveAttribute("href", "#judge");
  await expect(page.locator("#start-own")).toHaveAttribute("href", "/start");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const i of [0, 1]) {
    await expect(links.nth(i)).toBeVisible();
    const box = (await links.nth(i).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
});

test("the T/P/M/R key hints show in test builds and are gone on the real site", async ({ page }) => {
  await open(page);
  await expect(page.locator(".keys")).toBeVisible();
  await open(page, demoApi(), "?e2e", NOHOOKS);
  await expect(page.locator(".keys")).toBeHidden();
  await expect(page.locator("#hdr-links")).toBeVisible();
});

test("none of the new hints show in the pixel-comparison mode", async ({ page }) => {
  await open(page, demoApi(), "?e2e=parity");
  for (const sel of ["#hdr-links", "[data-both-note]", "#agent-note", "#setup"]) {
    for (const el of await page.locator(sel).all()) await expect(el).toBeHidden();
  }
});

test("each card says Skip to the deadline and Start over move both shows, and a skip tells the judge what happened", async ({ page }) => {
  await open(page);
  const notes = page.locator("[data-both-note]");
  await expect(notes).toHaveCount(2);
  for (const n of await notes.all()) await expect(n).toHaveText("Skip to the deadline and Start over move both sample shows together.");
  await page.locator("#show-a [data-act=ff]").click();
  await expect(page.locator("[data-judge-msg]")).toHaveText("Both sample shows have reached their deadlines. Press Start over for a fresh pair (you need one to try the checkout).", { timeout: 15_000 });
});

test("a failed skip says the error, not the success line", async ({ page }) => {
  const base = demoApi();
  await open(page, (req) => (req.path.endsWith("/fast-forward") ? apiError(429, "rate_limited", "Too many tries. Please wait a moment and try again.") : base(req)));
  await page.locator("#show-b [data-act=ff]").click();
  await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
});

test("the judges box lists what to try in order, with the agent note under the log heading", async ({ page }) => {
  await open(page);
  const steps = page.locator("#judge .try li");
  await expect(steps).toHaveCount(4);
  await expect(steps.nth(0)).toContainText("Hold a spot on Juniper Vale with the sandbox login below.");
  await expect(steps.nth(1)).toContainText("jumps both shows forward in time so the agent checks whether fans are joining fast enough. If a show is behind, it asks the artist first.");
  await expect(steps.nth(2)).toContainText("ends both shows: Juniper Vale fills up, is charged and paid out; Marlow Finch ends as it stands, and short of its target every hold is cancelled.");
  await expect(steps.nth(3)).toContainText("Start your own show");
  for (const id of ["#pledge-a", "#manage-a", "#manage-b", "#pace"]) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator("#agent-note")).toHaveText("Each show has its own AI agent. It can only act inside the five money rules below. Times follow the demo’s clock, which jumps when you skip ahead.");
});

test("the login has its own Email and Password lines, and Copy puts exactly each value on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, demoApi(), "?e2e=quiet&buyer=sb-test@personal.example.com,Pa55-w0rd|x");
  const rows = page.locator("[data-judge-creds] .cred");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator("code")).toHaveText("sb-test@personal.example.com");
  await expect(rows.nth(1).locator("code")).toHaveText("Pa55-w0rd|x");
  await expect(page.locator("[data-judge-creds]")).toContainText("It’s play money: nothing real is charged.");
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  await rows.nth(0).getByRole("button", { name: /copy/i }).click();
  await expect(rows.nth(0).getByRole("button")).toHaveText("Copied");
  expect(await clip()).toBe("sb-test@personal.example.com");
  await rows.nth(1).getByRole("button", { name: /copy/i }).click();
  expect(await clip()).toBe("Pa55-w0rd|x");
  await expect(rows.nth(0).getByRole("button")).toHaveText("Copy", { timeout: 5000 });
});

test("with no login set the box still says it is coming soon", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-judge-creds]")).toHaveText("Sandbox buyer login coming soon");
  await expect(page.locator("[data-judge-creds] .cred")).toHaveCount(0);
});

test.describe("the setup line", () => {
  /** A fresh copy that starts with few fans seated; the server's real answer (everyone seated) arrives on the next poll. */
  function fillingApi(): FakeApi {
    const base = demoApi();
    return (req) => {
      const r = base(req);
      if (req.method === "POST" && req.path === "/api/demo" && r) {
        // A copy of the answer, so the fake's own shows (which later polls return) keep their seated fans.
        const body = structuredClone(r.body) as { shows: { fans: { committed: number }; version: string }[] };
        body.shows[0].fans.committed = 10;
        body.shows[0].version = "e0.l0";
        body.shows[1].fans.committed = 4;
        body.shows[1].version = "e0.l0";
        return { ...r, body };
      }
      return r;
    };
  }
  const LINE = "Setting up your sample shows. The starting fans are real PayPal sandbox holds, seated a few at a time.";

  test("shows while a fresh copy fills, then goes away once the starting fans are seated", async ({ page }) => {
    await open(page, fillingApi(), "");
    await expect(page.locator("#setup")).toHaveText(LINE);
    await expect(page.locator("#setup")).toBeVisible();
    await expect(fans(page, "a")).toHaveText("29", { timeout: 20_000 });
    await expect(page.locator("#setup")).toBeHidden();
  });

  test("never shows for a copy that was already seated when the page loaded", async ({ page }) => {
    await page.addInitScript((v) => { if (!localStorage.getItem("ttr:demo")) localStorage.setItem("ttr:demo", JSON.stringify(v)); }, { demoId: DEMO_ID, demoKey: DEMO_KEY, expiresAt: Date.now() + 86_400_000 });
    const seen = await open(page, fillingApi());
    expect(seen.some((r) => r.method === "POST" && r.path === "/api/demo")).toBe(false);
    await expect(page.locator("#setup")).toBeHidden();
  });
});

test.describe("a clicked button reads Working… while its request is in flight", () => {
  /** Holds the answer to requests matching `glob` until `release()`, then passes them on to the fake API (or `reply`). */
  async function hold(page: Page, glob: string, reply?: { status: number; body: unknown }) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route(glob, async (route) => {
      await gate;
      if (reply) await route.fulfill({ status: reply.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(reply.body) });
      else await route.fallback();
    });
    return release;
  }
  const cases: [string, string, string, string][] = [
    ["Add 5 fans", "#show-b [data-act=add]", "**/api/demo/*/fans", "Add 5 fans"],
    ["Skip to the deadline", "#show-a [data-act=ff]", "**/api/demo/*/fast-forward", "Skip to the deadline"],
    ["Start over", "#show-b [data-act=reset]", "**/api/demo/*/reset", "Start over"],
    ["Check pace now", "#pace", "**/api/demo/*/pace", "Check pace now"],
  ];
  for (const [name, button, glob, label] of cases) {
    test(`${name}: Working… from the click, label back afterwards`, async ({ page }) => {
      await open(page);
      const release = await hold(page, glob);
      const btn = page.locator(button);
      await btn.click();
      await expect(btn).toHaveText("Working…");
      await expect(btn).toHaveAttribute("aria-busy", "true");
      // Every other control waits, and none of them says Working….
      for (const other of ["#show-a [data-act=add]", "#show-b [data-act=ff]", "#pace"].filter((o) => o !== button)) {
        await expect(page.locator(other)).toBeDisabled();
        await expect(page.locator(other)).not.toHaveText("Working…");
      }
      release();
      await expect(btn).toHaveText(label, { timeout: 10_000 });
      await expect(btn).not.toHaveAttribute("aria-busy", "true");
    });
  }

  for (const [name, button, glob, label] of cases) {
    test(`${name}: after an error the label comes back and the error is shown`, async ({ page }) => {
      await open(page);
      const release = await hold(page, glob, { status: 429, body: { error: { code: "rate_limited", message: "Too many tries. Please wait a moment and try again." } } });
      const btn = page.locator(button);
      await btn.click();
      await expect(btn).toHaveText("Working…");
      release();
      await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
      await expect(btn).toHaveText(label);
      await expect(btn).not.toHaveAttribute("aria-busy", "true");
      await expect(btn).toBeEnabled();
    });
  }
});
