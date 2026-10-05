import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, AgentLog, PayoutStrip, Placeholder, setStatus, countdownHTML, usd, clamp, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase, Payee, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";

interface SplitPart { label: string; who: string; fixed: number | null }
interface ShowCfg {
  key: string; name: string; crest: string; target: number; start: number; pledge: number; remain: number; deadline: string; yaw: number; seed: number;
  split: SplitPart[];
}
type CtlPhase = "open" | "tipping" | "tipped" | "ff" | "paying" | "paid" | "missing" | "released";
type StatusKey = "held" | "tipped" | "paying" | "paid" | "missing" | "released";

// fixed sample data · "now" is Mon Nov 16, 10:19am (2026 calendar)
const SHOWS: ShowCfg[] = [
  { key: 'a', name: 'Juniper Vale', crest: 'SPINDLE RECORDS', target: 34, start: 29, pledge: 15, remain: 200460, deadline: 'Wed 6:00pm', yaw: .2, seed: 7,
    split: [{ label: 'Room', who: 'Spindle Records', fixed: 80 }, { label: 'Opener', who: 'The Low Tides', fixed: 100 }, { label: 'Artist', who: 'Juniper Vale', fixed: null }] },
  { key: 'b', name: 'Marlow Finch', crest: 'ELM ST HOUSE SHOW', target: 28, start: 19, pledge: 12, remain: 373260, deadline: 'Fri 6:00pm', yaw: -.2, seed: 19,
    split: [{ label: 'Room', who: 'Elm St house', fixed: 60 }, { label: 'Opener', who: 'The opener', fixed: 40 }, { label: 'Artist', who: 'Marlow Finch', fixed: null }] },
];
const splitOf = (cfg: ShowCfg, fans: number): number[] => { let rest = fans * cfg.pledge; return cfg.split.map(p => { const v = p.fixed == null ? rest : Math.min(p.fixed, rest); rest -= v; return v; }); };
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6, done: 2.6 }, MISS: { release: .12, msg: 2.05, done: 3.1, wave: .9 }, R: { tip: .7, payout: .7, miss: 1.3 } };
const log = new AgentLog($('#log'));
let minute = 19; const stamp = () => `Mon 10:${pad2(++minute)}am`;
const resetLog = () => { log.clear(); minute = 19; log.add({ time: 'Mon 10:19am', html: 'Watching 2 shows. <b>48 fans are on hold</b> and <span class="w-held">nobody has been charged</span>.', fine: '48 PayPal authorizations open · money rule 1', instant: true }); };
const payout = new PayoutStrip($('#payout'), SHOWS[0].split.map(p => ({ label: p.label, who: p.who })));

const STATUS: Record<StatusKey, () => [string, string, string]> = {
  held: () => ['held', 'Waiting for fans', '· $0 charged'],
  tipped: () => ['tipped', 'It’s on!', '· everyone’s charged'],
  paying: () => ['paying', 'Paying everyone', '· one PayPal payout'],
  paid: () => ['paid', 'Everyone’s paid', '· room, opener and artist'],
  missing: () => ['missing', 'Deadline passed', '· cancelling every hold'],
  released: () => ['released', 'Called off', '· nobody paid'],
};

