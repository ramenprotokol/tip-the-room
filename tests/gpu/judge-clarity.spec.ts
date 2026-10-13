// The home page and start page explain themselves to a first-time judge (links, notes, button states, copyable login).
// All run against the fake API; the new text is app-only, so the pixel-comparison runs (?e2e=parity) must not show it.
import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { DEMO_ID, DEMO_KEY, MANAGE_FRAMES, MAYA, MAYA_ID, MAYA_KEY, START_CREATE, demoApi, manageApi, pledgeApi, showOf, startApi } from "./fixtures";
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

test.describe("Use example emails on the start page", () => {
  const HINT = "No PayPal accounts handy? Example emails let you try signing. Sandbox only.";
  const sign = (page: Page) => page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());
  async function start(page: Page, query = "?e2e") {
    const seen = await installFakeApi(page, startApi());
    await page.goto(`${APP_BASE}start${query}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    return seen;
  }

  test("is hidden until the draft needs emails, fills every missing one, and unlocks signing", async ({ page }) => {
    const seen = await start(page);
    await expect(page.locator("#example-emails")).toBeHidden();
    await page.click("#fill");
    await expect(page.locator("#draft")).toBeVisible();
    await expect(page.locator("#sign")).toBeDisabled();
    await expect(page.locator("#example-emails")).toBeVisible();
    await expect(page.locator("#example-emails")).toContainText(HINT);
    await page.click("#use-example");
    await expect(page.locator("#mail-0")).toHaveValue("room@example.com");
    await expect(page.locator("#mail-3")).toHaveValue("artist@example.com");
    await expect(page.locator("#mail-1")).toHaveValue("");
    await expect(page.locator("#sign")).toBeEnabled();
    await expect(page.locator("#sign-hint")).toHaveText("Press and hold for 1.5 seconds. On a keyboard, hold Space or Enter.");
    await expect(page.locator("#example-emails")).toBeHidden();
    await sign(page);
    await expect(page.locator("#live")).toBeVisible();
    const body = seen.find((r) => r.path.endsWith("/sign"))?.body as { draft: { parties: { role: string; paypalEmail: string }[] } };
    expect(body.draft.parties.map((p) => [p.role, p.paypalEmail])).toEqual([["room", "room@example.com"], ["artist", "artist@example.com"]]);
  });

  test("keeps an email the visitor already typed and fills only the others", async ({ page }) => {
    await start(page);
    await page.click("#fill");
    await page.fill("#mail-3", "maya@band.test");
    await expect(page.locator("#example-emails")).toBeVisible();
    await page.click("#use-example");
    await expect(page.locator("#mail-3")).toHaveValue("maya@band.test");
    await expect(page.locator("#mail-0")).toHaveValue("room@example.com");
    await expect(page.locator("#sign")).toBeEnabled();
  });

  test("does not show in the pixel-comparison mode", async ({ page }) => {
    await start(page, "?e2e=parity");
    await page.click("#fill");
    await expect(page.locator("#example-emails")).toBeHidden();
  });
});

test.describe("fans above the target say how many more than needed joined", () => {
  test("on the demo, after the target is reached and more fans join", async ({ page }) => {
    await open(page);
    const sub = page.locator("#show-a [data-fans-sub]");
    await page.locator("#show-a [data-act=add]").click(); // 29 -> 34: it tips
    await expect(fans(page, "a")).toHaveText("34", { timeout: 15_000 });
    await expect(page.locator("#show-a [data-word]")).toHaveText("It’s on!", { timeout: 15_000 });
    await expect(page.locator("#show-a [data-act=add]")).toBeEnabled({ timeout: 15_000 });
    await page.locator("#show-a [data-act=add]").click(); // +5 after the tip
    await expect(fans(page, "a")).toHaveText("39", { timeout: 15_000 });
    await expect(sub).toHaveText("It’s on! · 5 more than needed joined", { timeout: 15_000 });
    await expect(page.locator("#show-a [data-of]")).toHaveText("fans · target was 34");
  });

  test("on the artist's show page", async ({ page }) => {
    const over = { ...MANAGE_FRAMES.tipped, show: showOf(MAYA, { fans: 23, state: "tipped", version: 8 }), version: "e8.l8" };
    const seen = await installFakeApi(page, manageApi([over]));
    await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e#${MAYA_KEY}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    expect(seen.length).toBeGreaterThan(0);
    await expect(page.locator("[data-fans-sub]")).toHaveText("It’s on! · 2 more than needed joined", { timeout: 15_000 });
  });

  test("nothing extra is said while fans have not passed the target", async ({ page }) => {
    await open(page);
    await expect(page.locator("#show-a [data-fans-sub]")).not.toContainText("more than needed");
  });
});

test.describe("a lasting pointer while a show's agent is asking the artist", () => {
  const SENTENCE = "Marlow Finch’s agent is asking the artist to approve a change.";
  const HREF = `/s/${DEMO_ID}b/manage#${DEMO_KEY}`;

  test("appears on that card and in the judges list after Check pace now, and survives a reload", async ({ page }) => {
    await open(page);
    for (const sel of ["#show-a [data-ask-pointer]", "#show-b [data-ask-pointer]", "[data-judge-ask]"]) await expect(page.locator(sel)).toBeHidden();
    await page.locator("#pace").click();
    const card = page.locator("#show-b [data-ask-pointer]");
    await expect(card).toBeVisible();
    await expect(card.locator("[data-ask-text]")).toHaveText(SENTENCE);
    await expect(card.locator("a")).toHaveText("Open Marlow Finch’s show page");
    await expect(card.locator("a")).toHaveAttribute("href", HREF);
    await expect(page.locator("#show-a [data-ask-pointer]")).toBeHidden();
    const here = page.locator("#judge [data-judge-ask]");
    await expect(here).toContainText(SENTENCE);
    await expect(here.locator("a")).toHaveAttribute("href", HREF);
    await expect(page.locator("[data-judge-msg]")).toContainText("The agent checked the pace.");
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeVisible();
    await expect(page.locator("#judge [data-judge-ask] a")).toHaveAttribute("href", HREF);
  });

  test("goes away once the question has been answered", async ({ page }) => {
    const base = demoApi();
    let answered = false;
    const api: FakeApi = (req) => {
      const r = base(req);
      if (answered && r && req.method === "GET" && req.path.endsWith("/manage")) {
        const body = structuredClone(r.body) as { proposals: { approved: string | null }[] };
        body.proposals.forEach((p) => { p.approved = "lower"; });
        return { ...r, body };
      }
      return r;
    };
    await open(page, api);
    await page.locator("#pace").click();
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeVisible();
    answered = true;
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeHidden();
    await expect(page.locator("[data-judge-ask]")).toBeHidden();
  });

  test("stays hidden in the pixel-comparison mode", async ({ page }) => {
    await open(page, demoApi(), "?e2e=parity");
    await page.locator("#pace").click();
    await expect(page.locator("[data-judge-msg]")).toContainText("The agent checked the pace.");
    await expect(page.locator("#show-b [data-ask-pointer]")).toBeHidden();
    await expect(page.locator("[data-judge-ask]")).toBeHidden();
  });
});

test.describe("who wrote it", () => {
  const AI_LINE = "Drafted by AI (Cloudflare Workers AI). Code checked every amount against your sentence.";
  const READER_LINE = "Filled in by the built-in reader.";
  async function start(page: Page, api: FakeApi, query = "?e2e") {
    await installFakeApi(page, api);
    await page.goto(`${APP_BASE}start${query}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  }

  test("the start page says AI wrote the draft when the server says so, and clears it on a new fill", async ({ page }) => {
    let source: "model" | "template" = "model";
    const base = startApi();
    await start(page, (req) => (req.method === "POST" && req.path === "/api/shows" ? { status: 201, body: { ...START_CREATE, source } } : base(req)));
    await expect(page.locator("#draft-source")).toBeHidden();
    await page.click("#fill");
    await expect(page.locator("#draft-source")).toHaveText(AI_LINE);
    source = "template";
    await page.click("#fill"); // the draft is untouched, so Fill it in again does not ask first
    await expect(page.locator("#draft-source")).toHaveText(READER_LINE);
  });

  test("the start page says the built-in reader filled it in for a template or resting draft", async ({ page }) => {
    for (const source of ["template", "resting"] as const) {
      const base = startApi();
      await start(page, (req) => (req.method === "POST" && req.path === "/api/shows" ? { status: 201, body: { ...START_CREATE, source } } : base(req)));
      await page.click("#fill");
      await expect(page.locator("#draft-source")).toHaveText(READER_LINE);
    }
  });

  test("the start page keeps the label out of the pixel-comparison mode", async ({ page }) => {
    await start(page, startApi(), "?e2e=parity");
    await page.click("#fill");
    await expect(page.locator("#draft")).toBeVisible();
    await expect(page.locator("#draft-source")).toBeHidden();
  });

  for (const [source, label] of [["model", "Written by the agent"], ["template", "Standard wording"]] as const) {
    test(`the show page's question card says "${label}" for a ${source} proposal`, async ({ page }) => {
      const frame = { ...MANAGE_FRAMES.initial, proposals: MANAGE_FRAMES.initial.proposals.map((p) => ({ ...p, source })) };
      await installFakeApi(page, manageApi([frame]));
      await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e#${MAYA_KEY}`);
      await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
      await expect(page.locator("#ask")).toBeVisible();
      await expect(page.locator("#ask-source")).toHaveText(label);
    });
  }
});

