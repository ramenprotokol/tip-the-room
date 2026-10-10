// Fixed API answers for the GPU tests. Times are UTC and every show's timeZone is "UTC", so the pages print the
// reference's sample times whatever the test machine's zone is. `now` is the reference's "now": Mon Nov 9 9:00am on
// the fan and show pages, Mon Nov 16 10:19am on the demo.
import type { CampaignState } from "../../src/core/campaign";
import type { RuleId } from "../../src/core/rules";
import type { AgentLogDto, AuthorizeResponse, BulbStatus, CreateOrderResponse, CreateShowResponse, DemoResponse, LedgerRowDto, LedgerStatus, ManageParty, ManageView, ProposalDto, PublicParty, PublicShow, SignResponse, StatusWords } from "../../src/worker/api-types";
import { apiError, type FakeApi, type FakeReply } from "./fake-api";

export const T = (mo: number, d: number, h: number, mi = 0): number => Date.UTC(2026, mo - 1, d, h, mi);
const iso = (ms: number) => new Date(ms).toISOString();
const usd = (dollars: number) => "$" + Math.round(dollars).toLocaleString("en-US");

const WORDS: Record<CampaignState, StatusWords> = { draft: "Draft", live: "Waiting for fans", tipped: "It's on!", paying_out: "Paying everyone", settled: "Everyone's paid", missed: "Called off · nobody paid", cancelled: "Called off · refunding" };
const INITIALS = ["JR", "AK", "LM", "TD", "SO", "PB", "NV", "CH", "EW", "RG", "MI", "BF", "OT", "KS", "DL", "HY", "QA", "UZ", "WN", "XE", "GP", "VC", "IB", "FM", "YJ", "ZR"];

export interface ShowBase {
  showId: string;
  showName: string;
  roomName: string;
  showDate: string;
  price: number;
  threshold: number;
  deadline: number;
  launchedAt: number;
  now: number;
  split: PublicParty[];
}
export interface ShowState {
  fans: number;
  state?: CampaignState;
  deadline?: number;
  now?: number;
  version?: number;
  threshold?: number;
  tag?: { at: number; initials: string };
}

export function showOf(b: ShowBase, s: ShowState): PublicShow {
  const state = s.state ?? "live";
  const threshold = s.threshold ?? b.threshold;
  const status: BulbStatus = state === "live" || state === "draft" ? "held" : state === "missed" ? "released" : state === "cancelled" ? "refunded" : "charged";
  const n = s.fans;
  const count = (k: BulbStatus) => (status === k ? n : 0);
  return {
    showId: b.showId,
    demo: true,
    state,
    status: WORDS[state],
    showName: b.showName,
    roomName: b.roomName,
    showDate: b.showDate,
    timeZone: "UTC",
    ticketPriceCents: b.price,
    threshold,
    deadline: iso(s.deadline ?? b.deadline),
    launchedAt: iso(b.launchedAt),
    fans: { committed: n, held: count("held"), charged: count("charged"), released: count("released"), refunded: count("refunded"), failed: 0, more: Math.max(0, threshold - n) },
    money: { heldCents: count("held") * b.price, chargedCents: count("charged") * b.price },
    bulbs: Array.from({ length: n }, (_, i) => ({ initials: s.tag && s.tag.at === i ? s.tag.initials : INITIALS[i % INITIALS.length], status })),
    split: b.split,
    mandateHash: "9f2c41e7b0d4a3c58e61f2a7d9b04c3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
    paypalClientId: "",
    now: s.now ?? b.now,
    version: `e${s.version ?? 1}.l${s.version ?? 1}`,
  };
}

const line = (seq: number, at: number, did: string, saw: string, rule: RuleId | null = null): AgentLogDto => ({ seq, at, saw, did, rule, requestId: null, resultId: null, source: "code" });

/* ---------------- Maya's show (pledge, manage, start) ---------------- */

