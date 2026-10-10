// Request/response types for the Tip the Room API. Plan 5's pages import this file: keep it types-only.
import type { CampaignState } from "../core/campaign";
import type { Cents } from "../core/money";
import type { RuleId } from "../core/rules";
import type { Role } from "../core/split";
import type { AiSource, ProposalOptionId } from "../agent/events";

export const MANAGE_KEY_HEADER = "x-manage-key";

/** Judges' links carry ?judge=<code>; the page sends it on demo create/reset only. */
export const JUDGE_CODE_HEADER = "x-judge-code";

/** What /api/health says about the live setup. Booleans and the PUBLIC PayPal client id only, never a secret. */
export interface SetupReport {
  rateSalt: boolean;
  webhook: boolean;
  judgeCode: boolean;
  receivers: boolean;
  paypalClientId: string | null;
}
export interface HealthResponse {
  ok: true;
  setup: SetupReport;
}

export type ErrorCode = "bad_request" | "not_found" | "forbidden" | "conflict" | "invalid" | "rate_limited" | "paypal_error" | "too_large" | "unavailable" | "internal";

/** Every error body. `message` is plain English and safe to show. */
export interface ApiError {
  error: { code: ErrorCode; message: string; problems?: string[]; retryAfterSec?: number };
}

export interface PartyInput {
  role: Role;
  label: string;
  paypalEmail: string;
  /** Room, opener, host: what they get, in cents. */
  fixedCents?: Cents;
  /** Artist: the least they must get, in cents. */
  minimumCents?: Cents;
}

/** The editable draft the Start page shows. The server sets showId and launchedAt when signing. */
export interface DraftFields {
  showName: string;
  roomName: string;
  /** YYYY-MM-DD. */
  showDate: string;
  ticketPriceCents: Cents;
  feeBufferBps: number;
  /** ISO timestamp with Z or an offset. */
  deadline: string;
  timeZone: string;
  parties: PartyInput[];
}

export interface CreateShowRequest {
  sentence: string;
  deadline?: string;
  timeZone?: string;
  emails?: Partial<Record<Role, string>>;
}

export interface CreateShowResponse {
  showId: string;
  /** One-time secret needed to sign this draft. Keep it in the browser; it is not stored in plain form. */
  signToken: string;
  draft: DraftFields;
  /** Fan target computed by code (null when the price is missing). */
  threshold: number | null;
  problems: string[];
  source: AiSource;
}

export interface SignRequest {
  signToken: string;
  draft: DraftFields;
}

export interface SignResponse {
  showId: string;
  /** Returned ONCE. Only its SHA-256 hash is stored. Send it as the x-manage-key header. */
  manageKey: string;
  mandateHash: string;
  threshold: number;
  deadline: string;
  sharePath: string;
  managePath: string;
  show: PublicShow;
}

export type StatusWords = "Draft" | "Waiting for fans" | "It's on!" | "Paying everyone" | "Everyone's paid" | "Called off · nobody paid" | "Called off · refunding";
export type BulbStatus = "held" | "charged" | "released" | "refunded" | "failed";

export interface PublicParty {
  role: Role;
  label: string;
  fixedCents: Cents | null;
  minimumCents: Cents | null;
}

/** Everything the pledge page needs. Never contains a PayPal email. */
export interface PublicShow {
  showId: string;
  demo: boolean;
  state: CampaignState;
  /** Read by the worker tests and the e2e run; the pages work the status out from state and fans. */
  status: StatusWords;
  showName: string;
  roomName: string;
  showDate: string;
  timeZone: string;
  ticketPriceCents: Cents;
  threshold: number;
  deadline: string;
  launchedAt: string;
  fans: { committed: number; held: number; charged: number; released: number; refunded: number; failed: number; more: number };
  /** Read by the worker tests and the e2e run. */
  money: { heldCents: Cents; chargedCents: Cents };
  /** One per pledge, in arrival order (bulb slots). */
  bulbs: { initials: string; status: BulbStatus }[];
  split: PublicParty[];
  mandateHash: string;
  /** For the PayPal JS SDK script tag (public value). */
  paypalClientId: string;
  /** The show's own clock in ms (a demo copy's clock runs ahead after fast-forward). Show times relative to this, not to the browser clock. */
  now: number;
  /** Change marker "e<last ledger seq>.l<last log seq>". Poll GET /api/shows/:id and refetch /manage only when it changes. */
  version: string;
}

