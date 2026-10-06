// Spec 9 "integration": drives the real Worker (wrangler dev --local, env "check") end to end against the PayPal sandbox.
// Run: npm run worker:check. Prints statuses and PayPal ids only. Never prints keys, tokens, manage keys or demo keys.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import type { CreateOrderResponse, CreateShowResponse, DemoResponse, ManageView, PublicShow, SignResponse } from "../src/worker/api-types";

const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = ".wrangler/worker-check";
let failures = 0;

function line(ok: boolean, step: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  ·  ${detail}` : ""}`);
}

async function api<T>(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["x-manage-key"] = key;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`(timed out waiting for ${what})`);
  return undefined;
}

const looksLikePayPalId = (s: string | null) => typeof s === "string" && /^[A-Z0-9]{10,25}$/.test(s);

rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(".wrangler", { recursive: true });
const log = createWriteStream(".wrangler/worker-check.log");
const child = spawn("npx", ["wrangler", "dev", "--local", "--env", "check", "--port", String(PORT), "--persist-to", STATE_DIR], { stdio: ["ignore", "pipe", "pipe"], detached: true });

/** Stops wrangler and everything it started (workerd), not just npx. */
function stopWorker() {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
process.on("SIGINT", () => {
  stopWorker();
  process.exit(130);
});
child.stdout.pipe(log);
child.stderr.pipe(log);

try {
  const up = await waitFor("the Worker", async () => ((await api<{ ok: boolean }>("GET", "/api/health")).data?.ok ? true : undefined), 90_000);
  line(up === true, "health");
  if (!up) throw new Error("Worker did not start; see .wrangler/worker-check.log");

  // ---- a real show (the artist path) ----
  const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  const created = await api<CreateShowResponse>("POST", "/api/shows", { sentence: "Worker check at Test Room, Dec 20, $15 tickets, room wants $10, I need $10", deadline, emails: { room: "check-room@example.com", artist: "check-artist@example.com" } });
  line(created.status === 201 && created.data.threshold === 2, "draft: code computes the target", `status ${created.status}, target ${created.data?.threshold}, written by ${created.data?.source}`);
  const signed = await api<SignResponse>("POST", `/api/shows/${created.data.showId}/sign`, { signToken: created.data.signToken, draft: created.data.draft });
  const showId = signed.data?.showId;
  line(signed.status === 200 && typeof signed.data.manageKey === "string" && signed.data.manageKey.length === 43, "sign returns a manage key once", `status ${signed.status}, show ${showId}`);
  const pub = await api<PublicShow>("GET", `/api/shows/${showId}`);
  line(pub.status === 200 && pub.data.state === "live" && !JSON.stringify(pub.data).includes("@"), "public show is live and has no emails");
  const forged = await api("POST", `/api/shows/${showId}/orders/1AB23456CD789012E/authorize`);
  line(forged.status === 404, "a forged order id is refused", `status ${forged.status}`);
  const order = await api<CreateOrderResponse>("POST", `/api/shows/${showId}/orders`, { initials: "WC" });
  line(order.status === 201 && looksLikePayPalId(order.data.orderId), "real sandbox order created", `order ${order.data?.orderId}`);
  const unapproved = await api("POST", `/api/shows/${showId}/orders/${order.data.orderId}/authorize`);
  const afterUnapproved = await api<PublicShow>("GET", `/api/shows/${showId}`);
  line(unapproved.status === 409 && afterUnapproved.data.fans.committed === 0, "an order the buyer never approved is not counted", `status ${unapproved.status}`);
  const noKey = await api("GET", `/api/shows/${showId}/manage`);
  const withKey = await api<ManageView>("GET", `/api/shows/${showId}/manage`, undefined, signed.data.manageKey);
  line(noKey.status === 403 && withKey.status === 200, "manage view needs the manage key");
  const hook = await api("POST", "/api/webhooks/paypal", { id: "WH-CHECK", event_type: "PAYMENT.AUTHORIZATION.CREATED", create_time: new Date().toISOString(), resource: { id: "X", custom_id: `${showId}:p1` } });
  line(hook.status === 403 || hook.status === 400, "webhooks need PAYPAL_WEBHOOK_ID and a valid signature", hook.status === 403 ? "refused: PAYPAL_WEBHOOK_ID not set" : "refused: signature check failed");

  // ---- the judge demo ----
  const demo = await api<DemoResponse>("POST", "/api/demo");
  line(demo.status === 201 && demo.data.shows[0].threshold === 34 && demo.data.shows[1].threshold === 28, "demo copy created", `demo ${demo.data?.demoId}`);
  const [a, b] = [demo.data.shows[0].showId, demo.data.shows[1].showId];
  const key = demo.data.demoKey;
  const seated = await waitFor(
    "29 + 19 simulated fans",
    async () => {
      const [sa, sb] = await Promise.all([api<PublicShow>("GET", `/api/shows/${a}`), api<PublicShow>("GET", `/api/shows/${b}`)]);
      return sa.data.fans.committed === 29 && sb.data.fans.committed === 19 ? true : undefined;
    },
    240_000,
  );
  line(seated === true, "simulated fans seated as sandbox card holds");
  const firstHold = (await api<ManageView>("GET", `/api/shows/${a}/manage`, undefined, key)).data.ledger.find((r) => r.status === "On hold");
  line(looksLikePayPalId(firstHold?.ref ?? null), "a simulated fan's ledger row carries a real PayPal authorization id", firstHold?.ref ?? "none");
  const more = await api("POST", `/api/demo/${demo.data.demoId}/fans`, { show: "a", count: 2 }, key);
  const thirtyOne = await waitFor("31 fans on show A", async () => ((await api<PublicShow>("GET", `/api/shows/${a}`)).data.fans.committed === 31 ? true : undefined), 120_000);
  line(more.status === 200 && thirtyOne === true, "add 2 fans");
  const ff = await api("POST", `/api/demo/${demo.data.demoId}/fast-forward`, undefined, key);
  line(ff.status === 200, "fast-forward accepted");
  const settledA = await waitFor("show A settled", async () => ((await api<PublicShow>("GET", `/api/shows/${a}`)).data.state === "settled" ? true : undefined), 420_000);
  const missedB = await waitFor("show B missed with every hold voided", async () => {
    const s = (await api<PublicShow>("GET", `/api/shows/${b}`)).data;
    return s.state === "missed" && s.fans.held === 0 && s.fans.released === 19 ? true : undefined;
  }, 240_000);
  const manageA = (await api<ManageView>("GET", `/api/shows/${a}/manage`, undefined, key)).data;
  const charged = manageA.ledger.filter((r) => r.what === "Charged" && looksLikePayPalId(r.ref));
  const paid = manageA.ledger.filter((r) => r.what.startsWith("Paid "));
  line(settledA === true && manageA.show.fans.charged === 36 && charged.length === 36, "show A tipped: every hold charged (34 plus the 2 top-up fans)", `${charged.length} charge rows with PayPal capture ids`);
  line(paid.length >= 1 && manageA.log.some((l) => l.rule === "rule-4-pay-the-split"), "show A payout batch sent under rule 4", paid.map((r) => `${r.who} ${r.amountCents} ${r.status}`).join(" · "));
  line(manageA.collectedNetCents > 0 && manageA.collectedNetCents < 36 * 1500, "collected net comes from PayPal's net amounts", `net ${manageA.collectedNetCents} of gross ${36 * 1500}`);
  const manageB = (await api<ManageView>("GET", `/api/shows/${b}/manage`, undefined, key)).data;
  line(missedB === true && manageB.ledger.filter((r) => r.status === "Cancelled").length >= 19 && manageB.log.some((l) => l.rule === "rule-3-void-on-miss"), "show B missed: every hold cancelled under rule 3");
  const reset = await api<DemoResponse>("POST", `/api/demo/${demo.data.demoId}/reset`, undefined, key);
  line(reset.status === 201 && reset.data.demoId !== demo.data.demoId, "reset returns a fresh copy", `new demo ${reset.data?.demoId}`);
} catch (e) {
  line(false, "check crashed", e instanceof Error ? e.message : String(e));
} finally {
  stopWorker();
  log.end();
}

console.log(failures === 0 ? "\nWorker check: all green." : `\nWorker check: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