class ShowCtl {
  cfg: ShowCfg;
  el: HTMLElement;
  stage: HTMLElement;
  tipEl: HTMLElement;
  status: HTMLElement;
  clock: HTMLElement;
  fansSub: HTMLElement;
  of: HTMLElement;
  moneySub: HTMLElement;
  odoFans: Odo;
  odoHeld: Odo;
  odoCharged: Odo;
  bAdd: HTMLButtonElement;
  bFF: HTMLButtonElement;
  ph: Placeholder;
  cues: Cues;
  view: SignView | null;
  phase!: CtlPhase;
  tipped!: boolean;
  fans!: number;
  remain!: number;
  busy!: boolean;
  pendingFF!: boolean;
  ffRaf?: number;
  constructor(cfg: ShowCfg) {
    this.cfg = cfg; const el = this.el = $('#show-' + cfg.key);
    this.stage = $('[data-stage]', el); this.tipEl = $('[data-tip]', el); this.status = $('[data-status]', el); Ticker.lamp(this.status);
    this.clock = $('[data-clock]', el); this.fansSub = $('[data-fans-sub]', el); this.of = $('[data-of]', el); this.moneySub = $('[data-money-sub]', el);
    this.odoFans = new Odo($('[data-fans]', el)); this.odoHeld = new Odo($('[data-held]', el)); this.odoCharged = new Odo($('[data-charged]', el));
    this.bAdd = $<HTMLButtonElement>('[data-act=add]', el); this.bFF = $<HTMLButtonElement>('[data-act=ff]', el);
    this.ph = new Placeholder($('[data-ph]', el), { name: cfg.name, target: cfg.target });
    this.cues = new Cues(); this.view = null;
    this.bAdd.addEventListener('click', () => this.addFans(5));
    this.bFF.addEventListener('click', () => this.fastForward());
    $('[data-act=reset]', el).addEventListener('click', () => { this.reset(); log.clear(cfg.key); });
    this.reset(true);
  }
  visual(): { phase: Phase; fans: number } { const p = this.phase; return { phase: p === 'paying' || p === 'paid' ? 'paid' : p === 'missing' || p === 'released' ? 'released' : this.tipped ? 'tipped' : 'held', fans: this.fans }; }
  model(): SignModel { const c = this.cfg; return { name: c.name, crest: c.crest, target: c.target, seed: c.seed, yaw: c.yaw, payees: this.payees() }; }
  payees(): Payee[] { const c = this.cfg, amts = splitOf(c, Math.max(this.fans, c.target)); return c.split.map((p, i) => ({ label: p.label, amount: amts[i] })); }
  attach(host: SignHost) {
    this.view = host.add(this.stage, this.model(), { state: () => this.visual(), tipEl: this.tipEl, ph: $('[data-ph]', this.el), tip: slot => this.tipText(slot) });
  }
  tipText(slot: number): string | null { if (slot >= Math.min(this.fans, this.cfg.target)) return null; const v = this.visual().phase; return `Fan ${pad2(slot + 1)} · $${this.cfg.pledge} ${v === 'held' ? 'on hold' : v === 'released' ? 'hold cancelled' : 'charged'}`; }
  reset(first = false) {
    this.cues.clear(); cancelAnimationFrame(this.ffRaf as number);
    this.phase = 'open'; this.tipped = false; this.fans = this.cfg.start; this.remain = this.cfg.remain; this.busy = false; this.pendingFF = false;
    this.renderMoney(true); this.odoFans.set(this.fans, true); this.clock.classList.remove('zero');
    this.moneySub.textContent = 'Nobody pays unless it happens.';
    this.setStatus('held', true); this.renderClock(); this.renderFans(); this.buttons();
    this.ph.update('held', this.fans); this.label();
    if (this.cfg.key === 'a' && !first) payout.reset();
    if (this.view) { this.view.setPayouts(this.payees()); this.view.reset(); }
  }
  setStatus(k: StatusKey, instant?: boolean) { const [s, w, said] = STATUS[k](); setStatus(this.status, s, w, said, instant); }
  renderMoney(instant?: boolean) { const total = this.fans * this.cfg.pledge; this.odoHeld.set(this.tipped || this.phase === 'released' || this.phase === 'missing' ? 0 : total, instant); this.odoCharged.set(this.tipped ? total : 0, instant); }
  renderClock() { this.clock.innerHTML = countdownHTML(this.remain); }
  renderFans() {
    const { fans } = this, { target } = this.cfg, p = this.phase;
    this.of.textContent = fans <= target ? `of ${target} fans` : `fans · target was ${target}`;
    this.fansSub.textContent = p === 'paid' || p === 'paying' ? 'Everyone’s paid'
      : p === 'released' || p === 'missing' ? `Called off · ${target - fans} short`
      : this.tipped ? (fans > target ? `It’s on! · ${fans - target} joined after it tipped` : 'It’s on! Everyone’s charged')
      : `${target - fans} more to make it happen`;
  }
  buttons() {
    const canAdd = (this.phase === 'open' || this.phase === 'tipped') && !this.busy, left = this.cfg.target - this.fans;
    this.bAdd.disabled = !canAdd; this.bAdd.textContent = !canAdd && !this.busy || this.tipped || left >= 5 || left <= 0 ? 'Add 5 fans' : `Add ${left} fan${left === 1 ? '' : 's'}`;
    this.bFF.disabled = !(this.phase === 'open' || this.phase === 'tipped') || this.busy;
  }
  label() {
    const v = this.visual(), c = this.cfg;
    const txt = v.phase === 'paid' ? 'fully lit, with payout signs hanging below: everyone has been paid'
      : v.phase === 'tipped' ? `fully lit: the show reached ${c.target} fans and everyone was charged`
      : v.phase === 'released' ? 'dark: the show was called off, every hold was cancelled, the board reads CALLED OFF, $0 CHARGED'
      : `${this.fans} of ${c.target} border bulbs screwed in and glowing dimly: fans on hold, nobody charged`;
    this.stage.setAttribute('aria-label', `Marquee sign for ${c.name}, ${txt}.`);
  }
  addFans(max = 5): number {
    if (!(this.phase === 'open' || this.phase === 'tipped') || this.busy) return 0;
    const c = this.cfg;
    if (this.tipped) return this.addAfterTip(max);
    const n = Math.min(max, c.target - this.fans); if (n <= 0) return 0;
    this.busy = true; this.buttons();
    const f0 = this.fans, step = REDUCED ? .06 : .24, land = REDUCED ? 0 : .38;
    if (this.view) this.view.play('pledge', { f0, f1: f0 + n });
    for (let k = 0; k < n; k++) this.cues.at(k * step + land, () => { this.fans++; this.odoFans.set(this.fans); this.renderMoney(); this.renderFans(); this.ph.update('held', this.fans); Snd.screw(k); });
    const total = (n - 1) * step + land + (REDUCED ? .05 : .2);
    this.cues.at(total, () => {
      log.add({ time: stamp(), html: `${n} more fan${n > 1 ? 's' : ''} joined ${c.name}. PayPal is holding their ${usd(n * c.pledge)}.`, fine: `${n} PayPal authorization${n > 1 ? 's' : ''} · money rule 1`, tag: c.key });
      this.busy = false; this.label();
      if (this.fans >= c.target) this.runTip(); else { this.setStatus('held'); this.buttons(); if (this.pendingFF) { this.pendingFF = false; this.fastForward(); } }
    });
    return total;
  }
  addAfterTip(n: number): number {
    const c = this.cfg; this.busy = true; this.buttons();
    const step = REDUCED ? .05 : .3;
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'bonus', REDUCED ? { to: 'tipped' } : { count: n });
    for (let k = 0; k < n; k++) this.cues.at(k * step + .1, () => { this.fans++; this.odoFans.set(this.fans); this.renderMoney(); this.renderFans(); Snd.screw(k); });
    const total = (n - 1) * step + .7;
    this.cues.at(total, () => {
      log.add({ time: stamp(), html: `${n} more fans joined after it tipped, and were <b>charged right away</b>: ${usd(n * c.pledge)}.`, fine: `captured on approval · money rule 2`, tag: c.key });
      this.busy = false; this.buttons(); this.label(); if (this.view) this.view.setPayouts(this.payees());
      if (this.pendingFF) { this.pendingFF = false; this.fastForward(); }
    });
    return total;
  }
  runTip() {
    const c = this.cfg, C = REDUCED ? { flare: .05, done: T.R.tip } : T.TIP;
    this.phase = 'tipping'; this.busy = true; this.buttons();
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
    if (!REDUCED) { Snd.chase(c.target, T.TIP.flare); this.cues.at(T.TIP.pop, () => Snd.sparks()); this.cues.at(T.TIP.itson, () => Snd.chord()); }
    this.cues.at(C.flare, () => {
      Snd.flare(); this.tipped = true; this.setStatus('tipped'); this.renderFans(); this.renderMoney();
      this.moneySub.textContent = `Charged the moment it tipped · ${this.fans} × $${c.pledge}`;
      this.ph.update('tipped', this.fans); this.label();
      log.add({ time: stamp(), html: `<b>${c.name} reached ${this.fans} fans. It’s on!</b> Everyone was charged at once: ${usd(this.fans * c.pledge)}.`, fine: `captured ${this.fans} PayPal authorizations at tipping · money rule 2`, tag: c.key });
    });
    this.cues.at(C.done, () => { this.phase = 'tipped'; this.busy = false; this.buttons(); if (this.pendingFF) { this.pendingFF = false; this.fastForward(); } });
  }
  fastForward() {
    if (!(this.phase === 'open' || this.phase === 'tipped')) { if (this.phase === 'tipping') this.pendingFF = true; return; }
    if (this.busy) { this.pendingFF = true; return; }
    const wasTipped = this.tipped; this.phase = 'ff'; this.buttons();
    const from = this.remain, dur = REDUCED ? .2 : 1.15, t0 = performance.now();
    if (this.view) this.view.tension(true);
    const step = (now: number) => {
      const k = clamp((now - t0) / 1000 / dur), e = k * k * (2.2 - 1.2 * k);
      this.remain = Math.round(from * (1 - e)); this.renderClock();
      if (k < 1) this.ffRaf = requestAnimationFrame(step); else { this.clock.classList.add('zero'); if (this.view) this.view.tension(false); if (wasTipped) this.runPayout(); else this.runMiss(); }
    };
    this.ffRaf = requestAnimationFrame(step);
  }
  runPayout() {
    const c = this.cfg, C = REDUCED ? { paid: .3, done: T.R.payout } : T.PAYOUT, amts = splitOf(c, this.fans);
    this.phase = 'paying'; this.setStatus('paying'); this.buttons();
    if (this.view) { this.view.setPayouts(this.payees()); this.view.play(REDUCED ? 'reduced' : 'payout', REDUCED ? { to: 'paid' } : {}); }
    if (!REDUCED) Snd.drop();
    this.cues.at(C.paid, () => {
      Snd.paid(); this.phase = 'paid'; this.setStatus('paid'); this.renderFans(); this.label(); this.ph.update('paid', this.fans);
      this.moneySub.textContent = 'Paid out in one PayPal batch.';
      if (c.key === 'a') payout.fill(amts, this.cues, `One PayPal payout, in money-rule order: ${c.split.map((p, i) => `${p.who} ${usd(amts[i])}`).join(' · ')}.`);
      log.add({ time: c.deadline, html: `Deadline reached. <span class="w-paid">Paid ${c.split.map((p, i) => `${p.who} ${usd(amts[i])}`).join(', then ')}.</span>`, fine: `1 PayPal payout batch · ${amts.length} items · money rule 3`, tag: c.key });
    });
  }
  runMiss() {
    const c = this.cfg, C = REDUCED ? { release: .05, msg: .8 } : T.MISS, held = this.fans * c.pledge;
    this.phase = 'missing'; this.buttons();
    if (this.view) this.view.play(REDUCED ? 'reduced' : 'miss', REDUCED ? { to: 'released' } : {});
    if (!REDUCED) { Snd.relays(12, T.MISS.wave); Snd.release(this.fans); }
    this.cues.at(C.release, () => {
      this.setStatus('missing'); this.renderFans(); this.renderMoney();
      this.moneySub.textContent = `${usd(held)} released back to ${this.fans} fans · nobody paid`;
      this.ph.update('released', this.fans);
      log.add({ time: c.deadline, html: `${c.name} ended at ${this.fans} of ${c.target}. <span class="w-rel">Every hold was cancelled. Nobody paid.</span>`, fine: `voided ${this.fans} PayPal authorizations · money rule 4`, tag: c.key });
    });
    this.cues.at(C.msg, () => { Snd.msg(); this.phase = 'released'; this.setStatus('released'); this.label(); });
  }
  demoTip() { if (this.tipped || this.phase !== 'open' || this.busy) { this.reset(); log.clear(this.cfg.key); } this.addFans(this.cfg.target - this.fans); }
  demoPay() { if (this.phase === 'tipped' && !this.busy) this.fastForward(); else if (this.tipped || this.phase === 'tipping') this.pendingFF = true; else { this.demoTip(); this.pendingFF = true; } }
  demoMiss() { if (this.phase !== 'open' || this.busy || this.tipped) { this.reset(); log.clear(this.cfg.key); } this.fastForward(); }
}

