# Tip the Room · Plan 5: Product surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the four ported Marquee pages (`/`, `/start`, `/s/:id`, `/s/:id/manage`) to the real Worker API from Plan 4, with the real PayPal JS SDK v6 button, an AG Grid Community ledger themed to the reference, a "Check pace now" demo control, a Cloudflare Pages build (CSP `_headers`, `_redirects`, `404.html`), and a local end-to-end judge-flow test, while every existing GPU parity test (pixel + text + prod) stays green.

**Architecture:** Each page keeps its ported DOM, CSS and animation beats, and gains (1) a boot step that loads typed data through one small fetch client (`src/web/shared/api.ts`), (2) render code that writes backend and user data with `textContent` only, and (3) an `apply(newData)` step that diffs the shown state against the new data and plays the same beats the reference plays (pledge → tip → fast-forward → pay out / miss). Agent-log lines are queued and revealed on the beat they belong to, so text and pixels land at the same frozen-clock moments as the reference. Parity runs never hit a backend: Playwright route mocking serves fixed fixtures (`tests/gpu/fake-api.ts`, `tests/gpu/fixtures.ts`) shaped so the derived text equals the reference's sample text. Test hooks (`window.__marquee`, reference-only controls) exist only on the dev server or in a test build opened with `?e2e`; the production build has none.

**Tech Stack:** TypeScript 6, Vite 8 (rolldown), vanilla DOM, three.js 0.170 + GSAP 3.12.5 (unchanged), AG Grid Community 36.2.0 (vanilla `createGrid`, Theming API `themeQuartz.withParams`), PayPal JS SDK v6 (`https://www.sandbox.paypal.com/web-sdk/v6/core`, `createInstance({ clientId })`, `createPayPalOneTimePaymentSession`, `<paypal-button>`), Vitest 5 (node), Playwright 1.63 (GPU parity, functional GPU specs, local e2e), Wrangler 4 (`wrangler dev --local --env check`).

## Global Constraints

- **Branch and commits.** Work on `plan-5-product-surfaces` (the controller creates it from master at 6b0981e or later). One commit per task, message `feat(web): …` / `test(gpu): …` / `feat(agent): …` as given in the task, ending with the trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never deploy, never `npm install` (the controller installs packages).
- **Checks after every task (all must pass):** `npm run typecheck && npm run lint && npm test && npm run test:gpu`. GPU tests need the local GPU and internet (fonts/CDN for the reference pages), exactly as in Plan 2.
- **Parity is locked.** `MAX_DIFF_RATIO` stays `0.005`, pixelmatch `threshold` stays `0.1`, `deviceScaleFactor` stays `1.5`. A failing parity test blocks the task; never loosen a threshold, never add a mask, skip or data field beyond the closed list below, and never edit `reference/`.
- **The closed list of parity allowances** (each one exists because the spec mandates real data or a new real control; each gets its own functional test):
  1. `[data-ref-only]` (already masked since Plan 2).
  2. `[data-app-only]` elements (new real controls: the judge panel, error lines, attention lines, call-off, the second proposal option, page notices) are hidden in the **app** page before the shot and the text read.
  3. **Data fields** (reference sample words the API does not carry): pledge `.row-top .eyebrow` and `.bill` (show time "8pm", the description), manage `.row-top .eyebrow` (show time), start `.mode` ("· sample") and `.field:has(#f-deadline) .hint` ("today" is the browser's day). The harness sizes each app element like the reference element, masks both, and leaves both out of the text check.
  4. **Skip** on the manage page only: `section[aria-labelledby="h-ledger"]` is hidden on **both** pages. The real AG Grid replaces the hand-made table (spec §4/§7); `tests/gpu/ledger.spec.ts` is its own visual and functional check.
- **Escaping.** Backend data and user-typed values reach the DOM only through `textContent`, `value`, `createElement`, `setAttribute` on non-URL attributes, canvas text, or AG Grid's text rendering. Never `innerHTML` with data. AG Grid cell renderers return DOM elements, never strings.
- **Plain English (spec 2c).** On screen: "on hold", "charged", "cancelled, nobody paid", "money rules you signed". PayPal jargon appears only in the agent log's small print (`<small class="fine">`) and the ledger's "PayPal ref" column. Error copy is the server's plain `message` (already safe to show) or one of the fixed sentences in `api.ts` / `pledge-flow.ts`.
- **Hooks.** `window.__marquee` and the `[data-ref-only]` controls exist only when `HOOKS` is true: `import.meta.env.DEV || (import.meta.env.VITE_E2E_HOOKS === "1" && location.search has "e2e")`. A production build (no `VITE_E2E_HOOKS`) never installs hooks and removes `[data-ref-only]` from the DOM. Hooks only call the same code paths the visible buttons call.
- **Build-time public settings** (never secrets): `VITE_API_BASE` (absolute API origin; empty = same origin), `VITE_PAYPAL_CLIENT_ID` (sandbox client id; empty = no PayPal button), `VITE_PUBLIC_ORIGIN` (origin printed in share links; empty = page origin), `VITE_SANDBOX_BUYER_EMAIL` / `VITE_SANDBOX_BUYER_PASSWORD` (sandbox buyer shown to judges), `VITE_E2E_HOOKS` (`"1"` only in test builds).
- **Times.** Every date/time on screen is formatted in the show's `timeZone` and measured against the show's own clock (`PublicShow.now`, ms), never the browser's clock alone. Countdowns stop at zero outside live/tipped (the reference's zero state; no negative or stale countdowns).
- **API contract (final, on master):** `PublicShow.now: number`, `PublicShow.version: string`, `ManageView.now: number`, `ManageView.version: string`, `ManageView.sharePath: string`, `DemoResponse.expiresAt: number`; manage rate limit 1,500/h. Poll `GET /api/shows/:id` and refetch `/manage` only when `version` changes. Task 1 adds `ProposalDto.options[].newDeadline/newThreshold`, `POST /api/shows/:id/proposals/:pid/decline` and `POST /api/demo/:id/pace`.

## Controller amendments (binding, 2026-10-06)

- **Packages:** `ag-grid-community@36.2.0` is already installed (exact) by the controller. Tasks must not run npm install.
- **Rule numbers:** the pages (the locked design) win. In Task 1, renumber the server's `RULES` in `src/core/rules.ts` so the numbers match what the pages show. Cancel-on-miss and pay-the-split swap numbers; ids and titles stay. Update every core and agent test that pins a number. Delete the client-side mapping the plan proposed, so there is one source of truth.
- **AG Grid parity (owner rule: pixel-perfect).** In Task 6/7, style AG Grid so the manage ledger region matches the reference's hand-made table within the SAME 0.5% pixel threshold at rest, on desktop and phone. Use the same fixture rows, fonts, row heights, colours, borders and header styles.
  - The main parity tests may mask the ledger region only if a SEPARATE parity test compares the AG Grid ledger region against the reference ledger region at the same 0.5% threshold.
  - If 0.5% can't be reached, the task stops at DONE_WITH_CONCERNS with the measured diff and screenshots in `.git/sdd/`, for the controller and owner to decide. It must NEVER loosen a threshold silently.
- **The other parity allowances** (sample-word data fields replaced by fixture data that equals the reference text, and app-only controls hidden in parity runs) are accepted, as a closed list.
- **Judge sandbox buyer credentials** come from `VITE_SANDBOX_BUYER_EMAIL` / `VITE_SANDBOX_BUYER_PASSWORD` at build time (owner sets them in Plan 6). When they're unset, the panel says "Sandbox buyer login coming soon" in plain words, and parity fixtures use the reference text.
- **Ignore files:** add `dist-nohooks/` and `dist-e2e/` to .gitignore and eslint ignores (Task 9).
- **Commit hygiene:** implementers `git add` only the paths their task touches.

## Controller pre-steps (before Task 1)

1. Plan 4 is merged (master 5a4ec21, roadmap 6b0981e). Create the branch: `git switch -c plan-5-product-surfaces master`. Commit this plan file there.
2. Install AG Grid Community, exact version: `npm install --save-exact ag-grid-community@36.2.0` (pulls `ag-stack@36.2.0` and `ag-charts-types`). No other packages: the PayPal SDK is a `<script>` from the sandbox host, the QR encoder already exists in `ui.ts`.
3. Add `dist-nohooks/` and `dist-e2e/` to `.gitignore` and to the `ignores` array in `eslint.config.js` (Task 9 and Task 10 build there). Commit as `chore: ignore test build folders`.
4. Local e2e (Task 10) needs the owner's sandbox credentials already in `.dev.vars` (same as `npm run worker:check`).
5. Owner decisions to collect (not blocking implementation): a sandbox **buyer** account (email + password) to print on the demo page for judges, set later as `VITE_SANDBOX_BUYER_EMAIL` / `VITE_SANDBOX_BUYER_PASSWORD` (Plan 6 deploy); without them the page says to use any sandbox personal account.

## Decisions (made by this plan)

| Question | Decision |
|---|---|
| Pace proposals in the demo (Plan 4 open question) | **YES:** "Check pace now" (`POST /api/demo/:id/pace`) moves each live demo show's clock to 75 % of its window and runs the due pace check. Show B (19 of 28) is behind there and gets "Extend 7 days or lower the target to 25"; show A (29 of 34) is on pace. |
| "Not now" on a proposal | Real endpoint `POST …/proposals/:pid/decline` that writes the agent-log line; the page also remembers the dismissal in `localStorage`. |
| Fast-forward key/button bodies | The request body names the button pressed (`{ "show": "a" \| "b" }`). The server ignores it and moves both shows (spec §4); the parity fake API uses it to replay the reference, where P only pays A and M only misses B. |
| Rule numbers in small print | Pages number the rules like the reference list (1 hold, 2 charge at tip, **3 pay**, **4 cancel**, 5 ask). The server's `RULES` numbers 3 and 4 the other way round; the client maps rule ids, so "money rule N" always matches the list on the page. |
| Paid vs sent | "Everyone's paid" only when every party's `payoutStatus` is `paid` (or `none`); otherwise "Payouts sent · waiting for PayPal to confirm" (example.com receivers stay Pending). |
| Demo descriptions | The two demo shows are fixed seeds; their sign crest/yaw/seed and the bill lines stay in the page (`LOOK`), everything else comes from the API. |
| Manage key | Read from `#fragment` once, kept in `localStorage` under `ttr:manage:<showId>`, then removed from the address bar with `history.replaceState`. |
| Countdown | `deadline − (show.now + time since fetch)`; re-based only when the server clock jumps by more than 60 s (demo fast-forward). |

## File map

| File | Task | What it is |
|---|---|---|
| `src/agent/policy.ts`, `src/agent/service.ts`, `src/agent/dispatch.ts`, `src/agent/views.ts`, `src/worker/router.ts`, `src/worker/api-types.ts` | 1 | Decline, demo pace check, proposal option numbers |
| `tests/agent/demo.test.ts`, `tests/worker/router-demo.test.ts` | 1 | Tests for the above |
| `src/web/vite-env.d.ts` | 2 | Typed `import.meta.env` |
| `src/web/shared/env.ts` | 2 | Build settings, `HOOKS`, `PARITY`, ready flag |
| `src/web/shared/api.ts` | 2 | Typed fetch client, `ApiFailure`, pending counter |
| `src/web/shared/format.ts` | 2 | Dates, money, rule numbers, log emphasis, split maths, show clock |
| `src/web/shared/keys.ts` | 2 | Show id from path, manage key, saved demo, dismissed proposals |
| `src/web/shared/ui.ts` | 2 | `AgentLog.addSegs`, safe `PayoutStrip` |
| `src/web/shared/hooks.ts` | 2 | `pending` on `MarqueeHooks` |
| `tests/web/{api,format,keys}.test.ts` | 2 | Unit tests |
| `src/web/build/routes.ts`, `vite.config.ts` | 3 | Dev/preview rewrites for `/s/:id`, `/s/:id/manage`, `/start` |
| `tests/gpu/{fake-api,fixtures,pages}.ts`, `tests/gpu/parity.ts` | 3 | Fake API, fixtures, page table, harness allowances, `settle` |
| `tests/gpu/{demo,start,pledge,manage,prod-parity,prod-smoke,fallbacks}.spec.ts`, `playwright.config.ts` | 3 | Specs on the page table; build env for test servers |
| `tests/web/routes.test.ts` | 3 | Rewrite unit test |
| `src/web/shared/{pledge-flow,paypal}.ts`, `src/web/pages/pledge.ts`, `pledge.html` | 4 | Fan pledge page |
| `tests/web/pledge-flow.test.ts`, `tests/gpu/pledge-flows.spec.ts` | 4 | Tests |
| `src/web/shared/start-draft.ts`, `src/web/pages/start.ts`, `start.html` | 5 | Start a show |
| `tests/web/start-draft.test.ts`, `tests/gpu/start-flows.spec.ts` | 5 | Tests |
| `src/web/shared/ledger.ts`, `tests/gpu/ledger/harness.{html,ts}`, `tests/gpu/ledger.spec.ts` | 6 | AG Grid ledger |
| `src/web/pages/manage.ts`, `manage.html` | 7 | Artist's show page |
| `tests/gpu/manage-flows.spec.ts` | 7 | Tests |
| `src/web/pages/demo.ts`, `index.html` | 8 | Try the demo |
| `tests/gpu/demo-flows.spec.ts` | 8 | Tests |
| `src/web/build/pages.ts`, `404.html`, `public/_redirects`, `.env.example` | 9 | Pages build files |
| `tests/web/pages-build.test.ts`, `tests/gpu/prod-csp.spec.ts`, `tests/gpu/prod-nohooks.spec.ts` | 9 | Tests |
| `playwright.e2e.config.ts`, `tests/e2e/judge-flow.spec.ts`, `package.json` | 10 | `npm run e2e:local` |
| `src/web/shared/styles.css` | 4, 6, 7, 8 | New app-only styles (appended; existing rules untouched) |

---

## Task 1: Worker additions: decline, "Check pace now", proposal option numbers

**Files:**
- Modify: `src/agent/policy.ts`, `src/agent/service.ts`, `src/agent/dispatch.ts`, `src/agent/views.ts`, `src/worker/api-types.ts`, `src/worker/router.ts`
- Test: `tests/agent/demo.test.ts`, `tests/worker/router-demo.test.ts`

**Interfaces:**
- `src/worker/api-types.ts`: `ProposalDto.options: { id: ProposalOptionId; label: string; newDeadline: string | null; newThreshold: number | null }[]`; new `DeclineResponse { proposalId: string; show: PublicShow }`; new `DemoPaceResponse { shows: [PublicShow, PublicShow] }`.
- `src/agent/policy.ts`: `export const DEMO_PACE_POINT = 0.75`.
- `CampaignService.declineProposal(proposalId: string): DeclineResponse` and `CampaignService.checkPaceNow(): Promise<PublicShow>`.
- `CampaignOp` gains `{ op: "decline"; manageKey: string | null; proposalId: string }` and `{ op: "demo_pace"; manageKey: string | null }`.
- Routes: `POST /api/shows/:id/proposals/:pid/decline` (manage key, `manage` limit) → `DeclineResponse`; `POST /api/demo/:id/pace` (demo key, new `demoPace` limit 30/h) → `DemoPaceResponse`.

- [ ] **Step 1: Write the failing service tests.** Append to `tests/agent/demo.test.ts` (it already defines `demoShow`, `run`, `makeService`, `SHOW`):

```ts
describe("check pace now (demo)", () => {
  it("moves show B to three quarters of its window and proposes a fix for being behind", async () => {
    const h = await demoShow("b");
    await run(h);
    const before = h.svc.clockOffset();
    const show = await h.svc.checkPaceNow();
    expect(show.state).toBe("live");
    expect(h.svc.clockOffset()).toBeGreaterThan(before);
    const p = h.svc.project();
    const launched = Date.parse(p.mandate!.launchedAt);
    expect(h.svc.now()).toBe(launched + Math.floor((p.campaign.deadline - launched) * 0.75));
    const proposals = h.svc.manageView().proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].options.map((o) => o.id)).toEqual(["extend", "lower"]);
    expect(proposals[0].options[0].label).toBe("Extend 7 days");
    expect(proposals[0].options[0].newDeadline).toMatch(/Z$/);
    expect(proposals[0].options[0].newThreshold).toBeNull();
    expect(proposals[0].options[1]).toMatchObject({ label: "Lower the target to 25", newThreshold: 25, newDeadline: null });
    expect(h.store.logs().some((l) => l.did.startsWith("Proposed:"))).toBe(true);
    expect(h.store.logs().some((l) => l.did.startsWith("Demo: skipped ahead"))).toBe(true);
  });

  it("finds show A on pace and changes nothing", async () => {
    const h = await demoShow("a");
    await run(h);
    await h.svc.checkPaceNow();
    expect(h.svc.manageView().proposals).toHaveLength(0);
    expect(h.store.logs().some((l) => l.did === "On pace. Nothing to change.")).toBe(true);
  });

  it("does not propose twice", async () => {
    const h = await demoShow("b");
    await run(h);
    await h.svc.checkPaceNow();
    await h.svc.checkPaceNow();
    expect(h.svc.manageView().proposals).toHaveLength(1);
    expect(h.store.logs().at(-1)?.did).toBe("The pace was already checked. Nothing new to propose.");
  });

  it("leaves a show that is over alone", async () => {
    const h = await demoShow("b");
    await run(h);
    h.svc.fastForward(false);
    const show = await h.svc.checkPaceNow();
    expect(show.state).toBe("missed");
    expect(h.svc.manageView().proposals).toHaveLength(0);
  });

  it("is refused on a real show", async () => {
    const h = makeService();
    h.svc.ensureSchema();
    h.svc.init({ showId: SHOW, signTokenHash: "x" });
    await expect(h.svc.checkPaceNow()).rejects.toThrow(/only in the demo/);
  });
});

describe("decline a proposal", () => {
  it("logs 'not now', changes nothing, and refuses unknown or approved proposals", async () => {
    const h = await demoShow("b");
    await run(h);
    await h.svc.checkPaceNow();
    const id = h.svc.manageView().proposals[0].proposalId;
    const res = h.svc.declineProposal(id);
    expect(res.proposalId).toBe(id);
    expect(res.show.threshold).toBe(28);
    expect(h.store.logs().at(-1)?.did).toBe('You said not now to "Extend 7 days" or "Lower the target to 25". Nothing changes.');
    expect(() => h.svc.declineProposal("nope")).toThrow(/no such proposal/);
    await h.svc.approve(id, { option: "lower" });
    expect(() => h.svc.declineProposal(id)).toThrow(/already approved/);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run tests/agent/demo.test.ts` → FAIL (`checkPaceNow` / `declineProposal` is not a function).

- [ ] **Step 3: Add the policy constant.** In `src/agent/policy.ts`, after `DEMO_TTL_MS`:

```ts
/** "Check pace now" (demo only) moves a demo show's clock to this share of its window: show B is behind pace there. */
export const DEMO_PACE_POINT = 0.75;
```

- [ ] **Step 4: Extend the API types.** In `src/worker/api-types.ts` replace the `options` line of `ProposalDto` and add two response types after `CallOffResponse`:

```ts
  options: { id: ProposalOptionId; label: string; newDeadline: string | null; newThreshold: number | null }[];
```

```ts
export interface DeclineResponse {
  proposalId: string;
  show: PublicShow;
}

export interface DemoPaceResponse {
  shows: [PublicShow, PublicShow];
}
```

- [ ] **Step 5: Expose the option numbers.** In `src/agent/views.ts` `proposalRows`, replace `options: x.options.map((o) => ({ id: o.id, label: o.label }))` with:

```ts
options: x.options.map((o) => ({ id: o.id, label: o.label, newDeadline: o.newDeadline !== undefined ? new Date(o.newDeadline).toISOString() : null, newThreshold: o.newThreshold ?? null })),
```

- [ ] **Step 6: Add the two service methods.** In `src/agent/service.ts`: add `DEMO_PACE_POINT` to the `./policy` import, add `DeclineResponse` to the `../worker/api-types` import, then insert after `callOff()`:

```ts
  /** The artist says "not now". Nothing changes; the agent log records it (the page also hides the card). */
  declineProposal(proposalId: string): DeclineResponse {
    const p = this.applyDeadline();
    this.requireMandate(p);
    const proposal = typeof proposalId === "string" ? p.proposals.get(proposalId) : undefined;
    if (!proposal) throw new ServiceError(404, "not_found", "There's no such proposal.");
    if (proposal.approved) throw new ServiceError(409, "conflict", "That proposal was already approved.");
    this.log({ saw: sawCounts(p), did: `You said not now to ${proposal.options.map((o) => `"${o.label}"`).join(" or ")}. Nothing changes.`, rule: null });
    return { proposalId, show: this.publicView(p) };
  }
```

and insert after `retire()`:

```ts
  /** Demo only ("Check pace now"): move the demo clock to DEMO_PACE_POINT of the window, then run the pace check that is due. */
  async checkPaceNow(): Promise<PublicShow> {
    this.requireDemo();
    const store = this.deps.store;
    const p = this.applyDeadline();
    const m = this.requireMandate(p);
    const c = p.campaign;
    if (c.state !== "live") return this.publicView(p);
    const launched = Date.parse(m.launchedAt);
    const at = launched + Math.floor((c.deadline - launched) * DEMO_PACE_POINT);
    const offset = at - this.deps.clock.now();
    if (offset > this.clockOffset()) {
      store.setMeta("clock_offset", String(offset));
      this.log({ saw: sawCounts(p), did: "Demo: skipped ahead to three quarters of the way to the deadline for a pace check.", rule: null });
    }
    const due = duePaceCheck(m, c, p.paceChecks, this.now());
    for (const n of due.mark) commit(store, this.now(), { type: "pace_checked", check: n });
    if (due.run !== null) await this.runPaceCheck(due.run);
    else this.log({ saw: sawCounts(this.project()), did: "The pace was already checked. Nothing new to propose.", rule: null });
    return this.publicView(this.applyDeadline());
  }
```

- [ ] **Step 7: Dispatch the ops.** In `src/agent/dispatch.ts` add to `CampaignOp`:

```ts
  | { op: "decline"; manageKey: string | null; proposalId: string }
  | { op: "demo_pace"; manageKey: string | null }
```

and to the `run` switch:

```ts
    case "decline":
      await service.checkKey(op.manageKey);
      return service.declineProposal(op.proposalId);
    case "demo_pace":
      await service.checkKey(op.manageKey);
      return service.checkPaceNow();
```

- [ ] **Step 8: Route them.** In `src/worker/router.ts`: add `DemoPaceResponse` to the `./api-types` import; add `demoPace: { limit: 30, windowMs: HOUR },` to `LIMITS` after `demoFastForward`; add the handlers after `callOff` and `demoFastForward`:

```ts
const decline: Handler = async (c) => {
  await limit(c, "manage");
  const id = showParam(c);
  return fromReply(await c.deps.campaigns.call(id, { op: "decline", manageKey: manageKey(c), proposalId: c.params[1] }));
};
```

```ts
const demoPace: Handler = async (c) => {
  await limit(c, "demoPace");
  const [a, b] = demoShowIds(demoParam(c));
  const ra = await c.deps.campaigns.call(a, { op: "demo_pace", manageKey: manageKey(c) });
  if (!ra.ok) return fromReply(ra);
  const rb = await c.deps.campaigns.call(b, { op: "demo_pace", manageKey: manageKey(c) });
  if (!rb.ok) return fromReply(rb);
  const res: DemoPaceResponse = { shows: [ra.data as PublicShow, rb.data as PublicShow] };
  return json(200, res);
};
```

and two `ROUTES` entries (after the approve route and after the fast-forward route):

```ts
  { method: "POST", pattern: /^\/api\/shows\/([a-z0-9]+)\/proposals\/([a-z0-9]+)\/decline$/, handler: decline },
```

```ts
  { method: "POST", pattern: /^\/api\/demo\/([a-z0-9]+)\/pace$/, handler: demoPace },
```

- [ ] **Step 9: Router tests.** Append inside `describe("demo routes", …)` in `tests/worker/router-demo.test.ts` (add `DemoPaceResponse, ManageView` to its type import):

```ts
  it("check pace now needs the demo key, answers with both shows and makes no PayPal call", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    expect((await w.call("POST", `/api/demo/${d.demoId}/pace`)).status).toBe(403);
    const res = await w.call("POST", `/api/demo/${d.demoId}/pace`, undefined, { "x-manage-key": d.demoKey });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DemoPaceResponse;
    expect(body.shows.map((s) => s.showId)).toEqual([`${d.demoId}a`, `${d.demoId}b`]);
    expect(w.paypal.calls).toHaveLength(0);
  });

  it("decline needs the key and a real proposal", async () => {
    const w = workerHarness();
    const d = (await (await w.call("POST", "/api/demo")).json()) as DemoResponse;
    const key = { "x-manage-key": d.demoKey };
    await w.call("POST", `/api/demo/${d.demoId}/pace`, undefined, key);
    const view = (await (await w.call("GET", `/api/shows/${d.demoId}b/manage`, undefined, key)).json()) as ManageView;
    const id = view.proposals[0].proposalId;
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/${id}/decline`)).status).toBe(403);
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/${id}/decline`, undefined, key)).status).toBe(200);
    expect((await w.call("POST", `/api/shows/${d.demoId}b/proposals/zzz/decline`, undefined, key)).status).toBe(404);
  });
```

(Show B has no seated fans in the router harness, so the pace check projects 0 and proposes; that is all this test needs.)

- [ ] **Step 10: Run all checks.** `npx vitest run tests/agent tests/worker` → PASS. If any older test compares a `ProposalDto` with `toEqual` and only `{ id, label }` options, add `newDeadline`/`newThreshold` to that expected object (find them with `grep -rn "proposals" tests/agent tests/worker`). Then `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS (web untouched, so GPU stays 39/39).

- [ ] **Step 11: Commit.** `git add -A src/agent src/worker tests/agent tests/worker && git commit -m "feat(agent): decline a proposal, demo 'check pace now', option numbers in proposals"` + trailer.

---

## Task 2: Web foundation: env, API client, formatting, keys, safe log and payout strip

**Files:**
- Modify: `src/web/vite-env.d.ts`, `src/web/shared/ui.ts`, `src/web/shared/hooks.ts`
- Create: `src/web/shared/env.ts`, `src/web/shared/api.ts`, `src/web/shared/format.ts`, `src/web/shared/keys.ts`
- Test: `tests/web/api.test.ts`, `tests/web/format.test.ts`, `tests/web/keys.test.ts`

**Interfaces:**
- `env.ts`: `API_BASE: string`, `PUBLIC_ORIGIN: string`, `SANDBOX_BUYER: { email: string; password: string }`, `HOOKS: boolean`, `PARITY: boolean`, `paypalClientId(): string`, `removeRefOnly(): void`, `markReady(): void`, `safeStorage(): Storage | null`.
- `api.ts`: `class ApiFailure extends Error { status; code: ErrorCode | "network"; problems: string[]; retryAfterSec? }`, `NETWORK_MESSAGE`, `FALLBACK_MESSAGE`, `pendingCount(): number`, `act<T>(fn): Promise<T>`, `type FetchLike`, `interface ApiClient` (methods below), `apiClient(base: string, fetchFn?: FetchLike): ApiClient`.
- `ApiClient`: `createShow(b)`, `sign(id, b)`, `getShow(id)`, `createOrder(id, b)`, `authorize(id, orderId)`, `manage(id, key)`, `approve(id, key, proposalId, b)`, `decline(id, key, proposalId)`, `callOff(id, key)`, `createDemo()`, `demoFans(demoId, key, b)`, `demoFastForward(demoId, key, show)`, `demoPace(demoId, key)`, `demoReset(demoId, key)`, each returning the matching `api-types` response.
- `format.ts`: `toMs`, `when(ms, tz, style: "long" | "faq" | "short" | "log" | "ledger")`, `dayLabel(date)`, `dollars(cents)`, `money2(cents)`, `ROLE_WORD`, `PAGE_RULE`, `fineLine(dto)`, `type Seg`, `emphasis(text)`, `askEmphasis(text)`, `planSplit(split, grossCents)`, `rulesLine(split)`, `andList(words)`, `type End`, `endOf(state)`, `payoutsConfirmed(parties)`, `class ShowClock`, `remainSec(deadline, clock, at?)`.
- `keys.ts`: `type KeyStore`, `showIdFromPath(pathname, search?)`, `takeKeyFromHash(hash)`, `rememberKey`, `recallKey`, `type SavedDemo`, `saveDemo`, `loadDemo`, `dismiss`, `isDismissed`.
- `ui.ts`: `AgentLog.addSegs({ time, segs, fine?, tag?, instant? })`; `PayoutStrip` builds its cells with DOM calls; `PayoutStrip.set(amounts, tags, states)`, `PayoutStrip.idle(text)`, `PayoutStrip.fill(amounts, cues, noteText?, tags?)`.
- `hooks.ts`: `MarqueeHooks.pending?: number`.

- [ ] **Step 1: Write the failing unit tests.**

`tests/web/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { andList, askEmphasis, dayLabel, dollars, emphasis, endOf, fineLine, money2, payoutsConfirmed, planSplit, remainSec, rulesLine, ShowClock, when } from "../../src/web/shared/format";

const T = (mo: number, d: number, h: number, mi = 0) => Date.UTC(2026, mo - 1, d, h, mi);
const text = (segs: { text: string; cls: string }[]) => segs.map((s) => (s.cls ? `[${s.cls}:${s.text}]` : s.text)).join("");

describe("dates in the show's time zone", () => {
  it("formats like the reference pages", () => {
    expect(when(T(11, 12, 18), "UTC", "long")).toBe("Thu Nov 12, 6:00pm");
    expect(when(T(11, 12, 18), "UTC", "faq")).toBe("Thu Nov 12, 6pm");
    expect(when(T(11, 12, 18), "UTC", "short")).toBe("Thu 6pm");
    expect(when(T(11, 9, 9, 11), "UTC", "log")).toBe("Mon 9:11am");
    expect(when(T(11, 3, 19, 12), "UTC", "ledger")).toBe("Nov 3 · 7:12pm");
    expect(when(T(11, 12, 18, 30), "UTC", "short")).toBe("Thu 6:30pm");
    expect(when(T(11, 12, 12), "UTC", "long")).toBe("Thu Nov 12, 12:00pm");
    expect(when(T(11, 12, 0), "UTC", "long")).toBe("Thu Nov 12, 12:00am");
    expect(when(T(11, 13, 2), "America/Vancouver", "long")).toBe("Thu Nov 12, 6:00pm");
  });
  it("falls back to UTC for an unknown zone", () => {
    expect(when(T(11, 12, 18), "Not/AZone", "long")).toBe("Thu Nov 12, 6:00pm");
  });
  it("labels a show date", () => {
    expect(dayLabel("2026-11-20")).toBe("Fri Nov 20");
    expect(dayLabel("nope")).toBe("nope");
  });
});

describe("money", () => {
  it("rounds whole dollars like usd() and shows cents in the ledger", () => {
    expect(dollars(31500)).toBe("$315");
    expect(dollars(123456)).toBe("$1,235");
    expect(money2(1500)).toBe("$15.00");
    expect(money2(123456)).toBe("$1,234.56");
  });
  it("splits in signed order, artist gets the rest", () => {
    const split = [{ role: "room" as const, fixedCents: 8000 }, { role: "opener" as const, fixedCents: 10000 }, { role: "artist" as const, fixedCents: null }];
    expect(planSplit(split, 51000)).toEqual([8000, 10000, 33000]);
    expect(planSplit(split, 12000)).toEqual([8000, 4000, 0]);
  });
  it("writes the money rules line", () => {
    expect(rulesLine([{ role: "room", label: "x", fixedCents: 8000, minimumCents: null }, { role: "opener", label: "y", fixedCents: 10000, minimumCents: null }, { role: "artist", label: "z", fixedCents: null, minimumCents: 30000 }])).toBe("Money rules: Room $80 → Opener $100 → Artist gets the rest");
    expect(andList(["room", "opener", "artist"])).toBe("room, opener and artist");
    expect(andList(["you"])).toBe("you");
  });
});

