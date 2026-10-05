import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, AgentLog, PayoutStrip, Placeholder, HoldButton, setStatus, countdownHTML, drawQR, copyText, enter, usd, clamp, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";

// fixed sample: Maya's show, "now" is Mon Nov 9, 9:00am (2026 calendar)
interface PayeeDef { label: string; who: string; fixed: number | null }
const SHOW: { name: string; crest: string; target: number; start: number; pledge: number; remain: number; seed: number; yaw: number; payees: PayeeDef[] } = { name: 'Acoustic Set', crest: 'LUCKY’S CAFÉ', target: 21, start: 12, pledge: 15, remain: 291600, seed: 31, yaw: .16,
  payees: [{ label: 'Room', who: 'Lucky’s Café', fixed: 100 }, { label: 'You', who: 'You (Maya)', fixed: null }] };
const INITIALS = ['JR', 'AK', 'LM', 'TD', 'SO', 'PB', 'NV', 'CH', 'EW', 'RG', 'MI', 'BF', 'OT', 'KS', 'DL', 'HY', 'QA', 'UZ', 'WN', 'XE', 'GP', 'VC', 'IB', 'FM', 'YJ', 'ZR'];
const STAMPS = ['Nov 3 · 7:12pm', 'Nov 3 · 9:40pm', 'Nov 4 · 8:05am', 'Nov 4 · 6:31pm', 'Nov 5 · 12:17pm', 'Nov 5 · 10:02pm', 'Nov 6 · 7:48pm', 'Nov 7 · 11:26am', 'Nov 7 · 4:53pm', 'Nov 8 · 2:15pm', 'Nov 8 · 9:37pm', 'Nov 9 · 8:41am'];
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6 }, MISS: { release: .12, msg: 2.05, wave: .9 } };
const splitOf = (fans: number) => { let rest = fans * SHOW.pledge; return SHOW.payees.map(p => { const v = p.fixed == null ? rest : Math.min(p.fixed, rest); rest -= v; return v; }); };
type LedgerStatus = 'On hold' | 'Charged' | 'Paid' | 'Cancelled';
const PILL: Record<LedgerStatus, string> = { 'On hold': 'on-hold', Charged: 'charged', Paid: 'paid', Cancelled: 'cancelled' };

/* ---- ledger: static, but shaped like AG Grid rows so the real grid can be themed to match ---- */
interface LedgerRow { when: string; what: string; who: string; amount: number; ref: string; status: LedgerStatus; hold?: boolean }
interface LedgerShape { el: HTMLElement; rows: LedgerRow[]; reset(): void; add(row: LedgerRow): void; setHolds(status: LedgerStatus): void; render(fresh?: number): void }
const Ledger: LedgerShape = {
  el: $('#rows'), rows: [],
  reset() { this.rows = []; for (let i = 0; i < SHOW.start; i++) this.rows.unshift({ when: STAMPS[i], what: 'Fan held a spot', who: `Fan ${pad2(i + 1)} · ${INITIALS[i]}`, amount: SHOW.pledge, ref: `SAMPLE-AUTH-${String(i + 1).padStart(3, '0')}`, status: 'On hold', hold: true }); this.render(); },
  add(row: LedgerRow) { this.rows.unshift(row); this.render(1); },
  setHolds(status: LedgerStatus) { this.rows.forEach(r => { if (r.hold) r.status = status; }); this.render(); },
  render(fresh = 0) {
    this.el.innerHTML = this.rows.map((r, i) => `<div class="ag-row ${i % 2 ? 'ag-row-odd' : 'ag-row-even'}" role="row" row-index="${i}">
      <div class="ag-cell when" role="gridcell" col-id="when">${r.when}</div><div class="ag-cell" role="gridcell" col-id="what" title="${r.what}">${r.what}</div>
      <div class="ag-cell" role="gridcell" col-id="who">${r.who}</div><div class="ag-cell num" role="gridcell" col-id="amount">$${r.amount.toFixed(2)}</div>
      <div class="ag-cell ref" role="gridcell" col-id="ref">${r.ref}</div>
      <div class="ag-cell ag-pinned-right" role="gridcell" col-id="status"><span class="pill ${PILL[r.status]}"><i aria-hidden="true"></i>${r.status}</span></div></div>`).join('');
    for (let i = 0; i < fresh; i++) { const row = this.el.children[i]; if (row instanceof HTMLElement) enter(row, 6, 400); }
  },
};