export const MAYA_ID = "acoustic-set-nov20";
export const MAYA_KEY = "k-7Q2M9X4T";
export const MAYA: ShowBase = {
  showId: MAYA_ID,
  showName: "Acoustic Set",
  roomName: "Lucky’s Café",
  showDate: "2026-11-20",
  price: 1500,
  threshold: 21,
  deadline: T(11, 12, 18),
  launchedAt: T(11, 2, 16, 12),
  now: T(11, 9, 9),
  split: [
    { role: "room", label: "Lucky’s Café", fixedCents: 10000, minimumCents: null },
    { role: "artist", label: "Maya", fixedCents: null, minimumCents: 20000 },
  ],
};
const NEW_DEADLINE = T(11, 16, 18);

export function mayaParties(status: ManageParty["payoutStatus"], paid = false): ManageParty[] {
  return [
    { role: "room", label: "Lucky’s Café", fixedCents: 10000, minimumCents: null, paypalEmail: "luckys-cafe@example.com", payoutCents: paid ? 10000 : null, payoutStatus: status },
    { role: "artist", label: "Maya", fixedCents: null, minimumCents: 20000, paypalEmail: "maya@example.com", payoutCents: paid ? 21500 : null, payoutStatus: status },
  ];
}

// The reference's twelve "Fan held a spot" stamps (reference/v2/manage.html STAMPS: month 11, day, hour, minute); later fans use its "Nov 9 · 9:{10+i}am".
const STAMPS: [number, number, number][] = [[3, 19, 12], [3, 21, 40], [4, 8, 5], [4, 18, 31], [5, 12, 17], [5, 22, 2], [6, 19, 48], [7, 11, 26], [7, 16, 53], [8, 14, 15], [8, 21, 37], [9, 8, 41]];
const stampOf = (i: number): number => (STAMPS[i] ? T(11, STAMPS[i][0], STAMPS[i][1], STAMPS[i][2]) : T(11, 9, 9, 10 + i));
export function holdRows(fans: number, status: LedgerStatus): LedgerRowDto[] {
  return Array.from({ length: fans }, (_, i) => ({ seq: i + 1, at: stampOf(i), what: "Fan held a spot", who: `Fan ${String(i + 1).padStart(2, "0")} · ${INITIALS[i]}`, amountCents: 1500, ref: `SAMPLE-AUTH-${String(i + 1).padStart(3, "0")}`, status })).reverse();
}

const ML = {
  signed: line(1, T(11, 8, 16, 12), "You signed the money rules. Your show is live.", "rules frozen · v1 · hash 9f2c41e7"),
  first: line(2, T(11, 3, 19, 12), "Your first fan held a spot. PayPal is holding $15.", "1 PayPal authorization", "rule-1-hold-only"),
  pace: line(3, T(11, 9, 9), "Pace check: 12 of 21 with 3 days left. I asked you about the deadline.", "projected 17 by the deadline · money rule 5 needs your OK"),
  approved: line(4, T(11, 9, 9, 11), "You approved it. The new deadline is Mon Nov 16, 6pm. Fans see it now.", "deadline extended once, +4 days · money rule 5 · approved by you"),
  five: line(5, T(11, 9, 9, 12), "5 more fans held a spot. PayPal is holding their $75.", "5 PayPal authorizations", "rule-1-hold-only"),
  four: line(6, T(11, 9, 9, 13), "4 more fans held a spot. PayPal is holding their $60.", "4 PayPal authorizations", "rule-1-hold-only"),
  tip: line(7, T(11, 9, 9, 15), "Your show reached 21 fans. It’s on! Everyone was charged at once: $315.", "captured 21 PayPal authorizations at tipping", "rule-2-capture-at-tip"),
  // Deliberate: the paid and missed lines are stamped Thu Nov 12 6pm (the original deadline) even after the extension, because reference/v2/manage.html prints exactly that.
  paid: line(8, T(11, 12, 18), "Deadline reached. Paid Lucky’s Café $100, then you $215.", "1 PayPal payout batch · 2 items", "rule-4-pay-the-split"),
  declined: line(4, T(11, 9, 9, 11), "You said not now. I’ll check the pace again tomorrow morning.", "proposal declined · no change"),
  missed: line(5, T(11, 12, 18), "Your show ended at 12 of 21. Every hold was cancelled. Nobody paid.", "voided 12 PayPal authorizations", "rule-3-void-on-miss"),
};