describe("agent log", () => {
  it("numbers rules like the page list and joins the small print", () => {
    expect(fineLine({ saw: "1 PayPal payout batch · 2 items", rule: "rule-4-pay-the-split", requestId: null, resultId: null })).toBe("1 PayPal payout batch · 2 items · money rule 3");
    expect(fineLine({ saw: "voided 12 PayPal authorizations", rule: "rule-3-void-on-miss", requestId: null, resultId: null })).toBe("voided 12 PayPal authorizations · money rule 4");
    expect(fineLine({ saw: "x", rule: null, requestId: "capture-p1", resultId: "3C1234567X" })).toBe("x · capture-p1 · 3C1234567X");
  });
  it("emphasises the same words the reference does", () => {
    expect(text(emphasis("You signed the money rules. Your show is live."))).toBe("You signed the money rules. [b:Your show is live.]");
    expect(text(emphasis("Pace check: 12 of 21 with 3 days left. I asked you about the deadline."))).toBe("[w-ask:Pace check:] 12 of 21 with 3 days left. I asked you about the deadline.");
    expect(text(emphasis("You approved it. The new deadline is Mon Nov 16, 6pm. Fans see it now."))).toBe("You approved it. [b:The new deadline is Mon Nov 16, 6pm.] Fans see it now.");
    expect(text(emphasis("Your show reached 21 fans. It’s on! Everyone was charged at once: $315."))).toBe("[b:Your show reached 21 fans. It’s on!] Everyone was charged at once: $315.");
    expect(text(emphasis("Deadline reached. Paid Lucky’s Café $100, then you $215."))).toBe("Deadline reached. [w-paid:Paid Lucky’s Café $100, then you $215.]");
    expect(text(emphasis("Your show ended at 12 of 21. Every hold was cancelled. Nobody paid."))).toBe("Your show ended at 12 of 21. [w-rel:Every hold was cancelled. Nobody paid.]");
    expect(text(emphasis("5 more fans joined after it tipped, and were charged right away: $75."))).toBe("5 more fans joined after it tipped, and were [b:charged right away]: $75.");
    expect(text(emphasis("Watching 2 shows. 48 fans are on hold and nobody has been charged."))).toBe("Watching 2 shows. [b:48 fans are on hold] and [w-held:nobody has been charged].");
    expect(text(emphasis("5 more fans held a spot. PayPal is holding their $75."))).toBe("5 more fans held a spot. PayPal is holding their $75.");
    expect(text(emphasis("<img src=x onerror=alert(1)>"))).toBe("<img src=x onerror=alert(1)>");
    expect(text(askEmphasis("Lucky’s Café is at 12 of 21 with 3 days left. At this pace it lands near 17."))).toBe("Lucky’s Café is at [b:12 of 21] with 3 days left. At this pace it lands near 17.");
  });
});

describe("show state", () => {
  it("maps campaign states to the end the page animates toward", () => {
    expect(["draft", "live", "tipped", "paying_out", "settled", "missed", "cancelled"].map((s) => endOf(s as never))).toEqual(["live", "live", "tipped", "paid", "paid", "missed", "cancelled"]);
  });
  it("calls payouts confirmed only when every party is paid", () => {
    expect(payoutsConfirmed([{ payoutStatus: "paid" }, { payoutStatus: "none" }])).toBe(true);
    expect(payoutsConfirmed([{ payoutStatus: "paid" }, { payoutStatus: "pending" }])).toBe(false);
    expect(payoutsConfirmed([])).toBe(false);
  });
  it("counts down on the show's clock and re-bases only on a big jump", () => {
    const c = new ShowClock(T(11, 9, 9), 1_000_000);
    expect(remainSec(T(11, 12, 18), c, 1_000_000)).toBe(291600);
    expect(remainSec(T(11, 12, 18), c, 1_003_000)).toBe(291597);
    c.sync(T(11, 9, 9), 1_005_000);
    expect(c.now(1_005_000)).toBe(T(11, 9, 9) + 5000);
    c.sync(T(11, 12, 18, 1), 1_005_000);
    expect(remainSec(T(11, 12, 18), c, 1_005_000)).toBe(0);
    expect(remainSec(T(11, 12, 18), null)).toBe(0);
  });
});
```

`tests/web/api.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { act, apiClient, ApiFailure, FALLBACK_MESSAGE, NETWORK_MESSAGE, pendingCount, type FetchLike } from "../../src/web/shared/api";

interface Seen { url: string; init: RequestInit }
function fake(status: number, body: string): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return { seen, fetch: async (url, init) => { seen.push({ url, init }); return new Response(body, { status }); } };
}

describe("api client", () => {
  it("calls the right path, sends JSON and the manage key only when given", async () => {
    const f = fake(200, JSON.stringify({ ok: 1 }));
    const api = apiClient("https://api.example", f.fetch);
    await api.getShow("s123");
    await api.manage("s123", "secret-key");
    await api.approve("s123", "secret-key", "pace1", { option: "extend" });
    await api.demoFastForward("dabc", "k123456", "b");
    expect(f.seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      "GET https://api.example/api/shows/s123",
      "GET https://api.example/api/shows/s123/manage",
      "POST https://api.example/api/shows/s123/proposals/pace1/approve",
      "POST https://api.example/api/demo/dabc/fast-forward",
    ]);
    expect((f.seen[0].init.headers as Record<string, string>)["x-manage-key"]).toBeUndefined();
    expect((f.seen[1].init.headers as Record<string, string>)["x-manage-key"]).toBe("secret-key");
    expect(f.seen[2].init.body).toBe(JSON.stringify({ option: "extend" }));
    expect(f.seen[3].init.body).toBe(JSON.stringify({ show: "b" }));
  });

  it("encodes ids so a path can't be smuggled", async () => {
    const f = fake(200, "{}");
    await apiClient("", f.fetch).getShow("a/../b");
    expect(f.seen[0].url).toBe("/api/shows/a%2F..%2Fb");
  });

  it("turns an error body into ApiFailure with the server's plain message", async () => {
    const f = fake(502, JSON.stringify({ error: { code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." } }));
    const err = await apiClient("", f.fetch).authorize("s1", "ORDER1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({ status: 502, code: "paypal_error", message: "PayPal didn't answer as expected. Nothing was charged." });
  });

  it("keeps problems and retry hints, and falls back on unreadable errors", async () => {
    const a = await apiClient("", fake(422, JSON.stringify({ error: { code: "invalid", message: "Check the draft.", problems: ["Add a price.", 7] } })).fetch).sign("s1", { signToken: "t", draft: {} as never }).catch((e: unknown) => e);
    expect(a).toMatchObject({ code: "invalid", problems: ["Add a price."] });
    const b = await apiClient("", fake(500, "<html>").fetch).getShow("s1").catch((e: unknown) => e);
    expect(b).toMatchObject({ status: 500, code: "internal", message: FALLBACK_MESSAGE });
    const c = await apiClient("", fake(200, "").fetch).getShow("s1").catch((e: unknown) => e);
    expect(c).toMatchObject({ code: "internal" });
  });

  it("reports a network failure in plain words", async () => {
    const err = await apiClient("", async () => { throw new TypeError("Failed to fetch"); }).getShow("s1").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network", message: NETWORK_MESSAGE });
  });

  it("counts work in flight until the caller's whole action ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const api = apiClient("", async () => { await gate; return new Response("{}", { status: 200 }); });
    const job = act(async () => { await api.getShow("s1"); });
    expect(pendingCount()).toBeGreaterThan(0);
    release();
    await job;
    expect(pendingCount()).toBe(0);
  });
});
```

`tests/web/keys.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dismiss, isDismissed, loadDemo, recallKey, rememberKey, saveDemo, showIdFromPath, takeKeyFromHash, type KeyStore } from "../../src/web/shared/keys";

function memory(): KeyStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}
const broken: KeyStore = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };

describe("keys and ids", () => {
  it("reads the show id from /s/:id, /s/:id/manage or ?show=", () => {
    expect(showIdFromPath("/s/sabcdefghjk")).toBe("sabcdefghjk");
    expect(showIdFromPath("/s/acoustic-set-nov20/manage")).toBe("acoustic-set-nov20");
    expect(showIdFromPath("/pledge.html", "?show=sabcdefghjk")).toBe("sabcdefghjk");
    expect(showIdFromPath("/s/../etc")).toBeNull();
    expect(showIdFromPath("/s/%3Cscript%3E")).toBeNull();
    expect(showIdFromPath("/")).toBeNull();
  });
  it("takes a manage key from the fragment only when it looks like one", () => {
    expect(takeKeyFromHash("#k-7Q2M9X4T")).toBe("k-7Q2M9X4T");
    expect(takeKeyFromHash("#<b>")).toBeNull();
    expect(takeKeyFromHash("")).toBeNull();
  });
  it("remembers keys per show and survives a storage that throws", () => {
    const s = memory();
    rememberKey(s, "s1", "key-123456");
    expect(recallKey(s, "s1")).toBe("key-123456");
    expect(recallKey(s, "s2")).toBeNull();
    expect(() => rememberKey(broken, "s1", "key-123456")).not.toThrow();
    expect(recallKey(broken, "s1")).toBeNull();
    expect(recallKey(null, "s1")).toBeNull();
  });
  it("saves the demo copy and rejects junk", () => {
    const s = memory();
    saveDemo(s, { demoId: "dabcdefghjk", demoKey: "demo-key-fixture", expiresAt: 123 });
    expect(loadDemo(s)).toEqual({ demoId: "dabcdefghjk", demoKey: "demo-key-fixture", expiresAt: 123 });
    s.data.set("ttr:demo", "{nope");
    expect(loadDemo(s)).toBeNull();
    s.data.set("ttr:demo", JSON.stringify({ demoId: "<x>", demoKey: "demo-key-fixture", expiresAt: 1 }));
    expect(loadDemo(s)).toBeNull();
  });
  it("remembers dismissed proposals per show", () => {
    const s = memory();
    expect(isDismissed(s, "s1", "pace1")).toBe(false);
    dismiss(s, "s1", "pace1");
    expect(isDismissed(s, "s1", "pace1")).toBe(true);
    expect(isDismissed(s, "s2", "pace1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail.** `npx vitest run tests/web` → FAIL (modules not found).

- [ ] **Step 3: Type the build settings.** Replace `src/web/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

/** Public build-time settings (never secrets). See .env.example. */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_PAYPAL_CLIENT_ID?: string;
  readonly VITE_PUBLIC_ORIGIN?: string;
  readonly VITE_SANDBOX_BUYER_EMAIL?: string;
  readonly VITE_SANDBOX_BUYER_PASSWORD?: string;
  readonly VITE_E2E_HOOKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 4: Create `src/web/shared/env.ts`.**

```ts
// Build-time settings (public values only) and the test-hook switch. Browser only.
const env = import.meta.env;
const query = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** API origin, e.g. "https://api.tiptheroom.example". Empty means the page's own origin. */
export const API_BASE: string = (env.VITE_API_BASE ?? "").trim().replace(/\/+$/, "");
/** PayPal sandbox client id (public). Never the secret. Empty: the PayPal button is not loaded. */
const PAYPAL_ID: string = (env.VITE_PAYPAL_CLIENT_ID ?? "").trim();
/** Origin printed in share links. Defaults to wherever the page is served from. */
export const PUBLIC_ORIGIN: string = (env.VITE_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "") || (typeof location === "undefined" ? "" : location.origin);
/** The sandbox buyer judges log in with (spec §4: printed on the page). Public sandbox values. */
export const SANDBOX_BUYER = { email: (env.VITE_SANDBOX_BUYER_EMAIL ?? "").trim(), password: (env.VITE_SANDBOX_BUYER_PASSWORD ?? "").trim() };
/** Test hooks (window.__marquee and the reference-only controls): dev server, or a test build opened with ?e2e. */
export const HOOKS: boolean = env.DEV || (env.VITE_E2E_HOOKS === "1" && query.has("e2e"));
/** Parity runs (?e2e=parity): no background polling, so the fake API's scripted answers stay in step. */
export const PARITY: boolean = HOOKS && query.get("e2e") === "parity";

/** The PayPal client id. Test pages may pass ?paypal=<id> (hooks only) to load a stubbed SDK. */
export function paypalClientId(): string {
  const override = HOOKS ? query.get("paypal") : null;
  return override && /^[A-Za-z0-9_-]{1,128}$/.test(override) ? override : PAYPAL_ID;
}

/** Production pages drop the reference pack's own controls ("Simulate PayPal approval", the reference nav, demo controls). */
export function removeRefOnly(): void {
  if (!HOOKS) document.querySelectorAll("[data-ref-only]").forEach((e) => e.remove());
}

/** Tests (and the local e2e run) wait for this instead of window.__marquee, which production builds don't have. */
export function markReady(): void {
  document.body.dataset.ready = "1";
}

export function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Create `src/web/shared/api.ts`.**

```ts
// The one typed fetch client for every page. Errors become ApiFailure with a plain-English message that is safe to show as text.
import { MANAGE_KEY_HEADER } from "../../worker/api-types";
import type { ApiError, ApproveRequest, ApproveResponse, AuthorizeResponse, CallOffResponse, CreateOrderRequest, CreateOrderResponse, CreateShowRequest, CreateShowResponse, DeclineResponse, DemoFansRequest, DemoFansResponse, DemoFastForwardResponse, DemoPaceResponse, DemoResponse, ErrorCode, ManageView, PublicShow, SignRequest, SignResponse } from "../../worker/api-types";

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly problems: string[] = [],
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export const NETWORK_MESSAGE = "We couldn't reach Tip the Room. Check your connection and try again.";
export const FALLBACK_MESSAGE = "Something went wrong on our side.";

let pending = 0;
/** API calls and page actions still running. Parity tests wait for 0 before moving the frozen clock. */
export const pendingCount = (): number => pending;
/** Runs one page action (request plus the render that follows) and counts it as in flight until it ends. */
export async function act<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  try {
    return await fn();
  } finally {
    pending -= 1;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClient {
  createShow(body: CreateShowRequest): Promise<CreateShowResponse>;
  sign(showId: string, body: SignRequest): Promise<SignResponse>;
  getShow(showId: string): Promise<PublicShow>;
  createOrder(showId: string, body: CreateOrderRequest): Promise<CreateOrderResponse>;
  authorize(showId: string, orderId: string): Promise<AuthorizeResponse>;
  manage(showId: string, key: string): Promise<ManageView>;
  approve(showId: string, key: string, proposalId: string, body: ApproveRequest): Promise<ApproveResponse>;
  decline(showId: string, key: string, proposalId: string): Promise<DeclineResponse>;
  callOff(showId: string, key: string): Promise<CallOffResponse>;
  createDemo(): Promise<DemoResponse>;
  demoFans(demoId: string, key: string, body: DemoFansRequest): Promise<DemoFansResponse>;
  /** `show` names the button pressed; the server moves both shows (spec §4). */
  demoFastForward(demoId: string, key: string, show: "a" | "b"): Promise<DemoFastForwardResponse>;
  demoPace(demoId: string, key: string): Promise<DemoPaceResponse>;
  demoReset(demoId: string, key: string): Promise<DemoResponse>;
}

const seg = (s: string) => encodeURIComponent(s);

function readError(status: number, data: unknown): ApiFailure {
  const e = data && typeof data === "object" ? (data as Partial<ApiError>).error : undefined;
  const message = typeof e?.message === "string" && e.message.trim() ? e.message : FALLBACK_MESSAGE;
  const problems = Array.isArray(e?.problems) ? e.problems.filter((p): p is string => typeof p === "string") : [];
  const retry = typeof e?.retryAfterSec === "number" ? e.retryAfterSec : undefined;
  const code = (typeof e?.code === "string" ? e.code : "internal") as ErrorCode;
  return new ApiFailure(status, code, message, problems, retry);
}

export function apiClient(base: string, fetchFn: FetchLike = (input, init) => fetch(input, init)): ApiClient {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, key?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers[MANAGE_KEY_HEADER] = key;
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "omit" });
    } catch {
      throw new ApiFailure(0, "network", NETWORK_MESSAGE);
    }
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) throw readError(res.status, data);
    if (data === null || typeof data !== "object") throw new ApiFailure(res.status, "internal", FALLBACK_MESSAGE);
    return data as T;
  }
  const run = <T>(method: "GET" | "POST", path: string, body?: unknown, key?: string) => act(() => call<T>(method, path, body, key));
  const show = (id: string) => `/api/shows/${seg(id)}`;
  const demo = (id: string) => `/api/demo/${seg(id)}`;
  return {
    createShow: (b) => run("POST", "/api/shows", b),
    sign: (id, b) => run("POST", `${show(id)}/sign`, b),
    getShow: (id) => run("GET", show(id)),
    createOrder: (id, b) => run("POST", `${show(id)}/orders`, b),
    authorize: (id, orderId) => run("POST", `${show(id)}/orders/${seg(orderId)}/authorize`),
    manage: (id, key) => run("GET", `${show(id)}/manage`, undefined, key),
    approve: (id, key, proposalId, b) => run("POST", `${show(id)}/proposals/${seg(proposalId)}/approve`, b, key),
    decline: (id, key, proposalId) => run("POST", `${show(id)}/proposals/${seg(proposalId)}/decline`, undefined, key),
    callOff: (id, key) => run("POST", `${show(id)}/call-off`, undefined, key),
    createDemo: () => run("POST", "/api/demo"),
    demoFans: (id, key, b) => run("POST", `${demo(id)}/fans`, b, key),
    demoFastForward: (id, key, which) => run("POST", `${demo(id)}/fast-forward`, { show: which }, key),
    demoPace: (id, key) => run("POST", `${demo(id)}/pace`, undefined, key),
    demoReset: (id, key) => run("POST", `${demo(id)}/reset`, undefined, key),
  };
}
```

- [ ] **Step 6: Create `src/web/shared/format.ts`.**

```ts
// Pure formatting and show maths shared by the pages (Node-testable: no DOM).
import type { CampaignState } from "../../core/campaign";
import type { RuleId } from "../../core/rules";
import type { Role } from "../../core/split";
import type { AgentLogDto, PublicParty } from "../../worker/api-types";

export const toMs = (v: string | number): number => (typeof v === "number" ? v : Date.parse(v));

interface Parts { wd: string; mon: string; day: number; hour: number; minute: number; pm: boolean }
const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    formats.set(tz, f);
  }
  return f;
}
function parts(ms: number, tz: string): Parts {
  let f: Intl.DateTimeFormat;
  try {
    f = formatFor(tz);
  } catch {
    f = formatFor("UTC");
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { wd: p.weekday, mon: p.month, day: Number(p.day), hour: Number(p.hour) % 12 || 12, minute: Number(p.minute), pm: String(p.dayPeriod).toUpperCase() === "PM" };
}
const clock = (x: Parts, minutes: boolean) => `${x.hour}${minutes || x.minute ? `:${String(x.minute).padStart(2, "0")}` : ""}${x.pm ? "pm" : "am"}`;

export type WhenStyle = "long" | "faq" | "short" | "log" | "ledger";
/** long "Thu Nov 12, 6:00pm" · faq "Thu Nov 12, 6pm" · short "Thu 6pm" · log "Mon 9:11am" · ledger "Nov 3 · 7:12pm". */
export function when(ms: number, tz: string, style: WhenStyle): string {
  const x = parts(ms, tz);
  switch (style) {
    case "long":
      return `${x.wd} ${x.mon} ${x.day}, ${clock(x, true)}`;
    case "faq":
      return `${x.wd} ${x.mon} ${x.day}, ${clock(x, false)}`;
    case "short":
      return `${x.wd} ${clock(x, false)}`;
    case "log":
      return `${x.wd} ${clock(x, true)}`;
    case "ledger":
      return `${x.mon} ${x.day} · ${clock(x, true)}`;
  }
}

/** "2026-11-20" → "Fri Nov 20". */
export function dayLabel(date: string): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  const x = parts(ms, "UTC");
  return `${x.wd} ${x.mon} ${x.day}`;
}

/** Whole dollars, like ui.ts usd(): 31500 → "$315". */
export const dollars = (cents: number): string => "$" + Math.round(cents / 100).toLocaleString("en-US");
/** Ledger amounts: 1500 → "$15.00". */
export const money2 = (cents: number): string => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const ROLE_WORD: Record<Role, string> = { room: "Room", opener: "Opener", host: "Host", artist: "Artist" };

/** "a", "a and b", "a, b and c". */
export function andList(words: string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Cents per party in signed order: fixed parties first, each capped by what's left; the artist gets the rest. */
export function planSplit(split: Pick<PublicParty, "role" | "fixedCents">[], grossCents: number): number[] {
  let rest = Math.max(0, grossCents);
  return split.map((p) => {
    const v = p.role === "artist" ? rest : Math.min(p.fixedCents ?? 0, rest);
    rest -= v;
    return v;
  });
}

/** "Money rules: Room $80 → Opener $100 → Artist gets the rest". */
export function rulesLine(split: PublicParty[]): string {
  const fixed = split.filter((p) => p.role !== "artist").map((p) => `${ROLE_WORD[p.role]} ${dollars(p.fixedCents ?? 0)}`);
  return `Money rules: ${[...fixed, "Artist gets the rest"].join(" → ")}`;
}

/** The pages list the rules in this order (reference/v2). The server's RULES numbers 3 and 4 the other way round. */
export const PAGE_RULE: Record<RuleId, number> = { "rule-1-hold-only": 1, "rule-2-capture-at-tip": 2, "rule-4-pay-the-split": 3, "rule-3-void-on-miss": 4, "rule-5-ask-first": 5 };

/** The agent log's small print: what it saw · which rule · PayPal request and result ids. */
export function fineLine(d: Pick<AgentLogDto, "saw" | "rule" | "requestId" | "resultId">): string {
  const rule = d.rule && PAGE_RULE[d.rule] ? `money rule ${PAGE_RULE[d.rule]}` : "";
  return [d.saw, rule, d.requestId ?? "", d.resultId ?? ""].filter((s) => typeof s === "string" && s.trim() !== "").join(" · ");
}

export interface Seg {
  text: string;
  cls: "" | "b" | "w-ask" | "w-held" | "w-paid" | "w-rel";
}
type Rule = [RegExp, Seg["cls"], boolean];
/** Status phrases the log highlights (the reference's bold and coloured words). The flag marks rules that only match at the very start. */
const LOG_RULES: Rule[] = [
  [/^Pace check:/, "w-ask", true],
  [/^[^]*?It[’']s on!/, "b", true],
  [/charged right away/, "b", false],
  [/Your show is live\./, "b", false],
  [/The new deadline is [^]*?(?:am|pm)\./, "b", false],
  [/\d+ fans are on hold/, "b", false],
  [/nobody has been charged/, "w-held", false],
  [/Paid [^]*$/, "w-paid", false],
  [/Every hold was cancelled\.[^]*$/, "w-rel", false],
];
const ASK_RULES: Rule[] = [[/\b\d+ of \d+\b/, "b", false]];

function highlight(text: string, rules: Rule[]): Seg[] {
  const out: Seg[] = [];
  let rest = String(text ?? "");
  let first = true;
  while (rest) {
    let best: { i: number; len: number; cls: Seg["cls"] } | null = null;
    for (const [re, cls, startOnly] of rules) {
      if (startOnly && !first) continue;
      const m = re.exec(rest);
      if (m && m[0].length > 0 && (!best || m.index < best.i)) best = { i: m.index, len: m[0].length, cls };
    }
    if (!best) {
      out.push({ text: rest, cls: "" });
      break;
    }
    if (best.i > 0) out.push({ text: rest.slice(0, best.i), cls: "" });
    out.push({ text: rest.slice(best.i, best.i + best.len), cls: best.cls });
    rest = rest.slice(best.i + best.len);
    first = false;
  }
  return out;
}
export const emphasis = (text: string): Seg[] => highlight(text, LOG_RULES);
/** The proposal card bolds the first "N of M". */
export const askEmphasis = (text: string): Seg[] => highlight(text, ASK_RULES);

export type End = "live" | "tipped" | "paid" | "missed" | "cancelled";
/** Where the sign is heading for a campaign state. */
export function endOf(state: CampaignState): End {
  switch (state) {
    case "tipped":
      return "tipped";
    case "paying_out":
    case "settled":
      return "paid";
    case "missed":
      return "missed";
    case "cancelled":
      return "cancelled";
    default:
      return "live";
  }
}

/** "Everyone's paid" only when PayPal confirmed every payout; otherwise the page says "Payouts sent". */
export function payoutsConfirmed(parties: { payoutStatus: string }[]): boolean {
  return parties.length > 0 && parties.every((p) => p.payoutStatus === "paid" || p.payoutStatus === "none");
}

/** The show's own clock: the server's `now` plus the time since it arrived. */
export class ShowClock {
  private base: number;
  private at: number;
  constructor(now: string | number, at: number = Date.now()) {
    const b = toMs(now);
    this.base = Number.isFinite(b) ? b : at;
    this.at = at;
  }
  now(at: number = Date.now()): number {
    return this.base + (at - this.at);
  }
  /** Adopts the server's clock only after a big jump (a demo fast-forward), so a slow answer can't nudge a running countdown. */
  sync(now: string | number, at: number = Date.now()): void {
    const b = toMs(now);
    if (Number.isFinite(b) && Math.abs(b - this.now(at)) > 60_000) {
      this.base = b;
      this.at = at;
    }
  }
}

export function remainSec(deadline: string | number, c: ShowClock | null, at: number = Date.now()): number {
  if (!c) return 0;
  const d = toMs(deadline);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - c.now(at)) / 1000)) : 0;
}
```

- [ ] **Step 7: Create `src/web/shared/keys.ts`.**

```ts
// Show ids from the URL, the artist's manage key, the judge's demo copy, dismissed proposals. Storage may throw (private mode): every access is guarded.
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const MANAGE = "ttr:manage:";
const DEMO = "ttr:demo";
const DISMISSED = "ttr:dismissed:";
const KEY_RE = /^[A-Za-z0-9_-]{6,128}$/;
const ID_RE = /^[a-z0-9-]{3,40}$/;

/** "/s/<id>" or "/s/<id>/manage" (Pages rewrites), or "?show=<id>" on a plain .html page. */
export function showIdFromPath(pathname: string, search = ""): string | null {
  const m = /^\/s\/([^/]+)(?:\/manage)?\/?$/.exec(pathname);
  let id: string | null;
  try {
    id = m ? decodeURIComponent(m[1]) : new URLSearchParams(search).get("show");
  } catch {
    return null;
  }
  return id && ID_RE.test(id) ? id : null;
}

export function takeKeyFromHash(hash: string): string | null {
  const k = hash.replace(/^#/, "");
  return KEY_RE.test(k) ? k : null;
}

export function rememberKey(store: KeyStore | null, showId: string, key: string): void {
  try {
    store?.setItem(MANAGE + showId, key);
  } catch {
    // Private mode: the key lives only in the link the artist saved.
  }
}

export function recallKey(store: KeyStore | null, showId: string): string | null {
  try {
    const k = store?.getItem(MANAGE + showId) ?? null;
    return k && KEY_RE.test(k) ? k : null;
  } catch {
    return null;
  }
}

export interface SavedDemo {
  demoId: string;
  demoKey: string;
  expiresAt: number;
}

export function saveDemo(store: KeyStore | null, d: SavedDemo): void {
  try {
    store?.setItem(DEMO, JSON.stringify(d));
  } catch {
    // Without storage the judge gets a fresh copy on the next visit.
  }
}

export function loadDemo(store: KeyStore | null): SavedDemo | null {
  try {
    const raw = store?.getItem(DEMO);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<SavedDemo>;
    if (typeof d.demoId === "string" && /^[a-z0-9]{3,40}$/.test(d.demoId) && typeof d.demoKey === "string" && KEY_RE.test(d.demoKey) && typeof d.expiresAt === "number") {
      return { demoId: d.demoId, demoKey: d.demoKey, expiresAt: d.expiresAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function dismiss(store: KeyStore | null, showId: string, proposalId: string): void {
  try {
    store?.setItem(`${DISMISSED}${showId}:${proposalId}`, "1");
  } catch {
    // The card comes back on reload; the agent log still has the "not now".
  }
}

export function isDismissed(store: KeyStore | null, showId: string, proposalId: string): boolean {
  try {
    return store?.getItem(`${DISMISSED}${showId}:${proposalId}`) === "1";
  } catch {
    return false;
  }
}
```

- [ ] **Step 8: Safe log lines and payout strip in `src/web/shared/ui.ts`.** Add this method to `class AgentLog` after `add(...)`:

```ts
  /** Same markup as add(), built from plain-text segments: backend text never goes through innerHTML. */
  addSegs({ time, segs, fine = '', tag = '', instant = false }: { time: string; segs: { text: string; cls: string }[]; fine?: string; tag?: string; instant?: boolean }) {
    const li = document.createElement('li'); if (tag) li.dataset.tag = tag;
    const t = document.createElement('time'); t.textContent = time;
    const msg = document.createElement('span'); msg.className = 'msg';
    for (const s of segs) {
      if (!s.cls) { msg.append(document.createTextNode(s.text)); continue; }
      const e = document.createElement(s.cls === 'b' ? 'b' : 'span'); if (s.cls !== 'b') e.className = s.cls; e.textContent = s.text; msg.append(e);
    }
    if (fine) { const sm = document.createElement('small'); sm.className = 'fine'; sm.textContent = fine; msg.append(sm); }
    li.append(t, msg); this.el.appendChild(li); if (!instant) enter(li); return li;
  }
```

In `class PayoutStrip`, replace the line `strip.innerHTML = payees.map(...).join('');` with:

```ts
    strip.textContent = '';
    for (const p of payees) {
      const cell = document.createElement('div'); cell.className = 'cell'; cell.dataset.state = 'waiting';
      const span = (cls: string, text: string) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
      const amt = span('amt', '$'); const n = document.createElement('span'); n.dataset.amt = ''; n.textContent = '0'; amt.append(n);
      const tag = span('tag', 'Waiting'); tag.dataset.tag = '';
      cell.append(span('lbl', p.label), span('who', p.who), amt, tag); strip.append(cell);
    }
```

Replace `fill(...)` and add `set` / `idle` after it:

```ts
  fill(amounts: number[], cues: Cues, noteText?: string, tags?: string[]) {
    amounts.forEach((v, i) => cues.at(i * .14, () => {
      this.odos[i].set(v);
      cues.at(.45, () => { const c = this.cells[i]; c.dataset.state = 'paid'; $('[data-tag]', c).textContent = tags?.[i] ?? 'Paid'; pop(c); });
    }));
    if (this.note && noteText) cues.at(.9, () => { this.note!.textContent = noteText; });
  }
  /** Final amounts at once (a page opened after the payout). */
  set(amounts: number[], tags: string[], states: string[], noteText?: string) {
    amounts.forEach((v, i) => { if (!this.cells[i]) return; this.odos[i].set(v, true); this.cells[i].dataset.state = states[i] ?? 'waiting'; $('[data-tag]', this.cells[i]).textContent = tags[i] ?? ''; });
    if (this.note && noteText) this.note.textContent = noteText;
  }
  /** The waiting sentence, from data. */
  idle(text: string) { if (this.note) { this.note.dataset.idle = text; this.note.textContent = text; } }
```

- [ ] **Step 9: Hooks type.** In `src/web/shared/hooks.ts` add to `MarqueeHooks`: `/** API calls and page actions in flight (parity tests wait for 0). */ readonly pending?: number;`.

- [ ] **Step 10: Run all checks.** `npx vitest run tests/web` → PASS. `npm run typecheck && npm run lint && npm test && npm run test:gpu` → PASS (the page DOM is unchanged: `PayoutStrip` builds the same elements; GPU 39/39).

- [ ] **Step 11: Commit.** `git add -A src/web tests/web && git commit -m "feat(web): typed API client, show formatting, keys, safe log and payout strip"` + trailer.

---

## Task 3: Test infrastructure: page routes, fake API, fixtures, parity allowances

This task changes no page behaviour. It moves every GPU spec onto a page table with final URLs and fake-API fixtures, so Tasks 4–8 only touch `src/`. The static pages ignore the fake API and the query string, so all 39 tests stay green here.

**Files:**
- Create: `src/web/build/routes.ts`, `tests/web/routes.test.ts`, `tests/gpu/fake-api.ts`, `tests/gpu/fixtures.ts`, `tests/gpu/pages.ts`
- Modify: `vite.config.ts`, `playwright.config.ts`, `tests/gpu/parity.ts`, `tests/gpu/demo.spec.ts`, `tests/gpu/start.spec.ts`, `tests/gpu/pledge.spec.ts`, `tests/gpu/manage.spec.ts`, `tests/gpu/prod-parity.spec.ts`, `tests/gpu/prod-smoke.spec.ts`, `tests/gpu/fallbacks.spec.ts`

**Interfaces:**
- `routes.ts`: `rewritePagePath(url: string): string` (`/s/:id/manage` → `/manage.html`, `/s/:id` → `/pledge.html`, `/start` → `/start.html`, query kept).
- `fake-api.ts`: `interface FakeRequest { method; path; body: unknown; key: string | null }`, `interface FakeReply { status?: number; body: unknown }`, `type FakeApi = (req) => FakeReply | undefined`, `installFakeApi(target: Page | BrowserContext, api: FakeApi): Promise<FakeRequest[]>`, `apiError(status, code, message): FakeReply`.
- `fixtures.ts`: `T(mo, d, h, mi?)`, `showOf(base, state)`, `MAYA_ID`, `MAYA_KEY`, `MAYA`, `mayaParties(status, paid?)`, `MANAGE_FRAMES`, `MANAGE_SCRIPTS` (`tipped`, `paid`, `calledOff`), `manageApi(frames)`, `PLEDGE_ORDER`, `pledgeApi(opts?)`, `START_CREATE`, `START_SIGNED`, `startApi(opts?)`, `DEMO_ID`, `DEMO_KEY`, `demoApi()`.
- `pages.ts`: `interface AppPage { name; refPath; appPath; prodPath; signs; api: () => FakeApi; dataFields: string[]; skip: string[] }`, `PAGES: Record<"demo" | "start" | "pledge" | "manage", AppPage>`.
- `parity.ts`: `openFrozen(browser, url, viewport, opts?: { reduced?: boolean; api?: FakeApi })`, `settle(page: Page): Promise<void>`, `shoot(f, fullPage, mask?: string[])`, `visibleText(page, hide?: string[])`, `expectParity(browser, refPath, appPath, scenario, opts: { viewport; fullPage; slug; expectSigns?; appBase?; api?: () => FakeApi; dataFields?: string[]; skip?: string[] })`, `APP_ONLY = "[data-app-only]"`.

- [ ] **Step 1: Write the failing route test.** `tests/web/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rewritePagePath } from "../../src/web/build/routes";

describe("page routes (same as public/_redirects)", () => {
  it("maps share, manage and start paths to their pages and keeps the query", () => {
    expect(rewritePagePath("/s/acoustic-set-nov20")).toBe("/pledge.html");
    expect(rewritePagePath("/s/acoustic-set-nov20/?e2e=parity")).toBe("/pledge.html?e2e=parity");
    expect(rewritePagePath("/s/sabcdefghjk/manage?e2e")).toBe("/manage.html?e2e");
    expect(rewritePagePath("/start")).toBe("/start.html");
    expect(rewritePagePath("/start?e2e=parity")).toBe("/start.html?e2e=parity");
  });
  it("leaves everything else alone", () => {
    for (const u of ["/", "/?e2e=parity", "/src/web/pages/pledge.ts", "/api/shows/x", "/s/a/b/c", "/assets/x.js", "/pledge.html"]) expect(rewritePagePath(u)).toBe(u);
  });
});
```

Run `npx vitest run tests/web/routes.test.ts` → FAIL (module not found).

- [ ] **Step 2: Create `src/web/build/routes.ts`.**

```ts
/** Dev and preview servers serve the same routes as Cloudflare Pages' public/_redirects. */
export function rewritePagePath(url: string): string {
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const search = q < 0 ? "" : url.slice(q);
  if (/^\/s\/[^/]+\/manage\/?$/.test(path)) return `/manage.html${search}`;
  if (/^\/s\/[^/]+\/?$/.test(path)) return `/pledge.html${search}`;
  if (path === "/start" || path === "/start/") return `/start.html${search}`;
  return url;
}
```

- [ ] **Step 3: Use it in `vite.config.ts`.** Replace the file:

```ts
import { defineConfig } from "vitest/config";
import type { Connect, Plugin } from "vite";
import { resolve } from "node:path";
import { rewritePagePath } from "./src/web/build/routes";

const root = import.meta.dirname;

/** /s/:id, /s/:id/manage and /start work on the dev and preview servers exactly as on Pages. */
function pagesRoutes(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url) req.url = rewritePagePath(req.url);
    next();
  };
  return {
    name: "pages-routes",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  plugins: [pagesRoutes()],
  server: { hmr: false, host: "127.0.0.1" },
  optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
  build: {
    rolldownOptions: {
      input: {
        main: resolve(root, "index.html"),
        start: resolve(root, "start.html"),
        pledge: resolve(root, "pledge.html"),
        manage: resolve(root, "manage.html"),
      },
      // Guarantees module-evaluation order across chunks, so gsap-global (window.gsap) runs before ui.ts's
      // module-load GSAP config. Without it the shared ui chunk can evaluate first in the production build.
      output: { strictExecutionOrder: true },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/gpu/**", "tests/e2e/**", "node_modules/**"],
    testTimeout: 30_000,
    // tests/agent/sqlite.ts uses node:sqlite, which prints an ExperimentalWarning in every worker.
    execArgv: ["--disable-warning=ExperimentalWarning"],
  },
});
```

- [ ] **Step 4: Test build settings in `playwright.config.ts`.** Replace the file:

```ts
// NOTE: parity runs need internet (the reference pages load fonts, three and gsap from CDNs) and a local GPU
// (WebGL via Metal). Without them the harness fails loudly instead of passing.
import { defineConfig } from "@playwright/test";

/** Public build settings for test servers: same-origin API (Playwright fakes it), no PayPal button, fixed share-link origin. */
const TEST_ENV = { VITE_API_BASE: "", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "https://tiptheroom.example", VITE_SANDBOX_BUYER_EMAIL: "", VITE_SANDBOX_BUYER_PASSWORD: "" };

// GPU parity tests: local only (hosted CI has no GPU). The reference is served as plain static files,
// the app by Vite, so each runs exactly the code it ships.
export default defineConfig({
  testDir: "tests/gpu",
  timeout: 180_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] },
  },
  webServer: [
    {
      command: "python3 -m http.server 5198 --bind 127.0.0.1 --directory reference",
      url: "http://127.0.0.1:5198/v2/demo.html",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 5199 --strictPort",
      url: "http://127.0.0.1:5199/",
      reuseExistingServer: true,
      timeout: 60_000,
      env: TEST_ENV,
    },
    {
      command: "npx vite build && npx vite preview --port 5200 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5200/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...TEST_ENV, VITE_E2E_HOOKS: "1" },
    },
  ],
});
```

- [ ] **Step 5: Create `tests/gpu/fake-api.ts`.**

```ts
// Parity and functional GPU tests never touch a backend: Playwright answers every /api/ request from a script.
import type { BrowserContext, Page, Route } from "@playwright/test";

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
}
export interface FakeReply {
  status?: number;
  body: unknown;
}
export type FakeApi = (req: FakeRequest) => FakeReply | undefined;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-manage-key", "access-control-allow-methods": "GET, POST, OPTIONS", "cache-control": "no-store" };

export const apiError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): FakeReply => ({ status, body: { error: { code, message, ...extra } } });

/** Routes every request whose path starts with /api/ to `api`. Unknown requests get a 404 error body. Returns the requests seen. */
export async function installFakeApi(target: Page | BrowserContext, api: FakeApi): Promise<FakeRequest[]> {
  const seen: FakeRequest[] = [];
  await target.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      let body: unknown = null;
      try {
        const raw = req.postData();
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const r: FakeRequest = { method: req.method(), path: new URL(req.url()).pathname, body, key: req.headers()["x-manage-key"] ?? null };
      seen.push(r);
      const reply = api(r) ?? apiError(404, "not_found", "There's nothing here.");
      await route.fulfill({ status: reply.status ?? 200, headers: { ...CORS, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(reply.body) });
    },
  );
  return seen;
}
```

- [ ] **Step 6: Create `tests/gpu/fixtures.ts`.** Every fixture is shaped so the text the app derives equals the reference's sample text (times in UTC, show `timeZone: "UTC"`, `now` = the reference's "now").

```ts
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

const line = (seq: number, at: number, did: string, saw: string, rule: RuleId | null = null): AgentLogDto => ({ seq, at, saw, did, rule, ruleTitle: null, requestId: null, resultId: null, source: "code" });

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

function holdRows(fans: number, status: LedgerStatus): LedgerRowDto[] {
  return Array.from({ length: fans }, (_, i) => ({ seq: i + 1, at: T(11, 3, 19, 12) + i * 3_600_000, what: "Fan held a spot", who: `Fan ${String(i + 1).padStart(2, "0")} · ${INITIALS[i]}`, amountCents: 1500, ref: `SAMPLE-AUTH-${String(i + 1).padStart(3, "0")}`, status })).reverse();
}

const ML = {
  signed: line(1, T(11, 8, 16, 12), "You signed the money rules. Your show is live.", "rules frozen · v1 · hash 9f2c41e7"),
  first: line(2, T(11, 3, 19, 12), "Your first fan held a spot. PayPal is holding $15.", "1 PayPal authorization", "rule-1-hold-only"),
  pace: line(3, T(11, 9, 9), "Pace check: 12 of 21 with 3 days left. I asked you about the deadline.", "projected 17 by the deadline · money rule 5 needs your OK"),
  approved: line(4, T(11, 9, 9, 11), "You approved it. The new deadline is Mon Nov 16, 6pm. Fans see it now.", "deadline extended once, +4 days · money rule 5 · approved by you"),
  five: line(5, T(11, 9, 9, 12), "5 more fans held a spot. PayPal is holding their $75.", "5 PayPal authorizations", "rule-1-hold-only"),
  four: line(6, T(11, 9, 9, 13), "4 more fans held a spot. PayPal is holding their $60.", "4 PayPal authorizations", "rule-1-hold-only"),
  tip: line(7, T(11, 9, 9, 15), "Your show reached 21 fans. It’s on! Everyone was charged at once: $315.", "captured 21 PayPal authorizations at tipping", "rule-2-capture-at-tip"),
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
  madeAt: T(11, 9, 9),
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

export function demoApi(): FakeApi {
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
  const response = (): DemoResponse => ({ demoId: DEMO_ID, demoKey: DEMO_KEY, shows: [a.show, b.show], expiresAt: T(11, 17, 10, 19) });
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
    if (s.show.state === "tipped") {
      set(s, { fans, state: "settled", now: deadline + 1000 });
      s.parties = demoParties(s.base, fans, "paid", true);
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
      b.proposals = [{ proposalId: "pace1", explanation: "Marlow Finch is at 19 of 28 with 2 days left. At this pace it lands near 25.", recommend: "extend", source: "template", options: [{ id: "extend", label: "Extend 7 days", newDeadline: iso(T(11, 27, 18)), newThreshold: null }, { id: "lower", label: "Lower the target to 25", newDeadline: null, newThreshold: 25 }], approved: null, madeAt: stamp() }];
      push(b, stamp(), "Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist.", "19 of 28 fans with 2 days left (75% of the way). At this pace, about 25.", "rule-5-ask-first");
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
```

- [ ] **Step 7: Create `tests/gpu/pages.ts`.**

```ts
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
```

- [ ] **Step 8: Harness allowances in `tests/gpu/parity.ts`.** Replace the file:

```ts
import { expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { installFakeApi, type FakeApi } from "./fake-api";

export const REF_BASE = "http://127.0.0.1:5198/v2/";
export const APP_BASE = "http://127.0.0.1:5199/";
export const PROD_BASE = "http://127.0.0.1:5200/";
export const MAX_DIFF_RATIO = 0.005;
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 400, height: 860 };
/** New real controls the reference doesn't have (judge panel, error lines, call-off …): hidden in the app page for parity. */
export const APP_ONLY = "[data-app-only]";

type Viewport = { width: number; height: number };

interface MarqueeView { anim?: { t0: number } }
interface MarqueeWindow { __marquee?: { ready?: boolean; views?: MarqueeView[]; pending?: number } }

export interface Frozen {
  page: Page;
  errors: string[];
  viewCount: number;
  run(ms: number): Promise<void>;
  toAnim(view: number, t: number): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openFrozen(browser: Browser, url: string, viewport: Viewport, opts: { reduced?: boolean; api?: FakeApi } = {}): Promise<Frozen> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, reducedMotion: opts.reduced ? "reduce" : "no-preference" });
  const page = await ctx.newPage();
  if (opts.api) await installFakeApi(page, opts.api);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await page.clock.install({ time: new Date("2026-11-16T10:19:00") });
  await page.clock.pauseAt(new Date("2026-11-16T10:19:01"));
  await page.goto(url, { waitUntil: "networkidle" });
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await page.evaluate(() => Boolean((window as MarqueeWindow).__marquee?.ready));
    if (!ready) await sleep(100);
  }
  if (!ready) {
    await ctx.close();
    throw new Error(`openFrozen: window.__marquee.ready never became true within 8 s at ${url} (page not loaded, script error, or no WebGL?)`);
  }
  const viewCount = await page.evaluate(() => (window as MarqueeWindow).__marquee?.views?.length ?? 0);
  await page.clock.runFor(1200);
  const run = (ms: number) => page.clock.runFor(ms);
  const toAnim = async (view: number, t: number) => {
    const ms = await page.evaluate(([i, tt]) => {
      const v = (window as MarqueeWindow).__marquee?.views?.[i];
      return v?.anim ? v.anim.t0 + tt * 1000 - performance.now() : null;
    }, [view, t] as const);
    if (ms === null) throw new Error(`toAnim: window.__marquee.views[${view}] or its anim is missing (no WebGL, or the animation never started)`);
    if (ms > 0) await page.clock.runFor(Math.ceil(ms));
  };
  return { page, errors, viewCount, run, toAnim, close: () => ctx.close() };
}

/**
 * Waits, in real time and without moving the page clock, until the app has no API call or page action in flight
 * (window.__marquee.pending is 0). The reference has no `pending`, so this returns at once there.
 */
export async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const n = await page.evaluate(() => (window as MarqueeWindow).__marquee?.pending ?? 0);
    if (n === 0) return;
    await sleep(25);
  }
  throw new Error("settle: the page still has API calls in flight after 5 s");
}

export async function shoot(f: Frozen, fullPage: boolean, mask: string[] = []): Promise<Buffer> {
  await f.page.evaluate(() => scrollTo(0, 0));
  await f.page.evaluate(() => document.fonts.ready);
  await sleep(300);
  return f.page.screenshot({ fullPage, mask: ["[data-ref-only]", ...mask].map((s) => f.page.locator(s)), maskColor: "#FF00FF" });
}

// Visible text of the page, for comparing what the pixels cannot (a wrong digit, a changed sentence).
// Reads document.body.innerText with [data-ref-only] elements (and any `hide` selectors) hidden for the read.
// The odometer's visual digit strips (span.odo, aria-hidden) are hidden too: they hold the digits 0-9 over and over,
// and the real value is carried by the sibling span.sr, which stays in the text.
// Whitespace runs collapse to one space per line and blank lines are dropped.
export async function visibleText(page: Page, hide: string[] = []): Promise<string> {
  const raw = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const saved = els.map((el) => el.style.display);
    els.forEach((el) => { el.style.display = "none"; });
    const text = document.body.innerText;
    els.forEach((el, i) => { el.style.display = saved[i] ?? ""; });
    return text;
  }, ["[data-ref-only]", ".odo", ...hide].join(", "));
  return raw.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

export function firstTextDifference(refText: string, appText: string): string {
  const r = refText.split("\n");
  const a = appText.split("\n");
  for (let i = 0; i < Math.max(r.length, a.length); i++) {
    if (r[i] !== a[i]) return `line ${i + 1}: reference ${JSON.stringify(r[i] ?? "(missing)")} vs app ${JSON.stringify(a[i] ?? "(missing)")}`;
  }
  return "(no difference)";
}

export function diffRatio(a: Buffer, b: Buffer, diffOut?: PNG): number {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) return 1;
  const out = diffOut ?? new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, out.data, A.width, A.height, { threshold: 0.1 });
  return n / (A.width * A.height);
}

async function hide(page: Page, selectors: string[]): Promise<void> {
  if (selectors.length) await page.addStyleTag({ content: `${selectors.join(", ")}{display:none!important}` });
}

/**
 * Data fields: reference sample words the API can't carry (a show time, a description). The app element gets the
 * reference element's exact size, both are masked, and both are left out of the text check.
 */
async function equalize(ref: Page, app: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    const box = await ref.evaluate((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { w: r.width, h: r.height } : null;
    }, sel);
    if (!box) throw new Error(`data field ${sel} is missing on the reference page`);
    const found = await app.evaluate(([s, w, h]) => {
      const el = document.querySelector<HTMLElement>(s);
      if (!el) return false;
      if (h > 0) Object.assign(el.style, { boxSizing: "border-box", width: `${w}px`, height: `${h}px`, overflow: "hidden" });
      return true;
    }, [sel, box.w, box.h] as const);
    if (!found) throw new Error(`data field ${sel} is missing on the app page`);
  }
}

export type Scenario = (f: Frozen) => Promise<void>;

export interface ParityOptions {
  viewport: Viewport;
  fullPage: boolean;
  slug: string;
  expectSigns?: boolean;
  appBase?: string;
  api?: () => FakeApi;
  dataFields?: string[];
  skip?: string[];
}

export async function expectParity(browser: Browser, refPath: string, appPath: string, scenario: Scenario, opts: ParityOptions): Promise<number> {
  let ref: Frozen | undefined;
  let app: Frozen | undefined;
  const fields = opts.dataFields ?? [];
  const skip = opts.skip ?? [];
  try {
    ref = await openFrozen(browser, REF_BASE + refPath, opts.viewport);
    app = await openFrozen(browser, (opts.appBase ?? APP_BASE) + appPath, opts.viewport, { api: opts.api?.() });
    if (opts.expectSigns ?? true) {
      expect(ref.viewCount, `${opts.slug}: reference rendered no signs (WebGL unavailable?), so nothing real would be compared`).toBeGreaterThan(0);
      expect(app.viewCount, `${opts.slug}: app sign count differs from the reference`).toBe(ref.viewCount);
    }
    await scenario(ref);
    await scenario(app);
    await hide(ref.page, skip);
    await hide(app.page, [...skip, APP_ONLY]);
    await equalize(ref.page, app.page, fields);
    const a = await shoot(ref, opts.fullPage, fields);
    const b = await shoot(app, opts.fullPage, fields);
    const refText = await visibleText(ref.page, fields);
    const appText = await visibleText(app.page, fields);
    const textEqual = refText === appText;
    const A = PNG.sync.read(a);
    const diff = new PNG({ width: A.width, height: A.height });
    const ratio = diffRatio(a, b, diff);
    const errorsFound = ref.errors.length > 0 || app.errors.length > 0;
    if (errorsFound || ratio > MAX_DIFF_RATIO || !textEqual) {
      mkdirSync("test-results/parity", { recursive: true });
      writeFileSync(`test-results/parity/${opts.slug}-ref.png`, a);
      writeFileSync(`test-results/parity/${opts.slug}-app.png`, b);
      writeFileSync(`test-results/parity/${opts.slug}-diff.png`, PNG.sync.write(diff));
      writeFileSync(`test-results/parity/${opts.slug}-ref.txt`, refText + "\n");
      writeFileSync(`test-results/parity/${opts.slug}-app.txt`, appText + "\n");
    }
    expect(ref.errors, "reference page errors").toEqual([]);
    expect(app.errors, "app page errors").toEqual([]);
    expect(refText.length, `${opts.slug}: reference page has no visible text, so the text check would prove nothing`).toBeGreaterThan(50);
    expect(textEqual, `${opts.slug}: visible text differs, first at ${firstTextDifference(refText, appText)}`).toBe(true);
    expect(ratio, `${opts.slug}: ${(ratio * 100).toFixed(3)}% of pixels differ`).toBeLessThanOrEqual(MAX_DIFF_RATIO);
    return ratio;
  } finally {
    await ref?.close();
    await app?.close();
  }
}
```

- [ ] **Step 9: Put the parity specs on the page table.** Replace `tests/gpu/demo.spec.ts`:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

const P = PAGES.demo;
const press = async (f: Parameters<Scenario>[0], key: string) => {
  await f.page.keyboard.press(key);
  await settle(f.page);
};
const tipTo = (t: number): Scenario => async (f) => {
  await press(f, "t");
  await f.run(1700);
  await f.toAnim(0, t);
};
const payoutTo = (t: number): Scenario => async (f) => {
  await press(f, "t");
  await f.run(1700);
  await f.toAnim(0, 4.8);
  await f.run(500);
  await press(f, "p");
  await f.run(1250);
  await f.toAnim(0, t);
};
const missTo = (t: number): Scenario => async (f) => {
  await press(f, "m");
  await f.run(1250);
  await f.toAnim(1, t);
};

const cases: Array<{ slug: string; scenario: Scenario; viewport: typeof DESKTOP; fullPage: boolean }> = [
  { slug: "demo-rest", scenario: async () => {}, viewport: DESKTOP, fullPage: true },
  { slug: "demo-tip-0.7", scenario: tipTo(0.7), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-2.4", scenario: tipTo(2.4), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-3.1", scenario: tipTo(3.1), viewport: DESKTOP, fullPage: false },
  { slug: "demo-tip-4.8", scenario: tipTo(4.8), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-1.0", scenario: payoutTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-payout-2.6", scenario: payoutTo(2.6), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-1.0", scenario: missTo(1.0), viewport: DESKTOP, fullPage: false },
  { slug: "demo-miss-3.2", scenario: missTo(3.2), viewport: DESKTOP, fullPage: true },
  { slug: "demo-phone-rest", scenario: async () => {}, viewport: PHONE, fullPage: true },
];

for (const c of cases) {
  test(`parity: ${c.slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, c.scenario, { viewport: c.viewport, fullPage: c.fullPage, slug: c.slug, api: P.api, dataFields: P.dataFields, skip: P.skip });
  });
}
```

Replace `tests/gpu/start.spec.ts`:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

const P = PAGES.start;
const filled: Scenario = async (f) => {
  await f.page.click("#fill");
  await settle(f.page);
  await f.run(900);
};
const live: Scenario = async (f) => {
  await filled(f);
  await f.page.evaluate(() => (window as unknown as { __marquee: { setEmails(): void } }).__marquee.setEmails());
  await f.run(400);
  await f.page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());
  await settle(f.page);
  await f.run(1600);
};

for (const [slug, scenario, viewport] of [
  ["start-initial", async () => {}, DESKTOP],
  ["start-filled", filled, DESKTOP],
  ["start-live", live, DESKTOP],
  ["start-phone-filled", filled, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: P.api, dataFields: P.dataFields, skip: P.skip });
  });
}
```

Replace `tests/gpu/pledge.spec.ts`:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Scenario } from "./parity";
import { PAGES } from "./pages";

interface PledgeWindow { __marquee: { setInitials(s: string): void; approve(): void } }
const P = PAGES.pledge;

// Hook call shapes match reference/v2/pledge.html: setInitials(string) and approve() (no arguments).
const onHold: Scenario = async (f) => {
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.setInitials("MR"));
  await f.page.evaluate(() => (window as unknown as PledgeWindow).__marquee.approve());
  await settle(f.page);
  await f.run(1500);
};

for (const [slug, scenario, viewport] of [
  ["pledge-initial", async () => {}, DESKTOP],
  ["pledge-on-hold", onHold, DESKTOP],
  ["pledge-phone-initial", async () => {}, PHONE],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: P.api, dataFields: P.dataFields, skip: P.skip });
  });
}
```

Replace `tests/gpu/manage.spec.ts`:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PHONE, expectParity, settle, type Frozen, type Scenario } from "./parity";
import { MANAGE_SCRIPTS, manageApi } from "./fixtures";
import { PAGES } from "./pages";

interface ManageHooks { approve(): void; addFans(n: number): void; skip(): void; reset(): void; decline(): void }
type ManageWindow = { __marquee: ManageHooks };
const P = PAGES.manage;

const approve = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.approve()); await settle(f.page); };
const decline = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.decline()); await settle(f.page); };
const addFans = async (f: Frozen, n: number) => { await f.page.evaluate((count) => (window as unknown as ManageWindow).__marquee.addFans(count), n); await settle(f.page); };
const skip = async (f: Frozen) => { await f.page.evaluate(() => (window as unknown as ManageWindow).__marquee.skip()); await settle(f.page); };

