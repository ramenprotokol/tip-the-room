import { describe, expect, it } from "vitest";
import { dismiss, isDismissed, loadDemo, recallKey, rememberKey, saveDemo, showIdFromPath, takeKeyFromHash, type KeyStore } from "../../src/web/shared/keys";

function memory(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const broken: KeyStore = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };

describe("keys and ids", () => {
  it("reads the show id from /s/:id, /s/:id/manage or ?show=", () => {
    expect(showIdFromPath("/s/sabcdefghjk")).toBe("sabcdefghjk");
    expect(showIdFromPath("/s/acoustic-set-nov20/manage")).toBe("acoustic-set-nov20");
    expect(showIdFromPath("/pledge.html", "?show=sabcdefghjk")).toBe("sabcdefghjk");
    expect(showIdFromPath("/s/../etc")).toBeNull();
    expect(showIdFromPath("/s/%3Cscript%3E")).toBeNull();
    expect(showIdFromPath("/")).toBeNull();
  });
  it("takes a manage key from the fragment only when it looks like one", () => {
    expect(takeKeyFromHash("#k-7Q2M9X4T")).toBe("k-7Q2M9X4T");
    expect(takeKeyFromHash("#<b>")).toBeNull();
    expect(takeKeyFromHash("")).toBeNull();
  });
  it("remembers keys per show and survives a storage that throws", () => {
    const s = memory();
    rememberKey(s, "s1", "key-123456");
    expect(recallKey(s, "s1")).toBe("key-123456");
    expect(recallKey(s, "s2")).toBeNull();
    expect(() => rememberKey(broken, "s1", "key-123456")).not.toThrow();
    expect(recallKey(broken, "s1")).toBeNull();
    expect(recallKey(null, "s1")).toBeNull();
  });
  it("saves the demo copy and rejects junk", () => {
    const s = memory();
    saveDemo(s, { demoId: "dabcdefghjk", demoKey: "demo-key-fixture", expiresAt: 123 });
    expect(loadDemo(s)).toEqual({ demoId: "dabcdefghjk", demoKey: "demo-key-fixture", expiresAt: 123 });
    s.data.set("ttr:demo", "{nope");
    expect(loadDemo(s)).toBeNull();
    s.data.set("ttr:demo", JSON.stringify({ demoId: "<x>", demoKey: "demo-key-fixture", expiresAt: 1 }));
    expect(loadDemo(s)).toBeNull();
  });
  it("remembers dismissed proposals per show", () => {
    const s = memory();
    expect(isDismissed(s, "s1", "pace1")).toBe(false);
    dismiss(s, "s1", "pace1");
    expect(isDismissed(s, "s1", "pace1")).toBe(true);
    expect(isDismissed(s, "s2", "pace1")).toBe(false);
  });
});