const PACE: ProposalDto = {
  proposalId: "pace1",
  explanation: "Lucky’s Café is at 12 of 21 with 3 days left. At this pace it lands near 17.",
  recommend: "extend",
  source: "template",
  options: [{ id: "extend", label: "Extend 4 days", newDeadline: iso(NEW_DEADLINE), newThreshold: null }],
  approved: null,
};

function manageView(show: PublicShow, o: { log: AgentLogDto[]; proposals?: ProposalDto[]; parties?: ManageParty[]; ledger?: LedgerRowDto[]; attention?: string[] }): ManageView {
  return { show, ledger: o.ledger ?? [], log: [...o.log].reverse(), proposals: o.proposals ?? [], parties: o.parties ?? mayaParties("planned"), notes: [], attention: o.attention ?? [], collectedNetCents: 0, now: show.now, version: show.version, sharePath: `/s/${show.showId}` };
}

export const MANAGE_FRAMES = {
  initial: manageView(showOf(MAYA, { fans: 12 }), { log: [ML.signed, ML.first, ML.pace], proposals: [PACE], ledger: holdRows(12, "On hold") }),
  approved: manageView(showOf(MAYA, { fans: 12, deadline: NEW_DEADLINE, version: 2 }), { log: [ML.signed, ML.first, ML.pace, ML.approved], proposals: [{ ...PACE, approved: "extend" }], ledger: holdRows(12, "On hold") }),
  fans17: manageView(showOf(MAYA, { fans: 17, deadline: NEW_DEADLINE, version: 3 }), { log: [ML.signed, ML.first, ML.pace, ML.approved, ML.five], proposals: [{ ...PACE, approved: "extend" }], ledger: holdRows(17, "On hold") }),
  tipped: manageView(showOf(MAYA, { fans: 21, state: "tipped", deadline: NEW_DEADLINE, version: 4 }), { log: [ML.signed, ML.first, ML.pace, ML.approved, ML.five, ML.four, ML.tip], proposals: [{ ...PACE, approved: "extend" }], ledger: holdRows(21, "Charged") }),
  paid: manageView(showOf(MAYA, { fans: 21, state: "settled", deadline: NEW_DEADLINE, version: 5 }), { log: [ML.signed, ML.first, ML.pace, ML.approved, ML.five, ML.four, ML.tip, ML.paid], proposals: [{ ...PACE, approved: "extend" }], parties: mayaParties("paid", true), ledger: holdRows(21, "Charged") }),
  declined: manageView(showOf(MAYA, { fans: 12, version: 2 }), { log: [ML.signed, ML.first, ML.pace, ML.declined], proposals: [PACE], ledger: holdRows(12, "On hold") }),
  missed: manageView(showOf(MAYA, { fans: 12, state: "missed", version: 3 }), { log: [ML.signed, ML.first, ML.pace, ML.declined, ML.missed], proposals: [PACE], ledger: holdRows(12, "Cancelled") }),
};

/** Frames served in order, one per GET /manage: boot, then one per page action (approve or decline refresh, then each hook). */
export const MANAGE_SCRIPTS = {
  tipped: [MANAGE_FRAMES.initial, MANAGE_FRAMES.approved, MANAGE_FRAMES.fans17, MANAGE_FRAMES.tipped],
  paid: [MANAGE_FRAMES.initial, MANAGE_FRAMES.approved, MANAGE_FRAMES.fans17, MANAGE_FRAMES.tipped, MANAGE_FRAMES.paid],
  calledOff: [MANAGE_FRAMES.initial, MANAGE_FRAMES.declined, MANAGE_FRAMES.missed],
};