const tipped: Scenario = async (f) => {
  await approve(f);
  await f.run(800);
  await addFans(f, 5);
  await f.run(1800);
  await addFans(f, 5);
  await f.run(6700);
};
const paid: Scenario = async (f) => {
  await tipped(f);
  await skip(f);
  await f.run(4450);
};
const calledOff: Scenario = async (f) => {
  await decline(f);
  await skip(f);
  await f.run(4850);
};

for (const [slug, scenario, viewport, frames] of [
  ["manage-initial", async () => {}, DESKTOP, MANAGE_SCRIPTS.tipped],
  ["manage-tipped", tipped, DESKTOP, MANAGE_SCRIPTS.tipped],
  ["manage-paid", paid, DESKTOP, MANAGE_SCRIPTS.paid],
  ["manage-called-off", calledOff, DESKTOP, MANAGE_SCRIPTS.calledOff],
  ["manage-phone-initial", async () => {}, PHONE, MANAGE_SCRIPTS.tipped],
] as const) {
  test(`parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, P.refPath, P.appPath, scenario, { viewport, fullPage: true, slug, api: () => manageApi([...frames]), dataFields: P.dataFields, skip: P.skip });
  });
}
```

- [ ] **Step 10: Put prod parity, prod smoke and fallbacks on the page table.** Replace `tests/gpu/prod-parity.spec.ts`:

```ts
import { test } from "@playwright/test";
import { DESKTOP, PROD_BASE, expectParity } from "./parity";
import { PAGES } from "./pages";

// The same pixel and text comparison as the dev parity specs, but the app side is the built site
// (vite build + preview, test hooks on with ?e2e), so minification or chunk-order problems that change the look show up here.
for (const p of [PAGES.demo, PAGES.start, PAGES.pledge, PAGES.manage]) {
  const slug = `${p.name === "demo" ? "demo-rest" : `${p.name}-initial`}`;
  test(`prod parity: ${slug}`, async ({ browser }) => {
    await expectParity(browser, p.refPath, p.prodPath, async () => {}, { viewport: DESKTOP, fullPage: true, slug: `prod-${slug}`, appBase: PROD_BASE, api: p.api, dataFields: p.dataFields, skip: p.skip });
  });
}
```

Replace `tests/gpu/prod-smoke.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { installFakeApi } from "./fake-api";
import { PROD_BASE, settle } from "./parity";
import { PAGES, type AppPage } from "./pages";

// The parity harness only sees the dev server. This runs the built site (vite build + preview) so
// production-only problems (chunk evaluation order, minification) are caught.

interface ProdWindow { __marquee?: { ready?: boolean; views?: unknown[]; ctls?: { phase: string }[] }; gsap?: { config(): { force3D?: unknown } } }

// Opens a built page, waits for window.__marquee.ready and checks the sign count and the GSAP config.
// ui.ts sets force3D:false at module load; seeing it proves window.gsap existed when ui.ts evaluated.
async function openProdPage(page: Page, p: AppPage): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  await installFakeApi(page, p.api());
  await page.goto(`${PROD_BASE}${p.prodPath}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean((window as ProdWindow).__marquee?.ready), undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as ProdWindow).__marquee?.views?.length)).toBe(p.signs);
  expect(await page.evaluate(() => (window as ProdWindow).gsap?.config().force3D)).toBe(false);
  return errors;
}

test("production build: / loads, GSAP config ran, demo keys run clean", async ({ page }) => {
  const errors = await openProdPage(page, PAGES.demo);
  const phases = () => page.evaluate(() => (window as unknown as ProdWindow).__marquee?.ctls?.map((c) => c.phase).join(","));
  await page.keyboard.press("t");
  await settle(page);
  await expect.poll(phases, { timeout: 30_000 }).toBe("tipped,open");
  await page.keyboard.press("p");
  await settle(page);
  await page.keyboard.press("m");
  await settle(page);
  await expect.poll(phases, { timeout: 30_000 }).toBe("paid,released");
  expect(errors).toEqual([]);
});

test("production build: /start loads, GSAP config ran, fill runs clean", async ({ page }) => {
  // The reference start page creates one sign (the live preview).
  const errors = await openProdPage(page, PAGES.start);
  await page.click("#fill");
  await settle(page);
  await page.waitForTimeout(1500);
  await expect(page.locator("[data-target-sentence]")).toContainText("You need 21 fans at $15");
  expect(errors).toEqual([]);
});

test("production build: the fan page loads, GSAP config ran, approval runs clean", async ({ page }) => {
  // The reference fan page creates one sign.
  const errors = await openProdPage(page, PAGES.pledge);
  // Reference hook shapes: setInitials(string) and approve() with no arguments.
  await page.evaluate(() => {
    const m = (window as unknown as { __marquee: { setInitials(s: string): void; approve(): void } }).__marquee;
    m.setInitials("MR");
    m.approve();
  });
  await settle(page);
  await page.waitForTimeout(2000);
  await expect(page.locator("#confirm")).toBeVisible();
  await expect(page.locator("[data-confirm-bulb]")).toContainText("MR");
  expect(errors).toEqual([]);
});

test("production build: the show page loads, GSAP config ran, approve and add fans run clean", async ({ page }) => {
  // The reference artist page creates one sign.
  const errors = await openProdPage(page, PAGES.manage);
  // Reference hook shapes: approve() with no arguments and addFans(n).
  await page.evaluate(() => (window as unknown as { __marquee: { approve(): void } }).__marquee.approve());
  await settle(page);
  await page.evaluate(() => (window as unknown as { __marquee: { addFans(n: number): void } }).__marquee.addFans(5));
  await settle(page);
  await page.waitForTimeout(2500);
  await expect(page.locator("#ask")).toBeHidden();
  await expect(page.locator("[data-fans]")).toContainText("17");
  expect(errors).toEqual([]);
});
```

In `tests/gpu/fallbacks.spec.ts` make exactly these edits (the rest of the file stays as it is):
1. Imports: `import { APP_BASE, DESKTOP, openFrozen, settle, type Frozen } from "./parity";`, plus `import { installFakeApi } from "./fake-api";` and `import { PAGES } from "./pages";`.
2. Replace the `pages` constant with `const pages = [PAGES.demo, PAGES.start, PAGES.pledge, PAGES.manage].map((p) => ({ path: p.appPath, name: p.name, signs: p.signs, api: p.api }));`.
3. In `runFlow`, add `await settle(page);` right after each `page.keyboard.press(...)`, after `page.click("#fill")`, and after each `call(page, ...)`.
4. In the reduced-motion test: `openFrozen(browser, APP_BASE + p.path, DESKTOP, { reduced: true, api: p.api() })`.
5. In the no-WebGL test: right after `const page = await ctx.newPage();` add `await installFakeApi(page, p.api());`.

- [ ] **Step 11: Run all checks.** `npx vitest run tests/web/routes.test.ts` → PASS. `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS, still 39 GPU tests (static pages ignore the fake API; the data fields and the ledger skip compare identical elements; `settle` returns at once because the static pages have no `pending`).

- [ ] **Step 12: Commit.** `git add -A vite.config.ts playwright.config.ts src/web/build tests && git commit -m "test(gpu): page table, fake API fixtures, parity data fields and settle; dev routes for /s/:id"` + trailer.

---

## Task 4: Fan pledge page (`/s/:id`) with the real PayPal v6 button

**Files:**
- Create: `src/web/shared/pledge-flow.ts`, `src/web/shared/paypal.ts`, `tests/web/pledge-flow.test.ts`, `tests/gpu/pledge-flows.spec.ts`
- Modify: `src/web/pages/pledge.ts` (replace), `pledge.html`, `src/web/shared/styles.css` (append)

**Interfaces:**
- `pledge-flow.ts`: `interface PledgeApi { createOrder(initials): Promise<CreateOrderResponse>; authorize(orderId): Promise<AuthorizeResponse> }`, `type PledgeEvent = { kind: "busy" } | { kind: "held"; res: AuthorizeResponse; initials: string } | { kind: "cancelled"; message: string } | { kind: "failed"; message: string }`, `CANCELLED`, `cleanInitials(v)`, `failureMessage(e)`, `class PledgeFlow { busy; done; createOrder(): Promise<string>; approve(orderId): Promise<void>; cancel(); error(e); simulate(): Promise<void> }`.
- `paypal.ts`: `SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core"`, `loadSdk(timeoutMs?)`, `interface ButtonHandlers`, `mountPayPalButton(slot, clientId, handlers): Promise<void>`.
- Page hooks (HOOKS only): `window.__marquee = { page: "pledge", ready, views, host, state, pending, approve(), setFans(n), setInitials(v) }`; `approve()` runs the real create-order → authorize path against the API (fake in tests).
- New DOM hooks in `pledge.html`: `[data-of]`, `[data-pledge-text]`, `[data-faq-hold]`, `[data-faq-when]`, `[data-pledge-msg]` (app-only), `#notice` (app-only).

