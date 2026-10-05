import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { clamp, countdownHTML, mulberry32, pad2, qrMatrix, trackPoints2D, usd } from "../../src/web/shared/ui";

describe("ui pure helpers", () => {
  it("formats numbers like the reference", () => {
    expect(pad2(7)).toBe("07");
    expect(usd(1234.4)).toBe("$1,234");
    expect(clamp(2)).toBe(1);
    expect(clamp(-1)).toBe(0);
  });
  it("mulberry32 is deterministic", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("countdownHTML renders days, hours, minutes and seconds", () => {
    const html = countdownHTML(200460);
    expect(html).toContain("02");
    expect(typeof html).toBe("string");
  });
  it("trackPoints2D returns n points", () => {
    expect(trackPoints2D(600, 200, 24, 34)).toHaveLength(34);
  });
  it("qrMatrix encodes text that jsQR decodes back", () => {
    for (const text of ["https://tiptheroom.example/s/acoustic-set-nov20", "Café 12 of 21"]) {
      const m = qrMatrix(text);
      const scale = 6;
      const margin = 4;
      const size = (m.length + margin * 2) * scale;
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const mx = Math.floor(x / scale) - margin;
          const my = Math.floor(y / scale) - margin;
          const dark = mx >= 0 && my >= 0 && mx < m.length && my < m.length && Boolean(m[my][mx]);
          const i = (y * size + x) * 4;
          const v = dark ? 0 : 255;
          data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
        }
      }
      expect(jsQR(data, size, size)?.data).toBe(text);
    }
  });
});
