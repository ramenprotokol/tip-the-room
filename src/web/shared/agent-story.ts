// The agent's story, from its log: which lines fold into one summary row, and which lines are real decisions.
// Pure (no DOM), so it is tested in Node. The DOM side is agent-story-dom.ts.
import { RULES, type RuleId } from "../../core/rules";
import type { AgentLogDto } from "../../worker/api-types";

/** The slice of a log entry this module reads. */
export type StoryEntry = Pick<AgentLogDto, "seq" | "at" | "saw" | "did" | "rule" | "requestId" | "resultId">;

/* ---------------- lines that fold into one summary row ---------------- */

/** Three kinds of line repeat once per fan: a simulated fan's hold, a charge, a cancelled hold. */
export type GroupKind = "seed" | "charge" | "cancel";

const SEED_LINE = /^Simulated .+ held a spot with a real sandbox card hold\./;
const CHARGE_LINE = /^Charged .+ \$[\d,]+(?:\.\d{2})?\. After PayPal's fee/;
const CANCEL_LINE = /^Cancelled .+\. Nobody was charged\.$/;

/** Which summary row a log line folds into, or null when it stands on its own. */
export function groupKind(e: Pick<StoryEntry, "did">): GroupKind | null {
  if (SEED_LINE.test(e.did)) return "seed";
  if (CHARGE_LINE.test(e.did)) return "charge";
  if (CANCEL_LINE.test(e.did)) return "cancel";
  return null;
}

/** First dollar amount in a line, in cents ("Charged Fan 03 · JR $15.00. After ..." gives 1500). 0 when there is none. */
export function firstCents(text: string): number {
  const m = /\$([\d,]+)(?:\.(\d{2}))?/.exec(text);
  if (!m) return 0;
  return Number(m[1].replace(/,/g, "")) * 100 + Number(m[2] ?? 0);
}

export const money = (cents: number): string => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

export interface GroupStat {
  count: number;
  cents: number;
}

/**
 * The one line a folded group shows. `starting` is how many starting fans the show seats (the home page knows; the show page
 * does not): while seating it reads "26 of 29 starting fans held a spot", and fans added after that are counted apart.
 */
export function groupSummary(kind: GroupKind, s: GroupStat, starting?: number): string {
  if (kind === "charge") return `${plural(s.count, "hold")} charged, ${money(s.cents)} in all (one line each, with the PayPal capture id)`;
  if (kind === "cancel") return `${plural(s.count, "hold")} cancelled, nobody charged (one line each)`;
  const real = "real PayPal sandbox card holds";
  if (starting === undefined) return `${plural(s.count, "simulated fan")} held a spot (${real})`;
  if (s.count <= starting) return `${s.count} of ${starting} starting fans held a spot (${real})`;
  return `${starting} starting fans and ${plural(s.count - starting, "added fan")} held a spot (${real})`;
}

/* ---------------- the decisions strip ---------------- */

export type DecisionKind = "checked" | "proposed" | "approved" | "notnow" | "tipped" | "charged" | "missed" | "cancelled" | "paid" | "calledoff";

export interface Decision {
  /** Stable per kind and show, so the strip can update a row in place (a count that grows). */
  key: string;
  kind: DecisionKind;
  /** The show's tag ("a" or "b" on the home page). */
  tag: string;
  text: string;
  /** The money rule that allowed it (display number), or null for a look that moves no money. */
  rule: number | null;
  ruleId: RuleId | null;
  /** A PayPal id worth showing (the payout batch). */
  ref: string | null;
  at: number;
}

export const KIND_WORD: Record<DecisionKind, string> = {
  checked: "On pace",
  proposed: "Proposed",
  approved: "Approved",
  notnow: "Not now",
  tipped: "It’s on",
  charged: "Charged",
  missed: "Missed",
  cancelled: "Cancelled",
  paid: "Paid out",
  calledoff: "Called off",
};

/** Short plain words for each money rule, beside its number. */
export const RULE_SHORT: Record<RuleId, string> = {
  "rule-1-hold-only": "only hold",
  "rule-2-capture-at-tip": "charge at the target",
  "rule-3-void-on-miss": "cancel on a miss",
  "rule-4-pay-the-split": "pay the signed split",
  "rule-5-ask-first": "ask the artist first",
};

export function ruleLabel(id: RuleId): string {
  return `Money rule ${RULES[id].number} · ${RULE_SHORT[id]}`;
}

function one(kind: DecisionKind, tag: string, e: StoryEntry, text: string, ref: string | null = null): Decision {
  const rule = e.rule && RULES[e.rule] ? e.rule : null;
  return { key: `${kind}:${tag}:${e.seq}`, kind, tag, text, rule: rule ? RULES[rule].number : null, ruleId: rule, ref, at: e.at };
}

