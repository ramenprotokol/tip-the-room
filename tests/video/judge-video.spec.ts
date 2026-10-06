// The judge flow on the local stack or the deployed site, filmed for the submission video. Captions are painted by the page overlay
// below (burned into the recording); slow waits are marked so scripts/video-build.ts can squeeze them. The PayPal popup
// is recorded separately and laid over the main video. If PayPal's login page changed, run with --headed and finish
// the popup by hand: the test waits up to 5 minutes for "You're on hold".
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { CAPTIONS, END_CARD, type Mark, type Timeline } from "./captions";

const OUT = "test-results/video";
const SIZE = { width: 1280, height: 720 };
// No site given: the local stack has no PayPal client id, so the popup step is skipped (the pledge page can't show a button).
const LOCAL = !(process.env.VIDEO_BASE_URL?.trim() || process.env.E2E_BASE_URL?.trim());
// The sandbox buyer login must never be on camera: the judge panel's login line is hidden on every page.
// On PayPal's own pages, typed fields are shown as dots so the buyer email and password never appear.
const HIDE_CREDS = "[data-judge-creds]{visibility:hidden!important}";
const MASK_PAYPAL = "input{-webkit-text-security:disc!important}";

async function paint(page: Page, text: string, full = false) {
  await page.evaluate(([t, f]) => {
    let el = document.getElementById("video-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "video-caption";
      el.setAttribute("aria-hidden", "true");
      document.body.append(el);
    }
    Object.assign(el.style, f
      ? { position: "fixed", inset: "0", display: "flex", alignItems: "center", justifyContent: "center", padding: "80px", background: "#1b1411", color: "#fff", font: "600 34px/1.5 'IBM Plex Sans', system-ui, sans-serif", textAlign: "center", zIndex: "2147483647" }
      : { position: "fixed", left: "50%", bottom: "28px", transform: "translateX(-50%)", width: "max-content", maxWidth: "1100px", padding: "12px 22px", borderRadius: "10px", background: "rgba(16,12,10,.86)", color: "#fff", font: "600 26px/1.35 'IBM Plex Sans', system-ui, sans-serif", textAlign: "center", zIndex: "2147483647", pointerEvents: "none", display: t ? "block" : "none" });
    el.textContent = t;
  }, [text, full] as const);
}

const ready = (page: Page) => expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 120_000 });

