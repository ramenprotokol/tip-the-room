import type { Runners } from "./executor";
import { HOLD_RUNNERS } from "./hold-runner";
import { PAYOUT_RUNNERS } from "./payout-runner";
import { SIM_RUNNERS } from "./sim-runner";

/** Every job kind the runtime can execute. */
export const RUNNERS: Runners = { ...HOLD_RUNNERS, ...PAYOUT_RUNNERS, ...SIM_RUNNERS };
