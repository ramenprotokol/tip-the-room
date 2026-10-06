// Spec 9 sandbox integration run. Run: npm run sandbox:check
// Prints statuses and PayPal ids only. Never prints keys or tokens.
import {
  captureHold,
  createCardHold,
  getCapture,
  getOrderPayments,
  getPayoutBatch,
  isDuplicateBatch,
  loadConfig,
  PayPalError,
  PayPalHttp,
  reauthorizeHold,
  refundCharge,
  sendPayouts,
  voidHold,
  type TestCard,
} from "../src/paypal";

const http = new PayPalHttp(loadConfig(process.env));
const run = `check-${Date.now()}`;
const card: TestCard = { number: "4111111111111111", expiry: "2030-12", securityCode: "123", name: "Simulated Fan" };
const pledge = (id: string) => ({ showId: run, pledgeId: id, amountCents: 1500, description: "Sandbox check hold" });
let failures = 0;

function line(ok: boolean, step: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  ·  ${detail}` : ""}`);
}
async function expectRefused(step: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    line(false, step, "PayPal allowed it");
  } catch (e) {
    line(e instanceof PayPalError && e.status < 500, step, e instanceof PayPalError ? `${e.status} ${e.paypalName} ${e.issues.map((i) => i.issue).join(",")}` : String(e));
  }
}

async function flowA() {
  const hold = await createCardHold(http, pledge("a"), card);
  line(hold.amountCents === 1500, "A · hold", hold.authorizationId);
  const charge = await captureHold(http, hold.authorizationId);
  line(charge.status === "COMPLETED", "A · capture", `${charge.captureId} ${charge.status}`);
  line(Number.isInteger(charge.netCents) && charge.netCents! < (charge.grossCents ?? 0), "A · net after fee", `gross ${charge.grossCents} fee ${charge.feeCents} net ${charge.netCents}`);
  const replay = await captureHold(http, hold.authorizationId);
  line(replay.captureId === charge.captureId, "A · capture replay is idempotent", replay.captureId);
  const refund = await refundCharge(http, charge.captureId);
  line(refund.status === "COMPLETED" || refund.status === "PENDING", "A · refund", `${refund.refundId} ${refund.status}`);
}

async function flowB() {
  const hold = await createCardHold(http, pledge("b"), card);
  await voidHold(http, hold.authorizationId);
  line(true, "B · void", hold.authorizationId);
  await expectRefused("B · capture after void is refused", () => captureHold(http, hold.authorizationId));
}

async function flowC() {
  const hold = await createCardHold(http, pledge("c"), card);
  await expectRefused("C · reauthorize on day 0 is refused (expected)", () => reauthorizeHold(http, hold.authorizationId, 1500));
  await voidHold(http, hold.authorizationId);
}

async function flowD() {
  const receiver = process.env.PAYPAL_SPIKE_PAYOUT_EMAIL?.trim() || "check-room@example.com";
  const lines = [{ role: "room" as const, label: "Sandbox Room", paypalEmail: receiver, amount: 100 }];
  const sent = await sendPayouts(http, run, lines);
  line(true, "D · payout batch", `${sent.batchId} ${sent.status}`);
  try {
    await sendPayouts(http, run, lines);
    line(false, "D · second batch for the same show is refused", "PayPal accepted it");
  } catch (e) {
    line(isDuplicateBatch(e), "D · second batch for the same show is refused", e instanceof PayPalError ? e.paypalName : String(e));
  }
  await new Promise((r) => setTimeout(r, 5000));
  const batch = await getPayoutBatch(http, sent.batchId);
  line(batch.batchId === sent.batchId, "D · batch readable", `${batch.status}, ${batch.items.length} item(s)`);
}

async function flowE() {
  const hold = await createCardHold(http, pledge("e"), card);
  const charge = await captureHold(http, hold.authorizationId);
  const order = await getOrderPayments(http, hold.orderId);
  line(order.captures.some((c) => c.id === charge.captureId) && order.authorizations.some((a) => a.id === hold.authorizationId), "E · order lists its authorization and capture", `${order.status} auth=${order.authorizations.map((a) => a.status).join(",")} capture=${order.captures.map((c) => c.status).join(",")}`);
  const read = await getCapture(http, charge.captureId, hold.authorizationId);
  line(read.netCents === charge.netCents && read.status === "COMPLETED", "E · capture readable with its net", `net ${read.netCents}`);
  await refundCharge(http, charge.captureId);
}

for (const [name, flow] of [["A", flowA], ["B", flowB], ["C", flowC], ["D", flowD], ["E", flowE]] as const) {
  try {
    await flow();
  } catch (e) {
    line(false, `${name} · flow crashed`, e instanceof PayPalError ? `${e.status} ${e.paypalName} debug_id=${e.debugId}` : String(e));
  }
}
console.log(failures === 0 ? "\nSandbox check: all green." : `\nSandbox check: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