- [ ] **Step 1: Write the failing unit test.** `tests/web/pledge-flow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AuthorizeResponse } from "../../src/worker/api-types";
import { ApiFailure } from "../../src/web/shared/api";
import { CANCELLED, cleanInitials, failureMessage, PledgeFlow, type PledgeApi, type PledgeEvent } from "../../src/web/shared/pledge-flow";

const held = { pledgeId: "p1", status: "held", tipped: false, show: {} } as unknown as AuthorizeResponse;

function setup(authorize: (orderId: string, n: number) => Promise<AuthorizeResponse>, createOrder?: () => Promise<never>) {
  const events: PledgeEvent[] = [];
  const authorized: string[] = [];
  let orders = 0;
  let auths = 0;
  const api: PledgeApi = {
    createOrder: createOrder ?? (async () => { orders += 1; return { orderId: `ORDER${orders}`, pledgeId: `p${orders}`, amountCents: 1500 }; }),
    authorize: (id) => { authorized.push(id); return authorize(id, ++auths); },
  };
  return { flow: new PledgeFlow(api, (e) => events.push(e), () => "MR"), events, authorized };
}

describe("pledge flow", () => {
  it("creates an order, authorizes it and reports the hold", async () => {
    const t = setup(async () => held);
    const id = await t.flow.createOrder();
    await t.flow.approve(id);
    expect(id).toBe("ORDER1");
    expect(t.events.map((e) => e.kind)).toEqual(["busy", "held"]);
    expect(t.events[1]).toMatchObject({ initials: "MR" });
    expect(t.flow.done).toBe(true);
    expect(t.flow.busy).toBe(false);
  });

  it("after a 502 on authorize, says so plainly and the next try uses a NEW order", async () => {
    const t = setup(async (_id, n) => { if (n === 1) throw new ApiFailure(502, "paypal_error", "PayPal didn't answer as expected. Nothing was charged."); return held; });
    await t.flow.approve(await t.flow.createOrder());
    expect(t.events.at(-1)).toEqual({ kind: "failed", message: "PayPal didn't answer as expected. Nothing was charged. Please try again." });
    expect(t.flow.busy).toBe(false);
    expect(t.flow.done).toBe(false);
    await t.flow.approve(await t.flow.createOrder());
    expect(t.authorized).toEqual(["ORDER1", "ORDER2"]);
    expect(t.events.at(-1)?.kind).toBe("held");
  });

  it("a cancelled popup places no hold and can be tried again", async () => {
    const t = setup(async () => held);
    await t.flow.createOrder();
    t.flow.cancel();
    expect(t.events.at(-1)).toEqual({ kind: "cancelled", message: CANCELLED });
    expect(t.flow.busy).toBe(false);
    expect(await t.flow.createOrder()).toBe("ORDER2");
  });

  it("shows our API's plain message when the order can't be created", async () => {
    const t = setup(async () => held, async () => { throw new ApiFailure(429, "rate_limited", "Too many tries. Please wait a moment and try again."); });
    await expect(t.flow.createOrder()).rejects.toBeInstanceOf(ApiFailure);
    expect(t.events.at(-1)).toEqual({ kind: "failed", message: "Too many tries. Please wait a moment and try again." });
  });

  it("does nothing more once the fan is on hold", async () => {
    const t = setup(async () => held);
    await t.flow.approve(await t.flow.createOrder());
    const n = t.events.length;
    await expect(t.flow.createOrder()).rejects.toThrow();
    t.flow.cancel();
    t.flow.error(new Error("late"));
    expect(t.events).toHaveLength(n);
  });

  it("simulate() runs the same create → authorize path and never throws", async () => {
    const t = setup(async () => { throw new ApiFailure(0, "network", "We couldn't reach Tip the Room. Check your connection and try again."); });
    await expect(t.flow.simulate()).resolves.toBeUndefined();
    expect(t.events.at(-1)?.kind).toBe("failed");
  });

  it("cleans initials and words unknown failures plainly", () => {
    expect(cleanInitials("m.r.")).toBe("MR");
    expect(cleanInitials("abcd")).toBe("ABC");
    expect(cleanInitials("<b>")).toBe("B");
    expect(cleanInitials("")).toBe("YOU");
    expect(failureMessage(new Error("INSTRUMENT_DECLINED"))).toBe("PayPal couldn't finish. Nothing was charged. Please try again.");
  });
});
```

Run `npx vitest run tests/web/pledge-flow.test.ts` → FAIL (module not found).

- [ ] **Step 2: Create `src/web/shared/pledge-flow.ts`.**

```ts
// The fan's pledge, separate from the DOM and the PayPal SDK so its failure paths are unit-tested.
import type { AuthorizeResponse, CreateOrderResponse } from "../../worker/api-types";
import { ApiFailure } from "./api";

export interface PledgeApi {
  createOrder(initials: string): Promise<CreateOrderResponse>;
  authorize(orderId: string): Promise<AuthorizeResponse>;
}

export type PledgeEvent = { kind: "busy" } | { kind: "held"; res: AuthorizeResponse; initials: string } | { kind: "cancelled"; message: string } | { kind: "failed"; message: string };

export const CANCELLED = "No hold was placed. You can try again whenever you like.";
const PAYPAL_TROUBLE = "PayPal didn't answer as expected. Nothing was charged. Please try again.";
const UNKNOWN = "PayPal couldn't finish. Nothing was charged. Please try again.";

/** 1 to 3 letters for the bulb; "YOU" when the fan leaves it blank. The server checks it again. */
export function cleanInitials(v: string): string {
  return (v || "").replace(/[^a-z]/gi, "").slice(0, 3).toUpperCase() || "YOU";
}

export function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) return e.code === "paypal_error" ? PAYPAL_TROUBLE : e.message;
  return UNKNOWN;
}

export class PledgeFlow {
  busy = false;
  done = false;

  constructor(
    private readonly api: PledgeApi,
    private readonly emit: (e: PledgeEvent) => void,
    private readonly initials: () => string,
  ) {}

  /** The PayPal button calls this for every attempt, so a failed or cancelled order is never reused. */
  async createOrder(): Promise<string> {
    if (this.done) throw new Error("This fan is already on hold.");
    this.busy = true;
    this.emit({ kind: "busy" });
    try {
      return (await this.api.createOrder(this.initials())).orderId;
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }

  async approve(orderId: string): Promise<void> {
    if (this.done) return;
    try {
      const res = await this.api.authorize(orderId);
      this.busy = false;
      this.done = true;
      this.emit({ kind: "held", res, initials: this.initials() });
    } catch (e) {
      this.fail(e);
    }
  }

  cancel(): void {
    if (this.done) return;
    this.busy = false;
    this.emit({ kind: "cancelled", message: CANCELLED });
  }

  error(e: unknown): void {
    if (this.done) return;
    this.fail(e);
  }

  /** Test hook path: the same create → authorize calls the button makes, without the popup. */
  async simulate(): Promise<void> {
    try {
      await this.approve(await this.createOrder());
    } catch {
      // Already reported through emit.
    }
  }

  private fail(e: unknown): void {
    this.busy = false;
    this.emit({ kind: "failed", message: failureMessage(e) });
  }
}
```

- [ ] **Step 3: Create `src/web/shared/paypal.ts`.**

```ts
// PayPal JS SDK v6, loaded from the sandbox host only (spec §6.1: Orders v2 intent AUTHORIZE, our server creates and
// authorizes the order). The real popup is checked by hand in Plan 6; GPU tests load a stub from this same URL.
export const SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

interface Session {
  start(options: { presentationMode: "auto" | "popup" | "modal" | "redirect" }, order: Promise<{ orderId: string }>): Promise<void>;
}
interface SdkInstance {
  findEligibleMethods(options?: { currencyCode?: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(callbacks: { onApprove(data: { orderId: string }): Promise<void> | void; onCancel(data?: unknown): void; onError(error: unknown): void }): Session | Promise<Session>;
}
interface PayPalV6 {
  createInstance(options: { clientId: string; components: string[] }): Promise<SdkInstance>;
}
declare global {
  interface Window {
    paypal?: PayPalV6;
  }
}

let loading: Promise<PayPalV6> | null = null;

export function loadSdk(timeoutMs = 15_000): Promise<PayPalV6> {
  if (window.paypal) return Promise.resolve(window.paypal);
  loading ??= new Promise<PayPalV6>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.async = true;
    const timer = setTimeout(() => reject(new Error("The PayPal SDK took too long to load.")), timeoutMs);
    s.onload = () => {
      clearTimeout(timer);
      if (window.paypal) resolve(window.paypal);
      else reject(new Error("The PayPal SDK loaded without window.paypal."));
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error("The PayPal SDK failed to load."));
    };
    document.head.append(s);
  }).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

export interface ButtonHandlers {
  /** Our API creates the order; returns its id. Called for every click. */
  createOrder(): Promise<string>;
  onApprove(orderId: string): Promise<void>;
  onCancel(): void;
  onError(error: unknown): void;
}

/** Replaces the slot's placeholder text with PayPal's button. Rejects when the SDK can't load or PayPal isn't offered. */
export async function mountPayPalButton(slot: HTMLElement, clientId: string, h: ButtonHandlers): Promise<void> {
  const paypal = await loadSdk();
  const sdk = await paypal.createInstance({ clientId, components: ["paypal-payments"] });
  const eligible = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!eligible.isEligible("paypal")) throw new Error("PayPal isn't offered here.");
  const session = await sdk.createPayPalOneTimePaymentSession({ onApprove: (d) => h.onApprove(d.orderId), onCancel: () => h.onCancel(), onError: (e) => h.onError(e) });
  const button = document.createElement("paypal-button");
  button.setAttribute("type", "pay");
  slot.textContent = "";
  slot.classList.add("is-rendered");
  slot.append(button);
  button.addEventListener("click", () => {
    session.start({ presentationMode: "auto" }, h.createOrder().then((orderId) => ({ orderId }))).catch((e: unknown) => h.onError(e));
  });
}
```

- [ ] **Step 4: Data hooks in `pledge.html`.** Make exactly these edits (attributes don't change pixels; the new elements are `hidden` and `data-app-only`):
1. Right after `<main>` add: `<section class="card notice" id="notice" data-app-only hidden aria-live="polite"><p data-notice-text></p></section>`
2. In the fans stat, change `<span>of 21 fans</span>` to `<span data-of>of 21 fans</span>`.
3. In the pledge card, change `<p style="margin:0;font-size:17px">` to `<p style="margin:0;font-size:17px" data-pledge-text>`.
4. After the `#pp-slot` div add: `<p class="pledge-msg" data-pledge-msg data-app-only hidden aria-live="polite"></p>`
5. FAQ: add `data-faq-hold` to the first answer `<p>` and `data-faq-when` to the second.

Append to `src/web/shared/styles.css`:

```css
/* ---------- Plan 5 (app-only): live PayPal button, pledge messages, page notices */
.pp-slot.is-rendered{border:0;background:none;min-height:0;padding:0;display:block}
.pledge-msg{margin:0;font:500 16px/1.4 var(--f-ui);color:#8A1A12}
.notice{margin:0 0 22px}
.notice p{margin:0;font:500 18px/1.45 var(--f-ui)}
```

- [ ] **Step 5: Replace `src/web/pages/pledge.ts`.**

```ts
import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, Placeholder, setStatus, countdownHTML, enter, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { AuthorizeResponse, PublicShow } from "../../worker/api-types";
import { API_BASE, HOOKS, PARITY, markReady, paypalClientId, removeRefOnly } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { dayLabel, dollars, endOf, planSplit, remainSec, ROLE_WORD, ShowClock, when } from "../shared/format";
import { showIdFromPath } from "../shared/keys";
import { cleanInitials, PledgeFlow, type PledgeEvent } from "../shared/pledge-flow";
import { mountPayPalButton } from "../shared/paypal";

removeRefOnly();
const api = apiClient(API_BASE);
const showId = showIdFromPath(location.pathname, location.search);
const SEED = 31, YAW = .16; // the reference's single-sign look (pledge, manage and start share it)
const NO_SHOW = 'There’s no show at this link. Check the link with whoever sent it.';

type PPhase = 'held' | 'tipping' | 'tipped' | 'closed';
interface PledgeState { fans: number; phase: PPhase; busy: boolean; mine: number }
const st: PledgeState = { fans: 0, phase: 'held', busy: false, mine: -1 };
let show: PublicShow | null = null, clock: ShowClock | null = null, ph: Placeholder | null = null, view: SignView | null = null;
const el = { stage: $('[data-stage]'), status: $('[data-status]'), clock: $('[data-clock]'), sub: $('[data-fans-sub]'), initials: $<HTMLInputElement>('#initials'), card: $('#pledge-card'), confirm: $('#confirm'), slot: $('#pp-slot'), msg: $('[data-pledge-msg]'), notice: $('#notice') };
const odoFans = new Odo($('[data-fans]')), odoHeld = new Odo($('[data-held]')), odoCharged = new Odo($('[data-charged]'));
const cues = new Cues();
Ticker.lamp(el.status);

const price = () => show?.ticketPriceCents ?? 0;
const target = () => show?.threshold ?? 1;
const closedVisual = (): Phase => { const e = show ? endOf(show.state) : 'live'; return e === 'paid' ? 'paid' : e === 'missed' || e === 'cancelled' ? 'released' : 'tipped'; };
const visual = (): { phase: Phase; fans: number } => ({ phase: st.phase === 'closed' ? closedVisual() : st.phase === 'tipped' || st.phase === 'tipping' ? 'tipped' : 'held', fans: st.fans });
const say = (text: string) => { el.msg.textContent = text; el.msg.hidden = !text; };
const simulateBtn = () => document.querySelector<HTMLButtonElement>('#simulate');

function renderClock() {
  const closed = st.phase === 'closed';
  el.clock.classList.toggle('zero', closed);
  el.clock.innerHTML = countdownHTML(closed || !show ? 0 : remainSec(show.deadline, clock));
}
function render(instant = false) {
  const p = dollars(price()), t = target(), v = visual().phase, charged = v === 'tipped' || v === 'paid', total = st.fans * price() / 100;
  odoFans.set(st.fans, instant);
  odoHeld.set(charged || v === 'released' ? 0 : total, instant); odoCharged.set(charged ? total : 0, instant);
  el.sub.textContent = v === 'paid' ? 'Everyone’s paid' : v === 'released' ? `Called off · ${Math.max(0, t - st.fans)} short` : charged ? 'It’s on! Everyone’s charged' : `${t - st.fans} more to make it happen`;
  $('[data-money-sub]').textContent = charged ? `Charged the moment it tipped · ${st.fans} × ${p}` : v === 'released' ? 'Every hold was cancelled. Nobody paid.' : 'Nobody pays unless it happens.';
  renderClock();
  const name = show?.showName ?? '';
  el.stage.setAttribute('aria-label', charged ? `Marquee sign for ${name}, fully lit: ${t} fans joined and the show is on.` : `Marquee sign for ${name}: ${st.fans} of ${t} bulbs glowing dimly, fans on hold.`);
  ph?.update(v, st.fans);
}

/** Every sentence that names the show, the price, the target or the deadline comes from the API (as text). */
function texts(s: PublicShow) {
  const p = dollars(s.ticketPriceCents), t = s.threshold, d = Date.parse(s.deadline), tz = s.timeZone;
  const artist = s.split.find(x => x.role === 'artist')?.label ?? '', opener = s.split.find(x => x.role === 'opener')?.label;
  $('.mode').textContent = s.demo ? 'Fan page · sample show' : 'Fan page';
  $('.row-top .eyebrow').textContent = `${dayLabel(s.showDate)} · ${s.roomName}`;
  $('#show-title').textContent = s.showName;
  $('.bill').textContent = `${artist}${opener ? ` with ${opener}` : ''} · ${s.roomName}`;
  $('.stat.clock dt').textContent = `Fans needed by · ${when(d, tz, 'long')}`;
  $('[data-of]').textContent = `of ${t} fans`;
  $('#h-pledge').textContent = `Hold my spot · ${p}`;
  $('[data-pledge-text]').textContent = st.phase === 'tipped' ? `The show is on, so PayPal charges ${p} as soon as you join.` : `PayPal holds ${p} on your account. You’re only charged if ${t} fans join by ${when(d, tz, 'short')}. If not, the hold is cancelled automatically.`;
  $('[data-confirm-text]').textContent = `PayPal is holding ${p} — you’ll only be charged if ${t} fans join by ${when(d, tz, 'short')}. If not, the hold is cancelled automatically.`;
  $('[data-faq-hold]').textContent = `PayPal sets ${p} aside on your account, like a hotel deposit. It isn’t charged unless the show happens.`;
  $('[data-faq-when]').textContent = `Only once ${t} fans have joined, and only if that happens by ${when(d, tz, 'faq')}. Then everyone is charged at once, and the room and the artist are paid at the deadline.`;
  document.title = `Tip the Room · Hold my spot at ${s.showName}`;
  document.querySelector('meta[name="description"]')?.setAttribute('content', `Hold a spot at ${s.showName}, ${s.roomName}. PayPal holds ${p} and you’re only charged if the show happens.`);
}

function notice(text: string) {
  $('[data-notice-text]').textContent = text; el.notice.hidden = false;
}
function closedState(s: PublicShow) {
  const e = endOf(s.state);
  if (e === 'paid') setStatus(el.status, 'paid', s.state === 'settled' ? 'Everyone’s paid' : 'Paying everyone', '', true);
  else setStatus(el.status, 'released', 'Called off', e === 'cancelled' ? '· refunding everyone' : '· nobody paid', true);
  el.card.hidden = true;
  notice('Pledging has closed for this show.');
}

function onHeld(res: AuthorizeResponse, ini: string) {
  const wasTipped = st.phase === 'tipped';
  show = res.show; st.busy = true;
  const f0 = st.fans; st.mine = f0;
  if (view) { view.setTag(f0, ini); if (wasTipped) view.play(REDUCED ? 'reduced' : 'bonus', REDUCED ? { to: 'tipped' } : { count: 1 }); else view.play('pledge', { f0, f1: f0 + 1 }); }
  cues.at(REDUCED ? 0 : .38, () => { st.fans++; render(); Snd.screw(0); });
  cues.at(REDUCED ? .05 : .6, () => {
    el.card.hidden = true; el.confirm.hidden = false; enter(el.confirm, 10, 450);
    $('[data-confirm-bulb]').textContent = `Your bulb is the one marked ${ini}.`;
    if (wasTipped) {
      $('[data-confirm-title]').textContent = 'You’re in';
      $('[data-confirm-text]').textContent = `The show is already on, so PayPal charged your ${dollars(price())} right away.`;
      st.busy = false; return;
    }
    if (res.tipped) {
      st.phase = 'tipping'; if (view) view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
      cues.at(REDUCED ? .05 : .62, () => {
        st.phase = 'tipped'; Snd.flare(); setStatus(el.status, 'tipped', 'It’s on!', '· everyone’s charged'); render();
        $('[data-confirm-title]').textContent = 'You made it happen';
        $('[data-confirm-text]').textContent = `${target()} fans joined, so the show is on. PayPal charged everyone ${dollars(price())}, you included.`;
      });
    } else st.busy = false;
  });
}

function onFlow(e: PledgeEvent) {
  const sim = simulateBtn();
  if (e.kind === 'busy') { say(''); st.busy = true; if (sim) sim.disabled = true; return; }
  if (e.kind === 'held') { onHeld(e.res, e.initials); return; }
  st.busy = false; if (sim) sim.disabled = false; say(e.message);
}
const flow = new PledgeFlow({
  createOrder: (initials) => act(() => api.createOrder(showId ?? '', { initials })),
  authorize: (orderId) => act(() => api.authorize(showId ?? '', orderId)),
}, onFlow, () => cleanInitials(el.initials.value));

function mountButton() {
  if (st.phase === 'closed') return;
  const id = paypalClientId();
  if (!id) { if (!HOOKS) el.slot.textContent = 'Pledging isn’t switched on for this site yet.'; return; }
  mountPayPalButton(el.slot, id, { createOrder: () => flow.createOrder(), onApprove: (orderId) => flow.approve(orderId), onCancel: () => flow.cancel(), onError: (err) => flow.error(err) })
    .catch(() => { el.slot.textContent = 'PayPal couldn’t load. Refresh the page to try again.'; });
}

async function boot(): Promise<void> {
  if (!showId) { notice(NO_SHOW); el.card.hidden = true; return; }
  let s: PublicShow;
  try { s = await act(() => api.getShow(showId)); }
  catch (e) { notice(e instanceof ApiFailure && e.status !== 404 ? e.message : NO_SHOW); el.card.hidden = true; return; }
  show = s; clock = new ShowClock(s.now);
  const e = endOf(s.state);
  st.fans = s.fans.committed; st.phase = e === 'live' ? 'held' : e === 'tipped' ? 'tipped' : 'closed';
  texts(s);
  ph = new Placeholder($('[data-ph]'), { name: s.showName, target: s.threshold });
  if (st.phase === 'tipped') setStatus(el.status, 'tipped', 'It’s on!', '· everyone’s charged', true);
  if (st.phase === 'closed') closedState(s);
  render(true);
  mountButton();
}

/** Other fans' pledges and the tip, seen by polling (never in parity runs). */
async function poll() {
  if (!show || !showId || st.busy || st.phase === 'closed' || document.hidden) return;
  let s: PublicShow;
  try { s = await api.getShow(showId); } catch { return; }
  if (s.version === show.version || st.busy) return;
  const wasLive = st.phase === 'held';
  show = s; clock?.sync(s.now);
  const e = endOf(s.state);
  if (e !== 'live' && e !== 'tipped') { st.phase = 'closed'; closedState(s); render(); view?.reset(); return; }
  st.fans = s.fans.committed;
  if (wasLive && e === 'tipped') {
    st.phase = 'tipping'; st.busy = true; if (view) view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
    cues.at(REDUCED ? .05 : .62, () => { st.phase = 'tipped'; Snd.flare(); setStatus(el.status, 'tipped', 'It’s on!', '· everyone’s charged'); texts(s); render(); st.busy = false; });
    return;
  }
  render(); view?.reset();
}

setInterval(() => { if (st.phase !== 'closed') renderClock(); }, 1000);
if (!PARITY) setInterval(() => { void poll(); }, 10_000);
soundToggle($('#sound'));

interface PledgeHooks extends MarqueeHooks { state: PledgeState; approve(): void; setFans(n: number): void; setInitials(v: string): void }
const hooks: PledgeHooks = {
  page: 'pledge', ready: false, views: [], state: st, get pending() { return pendingCount(); },
  approve: () => { if (!st.busy && st.phase !== 'closed') void flow.simulate(); },
  setFans(n) { st.fans = n; render(true); if (view) view.reset(); },
  setInitials(v) { el.initials.value = v; },
};
if (HOOKS) { window.__marquee = hooks; simulateBtn()?.addEventListener('click', () => hooks.approve()); }

await boot();
let host: SignHost | null = null;
if (show) { try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ } }
if (host && show) {
  const s = show, amounts = planSplit(s.split, Math.max(st.fans, s.threshold) * s.ticketPriceCents), each = dollars(s.ticketPriceCents);
  view = host.add(el.stage, { name: s.showName, crest: s.roomName.toUpperCase(), target: s.threshold, seed: SEED, yaw: YAW, payees: s.split.map((p, i) => ({ label: ROLE_WORD[p.role], amount: amounts[i] / 100 })) },
    { state: visual, tipEl: $('[data-tip]'), ph: $('[data-ph]'), tip: slot => slot < st.fans ? (slot === st.mine ? `You · ${each} ${visual().phase === 'held' ? 'on hold' : 'charged'}` : `Fan ${pad2(slot + 1)} · ${each} ${visual().phase === 'held' ? 'on hold' : 'charged'}`) : null });
  const h = host; Ticker.add(now => h.tick(now)); hooks.views = host.views; hooks.host = host;
}
hooks.ready = true;
markReady();
```

- [ ] **Step 6: Write the functional GPU spec.** `tests/gpu/pledge-flows.spec.ts` (dev server, real time, a stubbed SDK served from the real SDK URL):

```ts
import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MAYA, MAYA_ID, PLEDGE_ORDER, pledgeApi, showOf } from "./fixtures";
import { APP_BASE } from "./parity";

const SDK = "https://www.sandbox.paypal.com/web-sdk/v6/core";
const XSS = `<img src=x onerror="window.__xss=1">`;
// Stands in for PayPal's v6 SDK: same entry points, the popup answers with window.__ppMode (approve | cancel | error).
const STUB = `
customElements.define("paypal-button", class extends HTMLElement { connectedCallback() { this.textContent = "PayPal"; this.style.cssText = "display:block;min-height:44px;background:#ffc439;cursor:pointer"; } });
window.paypal = { createInstance: async (o) => { window.__ppClientId = o.clientId; return {
  findEligibleMethods: async () => ({ isEligible: (m) => m === "paypal" }),
  createPayPalOneTimePaymentSession: (cb) => ({ start: async (opts, order) => {
    let orderId; try { ({ orderId } = await order); } catch (e) { return; }
    const mode = window.__ppMode || "approve";
    if (mode === "approve") await cb.onApprove({ orderId });
    else if (mode === "cancel") cb.onCancel({ orderId });
    else cb.onError(new Error("closed"));
  } }) }; } };`;

async function open(page: Page, api: FakeApi, query = "?e2e&paypal=test-client") {
  await page.route(SDK, (r) => r.fulfill({ contentType: "application/javascript", body: STUB }));
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}s/${MAYA_ID}${query}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const authorizePaths = (seen: { path: string }[]) => seen.map((r) => r.path).filter((p) => p.endsWith("/authorize"));

test("the PayPal button replaces the placeholder, and an approved popup puts the fan on hold", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await expect(page.locator("#pp-slot")).toHaveClass(/is-rendered/);
  await expect(page.locator("#pp-slot")).not.toContainText("renders here");
  expect(await page.evaluate(() => (window as unknown as { __ppClientId: string }).__ppClientId)).toBe("test-client");
  await page.fill("#initials", "m.r");
  await page.locator("paypal-button").click();
  await expect(page.locator("#confirm")).toBeVisible();
  await expect(page.locator("[data-confirm-bulb]")).toHaveText("Your bulb is the one marked MR.");
  expect(seen.find((r) => r.path.endsWith("/orders"))?.body).toEqual({ initials: "MR" });
  expect(authorizePaths(seen)).toEqual([`/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}/authorize`]);
});

test("a cancelled popup places no hold and says so", async ({ page }) => {
  const seen = await open(page, pledgeApi());
  await page.evaluate(() => { (window as unknown as { __ppMode: string }).__ppMode = "cancel"; });
  await page.locator("paypal-button").click();
  await expect(page.locator("[data-pledge-msg]")).toHaveText("No hold was placed. You can try again whenever you like.");
  await expect(page.locator("#pledge-card")).toBeVisible();
  expect(authorizePaths(seen)).toEqual([]);
});

test("after a 502 the fan sees plain words, and the next try creates a NEW order", async ({ page }) => {
  const seen = await open(page, pledgeApi({ authorize: (n) => (n === 1 ? apiError(502, "paypal_error", "PayPal didn't answer as expected. Nothing was charged.") : undefined) }));
  await page.locator("paypal-button").click();
  await expect(page.locator("[data-pledge-msg]")).toHaveText("PayPal didn't answer as expected. Nothing was charged. Please try again.");
  await page.locator("paypal-button").click();
  await expect(page.locator("#confirm")).toBeVisible();
  expect(authorizePaths(seen)).toEqual([`/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}/authorize`, `/api/shows/${MAYA_ID}/orders/${PLEDGE_ORDER}2/authorize`]);
});

test("show data is shown as text, never as markup", async ({ page }) => {
  await open(page, pledgeApi({ show: { ...showOf(MAYA, { fans: 12 }), showName: XSS, roomName: XSS } }));
  await expect(page.locator("#show-title")).toHaveText(XSS);
  await expect(page.locator(".row-top .eyebrow")).toContainText(XSS);
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("an unknown show says so in plain words", async ({ page }) => {
  await open(page, () => undefined);
  await expect(page.locator("#notice")).toBeVisible();
  await expect(page.locator("#notice")).toHaveText("There’s no show at this link. Check the link with whoever sent it.");
  await expect(page.locator("#pledge-card")).toBeHidden();
});

test("a show that is over takes no pledges", async ({ page }) => {
  await open(page, pledgeApi({ show: showOf(MAYA, { fans: 12, state: "missed" }) }));
  await expect(page.locator("#notice")).toHaveText("Pledging has closed for this show.");
  await expect(page.locator("#pledge-card")).toBeHidden();
  await expect(page.locator("[data-word]")).toHaveText("Called off");
});
```

- [ ] **Step 7: Run all checks.** `npx vitest run tests/web` → PASS. `npx playwright test tests/gpu/pledge.spec.ts tests/gpu/pledge-flows.spec.ts` → PASS. Then the full `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS (39 + 6). If a pledge parity test fails, open `test-results/parity/pledge-*-{ref,app}.txt` and the diff PNG: the fix is in `pledge.ts`'s text/timing, never in the harness.

- [ ] **Step 8: Commit.** `git add -A src/web pledge.html tests && git commit -m "feat(web): fan pledge page on the real API with the PayPal v6 button, failure and cancel paths"` + trailer.

---

## Task 5: Start a show (`/start`): sentence → draft → edit → hold to sign → share link, QR and the private link

**Files:**
- Create: `src/web/shared/start-draft.ts`, `tests/web/start-draft.test.ts`, `tests/gpu/start-flows.spec.ts`
- Modify: `src/web/pages/start.ts` (replace), `start.html`

**Interfaces:**
- `start-draft.ts`: `type PayeeRole = "Room" | "Opener" | "Host" | "You"`, `interface PayeeRow { role; who; amount: number /* dollars */; optional?; me?; email }`, `interface Draft { name; room; date; price; deadline; payees; feeBufferBps; timeZone; artistLabel; year }`, `fromDraft(d: DraftFields): Draft`, `targetOf(d: Draft): number`, `parseDay(text, year): string | null`, `parseDeadline(text, year, tz): string | null`, `zonedIso(y, mo, d, h, mi, tz): string`, `toDraftFields(d: Draft): { fields: DraftFields | null; problems: string[] }`.
- Page hooks (HOOKS only): `{ page: "start", ready, views, host, data, pending, fill(), setEmails(), holdTo(p), sign() }`; `fill()` and `sign()` call the API (fake in tests).
- The fan target on screen is computed in the browser with `src/core` `thresholdPledges` (there is no re-preview endpoint); the server checks it again when signing.
- The private link is printed once as `<origin>/s/<id>/manage#<manageKey>` and kept in `localStorage` (`ttr:manage:<id>`).

- [ ] **Step 1: Write the failing unit test.** `tests/web/start-draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DraftFields } from "../../src/worker/api-types";
import { fromDraft, parseDay, parseDeadline, targetOf, toDraftFields } from "../../src/web/shared/start-draft";

const DRAFT: DraftFields = {
  showName: "Acoustic Set", roomName: "Lucky’s Café", showDate: "2026-11-20", ticketPriceCents: 1500, feeBufferBps: 500, deadline: "2026-11-12T18:00:00.000Z", timeZone: "UTC",
  parties: [{ role: "room", label: "Lucky’s Café", paypalEmail: "", fixedCents: 10000 }, { role: "artist", label: "Maya", paypalEmail: "", minimumCents: 20000 }],
};

describe("start draft", () => {
  it("shows the server draft the way the reference does", () => {
    const d = fromDraft(DRAFT);
    expect([d.name, d.room, d.date, d.price, d.deadline]).toEqual(["Acoustic Set", "Lucky’s Café", "Fri Nov 20", 15, "Thu Nov 12, 6:00pm"]);
    expect(d.payees.map((p) => [p.role, p.who, p.amount])).toEqual([["Room", "Lucky’s Café", 100], ["Opener", "", 0], ["Host", "", 0], ["You", "You", 200]]);
    expect(targetOf(d)).toBe(21);
  });

  it("reads dates and deadlines back in the show's zone", () => {
    expect(parseDay("Fri Nov 20", 2026)).toBe("2026-11-20");
    expect(parseDay("nov 20", 2026)).toBe("2026-11-20");
    expect(parseDay("2026-11-20", 2026)).toBe("2026-11-20");
    expect(parseDay("Feb 30", 2026)).toBeNull();
    expect(parseDay("soon", 2026)).toBeNull();
    expect(parseDeadline("Thu Nov 12, 6:00pm", 2026, "UTC")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseDeadline("Nov 12", 2026, "UTC")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseDeadline("Nov 12, 9:30am", 2026, "UTC")).toBe("2026-11-12T09:30:00.000Z");
    expect(parseDeadline("Thu Nov 12, 6:00pm", 2026, "America/Vancouver")).toBe("2026-11-13T02:00:00.000Z");
    expect(parseDeadline("whenever", 2026, "UTC")).toBeNull();
  });

  it("builds the signing draft, artist last, only payees with money", () => {
    const d = fromDraft(DRAFT);
    d.payees[0].email = "luckys-cafe@example.com";
    d.payees[3].email = "maya@example.com";
    d.payees[1].who = "The Low Tides";
    d.payees[1].amount = 50;
    d.payees[1].email = "tides@example.com";
    const { fields, problems } = toDraftFields(d);
    expect(problems).toEqual([]);
    expect(fields).toEqual({
      showName: "Acoustic Set", roomName: "Lucky’s Café", showDate: "2026-11-20", ticketPriceCents: 1500, feeBufferBps: 500, deadline: "2026-11-12T18:00:00.000Z", timeZone: "UTC",
      parties: [
        { role: "room", label: "Lucky’s Café", paypalEmail: "luckys-cafe@example.com", fixedCents: 10000 },
        { role: "opener", label: "The Low Tides", paypalEmail: "tides@example.com", fixedCents: 5000 },
        { role: "artist", label: "Maya", paypalEmail: "maya@example.com", minimumCents: 20000 },
      ],
    });
    expect(targetOf(d)).toBe(25);
  });

  it("lists every problem in plain words instead of signing", () => {
    const d = fromDraft(DRAFT);
    d.date = "someday";
    d.price = 0;
    const { fields, problems } = toDraftFields(d);
    expect(fields).toBeNull();
    expect(problems).toEqual(["Write the show date like Fri Nov 20.", "Add the price of a spot.", "Add a PayPal email for Lucky’s Café.", "Add a PayPal email for you."]);
  });
});
```

