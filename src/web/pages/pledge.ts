import "../shared/gsap-global";
import "../shared/styles.css";
import "../shared/boot.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, Placeholder, setStatus, countdownHTML, enter, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { AuthorizeResponse, PublicShow } from "../../worker/api-types";
import { API_BASE, HOOKS, PARITY, markBooted, markReady, paypalClientId, removeRefOnly } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { dayLabel, dollars, endOf, planSplit, remainSec, ROLE_WORD, ShowClock, when } from "../shared/format";
import { showIdFromPath } from "../shared/keys";
import { cleanInitials, noMemory, PledgeFlow, sessionMemory, type PledgeEvent } from "../shared/pledge-flow";
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

const current = (): PublicShow | null => show; // TS can't see assignments made inside functions
const price = () => show?.ticketPriceCents ?? 0;
const target = () => show?.threshold ?? 1;
const refunded = (): boolean => !!show && endOf(show.state) === 'cancelled';
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
  odoHeld.set(charged || v === 'released' ? 0 : total, instant); odoCharged.set(charged || refunded() ? total : 0, instant);
  el.sub.textContent = v === 'paid' ? (show?.state === 'paying_out' ? 'Paying everyone' : 'Payouts sent') : v === 'released' ? (refunded() ? 'Called off · refunding' : `Called off · ${Math.max(0, t - st.fans)} short`) : charged ? 'It’s on! Everyone’s charged' : `${t - st.fans} more to make it happen`;
  $('[data-money-sub]').textContent = charged ? `Charged the moment it tipped · ${st.fans} × ${p}` : v === 'released' ? (refunded() ? `Called off. All ${st.fans} fans who were charged are getting ${p} back.` : 'Every hold was cancelled. Nobody paid.') : 'Nobody pays unless it happens.';
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

/** The sign for a show: also used again when the artist changes the target or the deadline. */
function signModel(s: PublicShow): SignModel {
  const amounts = planSplit(s.split, Math.max(st.fans, s.threshold) * s.ticketPriceCents);
  return { name: s.showName, crest: s.roomName.toUpperCase(), target: s.threshold, seed: SEED, yaw: YAW, payees: s.split.map((p, i) => ({ label: ROLE_WORD[p.role], amount: amounts[i] / 100 })) };
}

function notice(text: string) {
  $('[data-notice-text]').textContent = text; el.notice.hidden = false;
}
function closedState(s: PublicShow) {
  const e = endOf(s.state);
  if (e === 'paid') setStatus(el.status, 'paid', s.state === 'settled' ? 'Payouts sent' : 'Paying everyone', s.state === 'settled' ? '· waiting for PayPal to confirm' : '', true);
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

/** A hold confirmed after a reload: the fan is already counted in the show we loaded, so no bulb animation. */
function onResumed(ini: string) {
  st.busy = false;
  el.card.hidden = true; el.confirm.hidden = false;
  $('[data-confirm-bulb]').textContent = `Your bulb is the one marked ${ini}.`;
}

function onFlow(e: PledgeEvent) {
  const sim = simulateBtn();
  if (e.kind === 'busy') { say(''); st.busy = true; if (sim) sim.disabled = true; return; }
  if (e.kind === 'held') { if (e.resumed) onResumed(e.initials); else onHeld(e.res, e.initials); return; }
  st.busy = false; if (sim) sim.disabled = false; say(e.message);
}
const flow = new PledgeFlow({
  createOrder: (initials) => act(() => api.createOrder(showId ?? '', { initials })),
  authorize: (orderId) => act(() => api.authorize(showId ?? '', orderId)),
}, onFlow, () => cleanInitials(el.initials.value), { memory: showId && !PARITY ? sessionMemory(showId) : noMemory });

function mountButton() {
  if (st.phase === 'closed') return;
  const id = paypalClientId(show?.paypalClientId ?? "");
  if (!id) { if (!HOOKS) el.slot.textContent = 'Pledging isn’t switched on for this site yet.'; return; }
  mountPayPalButton(el.slot, id, { canStart: () => flow.canStart(), createOrder: () => flow.createOrder(), onApprove: (orderId) => flow.approve(orderId), onCancel: () => flow.cancel(), onError: (err) => flow.error(err) })
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
  if (st.phase !== 'closed') void act(() => flow.resume());
}

/** Other fans' pledges and the tip, seen by polling (never in parity runs). */
async function poll() {
  if (!show || !showId || st.busy || st.phase === 'closed' || document.hidden) return;
  let s: PublicShow;
  try { s = await api.getShow(showId); } catch { return; }
  if (s.version === show.version || st.busy) return;
  const wasLive = st.phase === 'held';
  const termsChanged = s.threshold !== show.threshold || s.deadline !== show.deadline;
  show = s; clock?.sync(s.now);
  const e = endOf(s.state);
  if (e !== 'live' && e !== 'tipped') { st.phase = 'closed'; closedState(s); render(); view?.reset(); return; }
  st.fans = s.fans.committed;
  if (termsChanged) { texts(s); const m = signModel(s); ph?.setModel(m); view?.setModel(m); view?.reset(); }
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

interface PledgeHooks extends MarqueeHooks { state: PledgeState; poll(): void; approve(): void; setFans(n: number): void; setInitials(v: string): void }
const hooks: PledgeHooks = {
  page: 'pledge', ready: false, views: [], state: st, get pending() { return pendingCount(); },
  approve: () => { if (!st.busy && st.phase !== 'closed') void flow.simulate(); },
  setFans(n) { st.fans = n; render(true); if (view) view.reset(); },
  poll: () => { void act(() => poll()); },
  setInitials(v) { el.initials.value = v; },
};
if (HOOKS) { window.__marquee = hooks; simulateBtn()?.addEventListener('click', () => hooks.approve()); }

await boot();
markBooted();
let host: SignHost | null = null;
const booted = current();
if (booted) { try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ } }
if (host && booted) {
  const s = booted, each = dollars(s.ticketPriceCents);
  view = host.add(el.stage, signModel(s),
    { state: visual, tipEl: $('[data-tip]'), ph: $('[data-ph]'), tip: slot => slot < st.fans ? (slot === st.mine ? `You · ${each} ${visual().phase === 'held' ? 'on hold' : 'charged'}` : `Fan ${pad2(slot + 1)} · ${each} ${visual().phase === 'held' ? 'on hold' : 'charged'}`) : null });
  const h = host; Ticker.add(now => h.tick(now)); hooks.views = host.views; hooks.host = host;
}
hooks.ready = true;
markReady();
