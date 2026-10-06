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
import { dismiss, forgetKey, isDismissed, recallKey, rememberKey, showIdFromPath, takeKeyFromHash } from "../shared/keys";
import { LedgerGrid } from "../shared/ledger";

removeRefOnly();
const api = apiClient(API_BASE);
const store = safeStorage();
const showId = showIdFromPath(location.pathname, location.search);
const fragKey = takeKeyFromHash(location.hash);
// The private link carries the key once: keep it in this browser and take it out of the address bar.
if (showId && fragKey) { rememberKey(store, showId, fragKey); history.replaceState(null, '', location.pathname + location.search); }
let key = showId ? (fragKey ?? recallKey(store, showId)) : null;
const SEED = 31, YAW = .16, DAY = 86_400_000;
const T = { TIP: { flare: .62, pop: 1.0, itson: 2.38, done: 4.3 }, PAYOUT: { paid: 1.6 }, MISS: { release: .12, msg: 2.05, wave: .9 } };
const PAYEE = { room: 'Room', opener: 'Opener', host: 'Host', artist: 'You' } as const;

type MPhase = 'open' | 'tipping' | 'tipped' | 'ff' | 'paying' | 'paid' | 'missing' | 'released';
interface ManageState { phase: MPhase; tipped: boolean; fans: number; remain: number; busy: boolean; ffRaf: number }
type Option = ProposalDto['options'][number];
let st: ManageState = { phase: 'open', tipped: false, fans: 0, remain: 0, busy: false, ffRaf: 0 };
let mv: ManageView | null = null, clock: ShowClock | null = null, ph: Placeholder | null = null, view: SignView | null = null, payout: PayoutStrip | null = null, grid: LedgerGrid | null = null;
const queue: AgentLogDto[] = [];
let lastSeq = 0, ask: { proposalId: string; option: Option } | null = null;
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
  // The artist changed the target or the deadline (or someone did from another tab): refresh the words, the sign and the 3D view.
  if (prev && (prev.show.threshold !== v.show.threshold || prev.show.deadline !== v.show.deadline)) { texts(v.show); ph?.setModel({ name: v.show.showName, target: v.show.threshold }); view?.setModel(model()); }
  takeLog(v);
  grid?.setRows(v.ledger);
  renderAsk(); renderAttention(); renderCallOff();
  step();
  render();
}
/** The key stops working (the show was re-signed, or the link was never right): forget it and say so in plain words. */
function lostKey() {
  if (showId) forgetKey(store, showId);
  key = null; mv = null;
  history.replaceState(null, '', location.pathname + location.search);
  blocked('That private link doesn’t match this show. Open the link you saved when you signed.');
}
async function refresh() {
  if (!showId || !key) return;
  try { apply(await api.manage(showId, key)); }
  catch (e) { if (e instanceof ApiFailure && e.status === 403) { lostKey(); return; } throw e; }
}
/** Approve, not now and call off run one at a time: every one of their buttons is disabled while any is working. */
let acting = false;
const lockables = () => document.querySelectorAll<HTMLButtonElement>('#approve, #decline, #calloff-btn, #ask-alt button');
async function solo(fn: () => Promise<void>): Promise<boolean> {
  if (acting) return false;
  acting = true; lockables().forEach(b => { b.disabled = true; });
  try { await act(fn); } finally { acting = false; lockables().forEach(b => { b.disabled = false; }); }
  return true;
}
const resetApprove = () => { approveBtn.reset(); $('[data-approve-label]').textContent = 'Hold to approve'; };
async function approveNow(proposalId: string, option: Option) {
  if (!showId || !key) return;
  const id = showId, k = key;
  const ran = await solo(async () => {
    try { await api.approve(id, k, proposalId, { option: option.id }); el.ask.hidden = true; Snd.sign(); await refresh(); }
    catch (e) { if (e instanceof ApiFailure && e.status === 403) { lostKey(); return; } resetApprove(); askSay(e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.'); }
  });
  if (!ran) resetApprove();
}
async function declineNow() {
  if (!ask || !showId || !key) return;
  const id = ask.proposalId, sid = showId, k = key;
  await solo(async () => {
    el.ask.hidden = true; dismiss(store, sid, id);
    try { await api.decline(sid, k, id); } catch (e) { if (e instanceof ApiFailure && e.status === 403) { lostKey(); return; } /* the card stays hidden; the log just won't show the "not now" */ }
    try { await refresh(); } catch { /* the next poll catches up */ }
  });
}
async function callOffNow() {
  if (!showId || !key) return;
  const sid = showId, k = key;
  const ran = await solo(async () => {
    try { await api.callOff(sid, k); await refresh(); }
    catch (e) { if (e instanceof ApiFailure && e.status === 403) { lostKey(); return; } calloffBtn.reset(); $('[data-calloff-label]').textContent = 'Hold to call the show off'; el.calloffMsg.textContent = e instanceof ApiFailure ? e.message : 'Something went wrong. Please try again.'; el.calloffMsg.hidden = false; }
  });
  if (!ran) { calloffBtn.reset(); $('[data-calloff-label]').textContent = 'Hold to call the show off'; }
}
function blocked(text: string) {
  $('[data-notice-text]').textContent = text; el.notice.hidden = false;
  document.querySelectorAll<HTMLElement>('main > :not(#manage-notice)').forEach(n => { n.hidden = true; });
}
function model(): SignModel { const s = show(); return { name: s.showName, crest: s.roomName.toUpperCase(), target: s.threshold, seed: SEED, yaw: YAW, payees: payees() }; }

async function boot() {
  if (!showId) return blocked('There’s no show at this link.');
  if (!key) return blocked('This page needs your private link, the one you saved when you signed. Open that link to see your show.');
  let v: ManageView; const sid = showId, k0 = key;
  try { v = await act(() => api.manage(sid, k0)); }
  catch (e) {
    const f = e instanceof ApiFailure ? e : null;
    if (f?.status === 403) { forgetKey(store, sid); key = null; history.replaceState(null, '', location.pathname + location.search); }
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
  // Parity runs keep the reference's exact note text (a fixture-mode text); real pages say what the grid can do.
  if (!PARITY) { $('[data-note]').textContent = 'Newest first. Sort or filter any column.'; $('#csv').hidden = false; }
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