export function manageApi(frames: ManageView[]): FakeApi {
  let served = 0;
  const base = `/api/shows/${MAYA_ID}`;
  const current = () => frames[Math.min(Math.max(served - 1, 0), frames.length - 1)];
  return (req) => {
    if (req.method === "GET" && req.path === `${base}/manage`) {
      if (req.key !== MAYA_KEY) return apiError(403, "forbidden", "That private link doesn't match this show.");
      const v = frames[Math.min(served, frames.length - 1)];
      served += 1;
      return { body: v };
    }
    if (req.method === "GET" && req.path === base) return { body: current().show };
    if (req.method === "POST" && req.path === `${base}/proposals/pace1/approve`) return { body: { proposalId: "pace1", option: "extend", rule: "rule-5-ask-first", show: showOf(MAYA, { fans: 12, deadline: NEW_DEADLINE, version: 2 }) } };
    if (req.method === "POST" && req.path === `${base}/proposals/pace1/decline`) return { body: { proposalId: "pace1", show: current().show } };
    if (req.method === "POST" && req.path === `${base}/call-off`) return { body: { show: showOf(MAYA, { fans: 21, state: "cancelled", deadline: NEW_DEADLINE, version: 9 }) } };
    return undefined;
  };
}

/* ---------------- fan pledge ---------------- */

export const PLEDGE_ORDER = "5O190127TN364715T";

/** GET the show (12 of 21), create orders (a new id each time), authorize → 13 fans with the fan's initials. `authorize(n)` may override the n-th answer. */
export function pledgeApi(opts: { show?: PublicShow; authorize?: (n: number) => FakeReply | undefined } = {}): FakeApi {
  let orders = 0;
  let authorizes = 0;
  let initials = "YOU";
  const base = `/api/shows/${MAYA_ID}`;
  return (req) => {
    if (req.method === "GET" && req.path === base) return { body: opts.show ?? showOf(MAYA, { fans: 12 }) };
    if (req.method === "POST" && req.path === `${base}/orders`) {
      orders += 1;
      const ini = (req.body as { initials?: unknown } | null)?.initials;
      initials = typeof ini === "string" ? ini : "YOU";
      const r: CreateOrderResponse = { orderId: `${PLEDGE_ORDER}${orders > 1 ? orders : ""}`, pledgeId: `pfixture${orders}`, amountCents: 1500 };
      return { status: 201, body: r };
    }
    if (req.method === "POST" && /^\/api\/shows\/acoustic-set-nov20\/orders\/[A-Z0-9]+\/authorize$/.test(req.path)) {
      authorizes += 1;
      const custom = opts.authorize?.(authorizes);
      if (custom) return custom;
      const r: AuthorizeResponse = { pledgeId: `pfixture${orders}`, status: "held", tipped: false, show: showOf(MAYA, { fans: 13, version: 2, tag: { at: 12, initials } }) };
      return { body: r };
    }
    return undefined;
  };
}

/* ---------------- start a show ---------------- */

export const START_CREATE: CreateShowResponse = {
  showId: MAYA_ID,
  signToken: "sign-token-fixture-0123456789",
  draft: {
    showName: "Acoustic Set",
    roomName: "Lucky’s Café",
    showDate: "2026-11-20",
    ticketPriceCents: 1500,
    feeBufferBps: 500,
    deadline: iso(T(11, 12, 18)),
    timeZone: "UTC",
    parties: [
      { role: "room", label: "Lucky’s Café", paypalEmail: "", fixedCents: 10000 },
      { role: "artist", label: "Maya", paypalEmail: "", minimumCents: 20000 },
    ],
  },
  threshold: 21,
  problems: [],
  source: "template",
};

export const START_SIGNED: SignResponse = {
  showId: MAYA_ID,
  manageKey: MAYA_KEY,
  mandateHash: "9f2c41e7b0d4a3c58e61f2a7d9b04c3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
  threshold: 21,
  deadline: iso(T(11, 12, 18)),
  sharePath: `/s/${MAYA_ID}`,
  managePath: `/s/${MAYA_ID}/manage`,
  show: showOf({ ...MAYA, now: T(11, 2, 16, 12) }, { fans: 0 }),
};

export function startApi(opts: { create?: FakeReply; sign?: FakeReply } = {}): FakeApi {
  return (req) => {
    if (req.method === "POST" && req.path === "/api/shows") return opts.create ?? { status: 201, body: START_CREATE };
    if (req.method === "POST" && req.path === `/api/shows/${MAYA_ID}/sign`) return opts.sign ?? { body: START_SIGNED };
    return undefined;
  };
}

/* ---------------- the judge demo (stateful, replays the reference's T / P / M keys) ---------------- */

