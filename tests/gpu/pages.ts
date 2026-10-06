// One table for every GPU spec: where each page lives, its fake API, and its parity allowances (see the plan's
// Global Constraints for why each data field and skip exists; never add to these lists).
import type { FakeApi } from "./fake-api";
import { demoApi, MANAGE_SCRIPTS, manageApi, MAYA_ID, MAYA_KEY, pledgeApi, startApi } from "./fixtures";

export interface AppPage {
  name: "demo" | "start" | "pledge" | "manage";
  refPath: string;
  /** Path on the dev server (parity runs: no polling). */
  appPath: string;
  /** Path on the built test site (port 5200, hooks on with ?e2e). */
  prodPath: string;
  signs: number;
  api: () => FakeApi;
  dataFields: string[];
  skip: string[];
}

export const PAGES: Record<AppPage["name"], AppPage> = {
  demo: { name: "demo", refPath: "demo.html", appPath: "?e2e=parity", prodPath: "?e2e=parity", signs: 2, api: demoApi, dataFields: [], skip: [] },
  start: { name: "start", refPath: "start.html", appPath: "start?e2e=parity", prodPath: "start?e2e=parity", signs: 1, api: () => startApi(), dataFields: [".mode", ".field:has(#f-deadline) .hint"], skip: [] },
  pledge: { name: "pledge", refPath: "pledge.html", appPath: `s/${MAYA_ID}?e2e=parity`, prodPath: `s/${MAYA_ID}?e2e=parity`, signs: 1, api: () => pledgeApi(), dataFields: [".row-top .eyebrow", ".bill"], skip: [] },
  manage: { name: "manage", refPath: "manage.html", appPath: `s/${MAYA_ID}/manage?e2e=parity#${MAYA_KEY}`, prodPath: `s/${MAYA_ID}/manage?e2e=parity#${MAYA_KEY}`, signs: 1, api: () => manageApi(MANAGE_SCRIPTS.tipped), dataFields: [".row-top .eyebrow"], skip: ['section[aria-labelledby="h-ledger"]'] },
};
