import "../shared/gsap-global";
import "../shared/styles.css";
import "../shared/boot.css";
import { $, Ticker, Snd, soundToggle, Placeholder, HoldButton, drawQR, copyText, enter, usd } from "../shared/ui";
import type { SignHost, SignView, SignModel } from "../shared/sign";
import type { MarqueeHooks } from "../shared/hooks";
import type { CreateShowResponse, SignResponse } from "../../worker/api-types";
import { API_BASE, HOOKS, PUBLIC_ORIGIN, markBooted, markReady, removeRefOnly, safeStorage } from "../shared/env";
import { act, apiClient, ApiFailure, pendingCount } from "../shared/api";
import { rememberKey } from "../shared/keys";
import { when } from "../shared/format";
import { fromDraft, targetOf, toDraftFields, type Draft, type PayeeRow } from "../shared/start-draft";

removeRefOnly();
markBooted();
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
  const model: SignModel = { name: d.name || 'Your show', crest: d.room, target: Math.min(Math.max(target, 4), 80), seed: 31, yaw: .16, payees: paid.map((p): { label: string; amount: number } => ({ label: p.role, amount: p.amount })).concat([{ label: 'Artist', amount: me.amount || 0 }]) };
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
// A real start page is not a sample (the parity run masks this word as a data field).
$('.mode').textContent = 'Start a show';
if (HOOKS) window.__marquee = hooks;
let host: SignHost | null;
try { const { SignHost } = await import("../shared/sign"); host = await SignHost.create(); } catch { host = null; /* 3D is optional: the flat SVG sign remains */ }
if (host) {
  view = host.add(els.stage, { name: 'Your show', crest: 'YOUR ROOM', target: 20, seed: 31, yaw: .16, payees: [] }, { state: () => ({ phase: 'held', fans: 0 }), ph: $('[data-ph]') });
  const hs = host; Ticker.add(now => hs.tick(now)); hooks.views = host.views; hooks.host = host;
  if (D) update(true);
}
hooks.ready = true;
markReady();
