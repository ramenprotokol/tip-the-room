/* Tip the Room · Marquee v2 reference — DOM-side building blocks.
   Everything that moves is driven by one requestAnimationFrame loop (Ticker) and
   performance.now(), so Playwright's page.clock can freeze and step it. */

type TickFn = (now: number) => void;
type Gsap = typeof import('gsap').gsap;
type Pt = { x: number; y: number };

export const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T => r.querySelector<T>(s)!;
export const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document): T[] => [...r.querySelectorAll<T>(s)];
export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const smooth = (x: number) => { x = clamp(x); return x * x * (3 - 2 * x); };
export const easeOut3 = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
export const easeInOut = (x: number) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const backOut = (x: number, s = 1.7) => { x = clamp(x); const c = s + 1; return 1 + c * Math.pow(x - 1, 3) + s * Math.pow(x - 1, 2); };
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
export function mulberry32(a: number) { return function (): number { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------------- one clock for the whole page ---------------- */
export const Ticker = {
  fns: new Set<TickFn>(), lamps: new Set<HTMLElement>(), started: false, lampStep: -1,
  add(fn: TickFn) { this.fns.add(fn); this.start(); return () => this.fns.delete(fn); },
  lamp(el: HTMLElement) { this.lamps.add(el); },
  start() {
    if (this.started) return; this.started = true;
    const loop = (now: number) => {
      for (const f of [...this.fns]) f(now);
      const step = Math.floor(now / 66); // status lamps breathe at ~15 fps
      if (!REDUCED && step !== this.lampStep) { this.lampStep = step; const tk = (now / 1000).toFixed(3); for (const el of this.lamps) el.style.setProperty('--tk', tk); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
};
export function tween(ms: number, fn: (e: number, k: number) => void, ease: (x: number) => number = easeOut3) {
  const t0 = performance.now(); let off: () => void = () => {};
  fn(0, 0);
  off = Ticker.add(now => { const k = Math.min(1, (now - t0) / ms); fn(ease(k), k); if (k >= 1) off(); });
  return () => off();
}
/* cue list: run fn at t seconds from now (frame-aligned with the 3D) */
export class Cues {
  list: { t: number; fn: () => void }[];
  base: number | null;
  constructor() { this.list = []; this.base = null; Ticker.add(now => this.run(now)); }
  at(sec: number, fn: () => void) { const b = this.base ?? performance.now(); this.list.push({ t: b + sec * 1000, fn }); this.list.sort((a, c) => a.t - c.t); }
  run(now: number) { while (this.list.length && this.list[0].t <= now) { const c = this.list.shift()!; this.base = c.t; try { c.fn(); } finally { this.base = null; } } }
  clear() { this.list = []; }
}

/* small entrance / emphasis motions (GSAP when present, else the Ticker) */
const G = (): Gsap | null => (typeof window === 'undefined' ? null : (window as Window & { gsap?: Gsap }).gsap) || null;
if (G()) { G()!.ticker.lagSmoothing(0); G()!.config({ force3D: false }); } // 2D transforms stay on the paint path, so frozen frames rasterise identically
export function pop(el: HTMLElement | null | undefined) {
  if (REDUCED || !el) return;
  if (G()) G()!.fromTo(el, { scale: .92 }, { scale: 1, duration: .55, ease: 'back.out(3)', clearProps: 'transform' });
  else tween(550, k => { el.style.transform = k >= 1 ? '' : `scale(${.92 + .08 * k})`; }, k => backOut(k, 3));
}
export function enter(el: HTMLElement | null | undefined, dy = 8, ms = 450) {
  if (REDUCED || !el) return;
  if (G()) G()!.fromTo(el, { opacity: 0, y: dy }, { opacity: 1, y: 0, duration: ms / 1000, ease: 'power2.out', clearProps: 'transform,opacity' });
  else tween(ms, k => { el.style.opacity = String(k); el.style.transform = k >= 1 ? '' : `translateY(${dy * (1 - k)}px)`; });
}
export function setStatus(el: HTMLElement, state: string, word: string, said: string, instant = false) {
  el.dataset.state = state; $('[data-word]', el).textContent = word; $('[data-said]', el).textContent = said;
  Ticker.lamp(el); if (!instant) pop(el);
}
export function countdownHTML(sec: number) {
  const r = Math.max(0, Math.round(sec)), d = Math.floor(r / 86400), h = Math.floor(r % 86400 / 3600), m = Math.floor(r % 3600 / 60), s = r % 60;
  const g = (v: number, u: string) => `<span class="cg"><span>${pad2(v)}</span><small>${u}</small></span>`;
  return `${g(d, 'days')}<i>:</i>${g(h, 'hrs')}<i>:</i>${g(m, 'min')}<i>:</i>${g(s, 'sec')}`;
}

/* ---------------- odometer digits (rolled from JS, not CSS) ---------------- */
export class Odo {
  el: HTMLElement;
  v: number | null;
  cols: { s: HTMLElement; at: number; pos: number; off: (() => void) | null }[];
  wrap: HTMLElement;
  sr: HTMLElement;
  constructor(el: HTMLElement) { this.el = el; this.v = null; this.cols = []; el.textContent = ''; this.wrap = document.createElement('span'); this.wrap.className = 'odo'; this.wrap.setAttribute('aria-hidden', 'true'); this.sr = document.createElement('span'); this.sr.className = 'sr'; el.append(this.wrap, this.sr); }
  build(n: number) {
    this.wrap.textContent = ''; this.cols = [];
    for (let i = 0; i < n; i++) {
      const d = document.createElement('span'); d.className = 'd'; const s = document.createElement('span'); s.className = 's';
      for (let k = 0; k < 20; k++) { const x = document.createElement('span'); x.textContent = String(k % 10); s.appendChild(x); }
      d.appendChild(s); this.wrap.appendChild(d); this.cols.push({ s, at: 0, pos: 0, off: null });
    }
  }
  set(v: number, instant = false) {
    v = Math.max(0, Math.round(v)); const str = String(v), up = this.v !== null && v > this.v;
    if (str.length !== this.cols.length) { this.build(str.length); instant = true; }
    if (REDUCED || this.v === null) instant = true;
    str.split('').forEach((ch, i) => {
      const col = this.cols[i], d = +ch, place = (p: number) => { col.pos = p; col.s.style.transform = `translateY(${-p}em)`; };
      if (col.off) { col.off(); col.off = null; }
      if (instant) place(d);
      else {
        const from = col.pos % 10 === col.pos ? col.pos : col.pos - 10, to = up && d < col.at ? d + 10 : d;
        col.off = tween(550, k => { place(from + (to - from) * k); if (k >= 1) place(d); });
      }
      col.at = d;
    });
    this.sr.textContent = str; this.v = v;
  }
}

/* ---------------- sound (WebAudio synth, off by default) ---------------- */
export const Snd = {
  on: false, ctx: null as AudioContext | null, out: null as GainNode | null, nb: null as AudioBuffer | null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext; if (!AC) return false;
      this.ctx = new AC(); this.out = this.ctx.createGain(); this.out.gain.value = .55;
      const comp = this.ctx.createDynamicsCompressor(); this.out.connect(comp); comp.connect(this.ctx.destination);
      const len = this.ctx.sampleRate; this.nb = this.ctx.createBuffer(1, len, len);
      const d = this.nb.getChannelData(0); const r = mulberry32(3); for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  },
  click(when = 0, { f = 2400, q = 6, g = .1, d = .03 }: { f?: number; q?: number; g?: number; d?: number } = {}) {
    if (!this.on || !this.ctx) return; const c = this.ctx, t = c.currentTime + when;
    const s = c.createBufferSource(); s.buffer = this.nb; const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const gn = c.createGain(); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d);
    s.connect(bp); bp.connect(gn); gn.connect(this.out!); s.start(t, (when * 7.31) % .5); s.stop(t + d + .02);
  },
  tone(when: number, f: number, d: number, { type = 'sine', g = .06, f2 = null, a = .006 }: { type?: OscillatorType; g?: number; f2?: number | null; a?: number } = {}) {
    if (!this.on || !this.ctx) return; const c = this.ctx, t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    const gn = c.createGain(); gn.gain.setValueAtTime(.0001, t); gn.gain.exponentialRampToValueAtTime(g, t + a); gn.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(gn); gn.connect(this.out!); o.start(t); o.stop(t + d + .05);
  },
  screw(i: number) { this.click(0, { f: 3300, g: .07, d: .018 }); this.click(.045, { f: 3700, g: .06, d: .018 }); this.click(.09, { f: 4100, g: .05, d: .018 }); this.tone(.12, 1500 + i * 110, .16, { g: .035 }); },
  chase(n: number, dur: number) { for (let i = 0; i < n; i += 2) this.tone(i / n * dur, 2200 + i * 30, .04, { g: .022 }); },
  flare() { this.tone(0, 120, .45, { g: .14, f2: 48 }); this.click(0, { f: 6000, q: .7, g: .06, d: .5 }); this.tone(.02, 1046, .9, { g: .03, type: 'triangle' }); },
  sparks() { for (let i = 0; i < 22; i++) this.click(i * .035 + (i * .013) % .02, { f: 3000 + (i * 937) % 5000, q: 9, g: .05, d: .02 }); },
  chord() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(i * .03, f, 1.1, { g: .03, type: 'triangle' })); },
  drop() { [0, .07, .14].forEach((w, i) => this.tone(w, 180 - i * 12, .18, { g: .06 })); },
  paid(n = 3) { for (let i = 0; i < n; i++) { this.tone(i * .1, 1318.5, .5, { g: .04 }); this.tone(i * .1 + .05, 1975.5, .6, { g: .03 }); } },
  relays(n: number, dur: number) { for (let i = 0; i < n; i++) this.click(i / n * dur, { f: 850, q: 2.5, g: .08, d: .05 }); },
  release(n: number) { for (let i = 0; i < Math.min(n, 8); i++) this.tone(.3 + i * .16, 392, 1.2, { g: .012, f2: 587 }); },
  msg() { this.tone(0, 392, 1.4, { g: .025, type: 'triangle' }); this.tone(.04, 493.9, 1.4, { g: .018, type: 'triangle' }); },
  sign() { [0, .08, .16].forEach((w, i) => this.tone(w, 659.25 * Math.pow(1.26, i), .5, { g: .03, type: 'triangle' })); },
};
export function soundToggle(btn: HTMLElement) {
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    if (on && !Snd.ensure()) return;
    Snd.on = on; btn.setAttribute('aria-pressed', String(on)); $('[data-label]', btn).textContent = on ? 'Sound on' : 'Sound off';
    if (on) Snd.tone(0, 880, .15, { g: .03 });
  });
}