const el = { stage: $('[data-stage]'), status: $('[data-status]'), sentence: $('[data-sentence]'), clock: $('[data-clock]'), dl: $('[data-deadline-label]'), sub: $('[data-fans-sub]'), of: $('[data-of]'), add: $<HTMLButtonElement>('[data-act=add]'), ff: $<HTMLButtonElement>('[data-act=ff]'), ask: $('#ask') };
const odoFans = new Odo($('[data-fans]')), odoHeld = new Odo($('[data-held]')), odoCharged = new Odo($('[data-charged]'));
const ph = new Placeholder($('[data-ph]'), { name: SHOW.name, target: SHOW.target });
const log = new AgentLog($('#log')), payout = new PayoutStrip($('#payout'), SHOW.payees.map(p => ({ label: p.label, who: p.who })));
const cues = new Cues(); Ticker.lamp(el.status);
interface ManageState { phase: 'open' | 'tipping' | 'tipped' | 'ff' | 'paying' | 'paid' | 'missing' | 'released'; tipped: boolean; fans: number; remain: number; deadline: string; busy: boolean; asked: boolean; ffRaf: number }
let view: SignView | null = null, st: ManageState = { phase: 'open', tipped: false, fans: SHOW.start, remain: SHOW.remain, deadline: 'Thu Nov 12, 6:00pm', busy: false, asked: true, ffRaf: 0 }, minute = 0;
const stamp = () => `Mon 9:${pad2(++minute + 10)}am`;
type StatusKey = 'held' | 'tipped' | 'paying' | 'paid' | 'missing' | 'released';
const STATUS: Record<StatusKey, [string, string, string]> = { held: ['held', 'Waiting for fans', '· $0 charged'], tipped: ['tipped', 'It’s on!', '· everyone’s charged'], paying: ['paying', 'Paying everyone', '· one PayPal payout'], paid: ['paid', 'Everyone’s paid', ''], missing: ['missing', 'Deadline passed', '· cancelling every hold'], released: ['released', 'Called off', '· nobody paid'] };
const say = (k: StatusKey, instant?: boolean) => setStatus(el.status, ...STATUS[k], instant);
const visual = (): { phase: Phase; fans: number } => ({ phase: st.phase === 'paying' || st.phase === 'paid' ? 'paid' : st.phase === 'missing' || st.phase === 'released' ? 'released' : st.tipped ? 'tipped' : 'held', fans: st.fans });
const payees = () => { const a = splitOf(Math.max(st.fans, SHOW.target)); return SHOW.payees.map((p, i) => ({ label: p.label, amount: a[i] })); };