/**
 * The agent's real decisions, in the order they happened, from every log line a show has shown so far. The per-fan lines
 * collapse into one row each ("Charged 34 holds, $510.00"); a count that is still growing keeps its row and updates it.
 * Each row names the money rule that allowed it. `entries` is oldest first.
 */
export function buildDecisions(entries: ReadonlyArray<StoryEntry & { tag: string }>): Decision[] {
  const out: Decision[] = [];
  const grown = new Map<string, { d: Decision; n: number; cents: number }>();
  const grow = (kind: "charged" | "cancelled", tag: string, e: StoryEntry, cents: number) => {
    const k = `${kind}:${tag}`;
    let g = grown.get(k);
    if (!g) {
      g = { d: one(kind, tag, e, ""), n: 0, cents: 0 };
      g.d.key = k;
      grown.set(k, g);
      out.push(g.d);
    }
    g.n += 1;
    g.cents += cents;
    g.d.at = e.at;
    g.d.text = kind === "charged" ? `Charged ${plural(g.n, "hold")}, ${money(g.cents)}. Every fan who held a spot was charged at once.` : `Cancelled ${plural(g.n, "hold")}. Nobody was charged.`;
  };
  for (const e of entries) {
    const { tag, did } = e;
    if (CHARGE_LINE.test(did)) grow("charged", tag, e, firstCents(did));
    else if (CANCEL_LINE.test(did) && e.rule === "rule-3-void-on-miss") grow("cancelled", tag, e, 0);
    else if (/^On pace\. Nothing to change\.$/.test(did)) out.push(one("checked", tag, e, "Checked the pace: on pace, so nothing to change."));
    else if (/^Proposed: /.test(did)) out.push(one("proposed", tag, e, `Behind pace. ${did}`));
    else if (/^The artist approved "/.test(did)) {
      const q = /^The artist approved ("[^"]*")/.exec(did);
      out.push(one("approved", tag, e, q ? `The artist approved ${q[1]}. The agent applied it.` : did));
    } else if (/^You said not now to /.test(did)) out.push(one("notnow", tag, e, did.replace(/^You said/, "The artist said")));
    else if (/Charging every hold now\.$/.test(did)) {
      const fans = /^(\d+ of \d+ fans)/.exec(e.saw)?.[1];
      out.push(one("tipped", tag, e, `${fans ? `${fans}. ` : ""}${did}`));
    } else if (/^The deadline passed at \d+ of \d+ fans\. Cancelling every hold/.test(did)) out.push(one("missed", tag, e, did));
    else if (/^The artist called the show off\./.test(did)) out.push(one("calledoff", tag, e, did));
    else {
      const sent = /^(Sent the payouts exactly as signed|Tried once more for the payouts that failed): (.+)\.$/.exec(did);
      if (sent) out.push(one("paid", tag, e, `${sent[1] === "Sent the payouts exactly as signed" ? "One payout batch to PayPal" : "Tried the failed payouts again"}: ${sent[2]}.`, e.resultId));
    }
  }
  return out;
}

/* ---------------- Check pace now ---------------- */

/** The share of the window a demo "Check pace now" jumps to (src/agent/policy.ts DEMO_PACE_POINT). */
export const PACE_POINT = 0.75;

export interface PaceShow {
  key: string;
  state: string;
  committed: number;
  target: number;
  /** Fans the demo seats at the start. */
  starting: number;
}

/**
 * Fans a show needs seated before a pace check says what the full demo says: all its starting fans, but never more than it
 * takes to be on pace at the check point (a show that would be on pace is not left waiting for fans past that).
 */
export const paceNeeds = (s: Pick<PaceShow, "target" | "starting">): number => Math.min(s.starting, Math.ceil(s.target * PACE_POINT));

export interface PaceReady {
  ready: boolean;
  /** Plain words for the button's hint while it waits, with the real wait. */
  waiting: string;
}

/** About how long seating takes, from a page load (measured on the sandbox; the copy says "about"). */
export const PACE_WAIT_SECONDS = 30;

export function paceReady(shows: (PaceShow & { name: string })[]): PaceReady {
  const open = shows.filter((s) => s.state === "live");
  const short = open.filter((s) => s.committed < paceNeeds(s));
  if (short.length === 0) return { ready: true, waiting: "" };
  const parts = short.map((s) => `${s.name} ${s.committed} of ${paceNeeds(s)}`);
  return { ready: false, waiting: `Unlocks in about ${PACE_WAIT_SECONDS} seconds, once the starting fans are seated (${parts.join(", ")}).` };
}
