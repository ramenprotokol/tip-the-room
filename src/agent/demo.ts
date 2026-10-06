import type { MandateDraft } from "../core/mandate";

export interface Receivers {
  room: string;
  opener: string;
  artist: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Demo payout receivers. Unset (or invalid) → example.com addresses, which PayPal leaves UNCLAIMED.
 * Owner action (Plan 6): create three sandbox PERSONAL accounts and set PAYPAL_RECEIVER_* so payouts reach SUCCESS.
 */
export function receiversFrom(env: { PAYPAL_RECEIVER_ROOM?: string; PAYPAL_RECEIVER_OPENER?: string; PAYPAL_RECEIVER_ARTIST?: string }): Receivers {
  const pick = (v: string | undefined, fallback: string) => (v && EMAIL.test(v.trim()) ? v.trim() : fallback);
  return {
    room: pick(env.PAYPAL_RECEIVER_ROOM, "tip-the-room-room@example.com"),
    opener: pick(env.PAYPAL_RECEIVER_OPENER, "tip-the-room-opener@example.com"),
    artist: pick(env.PAYPAL_RECEIVER_ARTIST, "tip-the-room-artist@example.com"),
  };
}

export interface DemoSeed {
  key: "a" | "b";
  draft: Omit<MandateDraft, "showId" | "launchedAt" | "deadline" | "showDate">;
  /** Time from creation to the deadline (the reference's countdowns). */
  windowMs: number;
  /** Simulated fans seated at creation, as real sandbox card holds. */
  startFans: number;
}

/** The two fictional shows from reference/v2: A tips (34 × $15), B misses (28 × $12). */
export function demoSeeds(r: Receivers): [DemoSeed, DemoSeed] {
  return [
    {
      key: "a",
      windowMs: 200_460_000,
      startFans: 29,
      draft: {
        showName: "Juniper Vale",
        roomName: "Spindle Records",
        ticketPrice: 1500,
        feeBufferBps: 500,
        timeZone: "UTC",
        parties: [
          { role: "room", label: "Spindle Records", paypalEmail: r.room, fixed: 8000 },
          { role: "opener", label: "The Low Tides", paypalEmail: r.opener, fixed: 10000 },
          { role: "artist", label: "Juniper Vale", paypalEmail: r.artist, minimum: 30000 },
        ],
      },
    },
    {
      key: "b",
      windowMs: 373_260_000,
      startFans: 19,
      draft: {
        showName: "Marlow Finch",
        roomName: "Elm St house",
        ticketPrice: 1200,
        feeBufferBps: 500,
        timeZone: "UTC",
        parties: [
          { role: "room", label: "Elm St house", paypalEmail: r.room, fixed: 6000 },
          { role: "opener", label: "The opener", paypalEmail: r.opener, fixed: 4000 },
          { role: "artist", label: "Marlow Finch", paypalEmail: r.artist, minimum: 22000 },
        ],
      },
    },
  ];
}