async function payPalLogin(popup: Page, who: { email: string; password: string }): Promise<boolean> {
  try {
    await popup.waitForLoadState("domcontentloaded");
    await popup.locator('input[type="email"], input#email').first().fill(who.email, { timeout: 45_000 });
    const next = popup.locator("#btnNext");
    if (await next.isVisible().catch(() => false)) await next.click();
    await popup.locator('input[type="password"]').first().fill(who.password, { timeout: 30_000 });
    await popup.locator('#btnLogin, button[type="submit"]').first().click();
    await popup.getByRole("button", { name: /continue|complete|agree|pay now|review order/i }).first().click({ timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

test("submission video: the judge flow with captions", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: `${OUT}/raw`, size: SIZE } });
  await context.addInitScript(([css, paypalCss]) => {
    addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = css + (/paypal/i.test(location.hostname) ? paypalCss : "");
      document.head.append(st);
    });
  }, [HIDE_CREDS, MASK_PAYPAL] as const);
  const page = await context.newPage();
  // The demo pauses polling after 5 minutes without input: nudge the pointer once a minute so it never pauses on camera.
  let nudge = 0;
  const keepAlive = setInterval(() => { nudge += 1; void page.mouse.move(600 + (nudge % 2) * 8, 360).catch(() => undefined); }, 45_000);
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const segments: Mark[] = [];
  let popupSpan: Timeline["popup"] = null;
  let current = "";
  let popupVideo: ReturnType<Page["video"]> = null;
  const caption = async (text: string) => { current = text; await paint(page, text); };
  const go = async (url: string) => { await page.goto(url); await ready(page); await paint(page, current); };
  const dwell = (ms: number) => page.waitForTimeout(ms);
  const squeeze = async (fn: () => Promise<unknown>) => { const start = at(); try { await fn(); } finally { segments.push({ start, end: at(), kind: "squeeze" }); } };
  const fans = (k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);
  const word = (k: "a" | "b") => page.locator(`#show-${k} [data-word]`);

  // 1. The demo page.
  await go("/");
  await caption(CAPTIONS.intro); await dwell(5000);
  await caption(CAPTIONS.demo); await dwell(5000);
  await caption(CAPTIONS.seating);
  await squeeze(async () => { await expect(fans("a")).toHaveText("29", { timeout: 300_000 }); await expect(fans("b")).toHaveText("19", { timeout: 300_000 }); });
  await dwell(2000);

  // 2. The judge's own hold with the real PayPal popup.
  const creds = /sandbox buyer (\S+@[^\s,]+)(?:, password (\S+?))?\. It/.exec((await page.locator("[data-judge-creds]").textContent()) ?? "");
  const pledgeHref = await page.locator("#pledge-a").getAttribute("href");
  const manageA = await page.locator("#manage-a").getAttribute("href");
  const manageB = await page.locator("#manage-b").getAttribute("href");
  expect(pledgeHref && manageA && manageB).toBeTruthy();
  if (!LOCAL) {
    await caption(CAPTIONS.pledge);
    await go(pledgeHref!);
    await page.locator("#initials").fill("AB");
    const button = page.locator("#pp-slot paypal-button");
    await button.waitFor({ timeout: 60_000 });
    const popupWait = page.waitForEvent("popup", { timeout: 30_000 });
    await button.click();
    const popup = await popupWait;
    const popupStart = at();
    popupVideo = popup.video();
    const auto = creds?.[2] ? await payPalLogin(popup, { email: creds[1]!, password: creds[2] }) : false;
    if (!auto) console.log("Finish the PayPal popup by hand (run with --headed).");
    await expect(page.locator("#confirm")).toBeVisible({ timeout: 300_000 });
    popupSpan = { start: popupStart, end: at() };
    segments.push({ start: popupStart, end: popupSpan.end, kind: "fast" });
    await caption(CAPTIONS.held); await dwell(6000);

  }

  // 3. Pace check and the artist's approval card.
  await go("/");
  await caption(CAPTIONS.pace);
  await page.click("#pace");
  await squeeze(() => expect(page.locator("#log")).toContainText("Proposed:", { timeout: 90_000 }));
  await caption(CAPTIONS.ask);
  await go(manageB!);
  await expect(page.locator("#ask")).toBeVisible({ timeout: 30_000 });
  await dwell(7000);

  // 4. Add fans to B, then skip to the deadline.
  await go("/");
  await caption(CAPTIONS.add);
  await page.locator("#show-b [data-act=add]").click();
  await squeeze(() => expect(fans("b")).toHaveText("24", { timeout: 300_000 }));
  await caption(CAPTIONS.skip);
  await page.locator("#show-a [data-act=ff]").click();
  await squeeze(() => expect(word("a")).not.toHaveText("Waiting for fans", { timeout: 300_000 }));
  await caption(CAPTIONS.tip); await dwell(6000);
  await squeeze(() => expect(word("b")).toHaveText("Called off", { timeout: 300_000 }));
  await caption(CAPTIONS.miss); await dwell(5000);
  await squeeze(() => expect(word("a")).toHaveText(/Everyone’s paid|Payouts sent/, { timeout: 600_000 }));
  await caption(CAPTIONS.paid); await dwell(5000);

  // 5. Show A's page: ledger and agent log.
  await caption(CAPTIONS.ledger);
  await go(manageA!);
  await page.locator("#ledger").scrollIntoViewIfNeeded();
  await dwell(8000);
  await caption(CAPTIONS.log);
  await page.locator("#log").scrollIntoViewIfNeeded();
  await dwell(7000);

  // 6. An artist starts a show.
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  await caption(CAPTIONS.start);
  await go("/start");
  await page.locator("#sentence").fill(`Acoustic set at Lucky's Café, ${day(14)}, $15 tickets, café wants $100, opener gets $60, I need $200, pledges close ${day(10)}`);
  await page.click("#fill");
  await squeeze(() => expect(page.locator("#draft")).toBeVisible({ timeout: 90_000 }));
  const mails = page.locator('#paylist input[data-k="email"]');
  for (let i = 0; i < (await mails.count()); i += 1) await mails.nth(i).fill(`payee${i + 1}@example.com`);
  await dwell(4000);
  await caption(CAPTIONS.sign);
  await expect(page.locator("#sign")).toBeEnabled({ timeout: 10_000 });
  await page.locator("#sign").hover();
  await page.mouse.down(); await dwell(1900); await page.mouse.up();
  await expect(page.locator("#live")).toBeVisible({ timeout: 60_000 });
  await caption(CAPTIONS.share); await dwell(6000);

  // 7. End card.
  await paint(page, END_CARD, true); await dwell(6000);

  const total = at();
  clearInterval(keepAlive);
  await context.close();
  await page.video()!.saveAs(`${OUT}/main.webm`);
  if (popupVideo) await popupVideo.saveAs(`${OUT}/popup.webm`);
  const tl: Timeline = { segments, popup: popupSpan, total };
  writeFileSync(`${OUT}/timeline.json`, JSON.stringify(tl, null, 2));
});