test.describe("the fan page", () => {
  const SDK = "https://www.sandbox.paypal.com/web-sdk/v6/core";
  const STUB = `customElements.define("paypal-button", class extends HTMLElement { connectedCallback() { this.textContent = "PayPal"; this.style.cssText = "display:block;min-height:44px;background:#ffc439"; } });
window.paypal = { createInstance: async () => ({ findEligibleMethods: async () => ({ isEligible: (m) => m === "paypal" }), createPayPalOneTimePaymentSession: () => ({ start: async () => {} }) }) };`;
  const party = (role: "room" | "opener" | "artist", label: string) => ({ role, label, fixedCents: role === "artist" ? null : 5000, minimumCents: role === "artist" ? 20000 : null });
  async function fanPage(page: Page, split: ReturnType<typeof party>[], opts: { query?: string; state?: "live" | "missed" } = {}) {
    await page.route(SDK, (r) => r.fulfill({ contentType: "application/javascript", body: STUB }));
    await installFakeApi(page, pledgeApi({ show: { ...showOf(MAYA, { fans: 12, state: opts.state ?? "live" }), split } }));
    await page.goto(`${APP_BASE}s/${MAYA_ID}${opts.query ?? "?e2e&paypal=test-client"}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  }

  test("the bill leaves out the placeholder artist name 'You'", async ({ page }) => {
    await fanPage(page, [party("room", "Lucky’s Café"), party("artist", "You")]);
    await expect(page.locator(".bill")).toHaveText("Lucky’s Café");
  });

  test("the bill reads 'with <opener> · <room>' when only the opener is named", async ({ page }) => {
    await fanPage(page, [party("room", "Lucky’s Café"), party("opener", "The Low Tides"), party("artist", "You")]);
    await expect(page.locator(".bill")).toHaveText("with The Low Tides · Lucky’s Café");
  });

  test("a named artist is kept, with or without an opener", async ({ page }) => {
    await fanPage(page, [party("room", "Lucky’s Café"), party("artist", "Maya")]);
    await expect(page.locator(".bill")).toHaveText("Maya · Lucky’s Café");
    const p2 = await page.context().newPage();
    await installFakeApi(p2, pledgeApi({ show: { ...showOf(MAYA, { fans: 12 }), split: [party("room", "Lucky’s Café"), party("opener", "The Low Tides"), party("artist", "Maya")] } }));
    await p2.goto(`${APP_BASE}s/${MAYA_ID}?e2e`);
    await expect(p2.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(p2.locator(".bill")).toHaveText("Maya with The Low Tides · Lucky’s Café");
  });

  test("a line beside the PayPal button says the window's 'Complete Purchase' is still only a hold", async ({ page }) => {
    await fanPage(page, [party("room", "Lucky’s Café"), party("artist", "Maya")]);
    await expect(page.locator("#pledge-card #paypal-note")).toHaveText("PayPal's window says “Complete Purchase”. It is still only a hold: you are charged only if the show happens.");
    await expect(page.locator("#pledge-card #paypal-note")).toBeVisible();
  });

  test("the PayPal note is gone once pledging has closed, and absent in the pixel-comparison mode", async ({ page }) => {
    await fanPage(page, [party("room", "Lucky’s Café"), party("artist", "Maya")], { state: "missed" });
    await expect(page.locator("#paypal-note")).toBeHidden();
    const p2 = await page.context().newPage();
    await installFakeApi(p2, pledgeApi());
    await p2.goto(`${APP_BASE}s/${MAYA_ID}?e2e=parity`);
    await expect(p2.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await expect(p2.locator("#paypal-note")).toBeHidden();
  });

  test("the PayPal note goes away once the fan is on hold", async ({ page }) => {
    const approving = STUB.replace("start: async () => {}", "start: async (o, order) => { const { orderId } = await order; await cb.onApprove({ orderId }); }").replace("createPayPalOneTimePaymentSession: () =>", "createPayPalOneTimePaymentSession: (cb) =>");
    await page.route(SDK, (r) => r.fulfill({ contentType: "application/javascript", body: approving }));
    await installFakeApi(page, pledgeApi());
    await page.goto(`${APP_BASE}s/${MAYA_ID}?e2e&paypal=test-client`);
    await expect(page.locator("#paypal-note")).toBeVisible();
    await page.locator("paypal-button").click();
    await expect(page.locator("#confirm")).toBeVisible();
    await expect(page.locator("#paypal-note")).toBeHidden();
  });
});


test.describe("the start page warns when nobody was found to be paid", () => {
  const WARNING = "We couldn't find who gets paid in your sentence. Add the amounts below before you sign.";
  const emptyDraft = () => ({ ...START_CREATE, threshold: null, draft: { ...START_CREATE.draft, parties: START_CREATE.draft.parties.map((p) => ({ ...p, fixedCents: p.fixedCents === undefined ? undefined : 0, minimumCents: p.minimumCents === undefined ? undefined : 0 })) } });
  async function start(page: Page, create: () => unknown, query = "?e2e") {
    const base = startApi();
    await installFakeApi(page, (req) => (req.method === "POST" && req.path === "/api/shows" ? { status: 201, body: create() } : base(req)));
    await page.goto(`${APP_BASE}start${query}`);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  }

  test("shows when the draft has no amounts, and clears on the next fill", async ({ page }) => {
    let empty = true;
    await start(page, () => (empty ? emptyDraft() : START_CREATE));
    await expect(page.locator("#no-payees")).toBeHidden();
    await page.click("#fill");
    await expect(page.locator("#no-payees")).toHaveText(WARNING);
    await expect(page.locator("#no-payees")).toBeVisible();
    empty = false;
    await page.click("#fill");
    await expect(page.locator("#draft")).toBeVisible();
    await expect(page.locator("#no-payees")).toBeHidden();
  });

  test("stays hidden when the draft has amounts, and in the pixel-comparison mode", async ({ page }) => {
    await start(page, () => START_CREATE);
    await page.click("#fill");
    await expect(page.locator("#draft")).toBeVisible();
    await expect(page.locator("#no-payees")).toBeHidden();
    const p2 = await page.context().newPage();
    const base = startApi();
    await installFakeApi(p2, (req) => (req.method === "POST" && req.path === "/api/shows" ? { status: 201, body: emptyDraft() } : base(req)));
    await p2.goto(`${APP_BASE}start?e2e=parity`);
    await expect(p2.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await p2.click("#fill");
    await expect(p2.locator("#draft")).toBeVisible();
    await expect(p2.locator("#no-payees")).toBeHidden();
  });
});