export const DEMO_ID = "dparityfixt";
export const DEMO_KEY = "demo-key-fixture";
const DEMO_NOW = T(11, 16, 10, 19);
const SHOW_A: ShowBase = {
  showId: `${DEMO_ID}a`, showName: "Juniper Vale", roomName: "Spindle Records", showDate: "2026-11-20", price: 1500, threshold: 34, deadline: T(11, 18, 18), launchedAt: T(11, 15, 12), now: DEMO_NOW,
  split: [
    { role: "room", label: "Spindle Records", fixedCents: 8000, minimumCents: null },
    { role: "opener", label: "The Low Tides", fixedCents: 10000, minimumCents: null },
    { role: "artist", label: "Juniper Vale", fixedCents: null, minimumCents: 30000 },
  ],
};
const SHOW_B: ShowBase = {
  showId: `${DEMO_ID}b`, showName: "Marlow Finch", roomName: "Elm St house", showDate: "2026-11-22", price: 1200, threshold: 28, deadline: T(11, 20, 18), launchedAt: T(11, 15, 12), now: DEMO_NOW,
  split: [
    { role: "room", label: "Elm St house", fixedCents: 6000, minimumCents: null },
    { role: "opener", label: "The opener", fixedCents: 4000, minimumCents: null },
    { role: "artist", label: "Marlow Finch", fixedCents: null, minimumCents: 22000 },
  ],
};

function demoParties(b: ShowBase, fans: number, status: ManageParty["payoutStatus"], paid: boolean): ManageParty[] {
  let rest = fans * b.price;
  return b.split.map((p) => {
    const v = p.role === "artist" ? rest : Math.min(p.fixedCents ?? 0, rest);
    rest -= v;
    return { ...p, paypalEmail: `${p.role}@example.com`, payoutCents: paid ? v : null, payoutStatus: status };
  });
}

interface DemoSide { base: ShowBase; show: PublicShow; log: AgentLogDto[]; parties: ManageParty[]; proposals: ProposalDto[]; version: number }

