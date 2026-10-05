import "../shared/gsap-global";
import "../shared/styles.css";
import { $, Ticker, Snd, soundToggle, Placeholder, HoldButton, drawQR, copyText, enter, usd } from "../shared/ui";
import type { SignHost, SignView, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import { DEFAULT_FEE_BUFFER_BPS, dollarsToCents, thresholdPledges } from "../../core";

interface PayeeRow { role: string; who: string; amount: number; optional?: boolean; me?: boolean; email?: string }
interface Draft { name: string; room: string; date: string; price: number; deadline: string; payees: PayeeRow[] }

/* ---- deterministic stand-in for the AI draft (the real one is a model + code) ---- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const day = (m: number, d: number) => new Date(Date.UTC(2026, m, d));
const fmtDay = (dt: Date) => `${DOW[dt.getUTCDay()]} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
const title = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase());
const curly = (s: string) => s.replace(/'/g, '’');
function parseShow(text: string): Draft {
  const t = text.replace(/[’]/g, "'"), num = (re: RegExp) => { const m = t.match(re); return m ? +m[1] : null; };
  const price = num(/\$(\d+)\s*(?:tickets?|a ticket|each|a spot|per (?:ticket|person|fan))/i) ?? num(/tickets?\s*(?:are|at)?\s*\$(\d+)/i) ?? 15;
  const room = num(/(?:caf[eé]|room|venue|bar|shop|store|place)\s+(?:wants|needs|gets|charges)\s+\$(\d+)/i) ?? 0;
  const opener = num(/opener\s+(?:wants|needs|gets)\s+\$(\d+)/i) ?? 0;
  const host = num(/host\s+(?:wants|needs|gets)\s+\$(\d+)/i) ?? 0;
  const me = num(/\bI\s+(?:need|want|get)\s+\$(\d+)/i) ?? 0;
  const dm = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  const date = dm ? day(MONTHS.findIndex(x => x.toLowerCase() === dm[1].slice(0, 3).toLowerCase()), +dm[2]) : day(10, 20);
  const roomName = ((t.match(/\bat\s+((?:[A-Z][\w'é&.-]*\s?)+?)(?=\s+on\b|,|$)/) || [])[1] || '').trim();
  const name = ((t.match(/^\s*([^,]+?)\s+at\s+/i) || [])[1] || 'My show').trim();
  return { name: title(name), room: curly(roomName), date: fmtDay(date), price, deadline: `${fmtDay(new Date(date.getTime() - 8 * 864e5))}, 6:00pm`,
    payees: [{ role: 'Room', who: curly(roomName), amount: room }, { role: 'Opener', who: '', amount: opener, optional: true }, { role: 'Host', who: '', amount: host, optional: true }, { role: 'You', who: 'You', amount: me, me: true }] };
}
/* code, not the model, computes the target: the money core's thresholdPledges (fixed + your minimum, plus the 5% fee buffer, over the price) */
const targetOf = (d: Draft): number => {
  if (!(d.price > 0)) return 0;
  try {
    const fixedCosts = d.payees.filter(p => !p.me).map(p => dollarsToCents(+p.amount || 0));
    const artistMinimum = dollarsToCents(+(d.payees.find(p => p.me)?.amount ?? 0) || 0);
    return thresholdPledges({ fixedCosts, artistMinimum, ticketPrice: dollarsToCents(d.price), feeBufferBps: DEFAULT_FEE_BUFFER_BPS });
  } catch { return 0; } // a price under a cent or an absurdly large amount: show "Add a price" instead of throwing in an input handler
};
const slug = (d: Draft) => `${d.name}-${d.date.split(' ').slice(1).join('')}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const els = { sentence: $<HTMLTextAreaElement>('#sentence'), draft: $('#draft'), live: $('#live'), paylist: $('#paylist'), rules: $('#rules'), sign: $<HTMLButtonElement>('#sign'), target: $('[data-target-sentence]'), split: $('[data-split]'), stage: $('[data-stage]') };
const ph = new Placeholder($('[data-ph]'), { name: 'Your show', target: 20 });
let D: Draft | null = null, view: SignView | null = null;

function payRow(p: PayeeRow, i: number) {
  const li = document.createElement('li'); li.className = 'payrow' + (p.optional && !p.amount ? ' is-empty' : '');
  li.innerHTML = `<div class="role">${p.role}${p.optional ? '<small>optional</small>' : p.me ? '<small>gets the rest</small>' : ''}</div>
    <div class="field">${p.me ? '<span class="label">Who</span><input class="input" value="You" disabled aria-label="Who: you">' : `<label for="who-${i}">Name</label><input id="who-${i}" class="input" data-k="who" value="${p.who}" placeholder="${p.role === 'Opener' ? 'Opener’s name' : p.role === 'Host' ? 'Host’s name' : 'Room name'}" autocomplete="off">`}</div>
    <div class="field"><label for="amt-${i}">${p.me ? 'At least ($)' : 'Gets ($)'}</label><input id="amt-${i}" class="input mono" data-k="amount" inputmode="numeric" value="${p.amount || ''}" placeholder="0" autocomplete="off"></div>
    <div class="field email"><label for="mail-${i}">PayPal email</label><input id="mail-${i}" class="input mono" data-k="email" type="email" value="${p.email || ''}" placeholder="name@example.com" autocomplete="off"></div>`;
  li.addEventListener('input', e => { const el = e.target as HTMLInputElement, k = el.dataset.k as 'who' | 'amount' | 'email' | undefined; if (!k) return; if (k === 'amount') p.amount = +el.value.replace(/[^0-9.]/g, '') || 0; else p[k] = el.value; li.classList.toggle('is-empty', !!p.optional && !p.amount && !p.who); update(); });
  return li;
}
function fill() {
  const d = D = parseShow(els.sentence.value);
  $<HTMLInputElement>('#f-name').value = d.name; $<HTMLInputElement>('#f-room').value = d.room; $<HTMLInputElement>('#f-date').value = d.date; $<HTMLInputElement>('#f-price').value = String(d.price); $<HTMLInputElement>('#f-deadline').value = d.deadline;
  els.paylist.textContent = ''; d.payees.forEach((p, i) => els.paylist.appendChild(payRow(p, i)));
  els.draft.hidden = false; enter(els.draft, 12, 500); $('#fill').textContent = 'Fill it in again';
  update(true);
}
for (const [id, k] of [['f-name', 'name'], ['f-room', 'room'], ['f-date', 'date'], ['f-price', 'price'], ['f-deadline', 'deadline']] as const) $('#' + id).addEventListener('input', e => {
  if (!D) return; const v = (e.target as HTMLInputElement).value;
  if (k === 'price') D.price = +v.replace(/[^0-9.]/g, '') || 0; else D[k] = v;
  if (k === 'room') { D.payees[0].who = D[k]; const w = $<HTMLInputElement>('#who-0'); if (w) w.value = D[k]; }
  update();
});

let debounce: ReturnType<typeof setTimeout> | undefined;
function update(now = false) {
  if (!D) return;
  const target = targetOf(D), paid = D.payees.filter(p => !p.me && p.amount > 0), me = D.payees.find(p => p.me)!;
  els.target.innerHTML = target ? `You need <span class="dotnum">${target}</span> fans at ${usd(D.price)}` : 'Add a price to see how many fans you need';
  els.split.textContent = [...paid.map(p => `${p.who || p.role} gets ${usd(p.amount)}`), `You get the rest, at least ${usd(me.amount || 0)}`].join(' · ');
  els.rules.innerHTML = [
    `If <b>${target} fans</b> hold a spot by <b>${D.deadline}</b>, everyone is charged ${usd(D.price)} at once.`,
    `At the deadline, ${paid.length ? paid.map(p => `${p.who || p.role} is paid ${usd(p.amount)}`).join(', then ') + ', then you' : 'you'} get the rest (at least ${usd(me.amount || 0)}).`,
    `If fewer than ${target} fans join, every hold is cancelled and nobody pays.`,
    `To change the deadline or the target, your agent asks you first.`,
  ].map(x => `<li>${x}</li>`).join('');
  const missing = D.payees.filter(p => (p.amount > 0 || p.me) && !/^\S+@\S+\.\S+$/.test(p.email || '')).map(p => p.me ? 'you' : (p.who || p.role));
  els.sign.disabled = missing.length > 0 || target < 1;
  $('#sign-hint').textContent = missing.length ? `Add a PayPal email for ${missing.join(' and ')} to sign.` : 'Press and hold for 1.5 seconds. On a keyboard, hold Space or Enter.';
  const model: SignModel = { name: D.name || 'Your show', crest: D.room, target: Math.min(Math.max(target, 4), 80), seed: 31, yaw: .16, payees: paid.map(p => ({ label: p.role, amount: p.amount })).concat([{ label: 'Artist', amount: me.amount || 0 }]) };
  clearTimeout(debounce);
  const apply = () => { ph.setModel(model); ph.update('held', 0); if (view) view.setModel(model); els.stage.setAttribute('aria-label', `Preview of your marquee: ${model.name}, ${model.target} empty bulbs, one for each fan you need.`); };
  if (now) apply(); else debounce = setTimeout(apply, 250);
}
function goLive() {
  if (!D) return;
  Snd.sign();
  const s = slug(D), share = `https://tiptheroom.example/s/${s}`, manage = `https://tiptheroom.example/s/${s}/manage#k-7Q2M9X4T`;
  $('#share-url').textContent = share; $('#manage-url').textContent = manage;
  drawQR($<HTMLCanvasElement>('#qr'), share, { scale: 4, margin: 3 });
  const target = targetOf(D);
  $('[data-live-lede]').textContent = `Share your link. Fans hold a spot with PayPal, and nobody is charged unless ${target} of them join by ${D.deadline}.`;
  els.draft.hidden = true; els.live.hidden = false; enter(els.live, 12, 500);
  $('.intro').hidden = true;
  if (view) view.play('lap');
}
$('#fill').addEventListener('click', fill);
$('#copy-share').addEventListener('click', () => copyText($('#share-url').textContent ?? '', $('[data-copied]')));
$('#copy-manage').addEventListener('click', () => copyText($('#manage-url').textContent ?? '', $('[data-copied]')));
const holdBtn = new HoldButton(els.sign, { ms: 1500, onDone: () => { $('[data-sign-label]').textContent = 'Signed'; goLive(); } });
soundToggle($('#sound'));
ph.update('held', 0);

interface StartHooks extends MarqueeHooks { readonly data: Draft | null; fill(): void; setEmails(): void; holdTo(p: number): void; sign(): void }
const hooks: StartHooks = {
  page: 'start', ready: false, views: [], get data() { return D; },
  fill, setEmails() { const mails: Record<string, string> = { Room: 'luckys-cafe@example.com', You: 'maya@example.com' }; D!.payees.forEach((p, i) => { if (mails[p.role]) { p.email = mails[p.role]; const el = $<HTMLInputElement>('#mail-' + i); if (el) el.value = p.email; } }); update(true); },
  holdTo(p) { holdBtn.set(p); }, sign: () => { holdBtn.done = true; els.sign.classList.add('is-done'); $('[data-sign-label]').textContent = 'Signed'; goLive(); },
};
window.__marquee = hooks;
let host: SignHost | null = null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ }
if (host) {
  view = host.add(els.stage, { name: 'Your show', crest: 'YOUR ROOM', target: 20, seed: 31, yaw: .16, payees: [] }, { state: () => ({ phase: 'held', fans: 0 }), ph: $('[data-ph]') });
  Ticker.add(now => host.tick(now)); hooks.views = host.views; hooks.host = host;
  if (D) update(true);
}
hooks.ready = true;