export interface CreateOrderRequest {
  /** 1 to 3 letters. */
  initials: string;
}

/** Read by scripts/worker-check.ts, the worker tests and the e2e run (the pledge page only needs orderId). */
export interface CreateOrderResponse {
  orderId: string;
  pledgeId: string;
  amountCents: Cents;
}

export interface AuthorizeResponse {
  pledgeId: string;
  status: "held";
  /** True once the show has reached its target (this pledge may have tipped it). */
  tipped: boolean;
  show: PublicShow;
}

export type LedgerStatus = "On hold" | "Charged" | "Paid" | "Cancelled" | "Refunded" | "Failed" | "Pending" | "Sent" | "Info";

export interface LedgerRowDto {
  seq: number;
  at: number;
  what: string;
  who: string;
  amountCents: Cents | null;
  /** PayPal id (small print "PayPal ref" column). */
  ref: string | null;
  status: LedgerStatus;
}

export interface AgentLogDto {
  seq: number;
  at: number;
  saw: string;
  did: string;
  rule: RuleId | null;
  requestId: string | null;
  resultId: string | null;
  source: AiSource | "code";
}

export interface ProposalDto {
  proposalId: string;
  explanation: string;
  recommend: ProposalOptionId | "wait";
  source: AiSource;
  options: { id: ProposalOptionId; label: string; newDeadline: string | null; newThreshold: number | null }[];
  approved: ProposalOptionId | null;
}

export interface DeclineResponse {
  proposalId: string;
  show: PublicShow;
}

export interface DemoPaceResponse {
  shows: [PublicShow, PublicShow];
}

export interface ManageParty extends PublicParty {
  paypalEmail: string;
  payoutCents: Cents | null;
  payoutStatus: "planned" | "funds" | "paid" | "pending" | "failed" | "none";
}

export interface NoteDto {
  role: Role;
  label: string;
  text: string;
  source: AiSource;
}

/** The artist's show page. Ledger and log are newest first. */
export interface ManageView {
  show: PublicShow;
  ledger: LedgerRowDto[];
  log: AgentLogDto[];
  proposals: ProposalDto[];
  parties: ManageParty[];
  notes: NoteDto[];
  /** Plain-English problems that need the artist (failed or blocked steps). */
  attention: string[];
  collectedNetCents: Cents;
  /** Same as show.now and show.version, repeated so the manage page needs only this body. */
  now: number;
  version: string;
  /** "/s/<showId>" */
  sharePath: string;
}

export interface ApproveRequest {
  option: ProposalOptionId;
}

export interface ApproveResponse {
  proposalId: string;
  option: ProposalOptionId;
  rule: RuleId;
  show: PublicShow;
}

export interface CallOffResponse {
  show: PublicShow;
}

export interface DemoResponse {
  demoId: string;
  /** Returned once; works as the x-manage-key for both demo shows and the demo controls. */
  demoKey: string;
  /** [the show that tips, the show that misses]. */
  shows: [PublicShow, PublicShow];
  /** When this demo copy is deleted (real time, ms since epoch): 24 hours after it was made. */
  expiresAt: number;
}

export interface DemoFansRequest {
  show: "a" | "b";
  count: number;
}

export interface DemoFansResponse {
  queued: number;
  show: PublicShow;
}

export interface DemoFastForwardResponse {
  shows: [PublicShow, PublicShow];
}