Run `npx vitest run tests/web/start-draft.test.ts` → FAIL (module not found).

- [ ] **Step 2: Create `src/web/shared/start-draft.ts`.**

```ts
// The editable draft on the Start page: from the server's DraftFields to the form, and back for signing.
import { dollarsToCents, thresholdPledges } from "../../core";
import type { DraftFields, PartyInput } from "../../worker/api-types";
import { dayLabel, when } from "./format";

export type PayeeRole = "Room" | "Opener" | "Host" | "You";
export interface PayeeRow { role: PayeeRole; who: string; /** dollars */ amount: number; optional?: boolean; me?: boolean; email: string }
export interface Draft {
  name: string;
  room: string;
  /** "Fri Nov 20" */
  date: string;
  /** dollars */
  price: number;
  /** "Thu Nov 12, 6:00pm" in timeZone */
  deadline: string;
  payees: PayeeRow[];
  feeBufferBps: number;
  timeZone: string;
  artistLabel: string;
  year: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function fromDraft(d: DraftFields): Draft {
  const by = (r: PartyInput["role"]) => d.parties.find((p) => p.role === r);
  const room = by("room"), opener = by("opener"), host = by("host"), artist = by("artist");
  const dollars = (c?: number) => (c ?? 0) / 100;
  const dl = Date.parse(d.deadline);
  return {
    name: d.showName,
    room: d.roomName,
    date: d.showDate ? dayLabel(d.showDate) : "",
    price: dollars(d.ticketPriceCents),
    deadline: Number.isFinite(dl) ? when(dl, d.timeZone, "long") : "",
    feeBufferBps: d.feeBufferBps,
    timeZone: d.timeZone,
    artistLabel: artist?.label || "You",
    year: Number(d.showDate.slice(0, 4)) || new Date().getUTCFullYear(),
    payees: [
      { role: "Room", who: room?.label || d.roomName, amount: dollars(room?.fixedCents), email: room?.paypalEmail ?? "" },
      { role: "Opener", who: opener?.label ?? "", amount: dollars(opener?.fixedCents), optional: true, email: opener?.paypalEmail ?? "" },
      { role: "Host", who: host?.label ?? "", amount: dollars(host?.fixedCents), optional: true, email: host?.paypalEmail ?? "" },
      { role: "You", who: "You", amount: dollars(artist?.minimumCents), me: true, email: artist?.paypalEmail ?? "" },
    ],
  };
}

/** Code, not the model, computes the target (spec §3.1): the money core's thresholdPledges. 0 means "add a price". */
export function targetOf(d: Draft): number {
  if (!(d.price > 0)) return 0;
  try {
    const fixedCosts = d.payees.filter((p) => !p.me).map((p) => dollarsToCents(+p.amount || 0));
    const artistMinimum = dollarsToCents(+(d.payees.find((p) => p.me)?.amount ?? 0) || 0);
    return thresholdPledges({ fixedCosts, artistMinimum, ticketPrice: dollarsToCents(d.price), feeBufferBps: d.feeBufferBps });
  } catch {
    return 0;
  }
}

function validDate(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

/** "Fri Nov 20", "Nov 20", "Nov 20, 2026" or "2026-11-20" → "2026-11-20". */
export function parseDay(text: string, year: number): string | null {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return validDate(+t.slice(0, 4), +t.slice(5, 7), +t.slice(8, 10));
  const m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(t);
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  return mo ? validDate(m[3] ? +m[3] : year, mo, +m[2]) : null;
}

function wallAsUtc(ms: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** A wall-clock time in `tz` as an ISO instant. */
export function zonedIso(y: number, mo: number, d: number, h: number, mi: number, tz: string): string {
  let zone = tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - (wallAsUtc(guess, zone) - guess);
  t = guess - (wallAsUtc(t, zone) - t);
  return new Date(t).toISOString();
}

/** "Thu Nov 12, 6:00pm", "Nov 12, 9:30am" or "Nov 12" (6pm) in the show's zone → ISO. */
export function parseDeadline(text: string, year: number, tz: string): string | null {
  const m = /^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?$/i.exec(text.trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
  const day = mo ? validDate(year, mo, +m[2]) : null;
  if (!day) return null;
  let hour = 18, minute = 0;
  if (m[3]) {
    hour = (+m[3] % 12) + (m[5].toLowerCase() === "pm" ? 12 : 0);
    minute = m[4] ? +m[4] : 0;
    if (+m[3] > 12 || minute > 59) return null;
  }
  return zonedIso(year, mo, +m[2], hour, minute, tz);
}

/** The draft to sign, or every problem in plain words. Payees with no money are left out; the artist is always last. */
export function toDraftFields(d: Draft): { fields: DraftFields | null; problems: string[] } {
  const problems: string[] = [];
  const showDate = parseDay(d.date, d.year);
  const deadline = parseDeadline(d.deadline, d.year, d.timeZone);
  if (!d.name.trim()) problems.push("Add a show name.");
  if (!d.room.trim()) problems.push("Add the room.");
  if (!showDate) problems.push("Write the show date like Fri Nov 20.");
  if (!(d.price > 0)) problems.push("Add the price of a spot.");
  if (!deadline) problems.push("Write the deadline like Thu Nov 12, 6:00pm.");
  const parties: PartyInput[] = [];
  try {
    for (const p of d.payees) {
      if (!p.me && !(p.amount > 0)) continue;
      const who = p.me ? "you" : p.who.trim() || p.role;
      if (!EMAIL.test(p.email.trim())) problems.push(`Add a PayPal email for ${who}.`);
      if (p.me) parties.push({ role: "artist", label: d.artistLabel, paypalEmail: p.email.trim(), minimumCents: dollarsToCents(p.amount || 0) });
      else parties.push({ role: p.role === "Room" ? "room" : p.role === "Opener" ? "opener" : "host", label: p.who.trim() || (p.role === "Room" ? d.room.trim() : p.role), paypalEmail: p.email.trim(), fixedCents: dollarsToCents(p.amount) });
    }
  } catch {
    problems.push("Check the amounts: use whole dollars and cents.");
  }
  if (problems.length || !showDate || !deadline) return { fields: null, problems };
  return { fields: { showName: d.name.trim(), roomName: d.room.trim(), showDate, ticketPriceCents: dollarsToCents(d.price), feeBufferBps: d.feeBufferBps, deadline, timeZone: d.timeZone, parties }, problems: [] };
}
```

- [ ] **Step 3: Data hooks in `start.html`.** Exactly these edits:
1. After the `.actions` div that holds `#fill` (inside `.intro`), add: `<p class="pledge-msg" data-start-msg data-app-only hidden aria-live="polite"></p>`
2. Inside `.card.signing`, right before the `<div>` that holds `#sign`, add: `<ul class="problems" id="problems" data-app-only hidden aria-live="polite"></ul>`
3. In the live section's last `.actions`, add `id="open-manage"` to the `btn-red` link and `id="open-share"` to the other link.

Append to `src/web/shared/styles.css`:

```css
.problems{margin:0 0 12px;padding-left:20px;font:500 16px/1.4 var(--f-ui);color:#8A1A12}
```

- [ ] **Step 4: Replace `src/web/pages/start.ts`.**

```ts
import "../shared/gsap-global";
import "../shared/styles.css";
import { $, Ticker, Snd, soundToggle, Placeholder, HoldButton, drawQR, copyText, enter, usd } from "../shared/ui";
import type { SignHost, SignView, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { CreateShowResponse, SignResponse } from "../../worker/api-types";
import { API_BASE, HOOKS, PUBLIC_ORIGIN, markReady, removeRefOnly, safeStorage } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { rememberKey } from "../shared/keys";
import { when } from "../shared/format";
import { fromDraft, targetOf, toDraftFields, type Draft, type PayeeRow } from "../shared/start-draft";

removeRefOnly();
const api = apiClient(API_BASE);
const els = { sentence: $<HTMLTextAreaElement>('#sentence'), draft: $('#draft'), live: $('#live'), paylist: $('#paylist'), rules: $('#rules'), sign: $<HTMLButtonElement>('#sign'), target: $('[data-target-sentence]'), split: $('[data-split]'), stage: $('[data-stage]'), msg: $('[data-start-msg]'), problems: $('#problems'), fill: $<HTMLButtonElement>('#fill') };
const ph = new Placeholder($('[data-ph]'), { name: 'Your show', target: 20 });
let D: Draft | null = null, created: CreateShowResponse | null = null, view: SignView | null = null, signing = false;

/** Builds an element: attributes via setAttribute, children as nodes or plain text. Never parses HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}
const say = (text: string) => { els.msg.textContent = text; els.msg.hidden = !text; };
function showProblems(list: string[]) {
  els.problems.textContent = '';
  for (const p of list) els.problems.append(h('li', {}, p));
  els.problems.hidden = list.length === 0;
}
const today = (tz: string) => when(Date.now(), tz, 'long').split(',')[0];

function payRow(p: PayeeRow, i: number) {
  const li = h('li', { class: 'payrow' + (p.optional && !p.amount ? ' is-empty' : '') });
  const role = h('div', { class: 'role' }, p.role);
  if (p.optional) role.append(h('small', {}, 'optional')); else if (p.me) role.append(h('small', {}, 'gets the rest'));
  const who = h('div', { class: 'field' });
  if (p.me) { const you = h('input', { class: 'input', value: 'You', 'aria-label': 'Who: you' }); you.disabled = true; who.append(h('span', { class: 'label' }, 'Who'), you); }
  else { const name = h('input', { id: `who-${i}`, class: 'input', 'data-k': 'who', placeholder: p.role === 'Opener' ? 'Opener’s name' : p.role === 'Host' ? 'Host’s name' : 'Room name', autocomplete: 'off' }); name.value = p.who; who.append(h('label', { for: `who-${i}` }, 'Name'), name); }
  const amt = h('input', { id: `amt-${i}`, class: 'input mono', 'data-k': 'amount', inputmode: 'numeric', placeholder: '0', autocomplete: 'off' }); amt.value = p.amount ? String(p.amount) : '';
  const mail = h('input', { id: `mail-${i}`, class: 'input mono', 'data-k': 'email', type: 'email', placeholder: 'name@example.com', autocomplete: 'off' }); mail.value = p.email;
  li.append(role, who, h('div', { class: 'field' }, h('label', { for: `amt-${i}` }, p.me ? 'At least ($)' : 'Gets ($)'), amt), h('div', { class: 'field email' }, h('label', { for: `mail-${i}` }, 'PayPal email'), mail));
  li.addEventListener('input', e => { const el = e.target as HTMLInputElement, k = el.dataset.k as 'who' | 'amount' | 'email' | undefined; if (!k) return; if (k === 'amount') p.amount = +el.value.replace(/[^0-9.]/g, '') || 0; else p[k] = el.value; li.classList.toggle('is-empty', !!p.optional && !p.amount && !p.who); update(); });
  return li;
}

async function fill() {
  if (signing || els.fill.disabled) return;
  els.fill.disabled = true; say('');
  await act(async () => {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const res = await api.createShow({ sentence: els.sentence.value.trim(), timeZone });
      created = res; const d = D = fromDraft(res.draft);
      $<HTMLInputElement>('#f-name').value = d.name; $<HTMLInputElement>('#f-room').value = d.room; $<HTMLInputElement>('#f-date').value = d.date; $<HTMLInputElement>('#f-price').value = d.price ? String(d.price) : ''; $<HTMLInputElement>('#f-deadline').value = d.deadline;
      $('.field:has(#f-deadline) .hint').textContent = `Holds last up to 21 days, so keep it within 21 days of today, ${today(d.timeZone)}.`;
      els.paylist.textContent = ''; d.payees.forEach((p, i) => els.paylist.appendChild(payRow(p, i)));
      els.draft.hidden = false; enter(els.draft, 12, 500); els.fill.textContent = 'Fill it in again';
      showProblems(res.problems);
      update(true);
    } catch (e) {
      say(e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.');
    } finally {
      els.fill.disabled = false;
    }
  });
}
for (const [id, k] of [['f-name', 'name'], ['f-room', 'room'], ['f-date', 'date'], ['f-price', 'price'], ['f-deadline', 'deadline']] as const) $('#' + id).addEventListener('input', e => {
  if (!D) return; const v = (e.target as HTMLInputElement).value;
  if (k === 'price') D.price = +v.replace(/[^0-9.]/g, '') || 0; else D[k] = v;
  if (k === 'room') { D.payees[0].who = D[k]; const w = document.querySelector<HTMLInputElement>('#who-0'); if (w) w.value = D[k]; }
  update();
});

let debounce: ReturnType<typeof setTimeout> | undefined;
function update(now = false) {
  if (!D) return;
  const d = D, target = targetOf(d), paid = d.payees.filter(p => !p.me && p.amount > 0), me = d.payees.find(p => p.me)!;
  els.target.textContent = '';
  if (target) els.target.append('You need ', h('span', { class: 'dotnum' }, String(target)), ` fans at ${usd(d.price)}`);
  else els.target.textContent = 'Add a price to see how many fans you need';
  els.split.textContent = [...paid.map(p => `${p.who || p.role} gets ${usd(p.amount)}`), `You get the rest, at least ${usd(me.amount || 0)}`].join(' · ');
  const li = (...parts: (string | [string])[]) => h('li', {}, ...parts.map(x => typeof x === 'string' ? x : h('b', {}, x[0])));
  els.rules.textContent = '';
  els.rules.append(
    li('If ', [`${target} fans`], ' hold a spot by ', [d.deadline], `, everyone is charged ${usd(d.price)} at once.`),
    li(`At the deadline, ${paid.length ? paid.map(p => `${p.who || p.role} is paid ${usd(p.amount)}`).join(', then ') + ', then you' : 'you'} get the rest (at least ${usd(me.amount || 0)}).`),
    li(`If fewer than ${target} fans join, every hold is cancelled and nobody pays.`),
    li('To change the deadline or the target, your agent asks you first.'),
  );
  const missing = d.payees.filter(p => (p.amount > 0 || p.me) && !/^\S+@\S+\.\S+$/.test(p.email || '')).map(p => p.me ? 'you' : (p.who || p.role));
  els.sign.disabled = missing.length > 0 || target < 1 || signing;
  $('#sign-hint').textContent = missing.length ? `Add a PayPal email for ${missing.join(' and ')} to sign.` : 'Press and hold for 1.5 seconds. On a keyboard, hold Space or Enter.';
  const model: SignModel = { name: d.name || 'Your show', crest: d.room, target: Math.min(Math.max(target, 4), 80), seed: 31, yaw: .16, payees: paid.map(p => ({ label: p.role, amount: p.amount })).concat([{ label: 'Artist', amount: me.amount || 0 }]) };
  clearTimeout(debounce);
  const apply = () => { ph.setModel(model); ph.update('held', 0); if (view) view.setModel(model); els.stage.setAttribute('aria-label', `Preview of your marquee: ${model.name}, ${model.target} empty bulbs, one for each fan you need.`); };
  if (now) apply(); else debounce = setTimeout(apply, 250);
}

function resetSign() { holdBtn.reset(); $('[data-sign-label]').textContent = 'Hold to sign the money rules'; update(true); }
async function doSign() {
  if (!D || !created || signing) return;
  const { fields, problems } = toDraftFields(D);
  if (!fields) { showProblems(problems); resetSign(); return; }
  const showId = created.showId, signToken = created.signToken;
  signing = true; showProblems([]); say('');
  await act(async () => {
    try { goLive(await api.sign(showId, { signToken, draft: fields })); }
    catch (e) { const f = e instanceof ApiFailure ? e : null; say(f ? f.message : 'Something went wrong. Please try again.'); showProblems(f?.problems ?? []); signing = false; resetSign(); }
    finally { signing = false; }
  });
}
function goLive(res: SignResponse) {
  Snd.sign();
  const tz = res.show.timeZone, share = `${PUBLIC_ORIGIN}${res.sharePath}`, manage = `${PUBLIC_ORIGIN}${res.managePath}#${res.manageKey}`;
  rememberKey(safeStorage(), res.showId, res.manageKey);
  $('#share-url').textContent = share; $('#manage-url').textContent = manage;
  drawQR($<HTMLCanvasElement>('#qr'), share, { scale: 4, margin: 3 });
  $('.live .eyebrow').textContent = `Signed ${when(Date.parse(res.show.launchedAt), tz, 'long')}`;
  $('[data-live-lede]').textContent = `Share your link. Fans hold a spot with PayPal, and nobody is charged unless ${res.threshold} of them join by ${when(Date.parse(res.deadline), tz, 'long')}.`;
  $<HTMLAnchorElement>('#open-manage').href = `${res.managePath}#${res.manageKey}`;
  $<HTMLAnchorElement>('#open-share').href = res.sharePath;
  els.draft.hidden = true; els.live.hidden = false; enter(els.live, 12, 500);
  $('.intro').hidden = true;
  if (view) view.play('lap');
}

els.fill.addEventListener('click', () => { void fill(); });
$('#copy-share').addEventListener('click', () => copyText($('#share-url').textContent ?? '', $('[data-copied]')));
$('#copy-manage').addEventListener('click', () => copyText($('#manage-url').textContent ?? '', $('[data-copied]')));
const holdBtn = new HoldButton(els.sign, { ms: 1500, onDone: () => { $('[data-sign-label]').textContent = 'Signed'; void doSign(); } });
soundToggle($('#sound'));
ph.update('held', 0);

interface StartHooks extends MarqueeHooks { readonly data: Draft | null; fill(): void; setEmails(): void; holdTo(p: number): void; sign(): void }
const hooks: StartHooks = {
  page: 'start', ready: false, views: [], get data() { return D; }, get pending() { return pendingCount(); },
  fill: () => { void fill(); },
  setEmails() { const mails: Record<string, string> = { Room: 'luckys-cafe@example.com', You: 'maya@example.com' }; D?.payees.forEach((p, i) => { if (mails[p.role]) { p.email = mails[p.role]; const el = document.querySelector<HTMLInputElement>('#mail-' + i); if (el) el.value = p.email; } }); update(true); },
  holdTo(p) { holdBtn.set(p); },
  sign: () => { holdBtn.done = true; els.sign.classList.add('is-done'); $('[data-sign-label]').textContent = 'Signed'; void doSign(); },
};
if (HOOKS) window.__marquee = hooks;
let host: SignHost | null = null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ }
if (host) {
  view = host.add(els.stage, { name: 'Your show', crest: 'YOUR ROOM', target: 20, seed: 31, yaw: .16, payees: [] }, { state: () => ({ phase: 'held', fans: 0 }), ph: $('[data-ph]') });
  const hs = host; Ticker.add(now => hs.tick(now)); hooks.views = host.views; hooks.host = host;
  if (D) update(true);
}
hooks.ready = true;
markReady();
```

- [ ] **Step 5: Write the functional GPU spec.** `tests/gpu/start-flows.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MAYA_ID, MAYA_KEY, startApi } from "./fixtures";
import { APP_BASE } from "./parity";

async function open(page: Page, api: FakeApi) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}start?e2e`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
async function fillDraft(page: Page) {
  await page.click("#fill");
  await expect(page.locator("#draft")).toBeVisible();
  await page.fill("#mail-0", "luckys-cafe@example.com");
  await page.fill("#mail-3", "maya@example.com");
}
const sign = (page: Page) => page.evaluate(() => (window as unknown as { __marquee: { sign(): void } }).__marquee.sign());

test("signing sends the edited draft, then shows the share link and the private link once, and keeps the key", async ({ page }) => {
  const seen = await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-name", "Late Set");
  await sign(page);
  await expect(page.locator("#live")).toBeVisible();
  const body = seen.find((r) => r.path.endsWith("/sign"))?.body as { signToken: string; draft: { showName: string; showDate: string; deadline: string; parties: { role: string; paypalEmail: string }[] } };
  expect(body.signToken).toBe("sign-token-fixture-0123456789");
  expect(body.draft.showName).toBe("Late Set");
  expect([body.draft.showDate, body.draft.deadline]).toEqual(["2026-11-20", "2026-11-12T18:00:00.000Z"]);
  expect(body.draft.parties.map((p) => [p.role, p.paypalEmail])).toEqual([["room", "luckys-cafe@example.com"], ["artist", "maya@example.com"]]);
  await expect(page.locator("#share-url")).toHaveText(`https://tiptheroom.example/s/${MAYA_ID}`);
  await expect(page.locator("#manage-url")).toHaveText(`https://tiptheroom.example/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  await expect(page.locator("#open-manage")).toHaveAttribute("href", `/s/${MAYA_ID}/manage#${MAYA_KEY}`);
  expect(await page.evaluate((id) => localStorage.getItem(`ttr:manage:${id}`), MAYA_ID)).toBe(MAYA_KEY);
});

test("typed values are shown as text, never as markup", async ({ page }) => {
  await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-room", `<img src=x onerror="window.__xss=1">`);
  await expect(page.locator("[data-split]")).toContainText(`<img src=x onerror="window.__xss=1"> gets $100`);
  await expect(page.locator("#rules")).toContainText(`<img src=x onerror="window.__xss=1"> is paid $100`);
  expect(await page.locator("#rules img, [data-split] img, #paylist img").count()).toBe(0);
  expect(await page.locator("#rules b").count()).toBe(2);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("the server's problems are listed and the sign button resets", async ({ page }) => {
  await open(page, startApi({ sign: apiError(422, "invalid", "Please check the draft.", { problems: ["The deadline must be within 21 days of launch."] }) }));
  await fillDraft(page);
  await sign(page);
  await expect(page.locator("[data-start-msg]")).toHaveText("Please check the draft.");
  await expect(page.locator("#problems")).toHaveText("The deadline must be within 21 days of launch.");
  await expect(page.locator("[data-sign-label]")).toHaveText("Hold to sign the money rules");
  await expect(page.locator("#live")).toBeHidden();
});

test("an unreadable date is caught before anything is sent", async ({ page }) => {
  const seen = await open(page, startApi());
  await fillDraft(page);
  await page.fill("#f-date", "someday");
  await sign(page);
  await expect(page.locator("#problems")).toHaveText("Write the show date like Fri Nov 20.");
  expect(seen.some((r) => r.path.endsWith("/sign"))).toBe(false);
});

test("a refused sentence is explained in plain words", async ({ page }) => {
  await open(page, startApi({ create: apiError(422, "invalid", "Describe the show in one sentence (5 to 500 characters).") }));
  await page.fill("#sentence", "hi");
  await page.click("#fill");
  await expect(page.locator("[data-start-msg]")).toHaveText("Describe the show in one sentence (5 to 500 characters).");
  await expect(page.locator("#draft")).toBeHidden();
});
```

- [ ] **Step 6: Run all checks.** `npx vitest run tests/web` → PASS; `npx playwright test tests/gpu/start.spec.ts tests/gpu/start-flows.spec.ts` → PASS; then `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS.

- [ ] **Step 7: Commit.** `git add -A src/web start.html tests && git commit -m "feat(web): start page on the real API: draft, client-side target, hold to sign, share link and private link"` + trailer.

---

## Task 6: The AG Grid Community ledger, themed to the reference

Built and tested on its own test page first; Task 7 puts it on the show page.

**Files:**
- Create: `src/web/shared/ledger.ts`, `tests/gpu/ledger/harness.html`, `tests/gpu/ledger/harness.ts`, `tests/gpu/ledger.spec.ts`
- Modify: `src/web/shared/styles.css` (append)

**Interfaces:**
- `ledger.ts`: `ledgerTheme` (`themeQuartz.withParams(GRID_THEME)`), `pill(status: LedgerStatus): HTMLElement`, `csvSafe(value: string): string`, `class LedgerGrid { api: GridApi<LedgerRowDto>; constructor(el: HTMLElement, tz: () => string); setRows(rows: LedgerRowDto[]): void; csv(fileName: string): void; destroy(): void }`.
- Columns (reference order): When · What happened · Who · Amount · PayPal ref · Status (pinned right, pill). Newest first (`at` desc). Sort and filter on every column; CSV export with spreadsheet-formula guarding.
- Uses `ag-grid-community@36.2.0` (controller pre-step 2): `ModuleRegistry.registerModules([AllCommunityModule])`, `createGrid`, `themeQuartz`.

- [ ] **Step 1: Create the test page.** `tests/gpu/ledger/harness.html` (served by the dev server only; not a build entry):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledger harness</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
</head>
<body>
<main style="padding:24px">
  <section class="block" aria-labelledby="h-ledger">
    <h2 class="section-title" id="h-ledger">Every money move</h2>
    <div class="ledger-grid" id="ledger"></div>
    <p class="grid-note">Newest first. Sort or filter any column. <button class="linkish" type="button" id="csv">Download as CSV</button></p>
  </section>
</main>
<script type="module" src="/tests/gpu/ledger/harness.ts"></script>
</body>
</html>
```

`tests/gpu/ledger/harness.ts`:

```ts
import "../../../src/web/shared/styles.css";
import { LedgerGrid } from "../../../src/web/shared/ledger";
import type { LedgerRowDto } from "../../../src/worker/api-types";

declare global {
  interface Window { __ledger: { grid: LedgerGrid; rows(r: LedgerRowDto[]): void } }
}

const grid = new LedgerGrid(document.getElementById("ledger")!, () => "UTC");
document.getElementById("csv")!.addEventListener("click", () => grid.csv("tip-the-room-ledger.csv"));
window.__ledger = { grid, rows: (r) => grid.setRows(r) };
document.body.dataset.ready = "1";
```

- [ ] **Step 2: Write the failing GPU spec.** `tests/gpu/ledger.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { LedgerRowDto } from "../../src/worker/api-types";
import { APP_BASE } from "./parity";

const T = (d: number, h: number, mi = 0) => Date.UTC(2026, 10, d, h, mi);
const XSS = `<img src=x onerror="window.__xss=1">`;
const ROWS: LedgerRowDto[] = [
  { seq: 1, at: T(3, 19, 12), what: "Fan held a spot", who: "Fan 01 · JR", amountCents: 1500, ref: "5UX02069M9686893E", status: "Charged" },
  { seq: 3, at: T(12, 18), what: "Paid Lucky’s Café", who: "Lucky’s Café", amountCents: 10000, ref: "7X4QKXC6L5BNA", status: "Pending" },
  { seq: 2, at: T(9, 9, 15), what: XSS, who: "<b>Maya</b>", amountCents: 31500, ref: null, status: "Info" },
  { seq: 4, at: T(4, 8, 5), what: "=HYPERLINK(\"http://evil.example\")", who: "Fan 02 · AK", amountCents: null, ref: "8AB12345CD678901E", status: "Cancelled" },
];

async function open(page: Page) {
  await page.goto(`${APP_BASE}tests/gpu/ledger/harness.html`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await page.evaluate((rows) => window.__ledger.rows(rows), ROWS);
  await expect(page.locator("#ledger .ag-row").first()).toBeVisible();
}
const firstCells = (page: Page, col: string) => page.locator(`#ledger .ag-center-cols-container .ag-row[row-index="0"] .ag-cell[col-id="${col}"]`);

test("themed like the reference: ink header, 48 px rows, Plex fonts, status pinned right as a pill", async ({ page }) => {
  await open(page);
  const header = page.locator("#ledger .ag-header");
  expect(await header.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(21, 17, 14)");
  const headerText = page.locator("#ledger .ag-header-cell-text").first();
  expect(await headerText.evaluate((e) => getComputedStyle(e).textTransform)).toBe("uppercase");
  expect(await headerText.evaluate((e) => getComputedStyle(e).fontFamily)).toContain("IBM Plex Mono");
  const row = page.locator("#ledger .ag-center-cols-container .ag-row").first();
  expect(Math.round((await row.boundingBox())!.height)).toBe(48);
  expect(await page.locator("#ledger .ag-cell").first().evaluate((e) => getComputedStyle(e).fontFamily)).toContain("IBM Plex");
  await expect(page.locator("#ledger .ag-pinned-right-header")).toContainText("Status");
  await expect(page.locator("#ledger .ag-pinned-right-cols-container .pill").first()).toBeVisible();
  const headers = await page.locator("#ledger .ag-header-cell-text").allTextContents();
  expect(headers.map((h) => h.trim().toLowerCase())).toEqual(["when", "what happened", "who", "amount", "paypal ref", "status"]);
});

test("newest first, with times in the show's zone and cents in the amount", async ({ page }) => {
  await open(page);
  await expect(firstCells(page, "when")).toHaveText("Nov 12 · 6:00pm");
  await expect(firstCells(page, "amountCents")).toHaveText("$100.00");
  await expect(page.locator('#ledger .ag-pinned-right-cols-container .ag-row[row-index="0"] .pill')).toHaveText("Pending");
});

test("backend text is shown as text, never as markup", async ({ page }) => {
  await open(page);
  await expect(page.locator("#ledger")).toContainText(XSS);
  await expect(page.locator("#ledger")).toContainText("<b>Maya</b>");
  expect(await page.locator("#ledger img, #ledger .ag-cell b").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("sort, filter and CSV export work, and the CSV can't run spreadsheet formulas", async ({ page }) => {
  await open(page);
  await page.locator('#ledger .ag-header-cell[col-id="who"]').click();
  await expect(firstCells(page, "who")).toHaveText("<b>Maya</b>");
  await page.evaluate(() => window.__ledger.grid.api.setFilterModel({ who: { filterType: "text", type: "contains", filter: "Fan" } }));
  expect(await page.evaluate(() => window.__ledger.grid.api.getDisplayedRowCount())).toBe(2);
  await page.evaluate(() => window.__ledger.grid.api.setFilterModel(null));
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  expect(download.suggestedFilename()).toBe("tip-the-room-ledger.csv");
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split(/\r?\n/)[0]).toBe('"When","What happened","Who","Amount","PayPal ref","Status"');
  expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
  expect(csv).toContain('"Nov 12 · 6:00pm","Paid Lucky’s Café","Lucky’s Café","$100.00","7X4QKXC6L5BNA","Pending"');
});
```

Run `npx playwright test tests/gpu/ledger.spec.ts` → FAIL (module `ledger.ts` not found).

- [ ] **Step 3: Create `src/web/shared/ledger.ts`.**

```ts
// The settlement ledger (spec §4): AG Grid Community, themed with the reference's GRID_THEME.
// Escaping: AG Grid writes values as text; the only renderer (Status) returns a DOM element built with textContent.
import { AllCommunityModule, ModuleRegistry, createGrid, themeQuartz, type ColDef, type GridApi, type ICellRendererParams, type ValueFormatterParams } from "ag-grid-community";
import type { LedgerRowDto, LedgerStatus } from "../../worker/api-types";
import { money2, when } from "./format";
import { GRID_THEME } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

export const ledgerTheme = themeQuartz.withParams(GRID_THEME);

const PILL: Record<LedgerStatus, string> = { "On hold": "on-hold", Charged: "charged", Paid: "paid", Cancelled: "cancelled", Refunded: "refunded", Failed: "failed", Pending: "pending", Info: "info" };

export function pill(status: LedgerStatus): HTMLElement {
  const s = document.createElement("span");
  s.className = `pill ${PILL[status] ?? "info"}`;
  const dot = document.createElement("i");
  dot.setAttribute("aria-hidden", "true");
  s.append(dot, document.createTextNode(String(status)));
  return s;
}

/** Spreadsheet apps run cells that start with = + - @ (or a tab/CR) as formulas: prefix them with an apostrophe. */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export class LedgerGrid {
  readonly api: GridApi<LedgerRowDto>;
  private readonly tz: () => string;

  constructor(el: HTMLElement, tz: () => string) {
    this.tz = tz;
    const text = (p: ValueFormatterParams<LedgerRowDto>) => (p.value == null ? "" : String(p.value));
    const columnDefs: ColDef<LedgerRowDto>[] = [
      { field: "at", colId: "when", headerName: "When", width: 156, sort: "desc", cellClass: "when", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? when(p.value, this.tz(), "ledger") : "") },
      { field: "what", headerName: "What happened", flex: 1, minWidth: 240, tooltipField: "what", filter: "agTextColumnFilter", valueFormatter: text },
      { field: "who", headerName: "Who", width: 160, filter: "agTextColumnFilter", valueFormatter: text },
      { field: "amountCents", headerName: "Amount", width: 120, type: "rightAligned", cellClass: "num", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? money2(p.value) : "") },
      { field: "ref", headerName: "PayPal ref", width: 200, cellClass: "ref", filter: "agTextColumnFilter", valueFormatter: text },
      { field: "status", headerName: "Status", width: 140, pinned: "right", filter: "agTextColumnFilter", cellRenderer: (p: ICellRendererParams<LedgerRowDto, LedgerStatus>) => (p.value ? pill(p.value) : document.createTextNode("")) },
    ];
    this.api = createGrid<LedgerRowDto>(el, {
      theme: ledgerTheme,
      loadThemeGoogleFonts: false,
      columnDefs,
      rowData: [],
      defaultColDef: { sortable: true, resizable: true },
      enableBrowserTooltips: true,
      enableCellTextSelection: true,
      ensureDomOrder: true,
      overlayNoRowsTemplate: "<span>No money has moved yet.</span>",
    });
  }

  setRows(rows: LedgerRowDto[]): void {
    this.api.setGridOption("rowData", rows);
  }

  csv(fileName: string): void {
    this.api.exportDataAsCsv({
      fileName,
      processCellCallback: (p) => {
        const id = p.column.getColId();
        const v = p.value;
        if (id === "when") return typeof v === "number" ? when(v, this.tz(), "ledger") : "";
        if (id === "amountCents") return typeof v === "number" ? money2(v) : "";
        return csvSafe(v == null ? "" : String(v));
      },
    });
  }

  destroy(): void {
    this.api.destroy();
  }
}
```

- [ ] **Step 4: Ledger styles.** Append to `src/web/shared/styles.css` (the hand-made `.ag-theme-marquee` rules stay, but nothing in the app carries that class any more, so they no longer apply):

```css
/* ---------- Plan 5: the real AG Grid ledger (theme params in ledger.ts = GRID_THEME). Height = header + 8 rows, like the reference table */
.ledger-grid{height:calc(48px * 8 + 46px + 3px);width:100%}
.ledger-grid .ag-header-cell-text{text-transform:uppercase;letter-spacing:.1em}
.ledger-grid .ag-cell{display:flex;align-items:center}
.ledger-grid .ag-cell.when{font:500 14px/1.2 var(--f-mono);color:var(--ink-2)}
.ledger-grid .ag-cell.num{font:600 15px/1.2 var(--f-mono);justify-content:flex-end}
.ledger-grid .ag-cell.ref{font:400 13px/1.2 var(--f-mono);color:var(--ink-3)}
.pill.refunded{background:var(--lilac-soft);color:var(--ink)}.pill.refunded i{background:var(--lilac-ink)}
.pill.failed{background:#F6D6D3;color:#5A1410}.pill.failed i{background:#C8221B}
.pill.pending{background:#EFE9DE;color:var(--ink)}.pill.pending i{background:var(--ink-3)}
.pill.info{background:transparent;color:var(--ink-2)}.pill.info i{background:var(--ink-3)}
```

- [ ] **Step 5: Run the spec.** `npx playwright test tests/gpu/ledger.spec.ts` → PASS. If a theme parameter name is refused by `tsc`, compare it with `node_modules/ag-stack` and `node_modules/ag-grid-community/dist/types/src/theming/core/core-css.d.ts` (all eleven `GRID_THEME` names were checked against 36.2.0 when this plan was written) and fix the name in `GRID_THEME`, never by casting.

- [ ] **Step 6: Run all checks.** `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS (the pages don't use the grid yet).

- [ ] **Step 7: Commit.** `git add -A src/web tests && git commit -m "feat(web): AG Grid Community ledger themed to the reference, with sort, filter and safe CSV"` + trailer.

---

## Task 7: The artist's show page (`/s/:id/manage`)

**Files:**
- Create: `tests/gpu/manage-flows.spec.ts`
- Modify: `src/web/pages/manage.ts` (replace), `manage.html`, `src/web/shared/styles.css` (append)

**Interfaces:**
- Reads the manage key from `#fragment` (then `localStorage`), calls `GET /api/shows/:id/manage` with `x-manage-key`, polls `GET /api/shows/:id` every 5 s (not in parity runs) and refetches `/manage` only when `version` changes.
- `apply(view: ManageView)`: queue new log lines (by `seq`), replace ledger rows, re-render the proposal card, attention lines and call-off, then `step()` toward the new state with the reference's beats. Log lines are revealed on their beat: rule 1 lines when the pledge beat ends, rule 2 at the tip flare (or the end of a bonus beat), pay-the-split at "paid", void-on-miss at the release; everything else when nothing is moving.
- Proposal card: recommended option's question ("Extend the deadline N days, to <faq time>?" / "Lower the target to N fans?"), hold to approve (`POST …/approve`), other options as app-only "Or: …" buttons, "Not now" (`POST …/decline` + local dismissal), plain error line on failure.
- Call-off (tipped only, app-only): hold to call off → `POST …/call-off`.
- Hooks (HOOKS only): `{ page: "manage", ready, views, host, state, pending, approve(), decline(), addFans(n), skip(), reset(), holdTo(p) }`. `addFans`, `skip` and `reset` refetch `/manage` (a real show has no such actions; in tests the fake API serves the next scripted frame).

- [ ] **Step 1: Write the failing functional spec.** `tests/gpu/manage-flows.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import type { ManageView } from "../../src/worker/api-types";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { MANAGE_FRAMES, MANAGE_SCRIPTS, manageApi, MAYA, MAYA_ID, MAYA_KEY, mayaParties, showOf } from "./fixtures";
import { APP_BASE } from "./parity";

const XSS = `<img src=x onerror="window.__xss=1">`;
async function open(page: Page, api: FakeApi, hash = `#${MAYA_KEY}`) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}s/${MAYA_ID}/manage?e2e${hash}`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const holdSpace = async (page: Page, selector: string) => {
  await page.locator(selector).focus();
  await page.keyboard.down(" ");
  await page.waitForTimeout(1800);
  await page.keyboard.up(" ");
};

test("without the private link the page explains what to do", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped), "");
  await expect(page.locator("#manage-notice")).toHaveText("This page needs your private link, the one you saved when you signed. Open that link to see your show.");
});

test("a wrong private link is refused in plain words", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped), "#not-the-right-key");
  await expect(page.locator("#manage-notice")).toHaveText("That private link doesn’t match this show. Open the link you saved when you signed.");
});

