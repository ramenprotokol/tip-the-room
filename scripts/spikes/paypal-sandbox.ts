// Day-1 PayPal sandbox spike. Run: npm run spike
// Prints only statuses, PayPal error names and ids. Never prints keys or tokens.
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../../src/paypal/config";
import { PayPalError } from "../../src/paypal/errors";
import { PayPalHttp } from "../../src/paypal/http";
import { redact } from "../lib/redact";

const FIX = "tests/paypal/fixtures";
mkdirSync(FIX, { recursive: true });
const http = new PayPalHttp(loadConfig(process.env));
const run = `spike-${Date.now()}`;
const results: { check: string; ok: boolean; detail: string }[] = [];

function save(name: string, body: unknown) {
  writeFileSync(`${FIX}/${name}.json`, JSON.stringify(redact(body), null, 2) + "\n");
}
function record(check: string, ok: boolean, detail: string) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${check}  ·  ${detail}`);
}
function errDetail(e: unknown): string {
  return e instanceof PayPalError ? `${e.status} ${e.paypalName} [${e.issues.map((i) => i.issue).join(", ")}] debug_id=${e.debugId ?? "-"}` : String(e);
}

type Auth = { id: string; status: string; create_time?: string; expiration_time?: string };
type Order = { id: string; status: string; purchase_units?: { payments?: { authorizations?: Auth[] } }[] };

type Amt = { currency_code?: string; value?: string };
type Breakdown = { gross_amount?: Amt; paypal_fee?: Amt; net_amount?: Amt; total_refunded_amount?: Amt; exchange_rate?: Record<string, unknown> };
type CaptureBody = { id: string; status: string; seller_receivable_breakdown?: Breakdown };
type RefundBody = { id: string; status: string; seller_payable_breakdown?: Breakdown; seller_receivable_breakdown?: Breakdown };
/** Amount plus currency code only; nothing personal. */
const money = (a?: Amt) => (a ? `${a.value} ${a.currency_code}` : "absent");

const CARDS = ["4111111111111111", "4032039317984658"];
let cardIdx = 0;

/** Spike 3, option 1: a server-side card authorization (no buyer login). */
async function cardHold(tag: string): Promise<Auth> {
  const order = (await http.request<Order>({
    method: "POST",
    path: "/v2/checkout/orders",
    requestId: `${run}-order-${tag}-c${cardIdx}`,
    prefer: "return=representation",
    body: {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: "pledge", custom_id: `${run}:${tag}`, amount: { currency_code: "USD", value: "15.00" } }],
      payment_source: { card: { number: CARDS[cardIdx], expiry: "2030-12", security_code: "123", name: "Simulated Fan" } },
    },
  }))!;
  if (tag === "a") save("order-card-authorize", order);
  let auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) {
    // The order was created but not authorized yet: authorize it explicitly.
    const authorized = (await http.request<Order>({ method: "POST", path: `/v2/checkout/orders/${order.id}/authorize`, requestId: `${run}-authorize-${tag}-c${cardIdx}`, prefer: "return=representation", body: {} }))!;
    if (tag === "a") save("authorize-order", authorized);
    auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
  }
  if (!auth) throw new Error(`order ${order.id} (${order.status}) has no authorization`);
  return auth;
}

async function main() {
  // 1. Token
  try {
    await http.token();
    record("token", true, "issued");
  } catch (e) {
    record("token", false, errDetail(e));
    return;
  }

  // 2. Card hold (spike 3 option 1) + capture + idempotent replay
  let captureId: string | undefined;
  try {
    let a: Auth | undefined;
    try {
      a = await cardHold("a");
    } catch (e) {
      record("card hold (card 1)", false, errDetail(e));
      cardIdx = 1;
      a = await cardHold("a");
    }
    record("card hold", true, `authorization ${a.id} status ${a.status} created ${a.create_time} expires ${a.expiration_time} (card ${cardIdx + 1})`);
    const cap = await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${a.id}/capture`, requestId: `capture:${a.id}`, prefer: "return=representation", body: { final_capture: true } });
    save("capture", cap);
    captureId = cap!.id;
    const sb = cap!.seller_receivable_breakdown;
    record(
      "capture",
      cap!.status === "COMPLETED",
      `capture ${cap!.id} status ${cap!.status}; gross ${money(sb?.gross_amount)}, fee ${money(sb?.paypal_fee)}, net ${money(sb?.net_amount)}, exchange_rate ${sb?.exchange_rate ? JSON.stringify(sb.exchange_rate) : "absent"}`,
    );
    const again = await http.request<CaptureBody>({ method: "POST", path: `/v2/payments/authorizations/${a.id}/capture`, requestId: `capture:${a.id}`, prefer: "return=representation", body: { final_capture: true } });
    save("capture-replay", again);
    record("capture replay is idempotent", again!.id === cap!.id, `replay returned ${again!.id}`);
  } catch (e) {
    record("card hold / capture", false, errDetail(e));
  }

  // 3. Void
  try {
    const b = await cardHold("b");
    const v = await http.request<{ status?: string }>({ method: "POST", path: `/v2/payments/authorizations/${b.id}/void`, requestId: `void:${b.id}`, prefer: "return=representation" });
    save("void", v ?? { status: 204 });
    const voided = v == null || v.status === "VOIDED";
    record("void", voided, v == null ? `void ${b.id} returned no body (204)` : `void ${b.id} body status ${v.status ?? "absent"}`);
  } catch (e) {
    record("void", false, errDetail(e));
  }

  // 4. Reauthorize inside the honor period (expected to be refused; record exactly how)
  try {
    const c = await cardHold("c");
    const r = await http.request({ method: "POST", path: `/v2/payments/authorizations/${c.id}/reauthorize`, requestId: `reauth:${c.id}`, prefer: "return=representation", body: { amount: { currency_code: "USD", value: "15.00" } } });
    save("reauthorize-error", { unexpectedSuccess: r });
    record("reauthorize on day 0", false, "UNEXPECTED: allowed on day 0");
    await http.request({ method: "POST", path: `/v2/payments/authorizations/${c.id}/void`, requestId: `void:${c.id}` }).catch(() => undefined);
  } catch (e) {
    if (e instanceof PayPalError) save("reauthorize-error", { status: e.status, name: e.paypalName, issues: e.issues });
    record("reauthorize on day 0 refused (expected)", e instanceof PayPalError && e.status < 500, errDetail(e));
  }

  // 5. Refund
  if (captureId) {
    try {
      const rf = await http.request<RefundBody>({ method: "POST", path: `/v2/payments/captures/${captureId}/refund`, requestId: `refund:${captureId}`, prefer: "return=representation", body: {} });
      save("refund", rf);
      const shape = rf!.seller_payable_breakdown ? "seller_payable_breakdown" : rf!.seller_receivable_breakdown ? "seller_receivable_breakdown" : "neither breakdown";
      const bd = rf!.seller_payable_breakdown ?? rf!.seller_receivable_breakdown;
      record(
        "refund",
        true,
        `refund ${rf!.id} status ${rf!.status}; body has ${shape} (payable ${rf!.seller_payable_breakdown ? "yes" : "no"}, receivable ${rf!.seller_receivable_breakdown ? "yes" : "no"}); gross ${money(bd?.gross_amount)}, fee ${money(bd?.paypal_fee)}, net ${money(bd?.net_amount)}, total_refunded ${money(bd?.total_refunded_amount)}`,
      );
    } catch (e) {
      record("refund", false, errDetail(e));
    }
  }

  // 6. Payouts (spike 2) + duplicate sender_batch_id
  const receiver = process.env.PAYPAL_SPIKE_PAYOUT_EMAIL?.trim() || "spike-room@example.com";
  const batch = {
    sender_batch_header: { sender_batch_id: `payout-${run}`, email_subject: "Tip the Room payout", recipient_type: "EMAIL" },
    items: [{ recipient_type: "EMAIL", receiver, amount: { value: "1.00", currency: "USD" }, sender_item_id: `${run}-room`, note: "Spike payout" }],
  };
  try {
    const p = await http.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>({ method: "POST", path: "/v1/payments/payouts", requestId: `payout-${run}`, body: batch });
    save("payout-create", p);
    record("payouts enabled", true, `batch ${p!.batch_header.payout_batch_id} status ${p!.batch_header.batch_status} (receiver is ${receiver === "spike-room@example.com" ? "an unclaimed example address" : "PAYPAL_SPIKE_PAYOUT_EMAIL"})`);
    try {
      const dup = await http.request({ method: "POST", path: "/v1/payments/payouts", requestId: `payout-${run}-dup`, body: batch });
      save("payout-duplicate", { unexpectedSuccess: dup });
      record("duplicate sender_batch_id refused", false, "UNEXPECTED: PayPal accepted a second batch with the same sender_batch_id");
    } catch (e) {
      if (e instanceof PayPalError) save("payout-duplicate", { status: e.status, name: e.paypalName, issues: e.issues });
      record("duplicate sender_batch_id refused", e instanceof PayPalError, errDetail(e));
    }
    try {
      await new Promise((r) => setTimeout(r, 5000));
      const g = await http.request({ method: "GET", path: `/v1/payments/payouts/${p!.batch_header.payout_batch_id}` });
      save("payout-get", g);
      record("payout batch readable", true, "fetched batch status");
    } catch (e) {
      record("payout batch readable", false, errDetail(e));
    }
  } catch (e) {
    const perm = e instanceof PayPalError && (e.status === 401 || e.status === 403 || /PERMISSION|AUTHORIZ|NOT_AUTHORIZED/i.test(e.paypalName));
    record("payouts enabled", false, perm ? `${errDetail(e)}  → owner may need to tick "Payouts" in the sandbox app's features` : errDetail(e));
  }

  writeFileSync("docs/superpowers/spikes/.spike-results.json", JSON.stringify({ run, results }, null, 2) + "\n");
}

await main();
