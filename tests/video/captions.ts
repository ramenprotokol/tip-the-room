// The fixed caption track for the submission video (spec 12: no voice, captions only). docs/submission/video-script.md lists it.

export interface Mark {
  start: number;
  end: number;
  /** squeeze: a slow wait shown in a few seconds; fast: shown at 2x. */
  kind: "squeeze" | "fast";
}

export interface Timeline {
  segments: Mark[];
  popup: { start: number; end: number } | null;
  total: number;
}

export const CAPTIONS = {
  intro: "Tip the Room: fans hold a spot with PayPal. Nobody's charged unless the show happens.",
  demo: "Two sample shows. Each bulb is a fan whose $15 is on hold in the PayPal sandbox, not charged.",
  seating: "The starting fans are real sandbox card holds, seated by each show's agent (sped up).",
  pledge: "A judge holds a spot with the real PayPal sandbox popup (sped up 2x).",
  held: "PayPal holds the money. Nothing is charged unless the show happens.",
  pace: "Check pace now: show B is behind (sped up).",
  ask: "The agent proposes a fix and explains it. The artist must approve: the signed rules decide.",
  add: "Add fans to show B (sped up).",
  skip: "Skip to the deadline (sped up).",
  tip: "Show A reached its target: the agent charges every hold at once.",
  miss: "Show B fell short: every hold is cancelled. Nobody pays.",
  paid: "At the deadline, one PayPal payout batch pays the room, the opener and the artist.",
  ledger: "The settlement ledger (AG Grid): every hold, charge, cancel and payout, with real PayPal sandbox ids.",
  log: "The agent log: what it saw, what it did, and which signed rule allowed it.",
  start: "An artist starts a show in one sentence. Workers AI drafts it; code computes the fan target.",
  sign: "Hold to sign the money rules. That signature is the mandate the agent must follow.",
  share: "A share link and QR code for fans.",
} as const;

export const END_CARD = "Tip the Room · PayPal Orders, Authorizations, Payouts, Webhooks · Cloudflare Workers AI · AG Grid · Cloudflare Workers, Durable Objects, Pages · github.com/ramenprotokol/tip-the-room";