test("the key from the link is kept in the browser and removed from the address bar", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped));
  expect(await page.evaluate(() => location.hash)).toBe("");
  expect(await page.evaluate((id) => localStorage.getItem(`ttr:manage:${id}`), MAYA_ID)).toBe(MAYA_KEY);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#manage-notice")).toBeHidden();
  await expect(page.locator("h1.title")).toHaveText("Acoustic Set");
});

test("every backend string is shown as text: log, proposal, attention, ledger", async ({ page }) => {
  const f = MANAGE_FRAMES.initial;
  const bad: ManageView = {
    ...f,
    log: [{ ...f.log[0], seq: 99, did: XSS, saw: XSS }, ...f.log],
    proposals: [{ ...f.proposals[0], explanation: XSS }],
    attention: [XSS],
    ledger: [{ seq: 1, at: f.now, what: XSS, who: XSS, amountCents: 1500, ref: XSS, status: "On hold" }],
  };
  await open(page, manageApi([bad]));
  await expect(page.locator("#log")).toContainText(XSS);
  await expect(page.locator("#ask-explain")).toHaveText(XSS);
  await expect(page.locator("#attention")).toHaveText(XSS);
  await expect(page.locator("#ledger")).toContainText(XSS);
  expect(await page.locator("main img").count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("the other option is offered too, and a refused approval says why and resets the button", async ({ page }) => {
  const two: ManageView = { ...MANAGE_FRAMES.initial, proposals: [{ ...MANAGE_FRAMES.initial.proposals[0], options: [...MANAGE_FRAMES.initial.proposals[0].options, { id: "lower", label: "Lower the target to 17", newDeadline: null, newThreshold: 17 }] }] };
  const base = manageApi([two]);
  await open(page, (req) => (req.path.endsWith("/approve") ? apiError(409, "conflict", "That change can't be applied any more.") : base(req)));
  await expect(page.locator("#ask-alt button")).toHaveText("Or: Lower the target to 17");
  await expect(page.locator("#ask-q b")).toHaveText("Extend the deadline 4 days, to Mon Nov 16, 6pm?");
  await holdSpace(page, "#approve");
  await expect(page.locator("[data-ask-msg]")).toHaveText("That change can't be applied any more.");
  await expect(page.locator("[data-approve-label]")).toHaveText("Hold to approve");
});

test("Not now records it on the server and keeps the card hidden after a reload", async ({ page }) => {
  const seen = await open(page, manageApi(MANAGE_SCRIPTS.calledOff));
  await page.click("#decline");
  await expect(page.locator("#ask")).toBeHidden();
  await expect(page.locator("#log")).toContainText("You said not now.");
  expect(seen.some((r) => r.path === `/api/shows/${MAYA_ID}/proposals/pace1/decline`)).toBe(true);
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  await expect(page.locator("#ask")).toBeHidden();
});

test("a tipped show can be called off with a hold", async ({ page }) => {
  const cancelled: ManageView = { ...MANAGE_FRAMES.tipped, show: showOf(MAYA, { fans: 21, state: "cancelled", version: 9 }), version: "e9.l9" };
  const seen = await open(page, manageApi([MANAGE_FRAMES.tipped, cancelled]));
  await expect(page.locator("#calloff")).toBeVisible();
  await holdSpace(page, "#calloff-btn");
  await expect(page.locator("[data-word]")).toHaveText("Called off", { timeout: 15_000 });
  expect(seen.some((r) => r.path === `/api/shows/${MAYA_ID}/call-off`)).toBe(true);
  await expect(page.locator("#calloff")).toBeHidden();
});

test("attention lines and unconfirmed payouts are said honestly", async ({ page }) => {
  const pending: ManageView = { ...MANAGE_FRAMES.paid, parties: mayaParties("pending", true), attention: ["The payout couldn't be sent. It's waiting for your OK."] };
  await open(page, manageApi([pending]));
  await expect(page.locator("#attention")).toHaveText("The payout couldn't be sent. It's waiting for your OK.");
  await expect(page.locator("[data-word]")).toHaveText("Payouts sent");
  await expect(page.locator("[data-sentence]")).toContainText("PayPal is still confirming them.");
});

test("the ledger is the AG Grid with every money move and a CSV button", async ({ page }) => {
  await open(page, manageApi(MANAGE_SCRIPTS.tipped));
  await expect(page.locator("#ledger .ag-center-cols-container .ag-row").first()).toBeVisible();
  await expect(page.locator('#ledger .ag-center-cols-container .ag-row[row-index="0"] .ag-cell[col-id="who"]')).toHaveText("Fan 12 · BF");
  await expect(page.locator("#ledger")).toContainText("SAMPLE-AUTH-012");
  await expect(page.locator("#csv")).toBeVisible();
});
```

Run `npx playwright test tests/gpu/manage-flows.spec.ts` → FAIL (static page: no notice, no grid).

- [ ] **Step 2: Edit `manage.html`.** Exactly these edits:
1. Right after `<main>`: `<section class="card notice" id="manage-notice" data-app-only hidden aria-live="polite"><p data-notice-text></p></section>`
2. In `#ask`, give the explanation paragraph (the one with `<b>12 of 21</b>`) `id="ask-explain"`.
3. In `#ask`, after the `<p class="hold-hint" …>`, add: `<div class="actions" id="ask-alt" data-app-only hidden></div><p class="pledge-msg" data-ask-msg data-app-only hidden aria-live="polite"></p>`
4. Right before `<div class="ask" id="ask" …>`: `<ul class="attention" id="attention" data-app-only hidden aria-live="polite"></ul>`
5. Right after `<ol class="log" id="log" aria-live="polite"></ol>`:

```html
      <div class="calloff" id="calloff" data-app-only hidden>
        <p class="why">Can’t play? Calling the show off gives every fan who was charged their money back.</p>
        <button class="btn btn-hold" type="button" id="calloff-btn" style="min-height:48px;padding:0 18px;font-size:16px"><span class="lbl"><span data-calloff-label>Hold to call the show off</span></span></button>
        <p class="pledge-msg" data-calloff-msg hidden aria-live="polite"></p>
      </div>
```

6. Replace the whole `<div class="ag-root-wrapper ag-theme-marquee" …> … </div>` block and the `<p class="grid-note">…</p>` after it with:

```html
    <div class="ledger-grid" id="ledger"></div>
    <p class="grid-note">Newest first. Sort or filter any column. <button class="linkish" type="button" id="csv">Download as CSV</button></p>
```

Append to `src/web/shared/styles.css`:

```css
.attention{margin:0;padding:12px 16px 12px 34px;border:2px solid #C8221B;border-radius:14px;background:#FBE9E6;font:500 17px/1.4 var(--f-ui)}
.calloff{display:grid;gap:10px;padding-top:6px;border-top:1px solid var(--rule)}
.calloff .why{margin:0;font:400 16px/1.45 var(--f-ui);color:var(--ink-2)}
```

- [ ] **Step 3: Replace `src/web/pages/manage.ts`.**

```ts
import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, AgentLog, PayoutStrip, Placeholder, HoldButton, setStatus, countdownHTML, drawQR, copyText, usd, clamp, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { AgentLogDto, ManageView, ProposalDto, PublicShow } from "../../worker/api-types";
import type { RuleId } from "../../core/rules";
import { API_BASE, HOOKS, PARITY, PUBLIC_ORIGIN, markReady, removeRefOnly, safeStorage } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { andList, askEmphasis, dayLabel, dollars, emphasis, endOf, fineLine, planSplit, payoutsConfirmed, remainSec, ShowClock, when, type Seg } from "../shared/format";
import { dismiss, isDismissed, recallKey, rememberKey, showIdFromPath, takeKeyFromHash } from "../shared/keys";
import { LedgerGrid } from "../shared/ledger";

removeRefOnly();
const api = apiClient(API_BASE);
const store = safeStorage();
const showId = showIdFromPath(location.pathname, location.search);
const fragKey = takeKeyFromHash(location.hash);
// The private link carries the key once: keep it in this browser and take it out of the address bar.
if (showId && fragKey) { rememberKey(store, showId, fragKey); history.replaceState(null, '', location.pathname + location.search); }
const key = showId ? (fragKey ?? recallKey(store, showId)) : null;
const SEED = 31, YAW = .16, DAY = 86_400_000;
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6 }, MISS: { release: .12, msg: 2.05, wave: .9 } };
const PAYEE = { room: 'Room', opener: 'Opener', host: 'Host', artist: 'You' } as const;

type MPhase = 'open' | 'tipping' | 'tipped' | 'ff' | 'paying' | 'paid' | 'missing' | 'released';
interface ManageState { phase: MPhase; tipped: boolean; fans: number; remain: number; busy: boolean; ffRaf: number }
type Option = ProposalDto['options'][number];
let st: ManageState = { phase: 'open', tipped: false, fans: 0, remain: 0, busy: false, ffRaf: 0 };
let mv: ManageView | null = null, clock: ShowClock | null = null, ph: Placeholder | null = null, view: SignView | null = null, payout: PayoutStrip | null = null, grid: LedgerGrid | null = null;
let queue: AgentLogDto[] = [], lastSeq = 0, ask: { proposalId: string; option: Option } | null = null;
const el = { stage: $('[data-stage]'), status: $('[data-status]'), sentence: $('[data-sentence]'), clock: $('[data-clock]'), dl: $('[data-deadline-label]'), sub: $('[data-fans-sub]'), of: $('[data-of]'), ask: $('#ask'), askAlt: $('#ask-alt'), askMsg: $('[data-ask-msg]'), notice: $('#manage-notice'), attention: $('#attention'), calloff: $('#calloff'), calloffMsg: $('[data-calloff-msg]') };
const odoFans = new Odo($('[data-fans]')), odoHeld = new Odo($('[data-held]')), odoCharged = new Odo($('[data-charged]'));
const log = new AgentLog($('#log')), cues = new Cues();
Ticker.lamp(el.status);

type StatusKey = 'held' | 'tipped' | 'paying' | 'paid' | 'sent' | 'missing' | 'released' | 'refunding';
const STATUS: Record<StatusKey, [string, string, string]> = { held: ['held', 'Waiting for fans', '· $0 charged'], tipped: ['tipped', 'It’s on!', '· everyone’s charged'], paying: ['paying', 'Paying everyone', '· one PayPal payout'], paid: ['paid', 'Everyone’s paid', ''], sent: ['paid', 'Payouts sent', '· waiting for PayPal to confirm'], missing: ['missing', 'Deadline passed', '· cancelling every hold'], released: ['released', 'Called off', '· nobody paid'], refunding: ['released', 'Called off', '· refunding everyone'] };
const say = (k: StatusKey, instant?: boolean) => setStatus(el.status, ...STATUS[k], instant);
const show = (): PublicShow => mv!.show;
const target = () => mv?.show.threshold ?? 1;
const priceCents = () => mv?.show.ticketPriceCents ?? 0;
const tz = () => mv?.show.timeZone ?? 'UTC';
const fixedParties = () => show().split.filter(p => p.role !== 'artist');
const confirmed = () => payoutsConfirmed(mv?.parties ?? []);
const cancelled = () => mv?.show.state === 'cancelled';
const visual = (): { phase: Phase; fans: number } => ({ phase: st.phase === 'paying' || st.phase === 'paid' ? 'paid' : st.phase === 'missing' || st.phase === 'released' ? 'released' : st.tipped ? 'tipped' : 'held', fans: st.fans });
const splitOf = (fans: number) => planSplit(show().split, fans * priceCents()).map(c => c / 100);
const payees = () => { const a = splitOf(Math.max(st.fans, target())); return show().split.map((p, i) => ({ label: PAYEE[p.role], amount: a[i] })); };
const paidAmounts = () => { const parties = mv?.parties ?? []; return parties.length && parties.every(p => p.payoutCents !== null) ? parties.map(p => (p.payoutCents ?? 0) / 100) : splitOf(st.fans); };
const live = () => st.phase === 'open' || st.phase === 'tipped' || st.phase === 'tipping';

function segsInto(node: HTMLElement, segs: Seg[]) {
  node.textContent = '';
  for (const s of segs) { if (!s.cls) { node.append(s.text); continue; } const e = document.createElement(s.cls === 'b' ? 'b' : 'span'); if (s.cls !== 'b') e.className = s.cls; e.textContent = s.text; node.append(e); }
}
function addLog(e: AgentLogDto, instant = false) { log.addSegs({ time: when(e.at, tz(), 'log'), segs: emphasis(e.did), fine: fineLine(e), instant }); }
/** Reveals queued log lines up to the last one for `rule` (null: all of them). */
function flush(rule: RuleId | null, instant = false) {
  let upto = -1; queue.forEach((e, i) => { if (rule === null || e.rule === rule) upto = i; });
  for (const e of queue.splice(0, upto + 1)) addLog(e, instant);
}
function takeLog(v: ManageView) { for (const e of [...v.log].reverse()) if (e.seq > lastSeq) { queue.push(e); lastSeq = e.seq; } }

function render(instant = false) {
  if (!mv) return;
  const s = show(), { fans } = st, t = s.threshold, total = fans * priceCents() / 100, v = visual().phase, d = Date.parse(s.deadline), dl = when(d, s.timeZone, 'long');
  odoFans.set(fans, instant); odoHeld.set(st.tipped || v === 'released' ? 0 : total, instant); odoCharged.set(st.tipped && !cancelled() ? total : 0, instant);
  el.of.textContent = fans <= t ? `of ${t} fans` : `fans · target was ${t}`;
  el.sub.textContent = v === 'paid' ? (confirmed() ? 'Everyone’s paid' : 'Payouts sent') : v === 'released' ? (cancelled() ? 'Called off · refunding' : `Called off · ${t - fans} short`) : st.tipped ? (fans > t ? `It’s on! · ${fans - t} joined after it tipped` : 'It’s on! Everyone’s charged') : `${t - fans} more to make it happen`;
  const a = v === 'paid' ? paidAmounts() : splitOf(fans), fixed = fixedParties(), last = a.length - 1;
  el.sentence.textContent = v === 'paid' ? (confirmed() ? `Everyone’s paid. ${andList([...fixed.map((p, i) => `${p.label} got ${usd(a[i])}`), `you got ${usd(a[last])}`])}.` : `Payouts sent: ${andList([...fixed.map((p, i) => `${p.label} ${usd(a[i])}`), `you ${usd(a[last])}`])}. PayPal is still confirming them.`)
    : v === 'released' ? (cancelled() ? `Called off. Every fan who was charged is getting ${dollars(priceCents())} back.` : `Called off. Every hold was cancelled, ${usd(total)} went back to ${fans} fans, and nobody paid.`)
    : st.tipped ? `It’s on! ${fans} fans were charged ${usd(total)}. ${andList([...fixed.map(p => p.label), 'you'])} are paid at the deadline, ${dl}.`
    : `${fans} fans are on hold. ${t - fans} more by ${dl} and it’s on. Nobody has been charged.`;
  if (live()) st.remain = remainSec(s.deadline, clock);
  el.dl.textContent = `Deadline · ${dl}`; el.clock.innerHTML = countdownHTML(st.remain);
  el.stage.setAttribute('aria-label', `Your marquee sign: ${v === 'paid' ? 'fully lit, with payout signs hanging below' : v === 'tipped' ? 'fully lit, the show is on' : v === 'released' ? 'dark, it reads CALLED OFF, $0 CHARGED' : `${fans} of ${t} bulbs glowing dimly, fans on hold`}.`);
  ph?.update(v, fans);
}

function texts(s: PublicShow) {
  $('.mode').textContent = s.demo ? 'Your show page · sample show' : 'Your show page';
  $('.row-top .eyebrow').textContent = `Your show · ${dayLabel(s.showDate)} · ${s.roomName}`;
  $('h1.title').textContent = s.showName;
  document.title = `Tip the Room · ${s.showName}`;
}

function question(o: Option): string {
  const s = show();
  if (o.id === 'extend' && o.newDeadline) { const days = Math.round((Date.parse(o.newDeadline) - Date.parse(s.deadline)) / DAY); return `Extend the deadline ${days} day${days === 1 ? '' : 's'}, to ${when(Date.parse(o.newDeadline), s.timeZone, 'faq')}?`; }
  if (o.id === 'lower' && o.newThreshold) return `Lower the target to ${o.newThreshold} fans?`;
  return `${o.label}?`;
}
function why(o: Option): string {
  const s = show();
  if (o.id === 'extend' && o.newDeadline) { const notice = Math.ceil((Date.parse(`${s.showDate}T00:00:00Z`) - Date.parse(o.newDeadline)) / DAY); return `Your money rules allow one extension of up to 7 days. The show is ${dayLabel(s.showDate)}, so fans still get ${notice} day${notice === 1 ? '' : 's'}’ notice.`; }
  if (o.id === 'lower') return 'Your money rules let you lower the target once you say so. Everyone already on hold stays on hold.';
  return 'Some charges didn’t go through, so what was collected doesn’t cover everyone in full. Approving pays out what was collected, in your money-rule order.';
}
const askSay = (text: string) => { el.askMsg.textContent = text; el.askMsg.hidden = !text; };
function renderAsk() {
  if (!mv) return;
  const s = show();
  const p = s.state === 'live' && st.phase === 'open' ? mv.proposals.find(x => !x.approved && x.options.length > 0 && !isDismissed(store, s.showId, x.proposalId)) : undefined;
  el.ask.hidden = !p; el.askAlt.textContent = ''; el.askAlt.hidden = true;
  if (!p) { ask = null; return; }
  const main = p.options.find(o => o.id === p.recommend) ?? p.options[0];
  if (ask?.proposalId !== p.proposalId) { approveBtn.reset(); $('[data-approve-label]').textContent = 'Hold to approve'; askSay(''); }
  ask = { proposalId: p.proposalId, option: main };
  segsInto($('#ask-explain'), askEmphasis(p.explanation));
  $('#ask-q b').textContent = question(main);
  $('#ask .why').textContent = why(main);
  for (const o of p.options) {
    if (o === main) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn-ghost'; b.textContent = `Or: ${o.label}`;
    b.addEventListener('click', () => { void approveNow(p.proposalId, o); });
    el.askAlt.append(b); el.askAlt.hidden = false;
  }
}
function renderAttention() {
  const lines = mv?.attention ?? [];
  el.attention.textContent = '';
  for (const l of lines) { const li = document.createElement('li'); li.textContent = l; el.attention.append(li); }
  el.attention.hidden = lines.length === 0;
}
function renderCallOff() { el.calloff.hidden = mv?.show.state !== 'tipped'; }
function payNote(a: number[]) { const fixed = fixedParties(); return `One PayPal payout, in money-rule order: ${[...fixed.map((p, i) => `${p.label} ${usd(a[i])}`), `you ${usd(a[a.length - 1])}`].join(', then ')}.`; }
const TAG = { paid: 'Paid', pending: 'Sent', failed: 'Didn’t go through', none: 'Nothing to pay', planned: 'Planned' } as const;
const payTags = () => (mv?.parties ?? []).map(p => TAG[p.payoutStatus]);

/** One step toward the latest data, with the reference's beats. Each beat calls step() again when it ends. */
function step() {
  if (!mv || st.busy) return;
  const s = show(), want = s.fans.committed, end = endOf(s.state), t = s.threshold;
  const goesOn = end === 'tipped' || end === 'paid' || end === 'cancelled';
  if (st.phase === 'open' && !st.tipped) {
    const cap = goesOn ? Math.min(want, t) : want;
    if (cap > st.fans) return addFans(cap - st.fans, false);
    if (goesOn) return tip();
    if (end === 'missed') return skip();
  } else if (st.phase === 'tipped') {
    if (want > st.fans) return addFans(want - st.fans, true);
    if (end === 'paid' || end === 'cancelled') return skip();
  }
  flush(null);
}
function addFans(n: number, after: boolean) {
  st.busy = true; render();
  const f0 = st.fans, gap = REDUCED ? .06 : after ? .3 : .24, land = REDUCED || after ? .1 : .38;
  if (view) view.play(after ? (REDUCED ? 'reduced' : 'bonus') : 'pledge', after ? (REDUCED ? { to: 'tipped' } : { count: n }) : { f0, f1: f0 + n });
  for (let k = 0; k < n; k++) cues.at(k * gap + land, () => { st.fans++; render(); Snd.screw(k); });
  cues.at((n - 1) * gap + land + .2, () => {
    st.busy = false;
    flush(after ? 'rule-2-capture-at-tip' : 'rule-1-hold-only');
    const tipsNext = !after && endOf(show().state) !== 'live' && endOf(show().state) !== 'missed' && st.fans >= target();
    if (!tipsNext) { render(); if (view && after) view.setPayouts(payees()); }
    step();
  });
}
function tip() {
  st.phase = 'tipping'; st.busy = true; el.ask.hidden = true; render();
  if (view) view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
  if (!REDUCED) { Snd.chase(target(), T.TIP.flare); cues.at(T.TIP.pop, () => Snd.sparks()); cues.at(T.TIP.itson, () => Snd.chord()); }
  cues.at(REDUCED ? .05 : T.TIP.flare, () => { Snd.flare(); st.tipped = true; say('tipped'); flush('rule-2-capture-at-tip'); render(); });
  cues.at(REDUCED ? .7 : T.TIP.done, () => { st.phase = 'tipped'; st.busy = false; render(); if (view) view.setPayouts(payees()); renderCallOff(); step(); });
}
function skip() {
  const wasTipped = st.tipped; st.phase = 'ff'; st.busy = true; el.ask.hidden = true; render();
  const from = st.remain, dur = REDUCED ? .2 : 1.15, t0 = performance.now();
  if (view) view.tension(true);
  const tick = (now: number) => {
    const k = clamp((now - t0) / 1000 / dur), e = k * k * (2.2 - 1.2 * k); st.remain = Math.round(from * (1 - e)); el.clock.innerHTML = countdownHTML(st.remain);
    if (k < 1) { st.ffRaf = requestAnimationFrame(tick); return; }
    el.clock.classList.add('zero'); if (view) view.tension(false);
    if (wasTipped && endOf(show().state) === 'paid') payOut(); else miss();
  };
  st.ffRaf = requestAnimationFrame(tick);
}
function payOut() {
  const a = paidAmounts(); st.phase = 'paying'; say('paying'); render(); Snd.drop();
  if (view) { view.setPayouts(payees()); view.play(REDUCED ? 'reduced' : 'payout', REDUCED ? { to: 'paid' } : {}); }
  cues.at(REDUCED ? .3 : T.PAYOUT.paid, () => {
    Snd.paid(2); st.phase = 'paid'; st.busy = false; say(confirmed() ? 'paid' : 'sent');
    payout?.fill(a, cues, payNote(a), confirmed() ? undefined : payTags());
    flush('rule-4-pay-the-split');
    render(); step();
  });
}
function miss() {
  st.phase = 'missing'; render();
  if (view) view.play(REDUCED ? 'reduced' : 'miss', REDUCED ? { to: 'released' } : {});
  if (!REDUCED) { Snd.relays(12, T.MISS.wave); Snd.release(st.fans); }
  cues.at(REDUCED ? .05 : T.MISS.release, () => { say('missing'); flush('rule-3-void-on-miss'); payout?.reset(); render(); });
  cues.at(REDUCED ? .8 : T.MISS.msg, () => { Snd.msg(); st.phase = 'released'; st.busy = false; say(cancelled() ? 'refunding' : 'released'); render(); renderCallOff(); step(); });
}

/** A page opened after things happened shows the current state at once, without replaying beats. */
function jumpTo(s: PublicShow) {
  const end = endOf(s.state);
  st = { phase: end === 'live' ? 'open' : end === 'tipped' ? 'tipped' : end === 'paid' ? 'paid' : 'released', tipped: end === 'tipped' || end === 'paid' || end === 'cancelled', fans: s.fans.committed, remain: remainSec(s.deadline, clock), busy: false, ffRaf: 0 };
  el.clock.classList.toggle('zero', st.phase === 'paid' || st.phase === 'released');
  const fixed = fixedParties(), artist = s.split.find(p => p.role === 'artist');
  if (st.phase === 'paid') { const a = paidAmounts(); payout?.set(a, confirmed() ? a.map(() => 'Paid') : payTags(), a.map(() => 'paid'), payNote(a)); }
  else { payout?.reset(); if (st.phase !== 'released') payout?.plan(splitOf(Math.max(st.fans, s.threshold)), [...fixed.map(() => 'Planned'), `At least ${dollars(artist?.minimumCents ?? 0)} · planned`]); }
  say(st.phase === 'open' ? 'held' : st.phase === 'tipped' ? 'tipped' : st.phase === 'paid' ? (s.state === 'paying_out' ? 'paying' : confirmed() ? 'paid' : 'sent') : cancelled() ? 'refunding' : 'released', true);
}

function apply(v: ManageView) {
  const prev = mv; mv = v; clock?.sync(v.now);
  if (prev && prev.show.threshold !== v.show.threshold) { ph?.setModel({ name: v.show.showName, target: v.show.threshold }); if (view) view.setModel(model()); }
  takeLog(v);
  grid?.setRows(v.ledger);
  renderAsk(); renderAttention(); renderCallOff();
  step();
  render();
}
async function refresh() {
  if (!showId || !key) return;
  apply(await api.manage(showId, key));
}
async function approveNow(proposalId: string, option: Option) {
  if (!showId || !key) return;
  await act(async () => {
    try { await api.approve(showId, key, proposalId, { option: option.id }); el.ask.hidden = true; Snd.sign(); await refresh(); }
    catch (e) { approveBtn.reset(); $('[data-approve-label]').textContent = 'Hold to approve'; askSay(e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.'); }
  });
}
async function declineNow() {
  if (!ask || !showId || !key) return;
  const id = ask.proposalId;
  el.ask.hidden = true; dismiss(store, showId, id);
  await act(async () => {
    try { await api.decline(showId, key, id); } catch { /* the card stays hidden; the log just won't show the "not now" */ }
    try { await refresh(); } catch { /* the next poll catches up */ }
  });
}
async function callOffNow() {
  if (!showId || !key) return;
  await act(async () => {
    try { await api.callOff(showId, key); await refresh(); }
    catch (e) { calloffBtn.reset(); $('[data-calloff-label]').textContent = 'Hold to call the show off'; el.calloffMsg.textContent = e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.'; el.calloffMsg.hidden = false; }
  });
}
function blocked(text: string) {
  $('[data-notice-text]').textContent = text; el.notice.hidden = false;
  document.querySelectorAll<HTMLElement>('main > :not(#manage-notice)').forEach(n => { n.hidden = true; });
}
function model(): SignModel { const s = show(); return { name: s.showName, crest: s.roomName.toUpperCase(), target: s.threshold, seed: SEED, yaw: YAW, payees: payees() }; }

async function boot() {
  if (!showId) return blocked('There’s no show at this link.');
  if (!key) return blocked('This page needs your private link, the one you saved when you signed. Open that link to see your show.');
  let v: ManageView;
  try { v = await act(() => api.manage(showId, key)); }
  catch (e) {
    const f = e instanceof ApiFailure ? e : null;
    return blocked(f?.status === 403 ? 'That private link doesn’t match this show. Open the link you saved when you signed.' : f?.status === 404 ? 'There’s no show at this link.' : f ? f.message : 'Something went wrong. Please refresh the page.');
  }
  mv = v; clock = new ShowClock(v.now);
  const s = v.show;
  texts(s);
  ph = new Placeholder($('[data-ph]'), { name: s.showName, target: s.threshold });
  payout = new PayoutStrip($('#payout'), s.split.map(p => ({ label: PAYEE[p.role], who: p.role === 'artist' ? `You (${p.label})` : p.label })));
  const fixed = fixedParties();
  payout.idle(fixed.length ? `Paid at the deadline once the show is on: ${fixed.map(p => p.label).join(', then ')} first, then you get the rest.` : 'Paid at the deadline once the show is on: you get everything collected.');
  grid = new LedgerGrid($('#ledger'), tz); grid.setRows(v.ledger);
  const share = `${PUBLIC_ORIGIN}${v.sharePath || `/s/${showId}`}`;
  $('#share-url').textContent = share; drawQR($<HTMLCanvasElement>('#qr'), share, { scale: 4, margin: 3 });
  takeLog(v); flush(null, true);
  jumpTo(s);
  renderAsk(); renderAttention(); renderCallOff();
  render(true);
}

const approveBtn = new HoldButton($<HTMLButtonElement>('#approve'), { ms: 1500, onDone: () => { $('[data-approve-label]').textContent = 'Approved'; if (ask) void approveNow(ask.proposalId, ask.option); } });
const calloffBtn = new HoldButton($<HTMLButtonElement>('#calloff-btn'), { ms: 1500, onDone: () => { $('[data-calloff-label]').textContent = 'Calling it off…'; void callOffNow(); } });
$('#decline').addEventListener('click', () => { void declineNow(); });
$('#copy').addEventListener('click', () => copyText($('#share-url').textContent ?? '', $('[data-copied]')));
$('#csv').addEventListener('click', () => grid?.csv(`tip-the-room-${showId ?? 'show'}.csv`));
setInterval(() => { if (mv && live()) { st.remain = remainSec(show().deadline, clock); el.clock.innerHTML = countdownHTML(st.remain); } }, 1000);
if (!PARITY) setInterval(() => { if (!mv || !showId || document.hidden) return; api.getShow(showId).then(s => (s.version !== mv?.version ? refresh() : undefined)).catch(() => undefined); }, 5000);
soundToggle($('#sound'));

interface ManageHooks extends MarqueeHooks { readonly state: ManageState; addFans(max?: number): void; skip(): void; reset(): void; approve(): void; decline(): void; holdTo(p: number): void }
// A real show has no "add fans" or "skip": in test runs these fetch the next scripted answer from the fake API.
const pull = () => { void act(async () => { try { await refresh(); } catch { /* the next poll catches up */ } }); };
const hooks: ManageHooks = {
  page: 'manage', ready: false, views: [], get state() { return st; }, get pending() { return pendingCount(); },
  addFans: pull, skip: pull, reset: pull,
  approve: () => { if (!ask) return; approveBtn.done = true; $('#approve').classList.add('is-done'); $('[data-approve-label]').textContent = 'Approved'; void approveNow(ask.proposalId, ask.option); },
  decline: () => { void declineNow(); },
  holdTo: p => approveBtn.set(p),
};
if (HOOKS) {
  window.__marquee = hooks;
  document.querySelector('[data-act=add]')?.addEventListener('click', () => hooks.addFans(5));
  document.querySelector('[data-act=ff]')?.addEventListener('click', () => hooks.skip());
  document.querySelector('[data-act=reset]')?.addEventListener('click', () => hooks.reset());
}

await boot();
let host: SignHost | null = null;
if (mv) { try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ } }
if (host && mv) {
  const each = dollars(priceCents());
  view = host.add(el.stage, model(), { state: visual, tipEl: $('[data-tip]'), ph: $('[data-ph]'), tip: slot => slot < Math.min(st.fans, target()) ? `Fan ${pad2(slot + 1)} · ${mv?.show.bulbs[slot]?.initials ?? ''} · ${each} ${visual().phase === 'held' ? 'on hold' : visual().phase === 'released' ? 'hold cancelled' : 'charged'}` : null });
  const h = host; Ticker.add(now => h.tick(now)); hooks.views = host.views; hooks.host = host;
}
hooks.ready = true;
markReady();
```

- [ ] **Step 4: Run the manage specs.** `npx playwright test tests/gpu/manage.spec.ts tests/gpu/manage-flows.spec.ts tests/gpu/ledger.spec.ts` → PASS. If a manage parity case fails on text, read `test-results/parity/manage-*-{ref,app}.txt`: the frame text lives in `tests/gpu/fixtures.ts` and must keep matching the reference's sample copy; fix the page's derived sentence (or the beat a log line is flushed on), not the threshold.

- [ ] **Step 5: Run all checks.** `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS.

- [ ] **Step 6: Commit.** `git add -A src/web manage.html tests && git commit -m "feat(web): show page on the real API: proposals with approve and not now, AG Grid ledger, agent log, attention, call-off"` + trailer.

---

## Task 8: Try the demo (`/`): two seeded shows, Add fans, Skip to the deadline, Check pace now, Start over, judge panel

**Files:**
- Create: `tests/gpu/demo-flows.spec.ts`
- Modify: `src/web/pages/demo.ts` (replace), `index.html`, `src/web/shared/styles.css` (append)

**Interfaces:**
- Boot: reuse the saved copy (`ttr:demo`, if it has more than 10 minutes left and both shows answer) or `POST /api/demo`; save `{ demoId, demoKey, expiresAt }`; fetch each show's `/manage` (the demo key is the manage key) for its log and payout parties.
- Controls (both real, both visible): "Add N fans" → `POST /api/demo/:id/fans { show, count }`; "Skip to the deadline" → `POST /api/demo/:id/fast-forward { show }`; "Start over" → `POST /api/demo/:id/reset`; "Check pace now" (judge panel) → `POST /api/demo/:id/pace`. Keys: T = add the fans show A still needs, P = skip (button of A), M = skip (button of B), R = start over.
- Polling every 4 s (not in parity runs): `GET /api/shows/:id` for both; a changed `version` → apply + refetch `/manage`.
- `ShowCtl.apply(show)` / `ShowCtl.takeView(view, instant?)` / `ShowCtl.step()`: same beats as the reference; log lines revealed on their beat (as on the show page).
- Judge panel (app-only): sandbox buyer from `VITE_SANDBOX_BUYER_EMAIL` / `VITE_SANDBOX_BUYER_PASSWORD` (fallback sentence when unset), "Check pace now", links to show A's fan page and both show pages (`#<demoKey>`), a plain message line.
- Hooks (HOOKS only): `{ page: "demo", ctls, views, host, ready, pending }`.

- [ ] **Step 1: Write the failing functional spec.** `tests/gpu/demo-flows.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";
import { apiError, installFakeApi, type FakeApi } from "./fake-api";
import { DEMO_ID, DEMO_KEY, demoApi } from "./fixtures";
import { APP_BASE } from "./parity";

async function open(page: Page, api: FakeApi = demoApi()) {
  const seen = await installFakeApi(page, api);
  await page.goto(`${APP_BASE}?e2e`);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
  return seen;
}
const fans = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);

test("the judge panel prints the sandbox login sentence and links to the demo shows", async ({ page }) => {
  await open(page);
  await expect(page.locator("#judge")).toBeVisible();
  await expect(page.locator("[data-judge-creds]")).toHaveText("To try the real PayPal checkout, log in with any PayPal sandbox personal account. It’s play money: nothing real is charged.");
  await expect(page.locator("#pledge-a")).toHaveAttribute("href", `/s/${DEMO_ID}a`);
  await expect(page.locator("#pledge-a")).toHaveText("Hold a spot on Juniper Vale");
  await expect(page.locator("#manage-b")).toHaveAttribute("href", `/s/${DEMO_ID}b/manage#${DEMO_KEY}`);
  await expect(page.locator("#log li")).toHaveCount(1);
  await expect(page.locator("#log")).toContainText("Watching 2 shows. 48 fans are on hold and nobody has been charged.");
});

test("Check pace now shows the agent's proposal for the show that is behind", async ({ page }) => {
  const seen = await open(page);
  await page.click("#pace");
  await expect(page.locator("#log")).toContainText("Proposed: Extend 7 days or Lower the target to 25. Waiting for the artist.");
  await expect(page.locator("#log")).toContainText("On pace. Nothing to change.");
  await expect(page.locator("[data-judge-msg]")).toHaveText("The agent checked the pace. Marlow Finch is behind, so it asked the artist first. Open the show page to answer.");
  expect(seen.some((r) => r.path === `/api/demo/${DEMO_ID}/pace` && r.key === DEMO_KEY)).toBe(true);
});

test("Add fans asks the API for that show and the new bulbs land", async ({ page }) => {
  const seen = await open(page);
  await page.locator("#show-b [data-act=add]").click();
  await expect(fans(page, "b")).toHaveText("24", { timeout: 10_000 });
  expect(seen.find((r) => r.path.endsWith("/fans"))?.body).toEqual({ show: "b", count: 5 });
  await expect(page.locator("#log")).toContainText("5 more fans joined Marlow Finch. PayPal is holding their $60.");
});

test("Skip to the deadline on a show that is short calls it off", async ({ page }) => {
  const seen = await open(page);
  await page.locator("#show-b [data-act=ff]").click();
  await expect(page.locator("#show-b [data-word]")).toHaveText("Called off", { timeout: 10_000 });
  expect(seen.find((r) => r.path.endsWith("/fast-forward"))?.body).toEqual({ show: "b" });
  await expect(page.locator("#log")).toContainText("Marlow Finch ended at 19 of 28. Every hold was cancelled. Nobody paid.");
});

test("Start over gets a fresh copy, and a saved copy is reused on reload", async ({ page }) => {
  const seen = await open(page);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("ttr:demo"))) ?? "null")).toMatchObject({ demoId: DEMO_ID, demoKey: DEMO_KEY });
  await page.locator("#show-a [data-act=reset]").click();
  await expect(page.locator("[data-judge-msg]")).toHaveText("A fresh pair of sample shows is ready.");
  expect(seen.some((r) => r.path === `/api/demo/${DEMO_ID}/reset`)).toBe(true);
  const before = seen.filter((r) => r.path === "/api/demo").length;
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1");
  expect(seen.filter((r) => r.path === "/api/demo").length).toBe(before);
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
});

