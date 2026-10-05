import { test, expect } from "@playwright/test";
import { DESKTOP, REF_BASE, diffRatio, openFrozen, shoot } from "./parity";

test("two frozen loads of the reference demo match (rest and tip 2.4)", async ({ browser }) => {
  for (const step of ["rest", "tip-2.4"] as const) {
    const shots: Buffer[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await openFrozen(browser, REF_BASE + "demo.html", DESKTOP);
      if (step === "tip-2.4") {
        await f.page.keyboard.press("t");
        await f.run(1700);
        await f.toAnim(0, 2.4);
      }
      shots.push(await shoot(f, false));
      expect(f.errors).toEqual([]);
      await f.close();
    }
    expect(diffRatio(shots[0], shots[1])).toBeLessThanOrEqual(0.005);
  }
});