/* ---------------- agent log (plain words + small print) ---------------- */
export class AgentLog {
  el: HTMLElement;
  constructor(el: HTMLElement) { this.el = el; }
  add({ time, html, fine = '', tag = '', instant = false }: { time: string; html: string; fine?: string; tag?: string; instant?: boolean }) {
    const li = document.createElement('li'); if (tag) li.dataset.tag = tag;
    li.innerHTML = `<time>${time}</time><span class="msg">${html}${fine ? `<small class="fine">${fine}</small>` : ''}</span>`;
    this.el.appendChild(li); if (!instant) enter(li); return li;
  }
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
  clear(tag?: string) { if (!tag) this.el.textContent = ''; else $$(`li[data-tag="${tag}"]`, this.el).forEach(li => li.remove()); }
}

/* ---------------- payout strip ---------------- */
export class PayoutStrip {
  el: HTMLElement;
  cells: HTMLElement[];
  odos: Odo[];
  note: HTMLElement | null;
  constructor(el: HTMLElement, payees: { label: string; who: string }[]) {
    this.el = el; const strip = $('.strip', el); strip.style.setProperty('--n', String(payees.length));
    strip.textContent = '';
    for (const p of payees) {
      const cell = document.createElement('div'); cell.className = 'cell'; cell.dataset.state = 'waiting';
      const span = (cls: string, text: string) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
      const amt = span('amt', '$'); const n = document.createElement('span'); n.dataset.amt = ''; n.textContent = '0'; amt.append(n);
      const tag = span('tag', 'Waiting'); tag.dataset.tag = '';
      cell.append(span('lbl', p.label), span('who', p.who), amt, tag); strip.append(cell);
    }
    this.cells = $$('.cell', strip); this.odos = this.cells.map(c => new Odo($('[data-amt]', c))); this.note = $('[data-pay-note]', el); this.reset();
  }
  reset() { this.cells.forEach((c, i) => { c.dataset.state = 'waiting'; $('[data-tag]', c).textContent = 'Waiting'; this.odos[i].set(0, true); }); if (this.note) this.note.textContent = this.note.dataset.idle || ''; }
  plan(amounts: number[], labels?: string[]) { amounts.forEach((v, i) => { this.odos[i].set(v, true); this.cells[i].dataset.state = 'waiting'; $('[data-tag]', this.cells[i]).textContent = labels ? labels[i] : 'Planned'; }); }
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
}

