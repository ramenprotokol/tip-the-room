import { expect, test, type Page } from "@playwright/test";

const fans = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);
const word = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-word]`);
const ready = (page: Page) => expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });

test("judge flow on the real Worker: seeded holds, check pace, add fans, skip to the deadline, start over", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
  await expect(page.locator("#show-b .title")).toHaveText("Marlow Finch");

  // The starting fans are real sandbox card holds, seated a few at a time by each show's alarm.
  await expect(fans(page, "a")).toHaveText("29", { timeout: 300_000 });
  await expect(fans(page, "b")).toHaveText("19", { timeout: 300_000 });
  await expect(word(page, "a")).toHaveText("Waiting for fans");

  // Check pace now: B (19 of 28 at three quarters of its window) is behind, so the agent asks the artist first.
  await page.click("#pace");
  await expect(page.locator("#log")).toContainText("Proposed:", { timeout: 60_000 });
  const showB = await context.newPage();
  await showB.goto((await page.locator("#manage-b").getAttribute("href"))!);
  await ready(showB);
  await expect(showB.locator("#ask")).toBeVisible();
  await expect(showB.locator("#ask-q b")).toContainText("?");
  await showB.close();

  // More simulated fans on B.
  await page.locator("#show-b [data-act=add]").click();
  await expect(fans(page, "b")).toHaveText("24", { timeout: 300_000 });

  // Skip to the deadline: A tops up, tips, everyone is charged and paid out; B misses and every hold is cancelled.
  await page.locator("#show-a [data-act=ff]").click();
  await expect(word(page, "b")).toHaveText("Called off", { timeout: 300_000 });
  await expect(word(page, "a")).toHaveText(/Everyone’s paid|Payouts sent/, { timeout: 600_000 });

  // A's show page: the AG Grid ledger has real sandbox ids.
  const showA = await context.newPage();
  await showA.goto((await page.locator("#manage-a").getAttribute("href"))!);
  await ready(showA);
  await expect(showA.locator("#ledger")).toContainText("Charged", { timeout: 30_000 });
  const refs = await showA.locator('#ledger .ag-cell[col-id="ref"]').allTextContents();
  expect(refs.some((r) => /^[A-Z0-9]{10,25}$/.test(r.trim()))).toBe(true);
  await showA.close();

  // Start over: a new private copy with fresh shows.
  const before = await page.evaluate(() => localStorage.getItem("ttr:demo"));
  await page.locator("#show-a [data-act=reset]").click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ttr:demo")), { timeout: 60_000 }).not.toBe(before);
  await expect(word(page, "a")).toHaveText("Waiting for fans", { timeout: 60_000 });
  await expect(word(page, "b")).toHaveText("Waiting for fans");
  expect(errors).toEqual([]);
});
