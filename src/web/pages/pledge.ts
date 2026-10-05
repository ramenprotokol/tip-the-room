import "../shared/gsap-global";
import "../shared/styles.css";
import { $, REDUCED, Ticker, Cues, Odo, Snd, soundToggle, Placeholder, setStatus, countdownHTML, enter, pad2 } from "../shared/ui";
import type { SignHost, SignView, Phase } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";

// fixed sample: Maya's show, "now" is Mon Nov 9, 9:00am (2026 calendar)
const SHOW = { name: 'Acoustic Set', crest: 'LUCKY’S CAFÉ', target: 21, start: 12, pledge: 15, remain: 291600, seed: 31, yaw: .16 };
interface PledgeState { fans: number; phase: 'held' | 'tipping' | 'tipped'; remain: number; busy: boolean; mine: number }
const st: PledgeState = { fans: SHOW.start, phase: 'held', remain: SHOW.remain, busy: false, mine: -1 };
const el = { stage: $('[data-stage]'), status: $('[data-status]'), clock: $('[data-clock]'), sub: $('[data-fans-sub]'), initials: $<HTMLInputElement>('#initials'), card: $('#pledge-card'), confirm: $('#confirm') };
const odoFans = new Odo($('[data-fans]')), odoHeld = new Odo($('[data-held]')), odoCharged = new Odo($('[data-charged]'));
const ph = new Placeholder($('[data-ph]'), { name: SHOW.name, target: SHOW.target });
const cues = new Cues(); let view: SignView | null = null;
Ticker.lamp(el.status);

const visual = (): { phase: Phase; fans: number } => ({ phase: st.phase === 'tipped' || st.phase === 'tipping' ? 'tipped' : 'held', fans: st.fans });
function render(instant = false) {
  odoFans.set(st.fans, instant);
  odoHeld.set(st.phase === 'tipped' ? 0 : st.fans * SHOW.pledge, instant); odoCharged.set(st.phase === 'tipped' ? st.fans * SHOW.pledge : 0, instant);
  el.sub.textContent = st.phase === 'tipped' ? 'It’s on! Everyone’s charged' : `${SHOW.target - st.fans} more to make it happen`;
  $('[data-money-sub]').textContent = st.phase === 'tipped' ? `Charged the moment it tipped · ${st.fans} × $${SHOW.pledge}` : 'Nobody pays unless it happens.';
  el.clock.innerHTML = countdownHTML(st.remain);
  el.stage.setAttribute('aria-label', st.phase === 'tipped' ? `Marquee sign for ${SHOW.name}, fully lit: ${SHOW.target} fans joined and the show is on.` : `Marquee sign for ${SHOW.name}: ${st.fans} of ${SHOW.target} bulbs glowing dimly, fans on hold.`);
  ph.update(visual().phase, st.fans);
}
function approve() {
  if (st.busy || st.phase !== 'held') return;
  st.busy = true; $<HTMLButtonElement>('#simulate').disabled = true;
  const ini = (el.initials.value || '').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'YOU';
  const f0 = st.fans; st.mine = f0;
  if (view) { view.setTag(f0, ini); view.play('pledge', { f0, f1: f0 + 1 }); }
  cues.at(REDUCED ? 0 : .38, () => { st.fans++; render(); Snd.screw(0); });
  cues.at(REDUCED ? .05 : .6, () => {
    el.card.hidden = true; el.confirm.hidden = false; enter(el.confirm, 10, 450);
    $('[data-confirm-bulb]').textContent = `Your bulb is the one marked ${ini}.`;
    if (st.fans >= SHOW.target) {
      st.phase = 'tipping'; if (view) view.play(REDUCED ? 'reduced' : 'tip', REDUCED ? { to: 'tipped' } : {});
      cues.at(REDUCED ? .05 : .62, () => {
        st.phase = 'tipped'; Snd.flare(); setStatus(el.status, 'tipped', 'It’s on!', '· everyone’s charged'); render();
        $('[data-confirm-title]').textContent = 'You made it happen';
        $('[data-confirm-text]').textContent = `${SHOW.target} fans joined, so the show is on. PayPal charged everyone $15, you included.`;
      });
    } else st.busy = false;
  });
}
$('#simulate').addEventListener('click', approve);
setInterval(() => { if (st.remain > 0) { st.remain--; el.clock.innerHTML = countdownHTML(st.remain); } }, 1000);
soundToggle($('#sound'));
render(true);

interface PledgeHooks extends MarqueeHooks { state: PledgeState; approve(): void; setFans(n: number): void; setInitials(v: string): void }
const hooks: PledgeHooks = { page: 'pledge', ready: false, views: [], state: st, approve, setFans(n) { st.fans = n; render(true); if (view) view.reset(); }, setInitials(v) { el.initials.value = v; } };
window.__marquee = hooks;
let host: SignHost | null = null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ }
if (host) {
  view = host.add(el.stage, { name: SHOW.name, crest: SHOW.crest, target: SHOW.target, seed: SHOW.seed, yaw: SHOW.yaw, payees: [{ label: 'Room', amount: 100 }, { label: 'Artist', amount: 215 }] },
    { state: visual, tipEl: $('[data-tip]'), ph: $('[data-ph]'), tip: slot => slot < st.fans ? (slot === st.mine ? `You · $${SHOW.pledge} ${st.phase === 'tipped' ? 'charged' : 'on hold'}` : `Fan ${pad2(slot + 1)} · $${SHOW.pledge} ${st.phase === 'tipped' ? 'charged' : 'on hold'}`) : null });
  Ticker.add(now => host.tick(now)); hooks.views = host.views; hooks.host = host;
}
hooks.ready = true;