/* ---------------- border track + flat SVG sign (instant paint, no-WebGL fallback) ---------------- */
export function trackPoints2D(w: number, h: number, r: number, n: number) {
  const segs: ['L' | 'A', number, number, number, number][] = [
    ['L', -w / 2 + r, h / 2, w / 2 - r, h / 2], ['A', w / 2 - r, h / 2 - r, Math.PI / 2, 0],
    ['L', w / 2, h / 2 - r, w / 2, -h / 2 + r], ['A', w / 2 - r, -h / 2 + r, 0, -Math.PI / 2],
    ['L', w / 2 - r, -h / 2, -w / 2 + r, -h / 2], ['A', -w / 2 + r, -h / 2 + r, -Math.PI / 2, -Math.PI],
    ['L', -w / 2, -h / 2 + r, -w / 2, h / 2 - r], ['A', -w / 2 + r, h / 2 - r, Math.PI, Math.PI / 2]];
  const len = (s: (typeof segs)[number]) => s[0] === 'L' ? Math.hypot(s[3] - s[1], s[4] - s[2]) : Math.abs(s[4] - s[3]) * r;
  const total = segs.reduce((a, s) => a + len(s), 0), out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    let d = (i + .5) * total / n;
    for (const s of segs) {
      const l = len(s); if (d > l) { d -= l; continue; }
      const k = d / l;
      if (s[0] === 'L') out.push({ x: s[1] + (s[3] - s[1]) * k, y: s[2] + (s[4] - s[2]) * k });
      else { const a = s[3] + (s[4] - s[3]) * k; out.push({ x: s[1] + Math.cos(a) * r, y: s[2] + Math.sin(a) * r }); }
      break;
    }
  }
  return out;
}
export class Placeholder {
  svg: Element;
  model!: { name: string; target: number };
  dots!: Element[];
  text!: Element;
  constructor(svg: Element, model: { name: string; target: number }) { this.svg = svg; this.setModel(model); }
  setModel(model: { name: string; target: number }) {
    this.model = model; const svg = this.svg, NS = 'http://www.w3.org/2000/svg'; svg.textContent = '';
    svg.setAttribute('viewBox', '0 0 640 368');
    const el = (tag: string, at: Record<string, string | number>) => { const e = document.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, String(at[k])); svg.appendChild(e); return e; };
    el('rect', { x: 52, y: 92, width: 536, height: 184, rx: 12, fill: '#C8221B', stroke: '#B8893A', 'stroke-width': 4 });
    el('rect', { x: 92, y: 130, width: 456, height: 108, rx: 5, fill: '#2A0C09', stroke: '#C9A04A', 'stroke-width': 3 });
    this.dots = trackPoints2D(504, 152, 12, model.target).map(p => el('circle', { cx: 320 + p.x, cy: 184 - p.y, r: 6.5, class: 's-empty' }));
    const name = model.name.toUpperCase(), size = Math.min(64, Math.round(900 / Math.max(6, name.length)));
    this.text = el('text', { x: 320, y: 184 + size * .36, 'text-anchor': 'middle', class: 'name', fill: '#D9662E', 'font-size': size });
    this.text.textContent = name;
  }
  update(phase: string, fans: number) {
    const lit = phase === 'tipped' || phase === 'paid';
    this.dots.forEach((d, i) => d.setAttribute('class', lit ? 's-lit' : i < fans ? (phase === 'released' ? 's-off' : 's-held') : 's-empty'));
    this.text.textContent = phase === 'released' ? 'CALLED OFF · $0' : this.model.name.toUpperCase();
    this.text.setAttribute('fill', lit ? '#FFF1C9' : phase === 'released' ? '#A8A2CC' : '#D9662E');
  }
}

