import { describe, expect, it } from "vitest";
import { IDLE_MS, IdleWatch } from "../../src/web/shared/idle";

describe("IdleWatch", () => {
  it("is idle after IDLE_MS without a touch and wakes on the next touch", () => {
    let t = 0;
    const w = new IdleWatch(() => t);
    expect(w.idle()).toBe(false);
    t = IDLE_MS - 1;
    expect(w.idle()).toBe(false);
    t = IDLE_MS;
    expect(w.idle()).toBe(true);
    w.touch();
    expect(w.idle()).toBe(false);
  });
});
