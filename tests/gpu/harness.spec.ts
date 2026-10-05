import { test, expect, type Browser } from "@playwright/test";
import { DESKTOP, MAX_DIFF_RATIO, REF_BASE, diffRatio, openFrozen, shoot, type Frozen } from "./parity";

async function capture(browser: Browser, tip: boolean): Promise<Buffer> {
  let f: Frozen | undefined;
  try {
    f = await openFrozen(browser, REF_BASE + "demo.html", DESKTOP);
    expect(f.viewCount, "reference demo must render signs (WebGL needed)").toBeGreaterThan(0);
    if (tip) {
      await f.page.keyboard.press("t");
      await f.run(1700);
      await f.toAnim(0, 2.4);
    }
    const shot = await shoot(f, false);
    expect(f.errors).toEqual([]);
    return shot;
  } finally {
    await f?.close();
  }
}

test("two frozen loads of the reference demo match (rest and tip 2.4), and rest differs from tip", async ({ browser }) => {
  const rest = [await capture(browser, false), await capture(browser, false)];
  const tip = [await capture(browser, true), await capture(browser, true)];
  const restRatio = diffRatio(rest[0], rest[1]);
  const tipRatio = diffRatio(tip[0], tip[1]);
  const negRatio = diffRatio(rest[0], tip[0]);
  console.log(`harness ratios: rest-vs-rest=${restRatio.toFixed(5)} tip-vs-tip=${tipRatio.toFixed(5)} rest-vs-tip(negative)=${negRatio.toFixed(5)} threshold=${MAX_DIFF_RATIO}`);
  expect(restRatio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
  expect(tipRatio).toBeLessThanOrEqual(MAX_DIFF_RATIO);
  expect(negRatio, "harness must see the rest and tip 2.4 frames as different").toBeGreaterThan(MAX_DIFF_RATIO);
});