/* ---------------- hold-to-confirm button ---------------- */
export class HoldButton {
  btn: HTMLButtonElement;
  ms: number;
  onDone: (() => void) | undefined;
  p: number;
  holding: boolean;
  done: boolean;
  last: number;
  t0!: number;
  constructor(btn: HTMLButtonElement, { ms = 1500, onDone }: { ms?: number; onDone?: () => void } = {}) {
    this.btn = btn; this.ms = ms; this.onDone = onDone; this.p = 0; this.holding = false; this.done = false; this.last = performance.now();
    if (!$('.fill', btn)) btn.insertAdjacentHTML('afterbegin', '<span class="fill" aria-hidden="true"></span>');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty -- verbatim port of the reference's swallow-errors catch
    btn.addEventListener('pointerdown', e => { if (e.button) return; e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) { } this.start(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, () => this.release());
    btn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); this.start(); } else if (e.key === ' ' || e.key === 'Enter') e.preventDefault(); });
    btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.release(); } });
    btn.addEventListener('blur', () => this.release());
    btn.addEventListener('click', e => e.preventDefault());
    btn.addEventListener('contextmenu', e => e.preventDefault());
    Ticker.add(now => this.tick(now));
  }
  start() { if (this.done || this.btn.disabled) return; this.holding = true; this.t0 = performance.now() - this.p * this.ms; }
  release() { this.holding = false; }
  set(p: number) { this.p = p; this.btn.style.setProperty('--p', p.toFixed(4)); }
  reset() { this.done = false; this.holding = false; this.set(0); this.btn.classList.remove('is-done'); }
  tick(now: number) {
    const dt = now - this.last; this.last = now; if (this.done) return;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- verbatim port: `this.onDone && this.onDone()`
    if (this.holding) { this.set(Math.min(1, (now - this.t0) / this.ms)); if (this.p >= 1) { this.done = true; this.holding = false; this.btn.classList.add('is-done'); this.onDone && this.onDone(); } }
    else if (this.p > 0) this.set(Math.max(0, this.p - dt / 260));
  }
}

