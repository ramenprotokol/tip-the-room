import "../shared/gsap-global";
import "../shared/styles.css";
import "../shared/boot.css";
import { IDLE_MS, watchIdle } from "../shared/idle";
import { compareVersion } from "../shared/version";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, AgentLog, PayoutStrip, Placeholder, setStatus, countdownHTML, usd, clamp, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase, Payee, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { AgentLogDto, DemoResponse, ManageParty, ManageView, PublicShow } from "../../worker/api-types";
import type { RuleId } from "../../core/rules";
import { API_BASE, HOOKS, PARITY, QUIET, SANDBOX_BUYER, judgeCode, markBooted, markReady, removeRefOnly, safeStorage } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { aiResting, andList, dayLabel, dollars, emphasis, endOf, fineLine, payoutsConfirmed, PAYOUT_TAG, payState, planSplit, remainSec, ROLE_WORD, restingLine, rulesLine, ShowClock, when } from "../shared/format";
import { loadDemo, saveDemo, type SavedDemo } from "../shared/keys";

removeRefOnly();
const idle = watchIdle();
const api = apiClient(API_BASE, undefined, { judgeCode });
const store = safeStorage();

type Key = 'a' | 'b';
interface Look { crest: string; yaw: number; seed: number; label: string }
// The two demo shows are fixed fictional seeds (src/agent/demo.ts). Their sign styling and the bill lines in index.html
// aren't in the API; everything else on the page comes from it.
const LOOK: Record<Key, Look> = { a: { crest: 'SPINDLE RECORDS', yaw: .2, seed: 7, label: 'Show A' }, b: { crest: 'ELM ST HOUSE SHOW', yaw: -.2, seed: 19, label: 'Show B' } };
type CtlPhase = 'open' | 'tipping' | 'tipped' | 'ff' | 'paying' | 'paid' | 'missing' | 'released';
type StatusKey = 'held' | 'tipped' | 'paying' | 'funds' | 'paid' | 'sent' | 'failed' | 'missing' | 'released' | 'refunding';
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6, done: 2.6 }, MISS: { release: .12, msg: 2.05, done: 3.1, wave: .9 }, R: { tip: .7, payout: .7, miss: 1.3 } };
const log = new AgentLog($('#log'));
let payout: PayoutStrip | null = null;
let demo: SavedDemo | null = null;
let inflight = false;
const judgeMsg = (text: string) => { $('[data-judge-msg]').textContent = text; };
const failed = (e: unknown) => judgeMsg(e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.');

class ShowCtl {
  key: Key; look: Look; el: HTMLElement; stage: HTMLElement; tipEl: HTMLElement; status: HTMLElement; clockEl: HTMLElement; fansSub: HTMLElement; of: HTMLElement; moneySub: HTMLElement;
  odoFans: Odo; odoHeld: Odo; odoCharged: Odo; bAdd: HTMLButtonElement; bFF: HTMLButtonElement; bReset: HTMLButtonElement;
  ph: Placeholder | null = null; cues = new Cues(); view: SignView | null = null;
  show: PublicShow | null = null; parties: ManageParty[] = []; openProposals = 0; clock: ShowClock | null = null; queue: AgentLogDto[] = []; lastSeq = 0; resting = false; viewVersion: string | null = null; viewP: Promise<void> | null = null;
  phase: CtlPhase = 'open'; tipped = false; fans = 0; remain = 0; busy = false; ffRaf = 0;
  constructor(key: Key) {
    this.key = key; this.look = LOOK[key]; const el = this.el = $('#show-' + key);
    this.stage = $('[data-stage]', el); this.tipEl = $('[data-tip]', el); this.status = $('[data-status]', el); Ticker.lamp(this.status);
    this.clockEl = $('[data-clock]', el); this.fansSub = $('[data-fans-sub]', el); this.of = $('[data-of]', el); this.moneySub = $('[data-money-sub]', el);
    this.odoFans = new Odo($('[data-fans]', el)); this.odoHeld = new Odo($('[data-held]', el)); this.odoCharged = new Odo($('[data-charged]', el));
    this.bAdd = $<HTMLButtonElement>('[data-act=add]', el); this.bFF = $<HTMLButtonElement>('[data-act=ff]', el);
    this.bAdd.addEventListener('click', () => { void this.addClicked(); });
    this.bFF.addEventListener('click', () => { void this.ffClicked(); });
    this.bReset = $<HTMLButtonElement>('[data-act=reset]', el); this.bReset.addEventListener('click', () => { void resetDemo(); });
  }
  get name() { return this.show?.showName ?? ''; }
  get target() { return this.show?.threshold ?? 1; }
  get cents() { return this.show?.ticketPriceCents ?? 0; }
  get confirmed() { return payoutsConfirmed(this.parties); }
  /** Called off after it tipped: every fan was charged, so the money is coming back (never "nobody paid"). */
  get refunded(): boolean { return !!this.show && endOf(this.show.state) === 'cancelled'; }
  refundSub(): string { return `Called off. Every fan who was charged is getting ${dollars(this.cents)} back.`; }
  /** The status line once the deadline has passed on a show that was on: paid, failed, paying (nothing sent yet) or sent (PayPal confirming). */
  get payKey(): StatusKey { return ({ confirmed: 'paid', failed: 'failed', waiting: 'sent', planned: 'paying', funds: 'funds' } as const)[payState(this.parties)]; }
  payMoneySub(): string { const s = payState(this.parties); return s === 'confirmed' ? 'Paid out in one PayPal batch.' : s === 'failed' ? 'Sent in one PayPal batch. One payout didn’t go through.' : s === 'planned' ? 'Paying everyone in one PayPal batch. Nothing has been sent yet.' : s === 'funds' ? 'Paying everyone in one PayPal batch. PayPal needs more funds first, so the agent will try again.' : 'Sent in one PayPal batch. PayPal is confirming it.'; }
  payFansSub(): string { return ({ confirmed: 'Everyone’s paid', failed: 'A payout didn’t go through', planned: 'Paying everyone', funds: 'Paying everyone · waiting on PayPal', waiting: 'Payouts sent' } as const)[payState(this.parties)]; }
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
    this.show = s; this.parties = []; this.openProposals = 0; this.queue = []; this.lastSeq = 0; this.viewVersion = null; this.clock = new ShowClock(s.now); this.busy = false;
    this.texts(s);
    if (this.ph) this.ph.setModel({ name: s.showName, target: s.threshold }); else this.ph = new Placeholder($('[data-ph]', this.el), { name: s.showName, target: s.threshold });
    if (this.key === 'a') payout ??= new PayoutStrip($('#payout'), s.split.map(p => ({ label: ROLE_WORD[p.role], who: p.label })));
    this.jumpTo(s);
    if (this.view) { this.view.setModel(this.model()); this.view.setPayouts(this.payees()); this.view.reset(); }
  }
  /** Every sentence that comes from the show's own facts (name, day, deadline, price, split). */
  texts(s: PublicShow) {
    $('.row-top .eyebrow', this.el).textContent = `${this.look.label} · ${dayLabel(s.showDate)}`;
    $('.title', this.el).textContent = s.showName;
    $('.stat.clock dt', this.el).textContent = `Deadline · ${when(Date.parse(s.deadline), s.timeZone, 'long')}`;
    const [spot, rules] = Array.from(this.el.querySelectorAll<HTMLElement>('.rules-line > span'));
    const b = document.createElement('b'); b.textContent = dollars(s.ticketPriceCents); spot.textContent = ''; spot.append(b, ' a spot');
    rules.textContent = rulesLine(s.split);
    if (this.key === 'a') $('#payout .section-title').textContent = `Payout · ${s.showName}`;
  }
  jumpTo(s: PublicShow) {
    const end = endOf(s.state);
    this.fans = s.fans.committed; this.tipped = end === 'tipped' || end === 'paid' || end === 'cancelled';
    this.phase = end === 'live' ? 'open' : end === 'tipped' ? 'tipped' : end === 'paid' ? 'paid' : 'released';
    this.remain = remainSec(s.deadline, this.clock);
    this.renderMoney(true); this.odoFans.set(this.fans, true);
    const over = this.phase === 'paid' || this.phase === 'released';
    this.clockEl.classList.toggle('zero', over);
    this.moneySub.textContent = this.phase === 'paid' ? this.payMoneySub() : this.phase === 'released' ? (this.refunded ? this.refundSub() : `${usd(this.fans * this.cents / 100)} released back to ${this.fans} fans · nobody paid`) : this.tipped ? `Charged the moment it tipped · ${this.fans} × ${dollars(this.cents)}` : 'Nobody pays unless it happens.';
    this.setStatus(this.phase === 'open' ? 'held' : this.phase === 'tipped' ? 'tipped' : this.phase === 'paid' ? this.payKey : this.refunded ? 'refunding' : 'released', true);
    this.renderClock(); this.renderFans(); this.buttons(); this.ph?.update(this.visual().phase, this.fans); this.label();
    if (this.key === 'a' && payout) payout.reset();
  }
  setStatus(k: StatusKey, instant?: boolean) {
    const roles = andList((this.show?.split ?? []).map(p => ROLE_WORD[p.role].toLowerCase()));
    const S: Record<StatusKey, [string, string, string]> = { held: ['held', 'Waiting for fans', '· $0 charged'], tipped: ['tipped', 'It’s on!', '· everyone’s charged'], paying: ['paying', 'Paying everyone', '· one PayPal payout'], funds: ['paying', 'Paying everyone', '· waiting on PayPal'], paid: ['paid', 'Everyone’s paid', `· ${roles}`], sent: ['paid', 'Payouts sent', '· waiting for PayPal to confirm'], failed: ['missing', 'A payout didn’t go through', '· needs a look'], missing: ['missing', 'Deadline passed', '· cancelling every hold'], released: ['released', 'Called off', '· nobody paid'], refunding: ['released', 'Called off', '· refunding everyone'] };
    const [s, w, said] = S[k]; setStatus(this.status, s, w, said, instant);
  }
  renderMoney(instant?: boolean) { const total = this.fans * this.cents / 100; this.odoHeld.set(this.tipped || this.phase === 'released' || this.phase === 'missing' ? 0 : total, instant); this.odoCharged.set(this.tipped ? total : 0, instant); }
  renderClock() { this.clockEl.innerHTML = countdownHTML(this.remain); }
  renderFans() {
    const { fans, target } = this, p = this.phase;
    this.of.textContent = fans <= target ? `of ${target} fans` : `fans · target was ${target}`;
    this.fansSub.textContent = p === 'paid' || p === 'paying' ? (p === 'paid' ? this.payFansSub() : 'Everyone’s paid')
      : p === 'released' || p === 'missing' ? (this.refunded ? 'Called off · refunding' : `Called off · ${target - fans} short`)
      : this.tipped ? (fans > target ? `It’s on! · ${fans - target} joined after it tipped` : 'It’s on! Everyone’s charged')
      : `${target - fans} more to make it happen`;
  }
  buttons() {
    const open = this.phase === 'open' || this.phase === 'tipped', canAdd = open && !this.busy, left = this.target - this.fans;
    this.bAdd.disabled = !canAdd || inflight; this.bAdd.textContent = !open || this.tipped || left >= 5 || left <= 0 ? 'Add 5 fans' : `Add ${left} fan${left === 1 ? '' : 's'}`;
    this.bFF.disabled = !open || this.busy || inflight;
    this.bReset.disabled = inflight;
  }
  label() {
    const v = this.visual(), t = this.target;
    const txt = v.phase === 'paid' ? 'fully lit, with payout signs hanging below: everyone has been paid'
      : v.phase === 'tipped' ? `fully lit: the show reached ${t} fans and everyone was charged`
      : v.phase === 'released' ? (this.refunded ? 'dark: the show was called off and every fan who was charged is being refunded' : 'dark: the show was called off, every hold was cancelled, the board reads CALLED OFF, $0 CHARGED')
      : `${this.fans} of ${t} border bulbs screwed in and glowing dimly: fans on hold, nobody charged`;
    this.stage.setAttribute('aria-label', `Marquee sign for ${this.name}, ${txt}.`);
  }

  /* ---- data in ---- */
  apply(s: PublicShow) {
    if (!this.show || s.showId !== this.show.showId) return;
    const prev = this.show; this.show = s; this.clock?.sync(s.now);
    // The artist changed the target or the deadline from the show page: refresh the words, the sign and the 3D view.
    if (prev.threshold !== s.threshold || prev.deadline !== s.deadline || prev.ticketPriceCents !== s.ticketPriceCents) {
      this.texts(s); this.ph?.setModel({ name: s.showName, target: s.threshold });
      if (this.view) { this.view.setModel(this.model()); this.view.setPayouts(this.payees()); }
      this.remain = remainSec(s.deadline, this.clock); this.renderClock(); this.renderFans(); this.renderMoney(true); this.label();
    }
    this.buttons(); this.step();
  }
  takeView(v: ManageView, instant = false) {
    this.resting = aiResting(v.log); showResting();
    this.parties = v.parties; this.openProposals = v.proposals.filter(p => !p.approved).length;
    for (const e of [...v.log].reverse()) if (e.seq > this.lastSeq) { this.queue.push(e); this.lastSeq = e.seq; }
    if (this.phase === 'paid') { this.setStatus(this.payKey, true); this.renderFans(); this.moneySub.textContent = this.payMoneySub(); }
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
      if (end === 'cancelled') return this.runCallOff();
      if (end === 'paid') return this.fastForward();
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
      Snd.paid(); this.phase = 'paid'; this.setStatus(this.payKey); this.renderFans(); this.label(); this.ph?.update('paid', this.fans);
      this.moneySub.textContent = this.payMoneySub();
      if (this.key === 'a' && payout) payout.fill(amts, this.cues, `One PayPal payout, in money-rule order: ${split.map((p, i) => `${p.label} ${usd(amts[i])}`).join(' · ')}.`, this.confirmed ? undefined : this.parties.map(p => PAYOUT_TAG[p.payoutStatus]));
      this.flush('rule-4-pay-the-split');
      this.buttons(); this.step();
    });
  }
  /** Called off after the tip: no countdown spin and no miss animation, the sign just goes dark and the refund is named. */
  runCallOff() {
    this.phase = 'released'; this.setStatus('refunding');
    this.renderFans(); this.renderMoney(); this.moneySub.textContent = this.refundSub();
    this.view?.reset(); this.ph?.update('released', this.fans); this.label();
    this.flush(null); this.buttons();
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

  /* ---- the controls (real API calls, one at a time across the whole page) ---- */
  addCount(): number { return this.tipped ? 5 : Math.max(1, Math.min(5, this.target - this.fans)); }
  async addClicked(count = this.addCount()) {
    if (!demo || !(this.phase === 'open' || this.phase === 'tipped') || this.busy) return;
    const d = demo;
    await solo(async () => { const r = await api.demoFans(d.demoId, d.demoKey, { show: this.key, count }); await applyShow(this, r.show); });
  }
  async ffClicked() {
    if (!demo || !(this.phase === 'open' || this.phase === 'tipped') || this.busy) return;
    const d = demo;
    await solo(async () => { const r = await api.demoFastForward(d.demoId, d.demoKey, this.key); await Promise.all([applyShow(A, r.shows[0]), applyShow(B, r.shows[1])]); });
  }
}

