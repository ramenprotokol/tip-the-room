import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/agent/ids";
import { UNSIGNED_TTL_MS } from "../../src/agent/policy";
import { DRAFT, makeService, SIGN_TOKEN } from "./harness";
import { LAUNCH, SHOW } from "./fixtures";

async function unsigned() {
  const h = makeService();
  h.svc.ensureSchema();
  h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
  return h;
}

describe("a show nobody signs", () => {
  it("is armed to expire 24 h after it was created", async () => {
    const h = await unsigned();
    expect(UNSIGNED_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(h.svc.nextWakeAt()).toBe(LAUNCH + UNSIGNED_TTL_MS);
  });

  it("is kept until then, and told to be deleted at 24 h", async () => {
    const h = await unsigned();
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS - 1;
    expect(await h.svc.tick()).toEqual({ expired: false });
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS;
    expect(await h.svc.tick()).toEqual({ expired: true });
  });

  it("can no longer be signed once it has lapsed, even before the alarm deleted it", async () => {
    const h = await unsigned();
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS + 1;
    await expect(h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT })).rejects.toMatchObject({ status: 404 });
  });

  it("is kept for good once it is signed (a real show is never expired)", async () => {
    const h = await unsigned();
    h.clock.t = LAUNCH + UNSIGNED_TTL_MS - 1000;
    await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
    expect(h.store.getMeta("expires_at")).toBeUndefined();
    h.clock.t = LAUNCH + 3 * UNSIGNED_TTL_MS;
    expect(await h.svc.tick()).toEqual({ expired: false });
    // Its next wake-up is its own deadline, not an expiry.
    expect(h.svc.nextWakeAt()).not.toBeNull();
  });
});
