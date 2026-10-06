import type { AiDeps } from "../../src/agent/ai";
import { sha256Hex } from "../../src/agent/ids";
import { SIM_CARD } from "../../src/agent/paypal-port";
import { CampaignService } from "../../src/agent/service";
import { Store } from "../../src/agent/store";
import type { AuthorizeResponse, DraftFields } from "../../src/worker/api-types";
import { FakePayPal } from "./fake-paypal";
import { LAUNCH, seqRandom, SHOW, TestClock } from "./fixtures";
import { memoryDb } from "./sqlite";

export const SIGN_TOKEN = "sign-token-for-tests-0123456789";

/** Same rules as fixtures.testMandate(): target 3 fans. */
export const DRAFT: DraftFields = {
  showName: "Acoustic Set",
  roomName: "Lucky's Café",
  showDate: "2026-11-10",
  ticketPriceCents: 1500,
  feeBufferBps: 500,
  deadline: "2026-11-08T00:00:00Z",
  timeZone: "UTC",
  parties: [
    { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixedCents: 2000 },
    { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimumCents: 2000 },
  ],
};

export interface HarnessOptions {
  ai?: AiDeps;
  clock?: TestClock;
  paypal?: FakePayPal;
  store?: Store;
}

export function makeService(opts: HarnessOptions = {}) {
  const store = opts.store ?? new Store(memoryDb());
  const clock = opts.clock ?? new TestClock(LAUNCH);
  const paypal = opts.paypal ?? new FakePayPal(clock);
  const svc = new CampaignService({ store, paypal, clock, ai: opts.ai ?? { ai: null, budget: { tryReserve: async () => true } }, random: seqRandom(), paypalClientId: "test-client-id", card: SIM_CARD });
  return { store, clock, paypal, svc };
}

export async function signedService(opts: HarnessOptions = {}) {
  const h = makeService(opts);
  h.svc.ensureSchema();
  h.svc.init({ showId: SHOW, signTokenHash: await sha256Hex(SIGN_TOKEN) });
  const signed = await h.svc.sign({ signToken: SIGN_TOKEN, draft: DRAFT });
  return { ...h, manageKey: signed.manageKey };
}

export async function pledge(svc: CampaignService, initials = "AB"): Promise<AuthorizeResponse> {
  const order = await svc.createOrder({ initials });
  return svc.authorize(order.orderId);
}
