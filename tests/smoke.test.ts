import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/main";

describe("scaffold", () => {
  it("exposes the app name", () => {
    expect(APP_NAME).toBe("Tip the Room");
  });
});