function render(instant = false) {
  const { fans } = st, total = fans * SHOW.pledge, v = visual().phase;
  odoFans.set(fans, instant); odoHeld.set(st.tipped || v === 'released' ? 0 : total, instant); odoCharged.set(st.tipped ? total : 0, instant);
  el.of.textContent = fans <= SHOW.target ? `of ${SHOW.target} fans` : `fans · target was ${SHOW.target}`;
  el.sub.textContent = v === 'paid' ? 'Everyone’s paid' : v === 'released' ? `Called off · ${SHOW.target - fans} short` : st.tipped ? (fans > SHOW.target ? `It’s on! · ${fans - SHOW.target} joined after it tipped` : 'It’s on! Everyone’s charged') : `${SHOW.target - fans} more to make it happen`;
  const a = splitOf(fans);
  el.sentence.textContent = v === 'paid' ? `Everyone’s paid. Lucky’s Café got ${usd(a[0])} and you got ${usd(a[1])}.`
    : v === 'released' ? `Called off. Every hold was cancelled, ${usd(total)} went back to ${fans} fans, and nobody paid.`
    : st.tipped ? `It’s on! ${fans} fans were charged ${usd(total)}. Lucky’s Café and you are paid at the deadline, ${st.deadline}.`
    : `${fans} fans are on hold. ${SHOW.target - fans} more by ${st.deadline} and it’s on. Nobody has been charged.`;
  el.dl.textContent = `Deadline · ${st.deadline}`; el.clock.innerHTML = countdownHTML(st.remain);
  const open = st.phase === 'open' || st.phase === 'tipped';
  el.add.disabled = !open || st.busy; const left = SHOW.target - fans; el.add.textContent = !open || st.tipped || left >= 5 || left <= 0 ? 'Add 5 fans' : `Add ${left} fan${left === 1 ? '' : 's'}`;
  el.ff.disabled = !open || st.busy;
  el.stage.setAttribute('aria-label', `Your marquee sign: ${v === 'paid' ? 'fully lit, with payout signs hanging below' : v === 'tipped' ? 'fully lit, the show is on' : v === 'released' ? 'dark, it reads CALLED OFF, $0 CHARGED' : `${fans} of ${SHOW.target} bulbs glowing dimly, fans on hold`}.`);
  ph.update(v, fans);
}
function reset() {
  cues.clear(); cancelAnimationFrame(st.ffRaf);
  st = { phase: 'open', tipped: false, fans: SHOW.start, remain: SHOW.remain, deadline: 'Thu Nov 12, 6:00pm', busy: false, asked: true, ffRaf: 0 }; minute = 0;
  log.clear();
  log.add({ time: 'Sun 4:12pm', html: 'You signed the money rules. <b>Your show is live.</b>', fine: 'rules frozen · v1 · hash 9f2c41e7', instant: true });
  log.add({ time: 'Tue 7:12pm', html: 'Your first fan held a spot. PayPal is holding $15.', fine: '1 PayPal authorization · money rule 1', instant: true });
  log.add({ time: 'Mon 9:00am', html: '<span class="w-ask">Pace check:</span> 12 of 21 with 3 days left. I asked you about the deadline.', fine: 'projected 17 by the deadline · money rule 5 needs your OK', instant: true });
  el.ask.hidden = false; approveBtn.reset(); $('[data-approve-label]').textContent = 'Hold to approve';
  Ledger.reset(); payout.reset(); payout.plan(splitOf(SHOW.target), ['Planned', 'At least $200 · planned']);
  say('held', true); render(true);
  if (view) { view.setPayouts(payees()); view.reset(); }
}
function approve() {
  st.remain += 4 * 86400; st.deadline = 'Mon Nov 16, 6:00pm'; el.ask.hidden = true; Snd.sign();
  log.add({ time: stamp(), html: 'You approved it. <b>The new deadline is Mon Nov 16, 6pm.</b> Fans see it now.', fine: 'deadline extended once, +4 days · money rule 5 · approved by you' });
  render();
}
function decline() { el.ask.hidden = true; log.add({ time: stamp(), html: 'You said not now. I’ll check the pace again tomorrow morning.', fine: 'proposal declined · no change' }); }
function addFans(max = 5) {
  if (!(st.phase === 'open' || st.phase === 'tipped') || st.busy) return;
  const n = st.tipped ? max : Math.min(max, SHOW.target - st.fans); if (n <= 0) return;
  st.busy = true; render();
  const f0 = st.fans, step = REDUCED ? .06 : st.tipped ? .3 : .24, land = REDUCED || st.tipped ? .1 : .38, after = st.tipped;
  if (view) view.play(after ? (REDUCED ? 'reduced' : 'bonus') : 'pledge', after ? (REDUCED ? { to: 'tipped' } : { count: n }) : { f0, f1: f0 + n });
  for (let k = 0; k < n; k++) cues.at(k * step + land, () => {
    const i = st.fans; st.fans++;
    Ledger.add({ when: 'Nov 9 · ' + `9:${pad2(10 + i)}am`, what: after ? 'Fan joined and was charged' : 'Fan held a spot', who: `Fan ${pad2(i + 1)} · ${INITIALS[i % INITIALS.length]}`, amount: SHOW.pledge, ref: `SAMPLE-${after ? 'CAPT' : 'AUTH'}-${String(i + 1).padStart(3, '0')}`, status: after ? 'Charged' : 'On hold', hold: true });
    render(); Snd.screw(k);
  });
  cues.at((n - 1) * step + land + .2, () => {
    st.busy = false;
    log.add({ time: stamp(), html: after ? `${n} more fans joined after it tipped, and were <b>charged right away</b>: ${usd(n * SHOW.pledge)}.` : `${n} more fan${n > 1 ? 's' : ''} held a spot. PayPal is holding their ${usd(n * SHOW.pledge)}.`, fine: after ? 'captured on approval · money rule 2' : `${n} PayPal authorization${n > 1 ? 's' : ''} · money rule 1` });
    if (!after && st.fans >= SHOW.target) tip(); else { render(); if (view && after) view.setPayouts(payees()); }
  });
}
function tip() {
  st.phase = 'tipping'; st.busy = true; el.ask.hidden = true; render();
  if (view) view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
  if (!REDUCED) { Snd.chase(SHOW.target, T.TIP.flare); cues.at(T.TIP.pop, () => Snd.sparks()); cues.at(T.TIP.itson, () => Snd.chord()); }
  cues.at(REDUCED ? .05 : T.TIP.flare, () => {
    Snd.flare(); st.tipped = true; say('tipped'); Ledger.setHolds('Charged');
    Ledger.add({ when: 'Nov 9 · ' + stamp().slice(4), what: `Everyone charged at tipping · ${st.fans} holds`, who: 'All fans', amount: st.fans * SHOW.pledge, ref: `SAMPLE-CAPT ×${st.fans}`, status: 'Charged' });
    log.add({ time: stamp(), html: `<b>Your show reached ${st.fans} fans. It’s on!</b> Everyone was charged at once: ${usd(st.fans * SHOW.pledge)}.`, fine: `captured ${st.fans} PayPal authorizations at tipping · money rule 2` });
    render();
  });
  cues.at(REDUCED ? .7 : T.TIP.done, () => { st.phase = 'tipped'; st.busy = false; render(); if (view) view.setPayouts(payees()); });
}
function skip() {
  if (!(st.phase === 'open' || st.phase === 'tipped') || st.busy) return;
  const wasTipped = st.tipped; st.phase = 'ff'; st.busy = true; el.ask.hidden = true; render();
  const from = st.remain, dur = REDUCED ? .2 : 1.15, t0 = performance.now();
  if (view) view.tension(true);
  const step = (now: number) => {
    const k = clamp((now - t0) / 1000 / dur), e = k * k * (2.2 - 1.2 * k); st.remain = Math.round(from * (1 - e)); el.clock.innerHTML = countdownHTML(st.remain);
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- verbatim port: `wasTipped ? payOut() : miss();`
    if (k < 1) st.ffRaf = requestAnimationFrame(step); else { el.clock.classList.add('zero'); if (view) view.tension(false); wasTipped ? payOut() : miss(); }
  };
  st.ffRaf = requestAnimationFrame(step);
}
function payOut() {
  const a = splitOf(st.fans); st.phase = 'paying'; say('paying'); render(); Snd.drop();
  if (view) { view.setPayouts(payees()); view.play(REDUCED ? 'reduced' : 'payout', REDUCED ? { to: 'paid' } : {}); }
  cues.at(REDUCED ? .3 : T.PAYOUT.paid, () => {
    Snd.paid(2); st.phase = 'paid'; st.busy = false; say('paid');
    payout.fill(a, cues, `One PayPal payout, in money-rule order: Lucky’s Café ${usd(a[0])}, then you ${usd(a[1])}.`);
    SHOW.payees.forEach((p, i) => Ledger.add({ when: 'Nov 12 · 6:00pm', what: `Paid ${p.label === 'You' ? 'you' : p.who}`, who: p.who, amount: a[i], ref: `SAMPLE-PAYOUT-01 · item ${i + 1}`, status: 'Paid' }));
    log.add({ time: 'Thu 6:00pm', html: `Deadline reached. <span class="w-paid">Paid Lucky’s Café ${usd(a[0])}, then you ${usd(a[1])}.</span>`, fine: '1 PayPal payout batch · 2 items · money rule 3' });
    render();
  });
}
function miss() {
  const held = st.fans * SHOW.pledge; st.phase = 'missing'; render();
  if (view) view.play(REDUCED ? 'reduced' : 'miss', REDUCED ? { to: 'released' } : {});
  if (!REDUCED) { Snd.relays(12, T.MISS.wave); Snd.release(st.fans); }
  cues.at(REDUCED ? .05 : T.MISS.release, () => {
    say('missing'); Ledger.setHolds('Cancelled');
    Ledger.add({ when: 'Nov 12 · 6:00pm', what: `Every hold cancelled · ${st.fans} holds`, who: 'All fans', amount: held, ref: `SAMPLE-VOID ×${st.fans}`, status: 'Cancelled' });
    log.add({ time: 'Thu 6:00pm', html: `Your show ended at ${st.fans} of ${SHOW.target}. <span class="w-rel">Every hold was cancelled. Nobody paid.</span>`, fine: `voided ${st.fans} PayPal authorizations · money rule 4` });
    payout.reset(); render();
  });
  cues.at(REDUCED ? .8 : T.MISS.msg, () => { Snd.msg(); st.phase = 'released'; st.busy = false; say('released'); render(); });
}

