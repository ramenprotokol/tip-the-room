import type { BudgetPort } from "../agent/ai";
import type { QuotaOp, QuotaPort, RateResult } from "../agent/quota";
import type { Env } from "./env";

async function quotaCall<T>(env: Env, op: QuotaOp): Promise<T> {
  const stub = env.QUOTA.get(env.QUOTA.idFromName("global"));
  const res = await stub.fetch("https://quota/op", { method: "POST", body: JSON.stringify(op) });
  if (!res.ok) throw new Error(`quota answered ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fails closed: if the budget can't be checked, the agent uses its templates. `judge` (read at each reserve, so a show can
 * be marked after its port was built) lets the caller use the part of the daily budget kept for judge links.
 */
export function budgetPort(env: Env, judge: boolean | (() => boolean) = false): BudgetPort {
  return {
    async tryReserve(neurons: number): Promise<boolean> {
      try {
        const j = typeof judge === "function" ? judge() : judge;
        return (await quotaCall<{ ok: boolean }>(env, { op: "reserve", neurons, judge: j })).ok === true;
      } catch {
        return false;
      }
    },
  };
}

export function quotaPort(env: Env): QuotaPort {
  return { hit: (key, limit, windowMs) => quotaCall<RateResult>(env, { op: "hit", key, limit, windowMs }) };
}