/** Every demo button (both shows, Start over, Check pace now) runs one at a time; the rest stay disabled until it ends. Errors show as a plain line. */
async function solo(fn: () => Promise<void>) {
  if (inflight) return;
  inflight = true; lock();
  try { await act(fn); }
  catch (e) { failed(e); }
  finally { inflight = false; lock(); }
}
function lock() { ctls.forEach(c => c.buttons()); $<HTMLButtonElement>('#pace').disabled = inflight; }

function showResting() { const p = $('#resting'); p.hidden = PARITY || !ctls.some(c => c.resting); p.textContent = p.hidden ? '' : restingLine(Date.now(), ctls.find(c => c.resting)?.show?.timeZone); }
function pullView(c: ShowCtl, instant = false): Promise<void> {
  if (!demo || !c.show) return Promise.resolve();
  if (c.show.version === c.viewVersion) return c.viewP ?? Promise.resolve();
  const k = demo.demoKey, id = c.show.showId, v = c.show.version;
  c.viewVersion = v;
  const p = (async () => {
    try { c.takeView(await api.manage(id, k), instant); } catch { if (c.viewVersion === v) c.viewVersion = null; }
  })();
  c.viewP = p; void p.then(() => { if (c.viewP === p) c.viewP = null; });
  return p;
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
  set('#pledge-a', `/s/${encodeURIComponent(A.show.showId)}`, `Hold a spot on ${A.show.showName}`);
  set('#manage-a', `/s/${encodeURIComponent(A.show.showId)}/manage#${demo.demoKey}`, `${A.show.showName}’s show page`);
  set('#manage-b', `/s/${encodeURIComponent(B.show.showId)}/manage#${demo.demoKey}`, `${B.show.showName}’s show page`);
}
function start(r: DemoResponse) {
  lastChangeAt = Date.now();
  demo = { demoId: r.demoId, demoKey: r.demoKey, expiresAt: r.expiresAt }; saveDemo(store, demo);
  log.clear(); A.load(r.shows[0]); B.load(r.shows[1]); summary(); links();
}
/** Throws away the saved copy and starts a new one (first load, Start over, or when the server no longer knows the old one). */
async function begin(r: DemoResponse) { start(r); judgeMsg('The starting fans are real PayPal sandbox holds. The agent seats them a few at a time, so filling the signs can take a few minutes.'); await Promise.all([pullView(A, true), pullView(B, true)]); }
async function freshCopy(msg: string) { await begin(await api.createDemo()); judgeMsg(msg); }
async function resetDemo() {
  const d = demo; if (!d) return;
  await solo(async () => {
    try { await begin(await api.demoReset(d.demoId, d.demoKey)); judgeMsg('A fresh pair of sample shows is ready.'); }
    catch (e) { if (e instanceof ApiFailure && (e.status === 404 || e.status === 403)) { await freshCopy('That demo copy had ended, so here is a fresh pair of sample shows.'); return; } throw e; }
  });
}
async function checkPace() {
  const d = demo; if (!d) return;
  if (![A, B].some(c => c.show?.state === 'live')) { judgeMsg('Neither show is still waiting for fans, so there’s no pace to check. Press Start over for a fresh pair.'); return; }
  await solo(async () => {
    const r = await api.demoPace(d.demoId, d.demoKey);
    await Promise.all([applyShow(A, r.shows[0]), applyShow(B, r.shows[1])]);
    const behind = [A, B].filter(c => c.openProposals > 0).map(c => c.name);
    judgeMsg(behind.length ? `The agent checked the pace. ${andList(behind)} ${behind.length === 1 ? 'is' : 'are'} behind, so it asked the artist first. Open the show page to answer.` : 'The agent checked the pace. Both shows are on track, so nothing changes.');
  });
}
async function boot() {
  const saved = loadDemo(store);
  await act(async () => {
    try {
      // A saved copy is reused only while it has more than 10 minutes left and the server still knows both shows.
      let reused = false;
      if (saved && saved.expiresAt - Date.now() > 10 * 60_000) {
        try {
          const a = await api.getShow(`${saved.demoId}a`), b = await api.getShow(`${saved.demoId}b`);
          demo = saved; log.clear(); A.load(a); B.load(b); summary(); links(); reused = true;
          await Promise.all([pullView(A, true), pullView(B, true)]);
        } catch (e) { if (!(e instanceof ApiFailure && e.status === 404)) throw e; }
      }
      if (!reused) await begin(await api.createDemo());
    } catch (e) { failed(e); }
  });
  $('[data-judge-creds]').textContent = SANDBOX_BUYER.email
    ? `To try the real PayPal checkout, log in with the sandbox buyer ${SANDBOX_BUYER.email}${SANDBOX_BUYER.password ? `, password ${SANDBOX_BUYER.password}` : ''}. It’s play money: nothing real is charged.`
    : 'Sandbox buyer login coming soon';
  $('#judge').hidden = false;
}
let retryAt = 0, lastChangeAt = Date.now();
/** A passive watcher must not see the demo freeze: keep going while a copy is still seating fans or settling, and for a while after its last change. */
const settling = () => Date.now() - lastChangeAt < IDLE_MS || ctls.some(c => c.busy || c.phase === 'ff' || c.phase === 'paying' || (c.show !== null && c.fans !== c.show.fans.committed));
function pausedLine(paused: boolean) { const p = $('#paused'); p.hidden = PARITY || !paused; p.textContent = p.hidden ? '' : 'Paused · tap or move the mouse to keep watching'; }
async function poll() {
  if (!demo || document.hidden || inflight) return;
  const paused = idle.idle() && !settling();
  pausedLine(paused);
  if (paused) return;
  await act(async () => {
    for (const c of [A, B]) {
      if (!c.show) continue;
      try { const s = await api.getShow(c.show.showId); if (compareVersion(s.version, c.show.version) > 0) { lastChangeAt = Date.now(); await applyShow(c, s); } }
      catch (e) {
        if (e instanceof ApiFailure && e.status === 404) {
          // The server forgot this copy. Start a new one, but back off after a refusal (429) instead of asking again every 4 s.
          if (Date.now() < retryAt) return;
          await solo(async () => {
            try { await freshCopy('That demo copy has ended, so here is a fresh pair of sample shows.'); }
            catch (err) { retryAt = Date.now() + (err instanceof ApiFailure && err.status === 429 ? 60_000 : 30_000); throw err; }
          });
          return;
        }
      }
    }
  });
}

interface DemoHooks extends MarqueeHooks { ctls: ShowCtl[]; host: SignHost | null }
const A = new ShowCtl('a'), B = new ShowCtl('b'), ctls = [A, B];
setInterval(() => ctls.forEach(c => { if ((c.phase === 'open' || c.phase === 'tipped' || c.phase === 'tipping') && c.show) { c.remain = remainSec(c.show.deadline, c.clock); c.renderClock(); } }), 1000);
if (!QUIET) setInterval(() => { void poll(); }, 4000);
soundToggle($('#sound'));
$('#pace').addEventListener('click', () => { void checkPace(); });
// t/p/m/r are the reference's test keys: dev and test builds only. The real site has the visible buttons.
if (HOOKS) addEventListener('keydown', e => {
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

try { await boot(); } finally { markBooted(); }
// 3D layer (optional): one shared WebGL renderer for both signs
let host: SignHost | null = null;
if (A.show && B.show) { try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { /* 3D is optional: host stays null, the flat SVG signs remain */ } }
if (host) { const h = host; ctls.forEach(c => c.attach(h)); Ticker.add(now => h.tick(now)); hooks.views = host.views; hooks.host = host; }
hooks.ready = true;
markReady();