/** `callOff`: a skip to the deadline finds the tipped show called off by its artist (state cancelled) instead of paid. */
export function demoApi(payout: ManageParty["payoutStatus"] = "paid", opts: { callOff?: boolean } = {}): FakeApi {
  let seq = 0;
  let minute = 19;
  let a: DemoSide;
  let b: DemoSide;
  const fresh = (base: ShowBase, fans: number): DemoSide => ({ base, show: showOf(base, { fans }), log: [], parties: demoParties(base, fans, "planned", false), proposals: [], version: 1 });
  const reset = () => {
    seq = 0;
    minute = 19;
    a = fresh(SHOW_A, 29);
    b = fresh(SHOW_B, 19);
  };
  reset();
  const stamp = () => T(11, 16, 10, ++minute);
  const push = (s: DemoSide, at: number, did: string, saw: string, rule: RuleId | null) => s.log.push(line(++seq, at, did, saw, rule));
  const set = (s: DemoSide, st: ShowState) => {
    s.version += 1;
    s.show = showOf(s.base, { ...st, version: s.version });
  };
  const side = (k: unknown) => (k === "b" ? b : a);
  const response = (): DemoResponse => ({ demoId: DEMO_ID, demoKey: DEMO_KEY, shows: [a.show, b.show], expiresAt: Date.now() + 86_400_000 });
  const view = (s: DemoSide): ManageView => ({ show: s.show, ledger: [], log: [...s.log].reverse(), proposals: s.proposals, parties: s.parties, notes: [], attention: [], collectedNetCents: 0, now: s.show.now, version: s.show.version, sharePath: `/s/${s.show.showId}` });

  function addFans(s: DemoSide, n: number) {
    const fans = s.show.fans.committed;
    const name = s.base.showName;
    const price = s.base.price / 100;
    if (s.show.state === "tipped") {
      set(s, { fans: fans + n, state: "tipped" });
      push(s, stamp(), `${n} more fans joined after it tipped, and were charged right away: ${usd(n * price)}.`, "captured on approval", "rule-2-capture-at-tip");
      return;
    }
    if (s.show.state !== "live") return;
    const now = fans + n;
    const tipped = now >= s.base.threshold;
    set(s, { fans: now, state: tipped ? "tipped" : "live" });
    push(s, stamp(), `${n} more fan${n > 1 ? "s" : ""} joined ${name}. PayPal is holding their ${usd(n * price)}.`, `${n} PayPal authorization${n > 1 ? "s" : ""}`, "rule-1-hold-only");
    if (tipped) push(s, stamp(), `${name} reached ${now} fans. It’s on! Everyone was charged at once: ${usd(now * price)}.`, `captured ${now} PayPal authorizations at tipping`, "rule-2-capture-at-tip");
  }

  function fastForward(s: DemoSide) {
    const fans = s.show.fans.committed;
    const deadline = Date.parse(s.show.deadline);
    if (s.show.state === "tipped" && opts.callOff) {
      set(s, { fans, state: "cancelled" });
      push(s, stamp(), `${s.base.showName} was called off by the artist. Every fan who was charged is getting ${usd(s.base.price / 100)} back.`, `refunding ${fans} captures`, null);
    } else if (s.show.state === "tipped") {
      set(s, { fans, state: "settled", now: deadline + 1000 });
      s.parties = demoParties(s.base, fans, payout, true);
      const paid = s.parties.map((p) => `${p.label} ${usd((p.payoutCents ?? 0) / 100)}`).join(", then ");
      push(s, deadline, `Deadline reached. Paid ${paid}.`, `1 PayPal payout batch · ${s.parties.length} items`, "rule-4-pay-the-split");
    } else if (s.show.state === "live") {
      set(s, { fans, state: "missed", now: deadline + 1000 });
      push(s, deadline, `${s.base.showName} ended at ${fans} of ${s.base.threshold}. Every hold was cancelled. Nobody paid.`, `voided ${fans} PayPal authorizations`, "rule-3-void-on-miss");
    }
  }

  function pace() {
    if (a.show.state === "live") {
      set(a, { fans: a.show.fans.committed });
      push(a, stamp(), "On pace. Nothing to change.", `${a.show.fans.committed} of 34 fans with 1 day left (75% of the way). At this pace, about 39.`, null);
    }
    if (b.show.state === "live" && b.proposals.length === 0) {
      set(b, { fans: b.show.fans.committed });
      b.proposals = [{ proposalId: "pace1", explanation: "Marlow Finch is at 19 of 28 with 1 day left. At this pace it lands near 25.", recommend: "extend", source: "template", options: [{ id: "extend", label: "Extend 7 days", newDeadline: iso(T(11, 27, 18)), newThreshold: null }, { id: "lower", label: "Lower the target to 25", newDeadline: null, newThreshold: 25 }], approved: null }];
      push(b, stamp(), "Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist.", "19 of 28 fans with 1 day left (75% of the way). At this pace, about 25.", "rule-5-ask-first");
    }
  }

  return (req) => {
    const p = req.path;
    if (req.method === "POST" && p === "/api/demo") return { status: 201, body: response() };
    for (const s of [a, b]) {
      if (req.method === "GET" && p === `/api/shows/${s.show.showId}`) return { body: s.show };
      if (req.method === "GET" && p === `/api/shows/${s.show.showId}/manage`) return req.key === DEMO_KEY ? { body: view(s) } : apiError(403, "forbidden", "That private link doesn't match this show.");
    }
    if (req.method !== "POST" || !p.startsWith(`/api/demo/${DEMO_ID}/`)) return undefined;
    if (req.key !== DEMO_KEY) return apiError(403, "forbidden", "That private link doesn't match this show.");
    const body = (req.body ?? {}) as { show?: unknown; count?: unknown };
    if (p.endsWith("/fans")) {
      const s = side(body.show);
      addFans(s, typeof body.count === "number" ? body.count : 0);
      return { body: { queued: body.count, show: s.show } };
    }
    if (p.endsWith("/fast-forward")) {
      fastForward(side(body.show));
      return { body: { shows: [a.show, b.show] } };
    }
    if (p.endsWith("/pace")) {
      pace();
      return { body: { shows: [a.show, b.show] } };
    }
    if (p.endsWith("/reset")) {
      reset();
      return { status: 201, body: response() };
    }
    return undefined;
  };
}
