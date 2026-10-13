import { describe, expect, it } from "vitest";
import { customIdFor, demoShowIds, isDemoId, isShowId, newId, newSecret, pledgeIdFromCustomId, sameHex, sha256Hex, showIdFromRef, visitorNet } from "../../src/agent/ids";
import { payoutBatchId, payoutItemId } from "../../src/paypal/payouts";
import { seqRandom } from "./fixtures";

describe("ids", () => {
  it("makes show, pledge and demo ids of 11 characters from a 32-letter alphabet", () => {
    const r = seqRandom();
    const s = newId("s", r);
    expect(s).toMatch(/^s[a-z2-9]{10}$/);
    expect(isShowId(s)).toBe(true);
    const d = newId("d", r);
    expect(isDemoId(d)).toBe(true);
    expect(demoShowIds(d).every(isShowId)).toBe(true);
    expect(newId("p", r)).not.toBe(newId("p", r));
  });
  it("rejects anything else as a show id", () => {
    for (const bad of ["", "s123", "S2345678abc", "sshowtestaa/", "x2345678abcd", "dshowtestaac"]) expect(isShowId(bad)).toBe(false);
  });
  it("makes 43-character base64url secrets", () => {
    expect(newSecret(seqRandom())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("hashes with SHA-256 and compares in constant time", async () => {
    const h = await sha256Hex("abc");
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sameHex(h, h)).toBe(true);
    expect(sameHex(h, h.replace(/.$/, "0"))).toBe(false);
    expect(sameHex(h, "ab")).toBe(false);
  });
  it("finds the show in every PayPal reference shape we create", () => {
    expect(showIdFromRef("sshowtestaa:p1")).toBe("sshowtestaa");
    expect(showIdFromRef("sshowtestaa-room")).toBe("sshowtestaa");
    expect(showIdFromRef("sshowtestaa-artist-r1")).toBe("sshowtestaa");
    expect(showIdFromRef("payout-sshowtestaa")).toBe("sshowtestaa");
    expect(showIdFromRef("payout-dshowtestaaa-r1")).toBe("dshowtestaaa");
    expect(showIdFromRef("someone-else:p1")).toBeNull();
    expect(showIdFromRef("")).toBeNull();
  });
  it("splits custom ids and caps them at 127 characters", () => {
    expect(customIdFor("sshowtestaa", "p1")).toBe("sshowtestaa:p1");
    expect(pledgeIdFromCustomId("sshowtestaa:p1-h1")).toBe("p1-h1");
    expect(pledgeIdFromCustomId("nocolon")).toBeNull();
    expect(() => customIdFor("s", "p".repeat(130))).toThrow(RangeError);
  });
  it("caps show ids so every derived PayPal id fits (request id <= 108, item id <= 63)", () => {
    const longest = demoShowIds("d" + "z".repeat(10))[1];
    expect(longest).toHaveLength(12);
    expect(isShowId(longest)).toBe(true);
    for (const retry of [false, true]) {
      const batch = payoutBatchId(longest, retry);
      expect(`${batch}`.length).toBeLessThanOrEqual(108);
      expect(`${showIdFromRef(batch)}`).toBe(longest);
      for (const role of ["room", "opener", "host", "artist"]) {
        const item = payoutItemId(longest, role, retry);
        expect(item.length).toBeLessThanOrEqual(63);
        expect(showIdFromRef(item)).toBe(longest);
      }
    }
    expect(isShowId(longest + "a")).toBe(false);
  });
});

describe("visitorNet", () => {
  it("leaves IPv4 and anything it can't read unchanged", () => {
    for (const same of ["203.0.113.7", "local", "", "garbage", "1:2:3:4:5:6:7:8:9", "1::2::3", "12345::1", "g::1", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8::", "::1.2.3.999"]) {
      expect(visitorNet(same)).toBe(same);
    }
  });
  it("counts an IPv6 /64 as one visitor", () => {
    expect(visitorNet("2001:db8::1")).toBe(visitorNet("2001:db8:0:0:ffff::2"));
    expect(visitorNet("2001:db8::1")).toBe(visitorNet("2001:DB8:0000:0000:0:0:0:9"));
    expect(visitorNet("2001:db8:0:1::1")).not.toBe(visitorNet("2001:db8::1"));
    expect(visitorNet("2001:db8:0:0:1:2:3:4")).toBe("2001:db8:0:0::/64");
    expect(visitorNet("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
  });
  it("handles ::, ::1, brackets and zone ids", () => {
    expect(visitorNet("::")).toBe("0:0:0:0::/64");
    expect(visitorNet("::1")).toBe("0:0:0:0::/64");
    expect(visitorNet("[2001:db8::1]")).toBe(visitorNet("2001:db8::7"));
    expect(visitorNet("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });
  it("turns an IPv4-mapped address into the IPv4 address", () => {
    expect(visitorNet("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(visitorNet("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(visitorNet("0:0:0:0:0:FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(visitorNet("::fffe:cb00:7107")).not.toBe("203.0.113.7");
  });
});