test("a refused demo is explained in plain words", async ({ page }) => {
  await open(page, (req) => (req.path === "/api/demo" ? apiError(429, "rate_limited", "Too many tries. Please wait a moment and try again.") : undefined));
  await expect(page.locator("[data-judge-msg]")).toHaveText("Too many tries. Please wait a moment and try again.");
});
```

Run `npx playwright test tests/gpu/demo-flows.spec.ts` → FAIL.

- [ ] **Step 2: Judge panel in `index.html`.** Insert right after the closing `</div>` of `<div class="front">` (inside `<main>`):

```html
  <section class="card judge" id="judge" data-app-only hidden aria-labelledby="h-judge">
    <h2 class="section-title" id="h-judge">For judges</h2>
    <p data-judge-creds></p>
    <div class="actions">
      <button class="btn" type="button" id="pace">Check pace now</button>
      <a class="btn btn-ghost" id="pledge-a" href="/">Hold a spot on show A</a>
      <a class="btn btn-ghost" id="manage-a" href="/">Show A’s page</a>
      <a class="btn btn-ghost" id="manage-b" href="/">Show B’s page</a>
    </div>
    <p class="hint" data-judge-msg aria-live="polite"></p>
  </section>
```

Append to `src/web/shared/styles.css`:

```css
.judge{margin-top:28px;display:grid;gap:12px}
.judge p{margin:0;font:400 17px/1.45 var(--f-ui)}
```

- [ ] **Step 3: Replace `src/web/pages/demo.ts`.**

```ts
import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, AgentLog, PayoutStrip, Placeholder, setStatus, countdownHTML, usd, clamp, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase, Payee, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { AgentLogDto, DemoResponse, ManageParty, ManageView, PublicShow } from "../../worker/api-types";
import type { RuleId } from "../../core/rules";
import { API_BASE, HOOKS, PARITY, SANDBOX_BUYER, markReady, removeRefOnly, safeStorage } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { andList, dayLabel, dollars, emphasis, endOf, fineLine, payoutsConfirmed, planSplit, remainSec, ROLE_WORD, rulesLine, ShowClock, when } from "../shared/format";
import { loadDemo, saveDemo, type SavedDemo } from "../shared/keys";

removeRefOnly();
const api = apiClient(API_BASE);
const store = safeStorage();

type Key = 'a' | 'b';
interface Look { crest: string; yaw: number; seed: number; label: string }
// The two demo shows are fixed fictional seeds (src/agent/demo.ts). Their sign styling and the bill lines in index.html
// aren't in the API; everything else on the page comes from it.
const LOOK: Record<Key, Look> = { a: { crest: 'SPINDLE RECORDS', yaw: .2, seed: 7, label: 'Show A' }, b: { crest: 'ELM ST HOUSE SHOW', yaw: -.2, seed: 19, label: 'Show B' } };
type CtlPhase = 'open' | 'tipping' | 'tipped' | 'ff' | 'paying' | 'paid' | 'missing' | 'released';
type StatusKey = 'held' | 'tipped' | 'paying' | 'paid' | 'sent' | 'missing' | 'released';
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6, done: 2.6 }, MISS: { release: .12, msg: 2.05, done: 3.1, wave: .9 }, R: { tip: .7, payout: .7, miss: 1.3 } };
const log = new AgentLog($('#log'));
let payout: PayoutStrip | null = null;
let demo: SavedDemo | null = null;
const judgeMsg = (text: string) => { $('[data-judge-msg]').textContent = text; };
const failed = (e: unknown) => judgeMsg(e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.');
const TAG = { paid: 'Paid', pending: 'Sent', failed: 'Didn’t go through', none: 'Nothing to pay', planned: 'Planned' } as const;

class ShowCtl {
  key: Key; look: Look; el: HTMLElement; stage: HTMLElement; tipEl: HTMLElement; status: HTMLElement; clockEl: HTMLElement; fansSub: HTMLElement; of: HTMLElement; moneySub: HTMLElement;
  odoFans: Odo; odoHeld: Odo; odoCharged: Odo; bAdd: HTMLButtonElement; bFF: HTMLButtonElement;
  ph: Placeholder | null = null; cues = new Cues(); view: SignView | null = null;
  show: PublicShow | null = null; parties: ManageParty[] = []; openProposals = 0; clock: ShowClock | null = null; queue: AgentLogDto[] = []; lastSeq = 0; viewVersion: string | null = null;
  phase: CtlPhase = 'open'; tipped = false; fans = 0; remain = 0; busy = false; requesting = false; ffRaf = 0;
  constructor(key: Key) {
    this.key = key; this.look = LOOK[key]; const el = this.el = $('#show-' + key);
    this.stage = $('[data-stage]', el); this.tipEl = $('[data-tip]', el); this.status = $('[data-status]', el); Ticker.lamp(this.status);
    this.clockEl = $('[data-clock]', el); this.fansSub = $('[data-fans-sub]', el); this.of = $('[data-of]', el); this.moneySub = $('[data-money-sub]', el);
    this.odoFans = new Odo($('[data-fans]', el)); this.odoHeld = new Odo($('[data-held]', el)); this.odoCharged = new Odo($('[data-charged]', el));
    this.bAdd = $<HTMLButtonElement>('[data-act=add]', el); this.bFF = $<HTMLButtonElement>('[data-act=ff]', el);
    this.bAdd.addEventListener('click', () => { void this.addClicked(); });
    this.bFF.addEventListener('click', () => { void this.ffClicked(); });
    $('[data-act=reset]', el).addEventListener('click', () => { void resetDemo(); });
  }
  get name() { return this.show?.showName ?? ''; }
  get target() { return this.show?.threshold ?? 1; }
  get cents() { return this.show?.ticketPriceCents ?? 0; }
  get confirmed() { return payoutsConfirmed(this.parties); }
  visual(): { phase: Phase; fans: number } { const p = this.phase; return { phase: p === 'paying' || p === 'paid' ? 'paid' : p === 'missing' || p === 'released' ? 'released' : this.tipped ? 'tipped' : 'held', fans: this.fans }; }
  splitOf(fans: number): number[] { return this.show ? planSplit(this.show.split, fans * this.cents).map(c => c / 100) : []; }
  payees(): Payee[] { const a = this.splitOf(Math.max(this.fans, this.target)); return (this.show?.split ?? []).map((p, i) => ({ label: ROLE_WORD[p.role], amount: a[i] })); }
  paidAmounts(): number[] { const ps = this.parties; return ps.length && ps.every(p => p.payoutCents !== null) ? ps.map(p => (p.payoutCents ?? 0) / 100) : this.splitOf(this.fans); }
  model(): SignModel { return { name: this.name, crest: this.look.crest, target: this.target, seed: this.look.seed, yaw: this.look.yaw, payees: this.payees() }; }
  attach(host: SignHost) {
    this.view = host.add(this.stage, this.model(), { state: () => this.visual(), tipEl: this.tipEl, ph: $('[data-ph]', this.el), tip: slot => this.tipText(slot) });
  }
  tipText(slot: number): string | null { if (slot >= Math.min(this.fans, this.target)) return null; const v = this.visual().phase; return `Fan ${pad2(slot + 1)} · ${dollars(this.cents)} ${v === 'held' ? 'on hold' : v === 'released' ? 'hold cancelled' : 'charged'}`; }

  /** A new copy of the show (first load or Start over): texts from data, then the current state at once. */
  load(s: PublicShow) {
    this.cues.clear(); cancelAnimationFrame(this.ffRaf);
    this.show = s; this.parties = []; this.openProposals = 0; this.queue = []; this.lastSeq = 0; this.viewVersion = null; this.clock = new ShowClock(s.now); this.busy = false; this.requesting = false;
    $('.row-top .eyebrow', this.el).textContent = `${this.look.label} · ${dayLabel(s.showDate)}`;
    $('.title', this.el).textContent = s.showName;
    $('.stat.clock dt', this.el).textContent = `Deadline · ${when(Date.parse(s.deadline), s.timeZone, 'long')}`;
    const [spot, rules] = Array.from(this.el.querySelectorAll<HTMLElement>('.rules-line > span'));
    const b = document.createElement('b'); b.textContent = dollars(s.ticketPriceCents); spot.textContent = ''; spot.append(b, ' a spot');
    rules.textContent = rulesLine(s.split);
    if (this.ph) this.ph.setModel({ name: s.showName, target: s.threshold }); else this.ph = new Placeholder($('[data-ph]', this.el), { name: s.showName, target: s.threshold });
    if (this.key === 'a') {
      payout ??= new PayoutStrip($('#payout'), s.split.map(p => ({ label: ROLE_WORD[p.role], who: p.label })));
      $('#payout .section-title').textContent = `Payout · ${s.showName}`;
    }
    this.jumpTo(s);
    if (this.view) { this.view.setModel(this.model()); this.view.setPayouts(this.payees()); this.view.reset(); }
  }
  jumpTo(s: PublicShow) {
    const end = endOf(s.state);
    this.fans = s.fans.committed; this.tipped = end === 'tipped' || end === 'paid' || end === 'cancelled';
    this.phase = end === 'live' ? 'open' : end === 'tipped' ? 'tipped' : end === 'paid' ? 'paid' : 'released';
    this.remain = remainSec(s.deadline, this.clock);
    this.renderMoney(true); this.odoFans.set(this.fans, true);
    const over = this.phase === 'paid' || this.phase === 'released';
    this.clockEl.classList.toggle('zero', over);
    this.moneySub.textContent = this.phase === 'paid' ? 'Paid out in one PayPal batch.' : this.phase === 'released' ? `${usd(this.fans * this.cents / 100)} released back to ${this.fans} fans · nobody paid` : this.tipped ? `Charged the moment it tipped · ${this.fans} × ${dollars(this.cents)}` : 'Nobody pays unless it happens.';
    this.setStatus(this.phase === 'open' ? 'held' : this.phase === 'tipped' ? 'tipped' : this.phase === 'paid' ? (this.confirmed ? 'paid' : 'sent') : 'released', true);
    this.renderClock(); this.renderFans(); this.buttons(); this.ph?.update(this.visual().phase, this.fans); this.label();
    if (this.key === 'a' && payout) payout.reset();
  }
  setStatus(k: StatusKey, instant?: boolean) {
    const roles = andList((this.show?.split ?? []).map(p => ROLE_WORD[p.role].toLowerCase()));
    const S: Record<StatusKey, [string, string, string]> = { held: ['held', 'Waiting for fans', '· $0 charged'], tipped: ['tipped', 'It’s on!', '· everyone’s charged'], paying: ['paying', 'Paying everyone', '· one PayPal payout'], paid: ['paid', 'Everyone’s paid', `· ${roles}`], sent: ['paid', 'Payouts sent', '· waiting for PayPal to confirm'], missing: ['missing', 'Deadline passed', '· cancelling every hold'], released: ['released', 'Called off', '· nobody paid'] };
    const [s, w, said] = S[k]; setStatus(this.status, s, w, said, instant);
  }
  renderMoney(instant?: boolean) { const total = this.fans * this.cents / 100; this.odoHeld.set(this.tipped || this.phase === 'released' || this.phase === 'missing' ? 0 : total, instant); this.odoCharged.set(this.tipped ? total : 0, instant); }
  renderClock() { this.clockEl.innerHTML = countdownHTML(this.remain); }
  renderFans() {
    const { fans, target } = this, p = this.phase;
    this.of.textContent = fans <= target ? `of ${target} fans` : `fans · target was ${target}`;
    this.fansSub.textContent = p === 'paid' || p === 'paying' ? (p === 'paid' && !this.confirmed ? 'Payouts sent' : 'Everyone’s paid')
      : p === 'released' || p === 'missing' ? `Called off · ${target - fans} short`
      : this.tipped ? (fans > target ? `It’s on! · ${fans - target} joined after it tipped` : 'It’s on! Everyone’s charged')
      : `${target - fans} more to make it happen`;
  }
  buttons() {
    const open = this.phase === 'open' || this.phase === 'tipped', canAdd = open && !this.busy, left = this.target - this.fans;
    this.bAdd.disabled = !canAdd || this.requesting; this.bAdd.textContent = !canAdd && !this.busy || this.tipped || left >= 5 || left <= 0 ? 'Add 5 fans' : `Add ${left} fan${left === 1 ? '' : 's'}`;
    this.bFF.disabled = !open || this.busy || this.requesting;
  }
  label() {
    const v = this.visual(), t = this.target;
    const txt = v.phase === 'paid' ? 'fully lit, with payout signs hanging below: everyone has been paid'
      : v.phase === 'tipped' ? `fully lit: the show reached ${t} fans and everyone was charged`
      : v.phase === 'released' ? 'dark: the show was called off, every hold was cancelled, the board reads CALLED OFF, $0 CHARGED'
      : `${this.fans} of ${t} border bulbs screwed in and glowing dimly: fans on hold, nobody charged`;
    this.stage.setAttribute('aria-label', `Marquee sign for ${this.name}, ${txt}.`);
  }

  /* ---- data in ---- */
  apply(s: PublicShow) { if (!this.show || s.showId !== this.show.showId) return; this.show = s; this.clock?.sync(s.now); this.buttons(); this.step(); }
  takeView(v: ManageView, instant = false) {
    this.parties = v.parties; this.openProposals = v.proposals.filter(p => !p.approved).length;
    for (const e of [...v.log].reverse()) if (e.seq > this.lastSeq) { this.queue.push(e); this.lastSeq = e.seq; }
    if (instant) this.flush(null, true); else this.step();
  }
  flush(rule: RuleId | null, instant = false) {
    let upto = -1; this.queue.forEach((e, i) => { if (rule === null || e.rule === rule) upto = i; });
    const tz = this.show?.timeZone ?? 'UTC';
    for (const e of this.queue.splice(0, upto + 1)) log.addSegs({ time: when(e.at, tz, 'log'), segs: emphasis(e.did), fine: fineLine(e), tag: this.key, instant });
  }
  /** One step toward the latest data, with the reference's beats; each beat calls step() again when it ends. */
  step() {
    const s = this.show; if (!s || this.busy || this.phase === 'ff' || this.phase === 'paying' || this.phase === 'missing' || this.phase === 'tipping') return;
    const want = s.fans.committed, end = endOf(s.state), goesOn = end === 'tipped' || end === 'paid' || end === 'cancelled';
    if (this.phase === 'open' && !this.tipped) {
      const cap = goesOn ? Math.min(want, this.target) : want;
      if (cap > this.fans) return this.addFans(cap - this.fans);
      if (goesOn) return this.runTip();
      if (end === 'missed') return this.fastForward();
    } else if (this.phase === 'tipped') {
      if (want > this.fans) return this.addAfterTip(want - this.fans);
      if (end === 'paid' || end === 'cancelled') return this.fastForward();
    }
    this.flush(null);
  }
  tipsNext() { const e = this.show ? endOf(this.show.state) : 'live'; return (e === 'tipped' || e === 'paid' || e === 'cancelled') && this.fans >= this.target; }

  /* ---- beats (timings from reference/v2/README.md) ---- */
  addFans(n: number) {
    this.busy = true; this.buttons();
    const f0 = this.fans, step = REDUCED ? .06 : .24, land = REDUCED ? 0 : .38;
    if (this.view) this.view.play('pledge', { f0, f1: f0 + n });
    for (let k = 0; k < n; k++) this.cues.at(k * step + land, () => { this.fans++; this.odoFans.set(this.fans); this.renderMoney(); this.renderFans(); this.ph?.update('held', this.fans); Snd.screw(k); });
    const total = (n - 1) * step + land + (REDUCED ? .05 : .2);
    this.cues.at(total, () => {
      this.flush('rule-1-hold-only');
      this.busy = false; this.label();
      if (!this.tipsNext()) { this.setStatus('held'); this.buttons(); }
      this.step();
    });
  }
  addAfterTip(n: number) {
    this.busy = true; this.buttons();
    const step = REDUCED ? .05 : .3;
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'bonus', REDUCED ? { to: 'tipped' } : { count: n });
    for (let k = 0; k < n; k++) this.cues.at(k * step + .1, () => { this.fans++; this.odoFans.set(this.fans); this.renderMoney(); this.renderFans(); Snd.screw(k); });
    this.cues.at((n - 1) * step + .7, () => {
      this.flush('rule-2-capture-at-tip');
      this.busy = false; this.buttons(); this.label(); if (this.view) this.view.setPayouts(this.payees());
      this.step();
    });
  }
  runTip() {
    const C = REDUCED ? { flare: .05, done: T.R.tip } : T.TIP;
    this.phase = 'tipping'; this.busy = true; this.buttons();
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
    if (!REDUCED) { Snd.chase(this.target, T.TIP.flare); this.cues.at(T.TIP.pop, () => Snd.sparks()); this.cues.at(T.TIP.itson, () => Snd.chord()); }
    this.cues.at(C.flare, () => {
      Snd.flare(); this.tipped = true; this.setStatus('tipped'); this.renderFans(); this.renderMoney();
      this.moneySub.textContent = `Charged the moment it tipped · ${this.fans} × ${dollars(this.cents)}`;
      this.ph?.update('tipped', this.fans); this.label();
      this.flush('rule-2-capture-at-tip');
    });
    this.cues.at(C.done, () => { this.phase = 'tipped'; this.busy = false; this.buttons(); this.step(); });
  }
  fastForward() {
    // Like the reference, the countdown run doesn't set busy (the button labels depend on it); step() waits on the phase instead.
    const wasTipped = this.tipped; this.phase = 'ff'; this.buttons();
    const from = this.remain, dur = REDUCED ? .2 : 1.15, t0 = performance.now();
    if (this.view) this.view.tension(true);
    const tick = (now: number) => {
      const k = clamp((now - t0) / 1000 / dur), e = k * k * (2.2 - 1.2 * k);
      this.remain = Math.round(from * (1 - e)); this.renderClock();
      if (k < 1) { this.ffRaf = requestAnimationFrame(tick); return; }
      this.clockEl.classList.add('zero'); if (this.view) this.view.tension(false);
      if (wasTipped && this.show && endOf(this.show.state) === 'paid') this.runPayout(); else this.runMiss();
    };
    this.ffRaf = requestAnimationFrame(tick);
  }
  runPayout() {
    const C = REDUCED ? { paid: .3, done: T.R.payout } : T.PAYOUT, amts = this.paidAmounts(), split = this.show?.split ?? [];
    this.phase = 'paying'; this.setStatus('paying'); this.buttons();
    if (this.view) { this.view.setPayouts(this.payees()); this.view.play(REDUCED ? 'reduced' : 'payout', REDUCED ? { to: 'paid' } : {}); }
    if (!REDUCED) Snd.drop();
    this.cues.at(C.paid, () => {
      Snd.paid(); this.phase = 'paid'; this.setStatus(this.confirmed ? 'paid' : 'sent'); this.renderFans(); this.label(); this.ph?.update('paid', this.fans);
      this.moneySub.textContent = this.confirmed ? 'Paid out in one PayPal batch.' : 'Sent in one PayPal batch. PayPal is confirming it.';
      if (this.key === 'a' && payout) payout.fill(amts, this.cues, `One PayPal payout, in money-rule order: ${split.map((p, i) => `${p.label} ${usd(amts[i])}`).join(' · ')}.`, this.confirmed ? undefined : this.parties.map(p => TAG[p.payoutStatus]));
      this.flush('rule-4-pay-the-split');
      this.buttons(); this.step();
    });
  }
  runMiss() {
    const C = REDUCED ? { release: .05, msg: .8 } : T.MISS, held = this.fans * this.cents / 100;
    this.phase = 'missing'; this.buttons();
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'miss', REDUCED ? { to: 'released' } : {});
    if (!REDUCED) { Snd.relays(12, T.MISS.wave); Snd.release(this.fans); }
    this.cues.at(C.release, () => {
      this.setStatus('missing'); this.renderFans(); this.renderMoney();
      this.moneySub.textContent = `${usd(held)} released back to ${this.fans} fans · nobody paid`;
      this.ph?.update('released', this.fans);
      this.flush('rule-3-void-on-miss');
    });
    this.cues.at(C.msg, () => { Snd.msg(); this.phase = 'released'; this.setStatus('released'); this.label(); this.buttons(); this.step(); });
  }

  /* ---- the controls (real API calls) ---- */
  addCount(): number { return this.tipped ? 5 : Math.max(1, Math.min(5, this.target - this.fans)); }
  async addClicked(count = this.addCount()) {
    if (!demo || !(this.phase === 'open' || this.phase === 'tipped') || this.busy || this.requesting) return;
    const d = demo; this.requesting = true; this.buttons();
    await act(async () => {
      try { const r = await api.demoFans(d.demoId, d.demoKey, { show: this.key, count }); this.requesting = false; await applyShow(this, r.show); }
      catch (e) { failed(e); }
      finally { this.requesting = false; this.buttons(); }
    });
  }
  async ffClicked() {
    if (!demo || !(this.phase === 'open' || this.phase === 'tipped') || this.requesting) return;
    const d = demo; this.requesting = true; this.buttons();
    await act(async () => {
      try { const r = await api.demoFastForward(d.demoId, d.demoKey, this.key); this.requesting = false; await Promise.all([applyShow(A, r.shows[0]), applyShow(B, r.shows[1])]); }
      catch (e) { failed(e); }
      finally { this.requesting = false; this.buttons(); }
    });
  }
}

async function pullView(c: ShowCtl, instant = false) {
  if (!demo || !c.show || c.show.version === c.viewVersion) return;
  c.viewVersion = c.show.version;
  try { c.takeView(await api.manage(c.show.showId, demo.demoKey), instant); } catch { c.viewVersion = null; }
}
async function applyShow(c: ShowCtl, s: PublicShow) { c.apply(s); await pullView(c); }

