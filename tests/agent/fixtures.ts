import { DAY_MS } from "../../src/core/holds";
import { buildMandate, signMandate, type Mandate } from "../../src/core/mandate";
import { eventKey, type LedgerEvent } from "../../src/agent/events";
import type { Random } from "../../src/agent/ids";
import type { StoredEvent } from "../../src/agent/store";

export const SHOW = "sshowtestaa";
export const LAUNCH = Date.parse("2026-11-01T00:00:00Z");
export const DEADLINE = Date.parse("2026-11-08T00:00:00Z");

/** A clock the test moves by hand. */
export class TestClock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
}

/** Deterministic, never-repeating "random" bytes: each call encodes a fresh counter. */
export function seqRandom(): Random {
  let n = 0;
  return (count) => {
    n += 1;
    const out = new Uint8Array(count);
    let v = n;
    for (let i = count - 1; i >= 0; i--) {
      out[i] = v % 32;
      v = Math.floor(v / 32);
    }
    return out;
  };
}

/** $15 pledges, room $20, artist minimum $20, 5% buffer: (2000 + 2000) × 1.05 / 1500 → target 3 fans. */
export function testMandate(): Mandate {
  return buildMandate({
    showId: SHOW,
    showName: "Acoustic Set",
    roomName: "Lucky's Café",
    showDate: "2026-11-20",
    ticketPrice: 1500,
    feeBufferBps: 500,
    parties: [
      { role: "room", label: "Lucky's Café", paypalEmail: "room@example.com", fixed: 2000 },
      { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimum: 2000 },
    ],
    launchedAt: "2026-11-01T00:00:00Z",
    deadline: "2026-11-08T00:00:00Z",
    timeZone: "UTC",
  });
}

export async function signedEvent(): Promise<LedgerEvent> {
  const s = await signMandate(testMandate(), "2026-11-01T00:00:00Z");
  return { type: "mandate_signed", mandate: s.mandate, hash: s.hash, signedAt: s.signedAt };
}

export function held(n: number, simulated = false): LedgerEvent {
  return { type: "pledge_held", pledgeId: `p${n}`, orderId: `O${n}`, authorizationId: `A${n}`, amountCents: 1500, authorizedAt: LAUNCH + n, expiresAt: LAUNCH + 29 * DAY_MS + n, initials: "AB", simulated };
}

export function captured(n: number, net = 1412): LedgerEvent {
  return { type: "capture_ok", authorizationId: `A${n}`, captureId: `C${n}`, grossCents: 1500, feeCents: 1500 - net, netCents: net };
}

export function stored(events: LedgerEvent[], start = LAUNCH): StoredEvent[] {
  return events.map((event, i) => ({ seq: i + 1, key: eventKey(event), at: start + i, event }));
}
