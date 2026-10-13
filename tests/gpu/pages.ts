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
  /** The only selectors this page may tag [data-app-only] (the harness fails on any other, and on any in the reference). */
  appOnly: string[];
}

// Later tasks extend `appOnly` with their own new controls (judge panel, error/attention lines, call-off, second option).
// The manage ledger grid is skipped on both pages: the real AG Grid replaces the hand-made table, and tests/gpu/ledger-parity.spec.ts
// compares the grid region (on the real manage page) against the reference table separately at the same 0.5%.
// Only the grid itself is skipped (reference table wrapper and the app's AG Grid); the heading and the note are compared.
// The note is a fixture-mode text: with ?e2e=parity the page prints the reference's exact note (and hides the CSV button, which is app-only).
const LEDGER_REF_GRID = 'section[aria-labelledby="h-ledger"] > .ag-root-wrapper';
const LEDGER_APP_GRID = ".ledger-grid";
export const PAGES: Record<AppPage["name"], AppPage> = {
  demo: { name: "demo", refPath: "demo.html", appPath: "?e2e=parity", prodPath: "?e2e=parity", signs: 2, api: demoApi, dataFields: [], skip: [], appOnly: ["#judge", "#resting", "#paused", "#hdr-links", "#setup", "[data-both-note]", "#agent-note", "[data-ask-pointer]", "[data-judge-ask]"] },
  start: { name: "start", refPath: "start.html", appPath: "start?e2e=parity", prodPath: "start?e2e=parity", signs: 1, api: () => startApi(), dataFields: [".mode", ".field:has(#f-deadline) .hint"], skip: [], appOnly: ["[data-start-msg]", "#problems", "#example-emails", "#draft-source", "#no-payees"] },
  pledge: { name: "pledge", refPath: "pledge.html", appPath: `s/${MAYA_ID}?e2e=parity`, prodPath: `s/${MAYA_ID}?e2e=parity`, signs: 1, api: () => pledgeApi(), dataFields: [".row-top .eyebrow", ".bill"], skip: [], appOnly: ["[data-pledge-msg]", "#check-again", "#notice", "#fingerprint", "#paypal-note"] },
  manage: { name: "manage", refPath: "manage.html", appPath: `s/${MAYA_ID}/manage?e2e=parity#${MAYA_KEY}`, prodPath: `s/${MAYA_ID}/manage?e2e=parity#${MAYA_KEY}`, signs: 1, api: () => manageApi(MANAGE_SCRIPTS.tipped), dataFields: [".row-top .eyebrow"], skip: [LEDGER_REF_GRID, LEDGER_APP_GRID], appOnly: ["#manage-notice", "#attention", "#ask-alt", "[data-ask-msg]", "#calloff", "#csv", "#notes", "#resting", "#ask-source"] },
};