function summary() {
  const shows = [A.show, B.show].filter((s): s is PublicShow => s !== null);
  const held = shows.reduce((n, s) => n + s.fans.held, 0), charged = shows.reduce((n, s) => n + s.fans.charged, 0);
  const time = A.show && A.clock ? when(A.clock.now(), A.show.timeZone, 'log') : '';
  log.addSegs({ time, segs: emphasis(`Watching ${shows.length} shows. ${held} fans are on hold and ${charged ? `${charged} have been charged` : 'nobody has been charged'}.`), fine: `${held} PayPal authorizations open · money rule 1`, instant: true });
}
function links() {
  if (!demo || !A.show || !B.show) return;
  const set = (id: string, href: string, text: string) => { const x = $<HTMLAnchorElement>(id); x.href = href; x.textContent = text; };
  set('#pledge-a', `/s/${A.show.showId}`, `Hold a spot on ${A.show.showName}`);
  set('#manage-a', `/s/${A.show.showId}/manage#${demo.demoKey}`, `${A.show.showName}’s show page`);
  set('#manage-b', `/s/${B.show.showId}/manage#${demo.demoKey}`, `${B.show.showName}’s show page`);
}
function start(r: DemoResponse) {
  demo = { demoId: r.demoId, demoKey: r.demoKey, expiresAt: r.expiresAt }; saveDemo(store, demo);
  log.clear(); A.load(r.shows[0]); B.load(r.shows[1]); summary(); links();
}
async function resetDemo() {
  if (!demo) return; const d = demo;
  await act(async () => {
    try { start(await api.demoReset(d.demoId, d.demoKey)); await Promise.all([pullView(A, true), pullView(B, true)]); judgeMsg('A fresh pair of sample shows is ready.'); }
    catch (e) { failed(e); }
  });
}
async function checkPace() {
  if (!demo) return; const d = demo;
  await act(async () => {
    try {
      const r = await api.demoPace(d.demoId, d.demoKey);
      await Promise.all([applyShow(A, r.shows[0]), applyShow(B, r.shows[1])]);
      const behind = [A, B].filter(c => c.openProposals > 0).map(c => c.name);
      judgeMsg(behind.length ? `The agent checked the pace. ${andList(behind)} ${behind.length === 1 ? 'is' : 'are'} behind, so it asked the artist first. Open the show page to answer.` : 'The agent checked the pace. Both shows are on track, so nothing changes.');
    } catch (e) { failed(e); }
  });
}
async function boot() {
  const saved = loadDemo(store);
  await act(async () => {
    try {
      let reused = false;
      if (saved && saved.expiresAt - Date.now() > 10 * 60_000) {
        try {
          const a = await api.getShow(`${saved.demoId}a`), b = await api.getShow(`${saved.demoId}b`);
          demo = saved; log.clear(); A.load(a); B.load(b); summary(); links(); reused = true;
        } catch { reused = false; }
      }
      if (!reused) start(await api.createDemo());
      await Promise.all([pullView(A, true), pullView(B, true)]);
    } catch (e) { failed(e); }
  });
  $('[data-judge-creds]').textContent = SANDBOX_BUYER.email
    ? `To try the real PayPal checkout, log in with the sandbox buyer ${SANDBOX_BUYER.email}${SANDBOX_BUYER.password ? `, password ${SANDBOX_BUYER.password}` : ''}. It’s play money: nothing real is charged.`
    : 'To try the real PayPal checkout, log in with any PayPal sandbox personal account. It’s play money: nothing real is charged.';
  $('#judge').hidden = false;
}
async function poll() {
  if (!demo || document.hidden) return;
  for (const c of [A, B]) {
    if (!c.show) continue;
    try { const s = await api.getShow(c.show.showId); if (s.version !== c.show.version) await applyShow(c, s); }
    catch (e) { if (e instanceof ApiFailure && e.status === 404) judgeMsg('This demo copy has ended. Press Start over for a fresh one.'); }
  }
}

interface DemoHooks extends MarqueeHooks { ctls: ShowCtl[]; host: SignHost | null }
const A = new ShowCtl('a'), B = new ShowCtl('b'), ctls = [A, B];
setInterval(() => ctls.forEach(c => { if ((c.phase === 'open' || c.phase === 'tipped' || c.phase === 'tipping') && c.show) { c.remain = remainSec(c.show.deadline, c.clock); c.renderClock(); } }), 1000);
if (!PARITY) setInterval(() => { void poll(); }, 4000);
soundToggle($('#sound'));
$('#pace').addEventListener('click', () => { void checkPace(); });
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const k = e.key.toLowerCase();
  if (k === 't') { if (A.show && A.phase === 'open' && !A.tipped) void A.addClicked(Math.max(1, Math.min(20, A.show.fans.more))); e.preventDefault(); }
  else if (k === 'p') { void A.ffClicked(); e.preventDefault(); }
  else if (k === 'm') { void B.ffClicked(); e.preventDefault(); }
  else if (k === 'r') { void resetDemo(); e.preventDefault(); }
});
const hooks: DemoHooks = { page: 'demo', ctls, views: [], host: null, ready: false, get pending() { return pendingCount(); } };
if (HOOKS) window.__marquee = hooks;

await boot();
// 3D layer (optional): one shared WebGL renderer for both signs
let host: SignHost | null = null;
if (A.show && B.show) { try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { /* 3D is optional: host stays null, the flat SVG signs remain */ } }
if (host) { const h = host; ctls.forEach(c => c.attach(h)); Ticker.add(now => h.tick(now)); hooks.views = host.views; hooks.host = host; }
hooks.ready = true;
markReady();
```

- [ ] **Step 4: Run the demo specs.** `npx playwright test tests/gpu/demo.spec.ts tests/gpu/demo-flows.spec.ts tests/gpu/prod-smoke.spec.ts tests/gpu/fallbacks.spec.ts` → PASS. A text mismatch at a tip/payout/miss checkpoint usually means a log line was revealed on the wrong beat: compare `test-results/parity/demo-*-{ref,app}.txt` and check the line's `rule` in `tests/gpu/fixtures.ts` against the `flush(...)` call of that beat.

- [ ] **Step 5: Run all checks.** `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS.

- [ ] **Step 6: Commit.** `git add -A src/web index.html tests && git commit -m "feat(web): demo page on real demo copies: add fans, skip to the deadline, check pace now, start over, judge panel"` + trailer.

---

## Task 9: Cloudflare Pages build: CSP `_headers`, `_redirects`, `404.html`, and a no-hooks production check

Deploying is not part of this plan (Plan 6). This task makes `npm run build` produce a ready-to-upload `dist/`.

**Files:**
- Create: `src/web/build/pages.ts`, `404.html`, `.env.example`, `tests/web/pages-build.test.ts`, `tests/gpu/prod-csp.spec.ts`, `tests/gpu/prod-nohooks.spec.ts`
- Modify: `vite.config.ts`, `playwright.config.ts`

**Interfaces:**
- `pages.ts`: `apiOrigin(apiBase: string): string | null` (throws for a non-absolute URL), `contentSecurityPolicy(apiBase: string): string`, `headersFile(apiBase: string): string`.
- Build output: `dist/_headers` (generated from `VITE_API_BASE`), `dist/_redirects` (copied from `public/`), `dist/404.html`, the four pages.
- Test servers: port 5201 serves a build **without** `VITE_E2E_HOOKS`.

- [ ] **Step 1: Write the failing unit test.** `tests/web/pages-build.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiOrigin, contentSecurityPolicy, headersFile } from "../../src/web/build/pages";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

describe("Pages build files", () => {
  it("allows exactly PayPal's SDK hosts, Google Fonts and the API", () => {
    const csp = contentSecurityPolicy("https://api.tiptheroom.example/");
    expect(directive(csp, "script-src")).toBe("script-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://www.paypalobjects.com");
    expect(directive(csp, "frame-src")).toBe("frame-src https://www.paypal.com https://www.sandbox.paypal.com");
    expect(directive(csp, "style-src")).toContain("https://fonts.googleapis.com");
    expect(directive(csp, "font-src")).toContain("https://fonts.gstatic.com");
    expect(directive(csp, "connect-src")).toContain("https://api.tiptheroom.example");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });
  it("uses the page's own origin when no API base is set, and refuses a relative one", () => {
    expect(apiOrigin("")).toBeNull();
    expect(directive(contentSecurityPolicy(""), "connect-src")).toBe("connect-src 'self' https://www.paypal.com https://www.sandbox.paypal.com https://api-m.sandbox.paypal.com");
    expect(() => apiOrigin("/api")).toThrow(/absolute URL/);
  });
  it("writes a Pages _headers file for every path", () => {
    const lines = headersFile("").split("\n");
    expect(lines[0]).toBe("/*");
    expect(lines.slice(1).filter(Boolean).every((l) => l.startsWith("  "))).toBe(true);
    expect(lines.some((l) => l.startsWith("  Content-Security-Policy: default-src 'self'"))).toBe(true);
    expect(lines).toContain("  X-Content-Type-Options: nosniff");
  });
  it("routes share and manage links to their pages, manage first", () => {
    expect(readFileSync("public/_redirects", "utf8").trim().split("\n").map((l) => l.trim().split(/\s+/))).toEqual([
      ["/s/:id/manage", "/manage.html", "200"],
      ["/s/:id", "/pledge.html", "200"],
    ]);
  });
  it("has a plain 404 page that points to the demo and the start page", () => {
    expect(existsSync("404.html")).toBe(true);
    const html = readFileSync("404.html", "utf8");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/start"');
    expect(html).toContain("There’s nothing here");
  });
});
```

Run `npx vitest run tests/web/pages-build.test.ts` → FAIL (module not found).

- [ ] **Step 2: Create `src/web/build/pages.ts`.**

```ts
// Files Cloudflare Pages reads from dist/: the security headers (generated, because the API origin is a build setting).
const PAYPAL = ["https://www.paypal.com", "https://www.sandbox.paypal.com"];

export function apiOrigin(apiBase: string): string | null {
  if (!apiBase) return null;
  try {
    return new URL(apiBase).origin;
  } catch {
    throw new Error(`VITE_API_BASE must be an absolute URL such as https://api.example.com, got "${apiBase}"`);
  }
}

/** PayPal's SDK script and checkout frames, Google Fonts, the API. Inline styles stay allowed (the pages and AG Grid's theme use them). */
export function contentSecurityPolicy(apiBase: string): string {
  const api = apiOrigin(apiBase);
  const d: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", ...PAYPAL, "https://www.paypalobjects.com"]],
    ["style-src", ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]],
    ["font-src", ["'self'", "https://fonts.gstatic.com", "data:"]],
    ["img-src", ["'self'", "data:", "blob:", ...PAYPAL, "https://www.paypalobjects.com"]],
    ["connect-src", ["'self'", ...(api ? [api] : []), ...PAYPAL, "https://api-m.sandbox.paypal.com"]],
    ["frame-src", [...PAYPAL]],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'", ...PAYPAL]],
    ["object-src", ["'none'"]],
  ];
  return d.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function headersFile(apiBase: string): string {
  return ["/*", `  Content-Security-Policy: ${contentSecurityPolicy(apiBase)}`, "  X-Content-Type-Options: nosniff", "  Referrer-Policy: strict-origin-when-cross-origin", "  Permissions-Policy: camera=(), microphone=(), geolocation=()", ""].join("\n");
}
```

- [ ] **Step 3: Create `404.html`.**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Tip the Room · Not found</title>
<meta name="color-scheme" content="light">
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800;900&family=Doto:wght@700;900&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/src/web/shared/styles.css">
</head>
<body>
<header class="bar">
  <a class="brand" href="/">
    <span class="wordmark"><span class="bulbs" aria-hidden="true"><i></i><i></i><i></i></span>Tip the Room</span>
    <span class="tagline">Nobody's charged unless the show happens.</span>
  </a>
</header>
<main>
  <section class="live" aria-labelledby="h-404">
    <h1 class="page-title" id="h-404">There’s nothing here</h1>
    <p class="lede">This link doesn’t lead to a show. Check it with whoever sent it, or start from one of these.</p>
    <div class="actions"><a class="btn btn-red btn-big" href="/">Try the demo</a><a class="btn" href="/start">Start a show</a></div>
  </section>
</main>
</body>
</html>
```

- [ ] **Step 4: Create `.env.example`.**

```bash
# Public build-time settings for the Pages site (vite build). Never put secrets here:
# PayPal's client secret lives only in the Worker (wrangler secret / .dev.vars).
# Absolute API origin. Empty = the page's own origin (tests fake it there).
VITE_API_BASE=
# PayPal SANDBOX client id (public). Empty = no PayPal button.
VITE_PAYPAL_CLIENT_ID=
# Origin printed in share links. Empty = the page's own origin.
VITE_PUBLIC_ORIGIN=
# Sandbox buyer shown to judges on the demo page (play money only).
VITE_SANDBOX_BUYER_EMAIL=
VITE_SANDBOX_BUYER_PASSWORD=
# Test builds only: "1" lets ?e2e turn on window.__marquee test hooks. Leave empty for the real site.
VITE_E2E_HOOKS=
```

- [ ] **Step 5: Final `vite.config.ts`.** Replace the file:

```ts
import { defineConfig } from "vitest/config";
import { loadEnv, type Connect, type Plugin } from "vite";
import { resolve } from "node:path";
import { headersFile } from "./src/web/build/pages";
import { rewritePagePath } from "./src/web/build/routes";

const root = import.meta.dirname;

/** /s/:id, /s/:id/manage and /start work on the dev and preview servers exactly as on Pages. */
function pagesRoutes(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url) req.url = rewritePagePath(req.url);
    next();
  };
  return {
    name: "pages-routes",
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

/** dist/_headers with the CSP for this build's API origin. */
function pagesFiles(apiBase: string): Plugin {
  return {
    name: "pages-files",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(apiBase) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  return {
    plugins: [pagesRoutes(), pagesFiles((env.VITE_API_BASE ?? "").trim())],
    server: { hmr: false, host: "127.0.0.1" },
    optimizeDeps: { entries: ["index.html", "start.html", "pledge.html", "manage.html"] },
    build: {
      // No inline modulepreload polyfill: the CSP allows no inline scripts.
      modulePreload: { polyfill: false },
      rolldownOptions: {
        input: {
          main: resolve(root, "index.html"),
          start: resolve(root, "start.html"),
          pledge: resolve(root, "pledge.html"),
          manage: resolve(root, "manage.html"),
          notfound: resolve(root, "404.html"),
        },
        // Guarantees module-evaluation order across chunks, so gsap-global (window.gsap) runs before ui.ts's
        // module-load GSAP config. Without it the shared ui chunk can evaluate first in the production build.
        output: { strictExecutionOrder: true },
      },
    },
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: ["tests/gpu/**", "tests/e2e/**", "node_modules/**"],
      testTimeout: 30_000,
      // tests/agent/sqlite.ts uses node:sqlite, which prints an ExperimentalWarning in every worker.
      execArgv: ["--disable-warning=ExperimentalWarning"],
    },
  };
});
```

- [ ] **Step 6: A no-hooks test server.** In `playwright.config.ts` add a fourth `webServer` entry after the 5200 one:

```ts
    {
      command: "npx vite build --outDir dist-nohooks && npx vite preview --outDir dist-nohooks --port 5201 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5201/",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...TEST_ENV, VITE_E2E_HOOKS: "" },
    },
```

- [ ] **Step 7: Write the GPU specs.** `tests/gpu/prod-nohooks.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { installFakeApi } from "./fake-api";
import { PAGES } from "./pages";

const NOHOOKS = "http://127.0.0.1:5201/";

// The real site: no window.__marquee even with ?e2e, no reference-only controls, and no API call that a visitor didn't cause.
for (const p of Object.values(PAGES)) {
  test(`production build without hooks: ${p.name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const seen = await installFakeApi(page, p.api());
    await page.goto(NOHOOKS + p.prodPath.replace("e2e=parity", "e2e"));
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    expect(await page.evaluate(() => typeof (window as unknown as { __marquee?: unknown }).__marquee)).toBe("undefined");
    expect(await page.locator("[data-ref-only]").count()).toBe(0);
    expect(await page.locator("#simulate").count()).toBe(0);
    const posts = seen.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual(p.name === "demo" ? ["/api/demo"] : []);
    expect(errors).toEqual([]);
  });
}

test("the 404 page is built and plain", async ({ page }) => {
  await page.goto(`${NOHOOKS}404.html`);
  await expect(page.locator("h1")).toHaveText("There’s nothing here");
  await expect(page.locator('a[href="/start"]')).toBeVisible();
});
```

`tests/gpu/prod-csp.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { contentSecurityPolicy } from "../../src/web/build/pages";
import { installFakeApi } from "./fake-api";
import { PROD_BASE } from "./parity";
import { PAGES } from "./pages";

// vite preview doesn't send dist/_headers, so this test adds the same CSP to every page and checks nothing is refused.
for (const p of Object.values(PAGES)) {
  test(`CSP allows everything ${p.name} needs`, async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await installFakeApi(page, p.api());
    await page.route((url) => url.origin === new URL(PROD_BASE).origin && !url.pathname.startsWith("/api/"), async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": contentSecurityPolicy("") } });
    });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => { ((window as unknown as { __csp: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`); });
    });
    await page.goto(PROD_BASE + p.prodPath);
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    expect(violations).toEqual([]);
  });
}
```

- [ ] **Step 8: Run all checks.** `npx vitest run tests/web` → PASS. `npm run build` → `ls dist` shows `_headers _redirects 404.html index.html start.html pledge.html manage.html assets`; `head -3 dist/_headers` starts with `/*` and the CSP line. Then `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS. If the CSP spec reports a violation, fix the page or the policy in `pages.ts` (and its unit test) — never drop the CSP spec.

- [ ] **Step 9: Commit.** `git add -A src/web/build vite.config.ts playwright.config.ts 404.html .env.example tests && git commit -m "feat(web): Pages build: CSP _headers from the API origin, 404 page, no-hooks production check"` + trailer.

---

## Task 10: `npm run e2e:local`: the judge flow on the real Worker

One local Playwright run against `wrangler dev --local --env check` (the real Worker, real sandbox card holds for simulated fans, no AI binding) and the built pages. No PayPal popup: the judge's own pledge with the real popup is checked by hand in Plan 6. Not part of `npm run test:gpu` (it needs `.dev.vars` and takes minutes).

**Files:**
- Create: `playwright.e2e.config.ts`, `tests/e2e/judge-flow.spec.ts`
- Modify: `package.json` (script only)

**Interfaces:**
- `npm run e2e:local` → `playwright test -c playwright.e2e.config.ts`.
- Servers: Worker on `http://127.0.0.1:8788` (fresh state in `.wrangler/e2e`), production-like build (no hooks) in `dist-e2e/` on `http://127.0.0.1:5173` (an origin the `check` env already allows) with `VITE_API_BASE=http://127.0.0.1:8788`.

- [ ] **Step 1: Add the script.** In `package.json` `scripts`, after `"worker:check"`, add: `"e2e:local": "playwright test -c playwright.e2e.config.ts",`

- [ ] **Step 2: Create `playwright.e2e.config.ts`.**

```ts
// Local end-to-end judge flow: the real Worker (wrangler dev --local --env check, PayPal sandbox from .dev.vars)
// and the built pages without test hooks. Run: npm run e2e:local
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 15 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] } },
  webServer: [
    {
      command: "rm -rf .wrangler/e2e && npx wrangler dev --local --env check --ip 127.0.0.1 --port 8788 --persist-to .wrangler/e2e",
      url: "http://127.0.0.1:8788/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 5173 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5173/",
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_BASE: "http://127.0.0.1:8788", VITE_PAYPAL_CLIENT_ID: "", VITE_PUBLIC_ORIGIN: "", VITE_E2E_HOOKS: "", VITE_SANDBOX_BUYER_EMAIL: "", VITE_SANDBOX_BUYER_PASSWORD: "" },
    },
  ],
});
```

- [ ] **Step 3: Create `tests/e2e/judge-flow.spec.ts`.**

```ts
import { expect, test, type Page } from "@playwright/test";

const fans = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-fans] .sr`);
const word = (page: Page, k: "a" | "b") => page.locator(`#show-${k} [data-word]`);
const ready = (page: Page) => expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 60_000 });

test("judge flow on the real Worker: seeded holds, check pace, add fans, skip to the deadline, start over", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await ready(page);
  await expect(page.locator("#show-a .title")).toHaveText("Juniper Vale");
  await expect(page.locator("#show-b .title")).toHaveText("Marlow Finch");

  // The starting fans are real sandbox card holds, seated a few at a time by each show's alarm.
  await expect(fans(page, "a")).toHaveText("29", { timeout: 300_000 });
  await expect(fans(page, "b")).toHaveText("19", { timeout: 300_000 });
  await expect(word(page, "a")).toHaveText("Waiting for fans");

  // Check pace now: B (19 of 28 at three quarters of its window) is behind, so the agent asks the artist first.
  await page.click("#pace");
  await expect(page.locator("#log")).toContainText("Proposed:", { timeout: 60_000 });
  const showB = await context.newPage();
  await showB.goto((await page.locator("#manage-b").getAttribute("href"))!);
  await ready(showB);
  await expect(showB.locator("#ask")).toBeVisible();
  await expect(showB.locator("#ask-q b")).toContainText("?");
  await showB.close();

  // More simulated fans on B.
  await page.locator("#show-b [data-act=add]").click();
  await expect(fans(page, "b")).toHaveText("24", { timeout: 300_000 });

  // Skip to the deadline: A tops up, tips, everyone is charged and paid out; B misses and every hold is cancelled.
  await page.locator("#show-a [data-act=ff]").click();
  await expect(word(page, "b")).toHaveText("Called off", { timeout: 300_000 });
  await expect(word(page, "a")).toHaveText(/Everyone’s paid|Payouts sent/, { timeout: 600_000 });

  // A's show page: the AG Grid ledger has real sandbox ids.
  const showA = await context.newPage();
  await showA.goto((await page.locator("#manage-a").getAttribute("href"))!);
  await ready(showA);
  await expect(showA.locator("#ledger")).toContainText("Charged", { timeout: 30_000 });
  const refs = await showA.locator('#ledger .ag-cell[col-id="ref"]').allTextContents();
  expect(refs.some((r) => /^[A-Z0-9]{10,25}$/.test(r.trim()))).toBe(true);
  await showA.close();

  // Start over: a new private copy with fresh shows.
  const before = await page.evaluate(() => localStorage.getItem("ttr:demo"));
  await page.locator("#show-a [data-act=reset]").click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ttr:demo")), { timeout: 60_000 }).not.toBe(before);
  await expect(word(page, "a")).toHaveText("Waiting for fans", { timeout: 60_000 });
  await expect(word(page, "b")).toHaveText("Waiting for fans");
  expect(errors).toEqual([]);
});
```

- [ ] **Step 4: Run it.** `npm run e2e:local` → 1 passed (it takes several minutes: about 60 real sandbox holds, 36 captures, a payout batch and 19 voids). If PayPal's sandbox is slow, rerun once before debugging; never raise the per-step timeouts above the values here without telling the controller.

- [ ] **Step 5: Run all checks.** `npm run typecheck && npm run lint && npm test && npm run test:gpu` → all PASS (the e2e folder is excluded from vitest and from the GPU config).

- [ ] **Step 6: Commit.** `git add -A package.json playwright.e2e.config.ts tests/e2e && git commit -m "test(e2e): local judge flow against wrangler dev --local --env check (npm run e2e:local)"` + trailer.

---

## Self-review

**Spec coverage.** §2b (artist → fans → agent) is the Start → pledge → show page path (Tasks 4, 5, 7); judges get the demo with two shows and plain controls (Task 8). §2c copy rules: every new sentence in this plan uses "on hold / charged / cancelled, nobody paid / money rules"; PayPal words appear only in log small print (`fineLine`) and the ledger's "PayPal ref" column; status words follow Waiting for fans → It's on! → Everyone's paid / Called off, with the honest "Payouts sent" when PayPal hasn't confirmed. §2d parity: the reference is never edited; thresholds are untouched; the only allowances are the closed list in Global Constraints. §4: private per-visitor copy, sandbox buyer printed on the page, Add fans, Fast-forward, Reset, the agent trace (log with what it saw, what it did, rule number, ids) and the AG Grid settlement sheet with sort, filter and CSV. §7: vanilla TS + Vite on Pages, routes `/`, `/start`, `/s/:id`, `/s/:id/manage#key`. §9: parity runs on fixed fixtures; the local e2e covers the judge flow minus the popup (Plan 6 does the popup by hand and the deployed run).

**Placeholder scan.** Every step has complete code or an exact edit. The two places that say "if X, do Y" are verification fallbacks (AG Grid theme names, already checked against 36.2.0; older tests comparing `ProposalDto` shapes), each naming the exact file to look at.

**Type consistency.** `PublicShow.now: number`, `version: string`, `ManageView.sharePath`, `DemoResponse.expiresAt: number` match master (6b0981e). `ApiClient` method names are used identically in Tasks 4, 5, 7, 8. `ShowClock`, `remainSec`, `endOf`, `planSplit`, `fineLine`, `emphasis`, `askEmphasis`, `payoutsConfirmed`, `ROLE_WORD`, `andList` are defined once in `format.ts` (Task 2) and used with the same signatures later. `MANAGE_SCRIPTS` keys (`tipped`, `paid`, `calledOff`) match `manage.spec.ts`. `SavedDemo.expiresAt` is a number like `DemoResponse.expiresAt`.

**Risks the controller should watch.**
1. *Parity timing.* Pages start beats only after an API answer. `settle()` waits for `pendingCount()` to reach 0 in real time while the page clock stays paused, so beats start at the same frozen instant as the reference. Background polling is off in parity runs (`?e2e=parity`); the countdown re-bases only on jumps > 60 s, so a fixture's fixed `now` can't nudge it.
2. *Log text at checkpoints.* Lines are revealed on the beat named by their `rule`. If a checkpoint's text differs, the fixture line's `rule` or the beat's `flush(...)` is the place to look.
3. *Pixel budget on log emphasis.* The reference bolds/colours parts of log lines; `emphasis()` reproduces exactly those phrases (unit-tested on every reference line), so the log renders the same DOM.
4. *PayPal v6.* API shape checked against PayPal's v6 docs (script `…/web-sdk/v6/core`, `createInstance({ clientId, components: ["paypal-payments"] })`, `findEligibleMethods`, `createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })`, `<paypal-button>`, `session.start({ presentationMode: "auto" }, Promise<{ orderId }>)`). GPU tests use a stub at the same URL; the real popup is a Plan 6 manual check, together with confirming the CSP hosts against the real SDK.
5. *Rule numbering.* The server's `RULES` numbers "cancel" 3 and "pay" 4; the pages list them the other way round. The client maps ids to the page order (`PAGE_RULE`). Worth an owner decision on whether to renumber the server instead (Plan 6 copy pass).
6. *Not in scope here:* parity scenarios asserting an end phase (a Plan 2 minor; prod smoke and fallbacks already assert phases); deploy, webhook registration and real receiver accounts (Plan 6).

**Owner decisions surfaced.** (a) The sandbox buyer email/password to print for judges (`VITE_SANDBOX_BUYER_*`, set at deploy). (b) Accepting the closed list of parity allowances (data fields for sample words the API doesn't carry; the ledger section skipped in manage parity because the real AG Grid replaces the hand-made table; app-only controls hidden for parity). (c) Rule numbering (risk 5).

## Ledger "PLAN 5 NOTES" → tasks

| Ledger note | Task |
|---|---|
| pledge: remove `#simulate` with its `pledge.ts` refs | 4 (kept only as a reference-only test control; `removeRefOnly()` deletes it in production; asserted in Task 9 `prod-nohooks`) |
| pledge: clear `#pp-slot` text before the PayPal render + a "rendered" state | 4 (`mountPayPalButton`, `.pp-slot.is-rendered`; `pledge-flows.spec`) |
| pledge: use the server's authorize response for count/tipped; failure and cancel paths | 4 (`PledgeFlow`, `onHeld`; unit + GPU tests) |
| pledge: replace the `SHOW` const and static texts with data; parity on a fixed fixture | 4 (`texts()`), 3 (`pledgeApi` fixture) |
| pledge: countdown from the deadline timestamp | 2 (`ShowClock`, `remainSec`), 4 |
| pledge: hide/remove `[data-ref-only]` in production | 2 (`removeRefOnly`), 9 (`prod-nohooks`) |
| pledge: server-side validation of initials | Plan 4 already validates (`/^[A-Za-z]{1,3}$/` in the service); 4 adds `cleanInitials` |
| pledge: gate `setFans`/`state` debug hooks | 2 (`HOOKS`), 4, 9 |
| manage: demo controls wired in `render()` — remove with the markup | 7 (`render()` never touches them; hooks wire them only when present) |
| manage: a replacement driver for tipped/paid/called-off parity, never loosen | 3 (`MANAGE_SCRIPTS`, `manageApi`), 7 |
| manage: real AG Grid; rescope `.ag-theme-marquee`; GRID_THEME vs static CSS → own visual check | 6 (`ledger.ts`, `ledger.spec.ts`), 7 (manage skip) |
| manage: LedgerRow/PILL, Status pinned right, newest first, sort/filter/CSV | 6 |
| manage: escape all backend data (ledger incl. title attribute, `AgentLog.add`) | 2 (`addSegs`, safe `PayoutStrip`), 6 (grid text + DOM renderer + CSV guarding), 7 (`manage-flows` escaping test) |
| manage: `#ask` from the backend + failure path | 1 (option numbers, decline), 7 (`renderAsk`, `approveNow`, `declineNow`) |
| manage: replace SHOW/INITIALS/STAMPS/stamp()/remain/deadline strings/share URL + QR | 7 |
| manage: `splitOf` assumes 2 payees (support 2–4) | 2 (`planSplit`, `andList`), 7, 8 |
| added: `start.ts` innerHTML/attribute interpolation of typed values | 5 (`h()` builder; `start-flows` escaping test) |
| added: ref-nav on all 4 pages + relative hrefs | 2/9 (reference-only, removed in production) |
| added: `404.html` for Pages | 9 |
| added: CSP (PayPal SDK scripts + frames, Google Fonts) | 9 (`pages.ts`, `prod-csp.spec`) |
| added: text-snapshot parity for fixtures | 3 (text parity runs on the fixture data) |
| added: manage `render()` reads `el.add/el.ff` via non-null `$` | 7 |
| added: gate `__marquee` mutators behind DEV or `?e2e`; no hook triggers server calls in production | 2 (`HOOKS` needs DEV or a `VITE_E2E_HOOKS=1` test build plus `?e2e`), 9 (`prod-nohooks`: no hooks, no unprompted POSTs) |
| Plan 4: "decide whether to add a demo control" for pace proposals | **Yes**: 1 (`POST /api/demo/:id/pace`), 8 ("Check pace now") |
| Coordinator: `version` polling, show `now`, `sharePath`, `expiresAt`, 502 → new order, client-side target, text-only rendering, honest "Payouts sent" | 4, 7, 8 (polling); 2 (`ShowClock`); 7 (`sharePath`); 8 (`expiresAt`); 4 (`PledgeFlow`); 5 (`targetOf`); all page tasks; 7, 8 (`payoutsConfirmed`) |

## Requirements traceability

| # | Requirement | Where |
|---|---|---|
| 1 | Pixel + text parity locked; 39 GPU tests green every task; fixed fixtures from a fake API; never loosen | Global Constraints; 3 (fake API, fixtures, page table, `settle`, closed allowance list); every task's check step |
| 2 | Pages on the real API types; one typed client | 2 (`api.ts` imports `api-types`); 4 pledge, 5 start, 7 manage, 8 demo |
| 2a | `/start`: sentence → draft → edit → hold to sign → share link + QR; manage key shown once, kept in `localStorage`, `#fragment` form | 5 |
| 2b | `/s/:id`: real PayPal v6 button; createOrder → our API; onApprove → authorize; failure/cancel; fresh order after 502 | 4 |
| 2c | `/s/:id/manage`: marquee, proposals + approve, themed AG Grid ledger (escaped), agent log, attention lines, call-off | 6, 7 |
| 2d | `/`: two seeded campaigns from `POST /api/demo`; Add fans, Fast-forward, Check pace now, Reset; sandbox buyer shown from config | 1, 8 |
| 3 | `VITE_PAYPAL_CLIENT_ID` public only; SDK from the sandbox host only; CSP `_headers` for PayPal scripts/frames, Google Fonts, API origin | 2 (`env.ts`), 4 (`SDK_URL`), 9 (`pages.ts`, `_headers`, `prod-csp`) |
| 4 | Escape all backend and user data; hooks gated behind DEV or `?e2e`; no hook server calls in production | 2, 4–8 (escaping tests), 9 (`prod-nohooks`) |
| 5 | Plain-English copy; PayPal jargon only in the "PayPal ref" column (and log small print, spec 2c) | Global Constraints; copy in 4–8; `fineLine` |
| 6 | AG Grid Community exact version in Controller pre-steps | Pre-step 2: `ag-grid-community@36.2.0` |
| 7 | Pages build: vite output, `404.html`, `_redirects` for `/s/:id` and `/s/:id/manage`, `VITE_API_BASE`; no deploy | 3 (dev/preview rewrites), 9 |
| 8 | `npm run e2e:local`: built pages vs `wrangler dev --local --env check`; simulated fans + fast-forward + reset; no popup | 10 |
| 9 | Sonnet trailer; never push or deploy; checks `npm run typecheck && npm run lint && npm test && npm run test:gpu` | Global Constraints; each task's last two steps |
| 10 | 7–10 tasks, each reviewable alone | 10 tasks |