interface DemoHooks extends MarqueeHooks { ctls: ShowCtl[]; host: SignHost | null }

resetLog();
const ctls = SHOWS.map(cfg => new ShowCtl(cfg)); const [A, B] = ctls;
setInterval(() => ctls.forEach(c => { if ((c.phase === 'open' || c.phase === 'tipped' || c.phase === 'tipping') && c.remain > 0) { c.remain--; c.renderClock(); } }), 1000);
soundToggle($('#sound'));
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target as HTMLElement | null; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const k = e.key.toLowerCase();
  if (k === 't') { A.demoTip(); e.preventDefault(); }
  else if (k === 'p') { A.demoPay(); e.preventDefault(); }
  else if (k === 'm') { B.demoMiss(); e.preventDefault(); }
  else if (k === 'r') { ctls.forEach(c => c.reset()); resetLog(); e.preventDefault(); }
});
window.__marquee = { page: 'demo', ctls, views: [], host: null, ready: false } as DemoHooks;

// 3D layer (optional): one shared WebGL renderer for both signs
let host: SignHost | null = null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { /* 3D is optional: host stays null, the flat SVG signs remain */ }
if (host) { ctls.forEach(c => c.attach(host)); Ticker.add(now => host.tick(now)); window.__marquee.views = host.views; window.__marquee.host = host; }
window.__marquee.ready = true;