const approveBtn = new HoldButton($<HTMLButtonElement>('#approve'), { ms: 1500, onDone: () => { $('[data-approve-label]').textContent = 'Approved'; approve(); } });
$('#decline').addEventListener('click', decline);
el.add.addEventListener('click', () => addFans(5)); el.ff.addEventListener('click', skip); $('[data-act=reset]').addEventListener('click', reset);
$('#copy').addEventListener('click', () => copyText($('#share-url').textContent ?? '', $('[data-copied]')));
drawQR($<HTMLCanvasElement>('#qr'), $('#share-url').textContent ?? '', { scale: 4, margin: 3 });
setInterval(() => { if ((st.phase === 'open' || st.phase === 'tipped' || st.phase === 'tipping') && st.remain > 0) { st.remain--; el.clock.innerHTML = countdownHTML(st.remain); } }, 1000);
soundToggle($('#sound'));
reset();

interface ManageHooks extends MarqueeHooks { readonly state: ManageState; addFans(max?: number): void; skip(): void; reset(): void; approve(): void; decline(): void; holdTo(p: number): void }
const hooks: ManageHooks = { page: 'manage', ready: false, views: [], get state() { return st; }, addFans, skip, reset, approve: () => { approveBtn.done = true; $('#approve').classList.add('is-done'); $('[data-approve-label]').textContent = 'Approved'; approve(); }, decline, holdTo: p => approveBtn.set(p) };
window.__marquee = hooks;
let host: SignHost | null = null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ }
if (host) {
  view = host.add(el.stage, { name: SHOW.name, crest: SHOW.crest, target: SHOW.target, seed: SHOW.seed, yaw: SHOW.yaw, payees: payees() },
    { state: visual, tipEl: $('[data-tip]'), ph: $('[data-ph]'), tip: slot => slot < Math.min(st.fans, SHOW.target) ? `Fan ${pad2(slot + 1)} · ${INITIALS[slot]} · $${SHOW.pledge} ${visual().phase === 'held' ? 'on hold' : visual().phase === 'released' ? 'hold cancelled' : 'charged'}` : null });
  Ticker.add(now => host.tick(now)); hooks.views = host.views; hooks.host = host;
}
hooks.ready = true;