/* ---------------- clipboard ---------------- */
export async function copyText(text: string, statusEl?: HTMLElement | null) {
  let ok = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty -- verbatim port of the reference's swallow-errors catch
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) { }
  if (statusEl) statusEl.textContent = ok ? 'Copied' : 'Select the link and copy it';
  return ok;
}

/* ---------------- QR code (byte mode, level M, versions 1–10) ---------------- */
const QR_M: Record<number, [number, [number, number][]]> = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
const QR_ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const gfMul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
function rsDivisor(deg: number) { const r = new Array<number>(deg).fill(0); r[deg - 1] = 1; let root = 1; for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gfMul(root, 2); } return r; }
function rsRemainder(data: number[], div: number[]) { const r = new Array<number>(div.length).fill(0); for (const b of data) { const f = b ^ r.shift()!; r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); } return r; }
function qrPenalty(m: boolean[][], n: number) {
  let p = 0, dark = 0; const at = (x: number, y: number) => m[y][x];
  for (let a = 0; a < n; a++) for (const H of [true, false]) {
    let run = 1, prev = H ? at(0, a) : at(a, 0);
    for (let b = 1; b < n; b++) { const c = H ? at(b, a) : at(a, b); if (c === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { run = 1; prev = c; } }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = at(x, y); if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3; }
  const pat = [1, 0, 1, 1, 1, 0, 1];
  for (let a = 0; a < n; a++) for (let b = 0; b + 7 <= n; b++) for (const H of [true, false]) {
    let ok = true; for (let k = 0; k < 7 && ok; k++) ok = (H ? at(b + k, a) : at(a, b + k)) === !!pat[k];
    if (!ok) continue;
    const light = (s: number, e: number) => { for (let k = s; k < e; k++) { if (k < 0 || k >= n) continue; if (H ? at(k, a) : at(a, k)) return false; } return true; };
    if (light(b - 4, b) || light(b + 7, b + 11)) p += 40;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (at(x, y)) dark++;
  const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1; return p + Math.max(0, k) * 10;
}
export function qrMatrix(text: string) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1; const capOf = (v: number) => QR_M[v][1].reduce((a, [c, d]) => a + c * d, 0);
  for (; ver <= 10; ver++) if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= capOf(ver) * 8) break;
  if (ver > 10) throw new Error('QR: text too long');
  const cap = capOf(ver), bits: number[] = [], push = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => push(b, 8));
  push(0, Math.min(4, cap * 8 - bits.length)); push(0, (8 - bits.length % 8) % 8);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0xEC; data.length < cap; p ^= 0xEC ^ 0x11) data.push(p);
  const [ecLen, groups] = QR_M[ver], div = rsDivisor(ecLen), blocks: { d: number[]; e: number[] }[] = []; let off = 0;
  for (const [count, len] of groups) for (let i = 0; i < count; i++) { const d = data.slice(off, off + len); off += len; blocks.push({ d, e: rsRemainder(d, div) }); }
  const cw: number[] = [], maxD = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) cw.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) cw.push(b.e[i]);
  const n = ver * 4 + 17, mod = Array.from({ length: n }, () => new Array<boolean>(n).fill(false)), fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (x: number, y: number, dk: boolean) => { mod[y][x] = dk; fn[y][x] = true; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= n || y >= n) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const al = QR_ALIGN[ver], na = al.length;
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, g = (i: number) => ((b >>> i) & 1) === 1; // level M = 00
    for (let i = 0; i <= 5; i++) set(8, i, g(i));
    set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, g(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, g(i));
    set(8, n - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) { let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25); const b = (ver << 12) | r; for (let i = 0; i < 18; i++) { const bit = ((b >>> i) & 1) === 1, a = n - 11 + i % 3, c = Math.floor(i / 3); set(a, c, bit); set(c, a, bit); } }
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) { mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const masks: ((x: number, y: number) => boolean)[] = [(x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = (m: number) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); drawFormat(m); const p = qrPenalty(mod, n); if (p < bestP) { bestP = p; best = m; } apply(m); }
  apply(best); drawFormat(best);
  return mod;
}
export function drawQR(canvas: HTMLCanvasElement, text: string, { scale = 4, margin = 4, dark = '#15110E', light = '#FFFFFF' }: { scale?: number; margin?: number; dark?: string; light?: string } = {}) {
  const m = qrMatrix(text), n = m.length, px = (n + margin * 2) * scale;
  canvas.width = px; canvas.height = px; const c = canvas.getContext('2d')!;
  c.fillStyle = light; c.fillRect(0, 0, px, px); c.fillStyle = dark;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) c.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  canvas.setAttribute('aria-label', `QR code for ${text}`); canvas.setAttribute('role', 'img');
  return n;
}

/* ---------------- AG Grid theme params matching the static ledger ----------------
   For AG Grid v33+ Theming API: themeQuartz.withParams(GRID_THEME). Header text is
   uppercase with 0.1em tracking (add .ag-header-cell-text CSS). Check names against
   the installed AG Grid version. Status column: pinned 'right', pill cell renderer. */
export const GRID_THEME = {
  backgroundColor: '#F3EEE4', foregroundColor: '#15110E', accentColor: '#C8221B',
  borderColor: 'rgba(21,17,14,0.17)', wrapperBorder: { width: 1.5, color: '#15110E' }, wrapperBorderRadius: 12,
  headerBackgroundColor: '#15110E', headerTextColor: '#F3EEE4', headerFontFamily: 'IBM Plex Mono', headerFontSize: 12, headerFontWeight: 600, headerHeight: 44,
  fontFamily: 'IBM Plex Sans', fontSize: 15, rowHeight: 48, oddRowBackgroundColor: 'rgba(21,17,14,0.025)',
  cellHorizontalPadding: 14, rowBorder: { width: 1, color: 'rgba(21,17,14,0.17)' }, columnBorder: false,
  pinnedColumnBorder: { width: 1.5, color: '#15110E' },
};
