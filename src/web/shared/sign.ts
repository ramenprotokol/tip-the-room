/* Tip the Room · Marquee v2 reference — the 3D marquee sign.
   One shared WebGL renderer (SignHost) draws every sign on the page into that sign's own
   2D canvas. Choreography is a pure function of time (performance.now()), so a frozen
   clock gives a frozen, repeatable frame. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { REDUCED, clamp, smooth, easeOut3, easeInOut, backOut, mulberry32, trackPoints2D, tween } from './ui';

/* cue times (seconds) — pages schedule their DOM changes against these */
export const TIP = { flare: .62, pop: 1.0, gather: 1.78, itson: 2.38, swap: 3.1, done: 4.3 };
export const PAYOUT = { stream: .5, paid: 1.6, done: 2.6 };
export const MISS = { wave: .9, release: .12, msg: 2.05, done: 3.1 };
export const PLEDGE = { step: .24, land: .38, dur: .5 };
export const BONUS = { step: .3, dur: .6 };
export const REDUCED_T = { tip: .7, payout: .7, miss: 1.3 };

const FONT = '"Big Shoulders Display","Arial Narrow",Impact,sans-serif';
const LIT = [1.0, .8, .46], FIL = [1.0, .3, .075], MINT = [.03, .95, .46], LILAC = [.46, .42, .86], ZERO = [0, 0, 0], BH = .62;
const LAYOUTS = {
  wide: { W: 3.6, H: 1.3, D: .36, track: .13, panelIn: .29, rows: 22, fov: 22, rest: [1.1, 1.62], lines: 1, small: { w: 1.02, h: .62, d: .16, gap: .24, plateH: .13 } },
  tall: { W: 2.6, H: 1.86, D: .36, track: .13, panelIn: .29, rows: 30, fov: 24, rest: [1.13, 1.5], lines: 2, small: { w: .84, h: .6, d: .16, gap: .2, plateH: .11 } },
};

type Layout = keyof typeof LAYOUTS;
type Val<T> = { value: T };
type RGB = number[];
export type Phase = 'held' | 'tipped' | 'paid' | 'released';
export type AnimKind = 'pledge' | 'tip' | 'bonus' | 'payout' | 'miss' | 'lap' | 'reduced';
export interface Payee { label: string; amount: number }
export interface SignModel { name: string; crest?: string; target: number; seed?: number; yaw?: number; payees?: Payee[] }
export interface SignOpts {
  state?: () => { phase: Phase; fans: number };
  tip?: (slot: number) => string | null;
  tipEl?: HTMLElement;
  ph?: HTMLElement;
}
export interface PlayOpts { f0?: number; f1?: number; count?: number; to?: Phase }
type Anim = { kind: AnimKind | 'payoutR'; t0: number; opts: PlayOpts; fans?: number; tHold?: number };
type Runners = Record<string, (t: number, o: PlayOpts) => boolean>;
type SampleOpts = { padRows?: number; gapRows?: number; padCols?: number; weights?: number[]; weight?: number; track?: number; minSquash?: number; thr?: number };
type Mats = {
  lacquer: THREE.MeshPhysicalMaterial; brass: THREE.MeshStandardMaterial; panel: THREE.MeshPhysicalMaterial; socket: THREE.MeshStandardMaterial;
  dot: THREE.MeshStandardMaterial; bulb: THREE.MeshStandardMaterial; glow: THREE.ShaderMaterial; black: THREE.MeshBasicMaterial; shadow: THREE.MeshBasicMaterial;
};
type Small = {
  g: THREE.Group; yF: number; lat: THREE.InstancedMesh; em: Float32Array; aux: Float32Array; pos: Float32Array; cells: number; cols: number; rows: number;
  amtCells: number[]; rods: THREE.Mesh[]; sh: THREE.Mesh; meshes: THREE.Mesh[]; plateMat: THREE.MeshStandardMaterial; texA: THREE.CanvasTexture; texB: THREE.CanvasTexture;
  drop: number; isPaid: boolean;
};
type AmtCell = { k: number; ci: number; x: number; y: number; z: number };
type SparkU = {
  uPopT: Val<number>; uGather: Val<number>; uSplit: Val<number>; uOn: Val<number>; uTime: Val<number>; uScale: Val<number>; uRes: Val<THREE.Vector2>;
  uSize: Val<number>; uCenter: Val<THREE.Vector3>; uRad: Val<THREE.Vector2>;
};

/* ---------------- lettering → lattice cells ---------------- */
function sampleText(lines: string[], cols: number, rows: number, o: SampleOpts = {}): number[] {
  const S = 12, cw = cols * S, ch = rows * S;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const n = lines.length, padR = o.padRows ?? 2, gapR = o.gapRows ?? 2, padC = o.padCols ?? 2;
  const weights = o.weights || lines.map(() => 1), wsum = weights.reduce((a, b) => a + b, 0);
  const avail = rows - 2 * padR - gapR * (n - 1), wt = o.weight || 900;
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `${wt} 100px ${FONT}`; const capRatio = (ctx.measureText('H').actualBoundingBoxAscent || 72) / 100;
  let y = padR * S;
  for (let i = 0; i < n; i++) {
    const bandH = avail * weights[i] / wsum * S;
    let size = bandH / capRatio, sx = 1;
    const setF = () => { ctx.font = `${wt} ${size}px ${FONT}`; if ('letterSpacing' in ctx) ctx.letterSpacing = `${(o.track ?? .07) * size}px`; };
    setF(); let w = ctx.measureText(lines[i]).width; const maxW = (cols - 2 * padC) * S;
    // eslint-disable-next-line no-useless-assignment -- verbatim port of the reference's re-measure
    if (w > maxW) { sx = Math.max(o.minSquash ?? .8, maxW / w); if (w * sx > maxW) { size *= maxW / (w * sx); setF(); w = ctx.measureText(lines[i]).width; } }
    const capH = capRatio * size, base = y + (bandH + capH) / 2;
    ctx.save(); ctx.translate(cw / 2, base); ctx.scale(sx, 1); ctx.fillText(lines[i], 0, 0); ctx.restore();
    y += bandH + gapR * S;
  }
  const data = ctx.getImageData(0, 0, cw, ch).data, out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let acc = 0; for (let sy = 0; sy < 4; sy++) for (let sxx = 0; sxx < 4; sxx++) { const px = c * S + 1.5 + sxx * 3, py = r * S + 1.5 + sy * 3; acc += data[((py | 0) * cw + (px | 0)) * 4 + 3]; }
    if (acc / 16 / 255 > (o.thr ?? .42)) out.push(r * cols + c);
  }
  return out;
}
/* 5x7 dot font (3-wide "$" so payout amounts keep their dollar sign on phones) */
const PX: Record<string, string> = {
  '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110', '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110', '4': '00010001100101010010111110001000010', '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110', '7': '11111000010001000100010000100001000', '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100', 'C': '01110100011000010000100001000101110', 'H': '10001100011000111111100011000110001',
  'A': '01110100011000111111100011000110001', 'R': '11110100011000111110101001001010001', 'G': '01110100011000010111100011000101111',
  'E': '11111100001000011110100001000011111', 'D': '11110100011000110001100011000111110',
};
const PX_DOLLAR = '010111100111001111010';
const pxWidth = (t: string) => [...t].reduce((w, ch) => w + (ch === ' ' ? 3 : ch === '$' ? 4 : 6), 0) - 1;
function pxText(text: string, cols: number, rowOff: number, out: number[]): number[] {
  let c0 = Math.floor((cols - pxWidth(text)) / 2);
  for (const ch of text) {
    if (ch === ' ') { c0 += 3; continue; }
    const w = ch === '$' ? 3 : 5, g = ch === '$' ? PX_DOLLAR : PX[ch];
    if (g) for (let r = 0; r < 7; r++) for (let c = 0; c < w; c++) if (g[r * w + c] === '1' && c0 + c >= 0 && c0 + c < cols) out.push((rowOff + r) * cols + c0 + c);
    c0 += w + 1;
  }
  return out;
}
function compose(cols: number, rows: number, lines: { t: string; px?: boolean }[], gap = 2, padCols = 3): number[] {
  const fixed = lines.reduce((a, l) => a + (l.px ? 7 : 0), 0), flex = lines.filter(l => !l.px);
  const free = rows - fixed - gap * (lines.length - 1) - 2;
  let r = 1; const out: number[] = [];
  for (const l of lines) {
    if (l.px) { pxText(l.t, cols, r, out); r += 7 + gap; continue; }
    const band = Math.floor(free / flex.length);
    sampleText([l.t], cols, band, { padRows: 0, gapRows: 0, padCols }).forEach(i => out.push(i + r * cols));
    r += band + gap;
  }
  return out;
}
const splitLines = (name: string) => { const w = name.trim().split(/\s+/); if (w.length < 2) return [name]; let best = 1, bd = Infinity; for (let i = 1; i < w.length; i++) { const d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i).join(' ').length); if (d < bd) { bd = d; best = i; } } return [w.slice(0, best).join(' '), w.slice(best).join(' ')]; };

/* ---------------- geometry + textures ---------------- */
function rrPath<P extends THREE.Path>(w: number, h: number, r: number, p: P): P { const x = -w / 2, y = -h / 2; p.moveTo(x + r, y); p.lineTo(x + w - r, y); p.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false); p.lineTo(x + w, y + h - r); p.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false); p.lineTo(x + r, y + h); p.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false); p.lineTo(x, y + r); p.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false); return p; }
function ringGeo(ow: number, oh: number, or_: number, iw: number, ih: number, ir: number, depth: number, bevel: number) {
  const s = rrPath(ow, oh, or_, new THREE.Shape()); s.holes.push(rrPath(iw, ih, ir, new THREE.Path()));
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * .8, bevelSegments: 3, curveSegments: 8 });
}
function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D, w: number, h: number) => void) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function brassPlate(text: string, paid: boolean) {
  return canvasTex(512, 112, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#EBCB82'); g.addColorStop(.45, '#C99F4B'); g.addColorStop(1, '#9C752B');
    x.fillStyle = g; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(70,45,10,.55)'; x.lineWidth = 5; x.strokeRect(8, 8, w - 16, h - 16);
    let size = 66; x.textBaseline = 'middle'; x.textAlign = 'left';
    const t2 = paid ? '  PAID' : '';
    const fit = () => { x.font = `800 ${size}px ${FONT}`; if ('letterSpacing' in x) x.letterSpacing = `${size * .1}px`; return x.measureText(text).width + (t2 ? x.measureText(t2).width : 0); };
    while (fit() > w - 40 && size > 30) size -= 2;
    const w1 = x.measureText(text).width, w2 = t2 ? x.measureText(t2).width : 0, x0 = (w - w1 - w2) / 2;
    x.fillStyle = '#2E1F08'; x.fillText(text, x0, h / 2 + 4);
    if (t2) { x.fillStyle = '#075A3C'; x.fillText(t2, x0 + w1, h / 2 + 4); }
  });
}
function shadowTex() {
  return canvasTex(256, 160, (x, w, h) => {
    x.fillStyle = '#000';
    if ('filter' in (x as object)) { x.filter = 'blur(16px)'; x.fillRect(42, 40, w - 84, h - 80); }
    else { const g = x.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(0,0,0,.9)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }
  });
}
function disposeTree(o: THREE.Object3D) { o.traverse(n => { if ((n as THREE.Mesh).geometry) (n as THREE.Mesh).geometry.dispose(); }); }

/* ---------------- materials + shaders ---------------- */
function dotMaterial(color: string, rough: number, uTime: THREE.IUniform<number>, env: THREE.Texture, envI: number, core: number) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, envMap: env, envMapIntensity: envI });
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
attribute vec4 aEm; attribute vec2 aAux; uniform float uTime; varying vec4 vEm; varying float vFacing; varying float vFlick; varying float vWhite;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vEm = aEm; vWhite = aAux.y;
vFacing = clamp(dot(normalize(transformedNormal), normalize(-mvPosition.xyz)), 0.0, 1.0);
float fl = sin(uTime*11.0 + aAux.x*37.0) * sin(uTime*5.3 + aAux.x*13.0);
vFlick = 1.0 + 0.24*fl*(1.0 - aEm.a);`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec4 vEm; varying float vFacing; varying float vFlick; varying float vWhite;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
float emax = max(vEm.r, max(vEm.g, vEm.b));
vec3 ehue = emax > 0.0001 ? vEm.rgb / emax : vec3(1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, ehue * vec3(1.0, 0.97, 0.92), clamp(vWhite, 0.0, 1.0));
totalEmissiveRadiance = vEm.rgb * (${core < 3 ? '0.32 + 1.1' : '0.12 + 1.6'}*pow(vFacing, ${core.toFixed(1)})) * vFlick;`);
  };
  m.customProgramCacheKey = () => 'marquee-dot-' + core;
  return m;
}
function glowMaterial(uTime: THREE.IUniform<number>, uGain: THREE.IUniform<number>) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime, uGain },
    vertexShader: `attribute vec4 aEm; attribute vec2 aAux; uniform float uTime; uniform float uGain; varying vec3 vC;
void main(){
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
  float f = clamp(dot(n, normalize(-mv.xyz)), 0.0, 1.0);
  float fl = sin(uTime*11.0 + aAux.x*37.0) * sin(uTime*5.3 + aAux.x*13.0);
  float flick = 1.0 + 0.24*fl*(1.0 - aEm.a);
  vC = aEm.rgb * (0.18 + 1.35*pow(f, 3.0)) * flick * uGain * mix(0.3, 1.0, clamp(aEm.a, 0.0, 1.0));
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
  });
}
const STREAK_COMMON = `uniform vec2 uRes; uniform float uScale; uniform float uTime;
varying vec2 vQ; varying float vLen; varying float vR; varying float vA; varying vec3 vCol;
float sm(float x){ x = clamp(x, 0.0, 1.0); return x*x*(3.0-2.0*x); }
void expand(vec3 head, vec3 tail, float rWorld){
  vec4 ch = projectionMatrix * modelViewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * modelViewMatrix * vec4(tail, 1.0);
  vec2 sh = ch.xy / ch.w * 0.5 * uRes, st = ct.xy / ct.w * 0.5 * uRes;
  float r = max(rWorld * uScale / ch.w, 0.9);
  vec2 d = sh - st; float L = length(d); vec2 dir = L > 0.001 ? d / L : vec2(1.0, 0.0); vec2 nrm = vec2(-dir.y, dir.x);
  float along = mix(-r, L + r, position.x), across = position.y * r;
  vQ = vec2(along, across); vLen = L; vR = r;
  gl_Position = vec4((st + dir*along + nrm*across) / (0.5*uRes), mix(ct.z/ct.w, ch.z/ch.w, position.x), 1.0);
}`;
const STREAK_FRAG = `varying vec2 vQ; varying float vLen; varying float vR; varying float vA; varying vec3 vCol;
void main(){
  float u = clamp(vQ.x, 0.0, vLen); float d = length(vec2(vQ.x - u, vQ.y)) / vR; if (d > 1.0 || vA < 0.002) discard;
  float core = 1.0 - d; core *= core;
  float tailFade = vLen > 0.5 ? mix(0.15, 1.0, u / vLen) : 1.0;
  float headDot = max(0.0, 1.0 - length(vQ - vec2(vLen, 0.0)) / vR);
  gl_FragColor = vec4(vCol * (core*tailFade*1.3 + headDot*headDot*1.4) * vA, 1.0);
}`;
/* sparks: burst from the name, swirl, gather into a message (gather) or arc to payout signs (split) */
const SPARK_VERT = `attribute vec3 aA; attribute vec3 aB; attribute vec3 aC; attribute vec4 aSeed; attribute vec2 aStag;
uniform float uPopT; uniform float uGather; uniform float uSplit; uniform float uOn; uniform float uSize;
uniform vec3 uCenter; uniform vec2 uRad;
${STREAK_COMMON}
vec3 P(float popT, float gth, float spl, out float alpha, out float gkO, out float skO, out float exO){
  float since = popT - aSeed.w*0.12; float pt = max(since, 0.0); float popped = step(0.0001, since);
  vec3 rel = aA - uCenter; vec2 q = vec2(rel.x/uRad.x, rel.y/uRad.y);
  float ang0 = atan(q.y, q.x), r0 = length(q);
  float ex = 1.0 - pow(1.0 - clamp(pt/0.5, 0.0, 1.0), 3.0);
  float rr = mix(r0, 0.38 + 0.5*aSeed.x, ex);
  float ang = ang0 + (2.3 + 1.6*aSeed.y)*pt;
  vec3 orbit = uCenter + vec3(cos(ang)*rr*uRad.x, sin(ang)*rr*uRad.y, (0.3 + 0.6*aSeed.z)*ex + 0.07*sin(pt*6.0 + aSeed.x*20.0));
  float gk = sm(gth*1.7 - aStag.x*0.7);
  vec3 bP = aB + vec3(0.0, 0.0, 0.02);
  vec3 p = mix(orbit, bP, gk); p.z += 0.22*sin(gk*3.14159);
  float sk = sm(spl*1.6 - aStag.y*0.6);
  vec3 cP = aC + vec3(0.0, 0.0, 0.02);
  vec3 ctrl = 0.5*(bP + cP) + vec3(0.0, 0.3, 0.95);
  vec3 sp = mix(mix(bP, ctrl, sk), mix(ctrl, cP, sk), sk);
  float splitting = step(0.0001, spl);
  p = mix(p, sp, splitting);
  float aG = (1.0 - smoothstep(0.88, 1.0, gk)) * popped;
  float aS = smoothstep(0.0, 0.04, sk) * (1.0 - smoothstep(0.9, 1.0, sk));
  alpha = mix(aG, aS, splitting); gkO = gk; skO = sk; exO = ex * (1.0 - splitting);
  return p;
}
void main(){
  float a, gk, sk, ex, a2, g2, s2, e2; float dt = 0.06;
  vec3 head = P(uPopT, uGather, uSplit, a, gk, sk, ex);
  vec3 tail = P(uPopT - dt, clamp(uGather - dt/0.62, 0.0, 1.0), clamp(uSplit - dt/0.9, 0.0, 1.0), a2, g2, s2, e2);
  vA = uOn * a;
  float tw = 0.7 + 0.5*sin(uTime*26.0 + aSeed.x*71.0);
  vec3 gold = vec3(1.0, 0.6, 0.2), cream = vec3(1.0, 0.86, 0.56);
  vCol = mix(mix(gold*mix(tw, 1.0, gk), cream, gk), mix(cream, gold, sin(sk*3.14159)*0.6), step(0.0001, uSplit));
  expand(head, tail, uSize*(1.0 + 0.4*ex*(1.0 - gk) + 0.3*sin(sk*3.14159)));
}`;
const EMBER_VERT = `attribute vec3 aA; attribute vec3 aV; attribute vec3 aL; uniform float uT; uniform float uSize;
${STREAK_COMMON}
vec3 E(float t){ float tt = max(t, 0.0); return aA + aV*(1.0 - exp(-tt*2.4))/2.4 + vec3(0.0, -0.8*tt*tt, 0.0); }
void main(){
  float t = uT - aL.y; float k = clamp(t/aL.x, 0.0, 1.0);
  vA = step(0.0, t) * (1.0 - k) * step(k, 0.999);
  vCol = mix(vec3(1.0, 0.82, 0.45), vec3(1.0, 0.36, 0.08), k);
  expand(E(t), E(t - 0.05), uSize*(1.0 - 0.5*k));
}`;
const ORB_VERT = `attribute vec3 aA; attribute vec3 aO; uniform float uT; uniform float uFans; uniform float uScale; uniform float uSize;
varying float vA; varying vec3 vCol;
void main(){
  float t = uT - aO.x - 0.06; float k = clamp(t/1.85, 0.0, 1.0); float e = k*k*(3.0-2.0*k);
  vec3 p = aA + vec3((aO.y - 0.5)*0.55*e + sin(t*2.3 + aO.y*6.28)*0.05*k, e*1.75, 0.08 + 0.5*e);
  float on = step(aO.z, uFans - 0.5) * step(0.0, t);
  vA = on * smoothstep(0.0, 0.07, k) * (1.0 - smoothstep(0.55, 1.0, k));
  vCol = mix(vec3(1.0, 0.8, 0.55), vec3(0.62, 0.55, 1.0), smoothstep(0.0, 0.35, k));
  vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
  gl_PointSize = max(uSize*(1.0 + 0.5*e)*uScale / -mv.z, 1.0);
}`;
const ORB_FRAG = `varying float vA; varying vec3 vCol; uniform float uCore;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d)*2.0; if (r > 1.0) discard;
  float core = smoothstep(uCore, 0.0, r); float halo = pow(1.0 - r, 3.0)*0.3;
  gl_FragColor = vec4(vCol*(core*1.8 + halo)*vA*1.2, 1.0); }`;
const COMPOSITE = {
  uniforms: { tBase: { value: null }, tGlow: { value: null }, tBloom: { value: null }, uGlowK: { value: .62 }, uBloomK: { value: .55 }, uFlash: { value: 0 }, uExposure: { value: 1.0 }, uSat: { value: 1.35 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tBase; uniform sampler2D tGlow; uniform sampler2D tBloom; uniform float uGlowK; uniform float uBloomK; uniform float uFlash; uniform float uExposure; uniform float uSat; varying vec2 vUv;
vec3 neutralTM(vec3 color){
  const float sc = 0.76; const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b)); float off = x < 0.08 ? x - 6.25*x*x : 0.04; color -= off;
  float peak = max(color.r, max(color.g, color.b)); if (peak < sc) return color;
  float d = 1.0 - sc; float np = 1.0 - d*d/(peak + d - sc); color *= np/peak;
  float g = 1.0 - 1.0/(desat*(peak - np) + 1.0); return mix(color, vec3(np), g);
}
vec3 oetf(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main(){
  vec4 b = texture2D(tBase, vUv);
  float a = clamp(b.a, 0.0, 1.0); vec3 c = b.rgb / max(a, 0.0001);
  vec3 sh = texture2D(tGlow, vUv).rgb, bl = texture2D(tBloom, vUv).rgb; // sharp emissive, bloom only
  // bloom landing on a coloured surface takes that surface's hue (warm light on red lacquer stays red, never pink)
  float cmax = max(c.r, max(c.g, c.b)), cmin = min(c.r, min(c.g, c.b));
  float sat = cmax > 0.0001 ? 1.0 - cmin/cmax : 0.0;
  vec3 chue = cmax > 0.0001 ? c/cmax : vec3(1.0);
  float surf = smoothstep(0.45, 0.85, sat) * (1.0 - smoothstep(0.55, 1.1, cmax));
  vec3 tint = mix(vec3(1.0), chue*vec3(0.62, 0.16, 0.04), surf);
  vec3 sgn = oetf(neutralTM((c + sh*uGlowK + bl*uBloomK*tint)*uExposure));
  // light that lands on the paper wall: crisp spark cores, a whisper of haze
  float ms = max(sh.r, max(sh.g, sh.b)), mb = max(bl.r, max(bl.g, bl.b));
  vec3 hs = sh / max(ms, 0.0001), hb = bl / max(mb, 0.0001);
  hs = clamp(mix(vec3(dot(hs, vec3(0.299, 0.587, 0.114))), hs, uSat), 0.0, 1.0);
  hb = clamp(mix(vec3(dot(hb, vec3(0.299, 0.587, 0.114))), hb, uSat), 0.0, 1.0);
  float gb = min(mb*0.12, 0.08) + uFlash*smoothstep(0.1, 0.7, mb)*0.16;
  float gs = smoothstep(0.4, 1.5, ms)*0.8;
  vec3 col = oetf(hb*0.8)*gb; float al = gb;
  col = oetf(hs*0.82)*gs + col*(1.0 - gs); al = gs + al*(1.0 - gs);
  float edge = smoothstep(0.0, 0.08, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  col *= edge; al *= edge;
  gl_FragColor = vec4(sgn*a + col*(1.0 - a), a + al*(1.0 - a));
}`,
};

/* ================= SignHost: one WebGL context for every sign ================= */
export class SignHost {
  declare canvas: HTMLCanvasElement;
  declare renderer: THREE.WebGLRenderer;
  declare env: THREE.Texture;
  declare pr: number;
  declare views: SignView[];
  declare w: number;
  declare h: number;
  static async create(): Promise<SignHost | null> {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-empty -- verbatim port of the reference's swallow-errors catch
    try { await Promise.race([Promise.all([document.fonts.load(`900 100px ${FONT}`), document.fonts.load(`800 60px ${FONT}`)]), new Promise(r => setTimeout(r, 3500))]); } catch (_) { }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- verbatim port of the reference's catch binding
    try { return new SignHost(); } catch (_) { return null; }
  }
  constructor() {
    this.canvas = document.createElement('canvas');
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1); r.setClearColor(0x000000, 0); r.autoClear = false; r.toneMapping = THREE.NoToneMapping;
    const pm = new THREE.PMREMGenerator(r); this.env = pm.fromScene(new RoomEnvironment(), .04).texture; pm.dispose();
    this.pr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.views = []; this.w = 1; this.h = 1; r.setSize(1, 1, false);
  }
  ensure(w: number, h: number) { if (w > this.w || h > this.h) { this.w = Math.max(w, this.w); this.h = Math.max(h, this.h); this.renderer.setSize(this.w, this.h, false); } }
  add(stage: HTMLElement, model: SignModel, opts?: SignOpts) { const v = new SignView(this, stage, model, opts); this.views.push(v); return v; }
  tick(now: number) { for (const v of this.views) v.tick(now); }
}

/* ================= SignView: one marquee ================= */
export class SignView {
  declare host: SignHost;
  declare stage: HTMLElement;
  declare model: SignModel;
  declare opts: SignOpts;
  declare r: THREE.WebGLRenderer;
  declare canvas: HTMLCanvasElement;
  declare ctx: CanvasRenderingContext2D;
  declare scene: THREE.Scene;
  declare camera: THREE.PerspectiveCamera;
  declare uTime: Val<number>;
  declare uGain: Val<number>;
  declare M: Mats;
  declare cRed: THREE.Color;
  declare cDim: THREE.Color;
  declare rtBase: THREE.WebGLRenderTarget;
  declare rtGlow: THREE.WebGLRenderTarget;
  declare bloom: UnrealBloomPass;
  declare comp: THREE.ShaderMaterial;
  declare quad: FullScreenQuad;
  declare ray: THREE.Raycaster;
  declare par: { x: number; y: number };
  declare parT: { x: number; y: number };
  declare anim: Anim | null;
  declare awake: number;
  declare lastRender: number;
  declare dirty: boolean;
  declare onScreen: boolean;
  declare hover: number;
  declare idleStep: number;
  declare tense: boolean;
  declare tags: Map<number, string>;
  declare tagEls: Map<number, HTMLSpanElement>;
  declare st: { frame: number; push: number; env: number; bloom: number; flash: number; dim: number };
  declare uRes: Val<THREE.Vector2>;
  declare uScale: Val<number>;
  declare layout: Layout | null | undefined;
  declare L: (typeof LAYOUTS)[Layout];
  declare root: THREE.Group;
  declare boardMeshes: THREE.Mesh[];
  declare dotMeshes: THREE.InstancedMesh[];
  declare glowOnly: (THREE.Mesh | THREE.Points)[];
  declare shadows: THREE.Mesh[];
  declare board: (geo: THREE.BufferGeometry, mat: THREE.Material, parent?: THREE.Object3D) => THREE.Mesh;
  declare rb: number;
  declare tw: number;
  declare th: number;
  declare bEm: Float32Array;
  declare bAux: Float32Array;
  declare bulbs: THREE.InstancedMesh;
  declare bPos: THREE.Vector3[];
  declare bXn: number[];
  declare screw: Float32Array;
  declare screwZ: Float32Array;
  declare cols: number;
  declare rows: number;
  declare pitch: number;
  declare cEm: Float32Array;
  declare cAux: Float32Array;
  declare cPos: Float32Array;
  declare cXn: Float32Array;
  declare lattice: THREE.InstancedMesh;
  declare sets: { name: number[]; itson: number[]; off: number[] };
  declare smalls: Small[];
  declare pm: { N: number; nameP: Int32Array; itP: Int32Array; stagG: Float32Array; delay: Float32Array; gk: Float32Array };
  declare uRad: Val<THREE.Vector2>;
  declare uCenter: Val<THREE.Vector3>;
  declare sparks: THREE.Mesh;
  declare uP: SparkU;
  declare mkSparks: (count: number, attrs: [string, Float32Array, number][]) => THREE.Mesh;
  declare flow: THREE.Mesh | null;
  declare uE: { uT: Val<number>; uScale: Val<number>; uRes: Val<THREE.Vector2>; uTime: Val<number>; uSize: Val<number> };
  declare embers: THREE.Mesh;
  declare uO: { uT: Val<number>; uFans: Val<number>; uScale: Val<number>; uSize: Val<number>; uCore: Val<number> };
  declare orbs: THREE.Points;
  declare fm: { N: number; amt: AmtCell[]; amtP: Int32Array; stagS: Float32Array; sk: Float32Array };
  declare frames: { rest: { ty: number; d: number }; paid: { ty: number; d: number } };
  declare aspect: number | undefined;
  declare dw: number;
  declare dh: number;
  declare ptr: { x: number; y: number } | undefined;
  declare needPick: boolean | undefined;
  declare warm: boolean;
  declare phase: Phase;
  declare fans: number;
  declare ambStep: number | undefined;
  declare shown: boolean | undefined;
  /* model: { name, crest, target, seed, yaw, payees:[{label, amount}] }
     opts:  { state: () => ({phase, fans}), tip: slot => text|null, tipEl, ph } */
  constructor(host: SignHost, stage: HTMLElement, model: SignModel, opts: SignOpts = {}) {
    this.host = host; this.stage = stage; this.model = model; this.opts = opts; this.r = host.renderer;
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d')!;
    stage.insertBefore(this.canvas, opts.tipEl || null);
    this.scene = new THREE.Scene(); this.scene.environment = host.env;
    const key = new THREE.DirectionalLight(0xfff0dc, 1.0); key.position.set(-2.6, 3.4, 4.2); this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0xfff8ee, 0x7a5a44, .35));
    this.camera = new THREE.PerspectiveCamera(22, 2, .1, 60);
    this.uTime = { value: 0 }; this.uGain = { value: 1 };
    const env = host.env;
    this.M = {
      lacquer: new THREE.MeshPhysicalMaterial({ color: '#C8221B', roughness: .34, metalness: 0, clearcoat: 1, clearcoatRoughness: .04, envMap: env, envMapIntensity: .6 }),
      brass: new THREE.MeshStandardMaterial({ color: '#D2A452', metalness: 1, roughness: .27 }),
      panel: new THREE.MeshPhysicalMaterial({ color: '#1E0806', roughness: .6, clearcoat: .4, clearcoatRoughness: .25, envMap: env, envMapIntensity: .5 }),
      socket: new THREE.MeshStandardMaterial({ color: '#0E0605', roughness: .12, metalness: 0 }),
      dot: dotMaterial('#100504', .3, this.uTime, env, .42, 2.2),
      bulb: dotMaterial('#5A1410', .1, this.uTime, env, .85, 5.0),
      glow: glowMaterial(this.uTime, this.uGain),
      black: new THREE.MeshBasicMaterial({ color: 0x000000 }),
      shadow: new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowTex(), transparent: true, opacity: .34, depthWrite: false }),
    };
    this.cRed = new THREE.Color('#C8221B'); this.cDim = new THREE.Color('#8F2420');
    this.rtBase = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.rtGlow = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), .8, .32, 0);
    (this.bloom.copyUniforms as { opacity: Val<number> }).opacity.value = 0; // keep rtGlow sharp-only; the composite reads the bloom texture itself
    this.comp = new THREE.ShaderMaterial({ ...COMPOSITE, uniforms: THREE.UniformsUtils.clone(COMPOSITE.uniforms), depthTest: false, depthWrite: false });
    this.comp.uniforms.tBase.value = this.rtBase.texture; this.comp.uniforms.tGlow.value = this.rtGlow.texture; this.comp.uniforms.tBloom.value = this.bloom.renderTargetsHorizontal[0].texture;
    this.quad = new FullScreenQuad(this.comp);
    this.ray = new THREE.Raycaster();
    this.par = { x: 0, y: 0 }; this.parT = { x: 0, y: 0 };
    this.anim = null; this.awake = 0; this.lastRender = 0; this.dirty = true; this.onScreen = true; this.hover = -1; this.idleStep = -1; this.tense = false;
    this.tags = new Map(); this.tagEls = new Map();
    this.st = { frame: 0, push: 0, env: 1, bloom: .8, flash: 0, dim: 0 };
    this.uRes = { value: new THREE.Vector2(1, 1) }; this.uScale = { value: 500 };
    new ResizeObserver(() => this.resize()).observe(stage);
    new IntersectionObserver(es => { this.onScreen = es[0].isIntersecting; }).observe(stage);
    stage.addEventListener('pointermove', e => this.onPointer(e));
    stage.addEventListener('pointerleave', () => { this.parT.x = this.parT.y = 0; this.setHover(-1); });
    this.resize();
  }

  /* ---------- build ---------- */
  setModel(model: SignModel) { this.model = model; this.layout = null; this.resize(); }
  build(layout: Layout) {
    if (this.root) { this.scene.remove(this.root); disposeTree(this.root); }
    this.layout = layout; const L = this.L = LAYOUTS[layout], md = this.model, M = this.M;
    const root = this.root = new THREE.Group();
    root.rotation.set(-.055, layout === 'tall' ? (md.yaw ?? .2) * .55 : (md.yaw ?? .2), 0);
    this.scene.add(root);
    this.boardMeshes = []; this.dotMeshes = []; this.glowOnly = []; this.shadows = [];
    const board = this.board = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = root) => { const m = new THREE.Mesh(geo, mat); m.userData.mat = mat; this.boardMeshes.push(m); parent.add(m); return m; };
    const fz = L.D / 2;
    board(new RoundedBoxGeometry(L.W, L.H, L.D, 5, .07), M.lacquer);
    board(ringGeo(L.W - .03, L.H - .03, .06, L.W - .09, L.H - .09, .035, .008, .008), M.brass).position.z = fz - .008;
    const pw = L.W - 2 * L.panelIn, ph = L.H - 2 * L.panelIn;
    board(ringGeo(pw + .1, ph + .1, .045, pw + .008, ph + .008, .012, .014, .011), M.brass).position.z = fz - .006;
    board(new THREE.PlaneGeometry(pw + .03, ph + .03), M.panel).position.z = fz + .002;
    // crest plate
    const crestW = Math.min(1.5, L.W * .46), crestH = .2;
    board(new RoundedBoxGeometry(crestW, crestH, .1, 3, .03), M.brass).position.set(0, L.H / 2 + crestH / 2 - .02, -.02);
    const crestMat = new THREE.MeshStandardMaterial({ map: canvasTex(768, 104, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#E9C77C'); g.addColorStop(1, '#A57D30'); x.fillStyle = g; x.fillRect(0, 0, w, h);
      let size = 64; const t = (md.crest || '').toUpperCase(); x.textAlign = 'center'; x.textBaseline = 'middle';
      const fit = () => { x.font = `800 ${size}px ${FONT}`; if ('letterSpacing' in x) x.letterSpacing = `${size * .14}px`; return x.measureText(t).width; };
      while (fit() > w - 60 && size > 28) size -= 2;
      x.fillStyle = '#2E1F08'; x.fillText(t, w / 2, h / 2 + 4);
    }), metalness: .75, roughness: .32 });
    board(new THREE.PlaneGeometry(crestW - .05, crestH - .06), crestMat).position.set(0, L.H / 2 + crestH / 2 - .02, .031);
    // border: one socket + bulb per fan slot
    const n = md.target, tw = L.W - 2 * L.track, th = L.H - 2 * L.track;
    const pts = trackPoints2D(tw, th, .085, n), per = 2 * (tw + th), rb = Math.min(.062, per / n * .3);
    this.rb = rb; this.tw = tw; this.th = th;
    const sock = new THREE.InstancedMesh(new THREE.CylinderGeometry(rb * .8, rb * .95, .045, 20).rotateX(Math.PI / 2), M.brass, n); sock.userData.mat = M.brass; this.boardMeshes.push(sock); root.add(sock);
    const hole = new THREE.InstancedMesh(new THREE.CircleGeometry(rb * .64, 20), M.socket, n); hole.userData.mat = M.socket; this.boardMeshes.push(hole); root.add(hole);
    const bulbGeo = new THREE.SphereGeometry(rb, 20, 14);
    this.bEm = new Float32Array(n * 4); this.bAux = new Float32Array(n * 2);
    const rnd = mulberry32((md.seed || 7) * 131 + 7);
    for (let i = 0; i < n; i++) this.bAux[i * 2] = rnd();
    bulbGeo.setAttribute('aEm', new THREE.InstancedBufferAttribute(this.bEm, 4)); bulbGeo.setAttribute('aAux', new THREE.InstancedBufferAttribute(this.bAux, 2));
    const bulbs = this.bulbs = new THREE.InstancedMesh(bulbGeo, M.bulb, n); bulbs.userData.mat = M.bulb; bulbs.frustumCulled = false;
    this.dotMeshes.push(bulbs); root.add(bulbs);
    const mtx = new THREE.Matrix4();
    this.bPos = pts.map(p => new THREE.Vector3(p.x, p.y, fz + .045 + rb * .72));
    this.bXn = pts.map(p => (p.x + tw / 2) / tw);
    pts.forEach((p, i) => { mtx.makeTranslation(p.x, p.y, fz + .0225); sock.setMatrixAt(i, mtx); mtx.makeTranslation(p.x, p.y, fz + .0455); hole.setMatrixAt(i, mtx); });
    this.screw = new Float32Array(n); this.screwZ = new Float32Array(n);
    // lattice: a full dot-matrix of glass bulbs
    const rows = L.rows, pitch = ph / rows, cols = Math.floor(pw / pitch), offX = (pw - cols * pitch) / 2, cells = cols * rows;
    this.cols = cols; this.rows = rows; this.pitch = pitch;
    const dotGeo = new THREE.SphereGeometry(pitch * .37, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
    this.cEm = new Float32Array(cells * 4); this.cAux = new Float32Array(cells * 2); this.cPos = new Float32Array(cells * 3); this.cXn = new Float32Array(cells);
    dotGeo.setAttribute('aEm', new THREE.InstancedBufferAttribute(this.cEm, 4)); dotGeo.setAttribute('aAux', new THREE.InstancedBufferAttribute(this.cAux, 2));
    const lat = this.lattice = new THREE.InstancedMesh(dotGeo, M.dot, cells); lat.userData.mat = M.dot; lat.frustumCulled = false;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, x = -pw / 2 + offX + (c + .5) * pitch, y = ph / 2 - (r + .5) * pitch;
      this.cPos[i * 3] = x; this.cPos[i * 3 + 1] = y; this.cPos[i * 3 + 2] = fz + .003; this.cXn[i] = (c + .5) / cols;
      this.cAux[i * 2] = rnd(); mtx.makeTranslation(x, y, fz + .003); lat.setMatrixAt(i, mtx);
    }
    this.dotMeshes.push(lat); root.add(lat);
    const name = md.name.toUpperCase();
    this.sets = {
      name: sampleText(L.lines === 2 ? splitLines(name) : [name], cols, rows, { padRows: L.lines === 2 ? 2 : 3, gapRows: 3, padCols: 3 }),
      itson: sampleText(L.lines === 2 ? ['IT’S', 'ON'] : ['IT’S ON'], cols, rows, { padRows: 2, gapRows: 3, padCols: 3, track: .1 }),
      off: L.lines === 2 ? compose(cols, rows, [{ t: 'CALLED' }, { t: 'OFF' }, { t: '$0 CHARGED', px: true }], 2, 2)
        : compose(cols, rows, [{ t: 'CALLED OFF' }, { t: '$0 CHARGED', px: true }], 2, 4),
    };
    // wall shadow
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(L.W + 1.1, L.H + 1.0), M.shadow); sh.position.set(.1, -.17, -fz - .03); root.add(sh); this.shadows.push(sh);
    this.smalls = []; this.buildSmalls(md.payees || []);
    this.buildFx();
    this.computeFrames();
    this.syncTags();
    this.warm = true;
  }
  /* payout signs hang under the main sign on brass rods; 2–4 of them */
  setPayouts(payees: Payee[]) { this.model = { ...this.model, payees }; if (this.root) { this.buildSmalls(payees); this.warm = true; this.dirty = true; } }
  buildSmalls(payees: Payee[]) {
    for (const s of this.smalls || []) { this.root.remove(s.g); s.rods.forEach(r => this.root.remove(r)); disposeTree(s.g); }
    const rm = new Set(this.smalls.flatMap(s => [...s.meshes, ...s.rods])); this.boardMeshes = this.boardMeshes.filter(m => !rm.has(m));
    const rmDots = new Set(this.smalls.map(s => s.lat)); this.dotMeshes = this.dotMeshes.filter(m => !rmDots.has(m));
    const rmSh = new Set(this.smalls.map(s => s.sh)); this.shadows = this.shadows.filter(m => !rmSh.has(m));
    this.smalls = [];
    const L = this.L, S = L.small, n = payees.length; if (!n) return;
    const span = L.W * .98, gapX = n === 2 ? .3 : .12, w = Math.min(S.w, (span - (n - 1) * gapX) / n);
    // choose the lattice rows so every amount (with its "$") fits
    const texts = payees.map(p => `$${Math.round(p.amount)}`);
    let rows = 10; const colsFor = (rws: number) => { const iw = w - .1, ih = S.h - .12, lw = iw - .03, lh = ih - S.plateH - .04; return Math.floor(lw / (lh / rws)); };
    while (rows < 14 && texts.some(t => pxWidth(t) > colsFor(rows))) rows++;
    payees.forEach((p, k) => this.buildSmall(k, p.label, texts[k], (k - (n - 1) / 2) * (w + gapX), w, rows));
  }
  buildSmall(k: number, label: string, amtText: string, x: number, w: number, rows: number) {
    const L = this.L, S = L.small, M = this.M, root = this.root, before = this.boardMeshes.length;
    const g = new THREE.Group(); root.add(g);
    const yF = -L.H / 2 - S.gap - S.h / 2; g.position.set(x, yF, 0); g.visible = false;
    const board = (geo: THREE.BufferGeometry, mat: THREE.Material) => this.board(geo, mat, g);
    board(new RoundedBoxGeometry(w, S.h, S.d, 4, .035), M.lacquer);
    const iw = w - .1, ih = S.h - .12, fz = S.d / 2;
    board(ringGeo(w - .022, S.h - .022, .03, w - .056, S.h - .056, .02, .006, .006), M.brass).position.z = fz - .006;
    board(ringGeo(iw + .04, ih + .04, .025, iw + .004, ih + .004, .01, .01, .008), M.brass).position.z = fz - .004;
    board(new THREE.PlaneGeometry(iw + .01, ih + .01), M.panel).position.z = fz + .002;
    const texA = brassPlate(label.toUpperCase(), false), texB = brassPlate(label.toUpperCase(), true);
    const plateMat = new THREE.MeshStandardMaterial({ map: texA, metalness: .7, roughness: .34 });
    board(new THREE.PlaneGeometry(iw - .02, S.plateH), plateMat).position.set(0, ih / 2 - S.plateH / 2 - .01, fz + .004);
    const lw = iw - .03, lh = ih - S.plateH - .04, cy = -ih / 2 + lh / 2 + .012;
    const pitch = lh / rows, cols = Math.floor(lw / pitch), offX = (lw - cols * pitch) / 2, cells = rows * cols;
    const geo = new THREE.SphereGeometry(pitch * .37, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
    const em = new Float32Array(cells * 4), aux = new Float32Array(cells * 2), pos = new Float32Array(cells * 3);
    geo.setAttribute('aEm', new THREE.InstancedBufferAttribute(em, 4)); geo.setAttribute('aAux', new THREE.InstancedBufferAttribute(aux, 2));
    const lat = new THREE.InstancedMesh(geo, M.dot, cells); lat.userData.mat = M.dot; lat.frustumCulled = false;
    const mtx = new THREE.Matrix4(), rnd = mulberry32((this.model.seed || 7) * 17 + k);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c, xx = -lw / 2 + offX + (c + .5) * pitch, yy = cy + lh / 2 - (r + .5) * pitch;
      pos[i * 3] = xx; pos[i * 3 + 1] = yy; pos[i * 3 + 2] = fz + .003; aux[i * 2] = rnd(); mtx.makeTranslation(xx, yy, fz + .003); lat.setMatrixAt(i, mtx);
    }
    this.dotMeshes.push(lat); g.add(lat);
    const amtCells = pxText(amtText, cols, Math.floor((rows - 7) / 2), []);
    const rods = [-1, 1].map(s => { const rod = this.board(new THREE.CylinderGeometry(.011, .011, 1, 10), M.brass); rod.position.set(x + s * (w / 2 - .14), 0, 0); rod.visible = false; return rod; });
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(w + .5, S.h + .5), M.shadow); sh.position.set(.06, -.1, -S.d / 2 - .03); g.add(sh); this.shadows.push(sh);
    const meshes = this.boardMeshes.slice(before).filter(m => !rods.includes(m));
    this.smalls.push({ g, yF, lat, em, aux, pos, cells, cols, rows, amtCells, rods, sh, meshes, plateMat, texA, texB, drop: 0, isPaid: false });
  }
  quadGeo(count: number) { const g = new THREE.InstancedBufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)); g.setIndex([0, 1, 2, 0, 2, 3]); g.instanceCount = count; return g; }
  buildFx() {
    const md = this.model, L = this.L, rnd = mulberry32((md.seed || 7) * 977 + 13), P = this.cPos, cells = this.cols * this.rows;
    const byX = (a: number, b: number) => P[a * 3] - P[b * 3] || P[b * 3 + 1] - P[a * 3 + 1];
    const nameS = this.sets.name.slice().sort(byX), itS = this.sets.itson.slice().sort(byX);
    // each spark carries a small cluster of cells, so the swirl stays readable
    const N = Math.max(1, Math.min(280, Math.max(nameS.length, itS.length)));
    const nameP = new Int32Array(cells).fill(0), itP = new Int32Array(cells).fill(0);
    nameS.forEach((c, j) => nameP[c] = Math.floor(j * N / nameS.length)); itS.forEach((c, j) => itP[c] = Math.floor(j * N / itS.length));
    const aA = new Float32Array(N * 3), aB = new Float32Array(N * 3), aC = new Float32Array(N * 3), aSeed = new Float32Array(N * 4), aStag = new Float32Array(N * 2);
    const stagG = new Float32Array(N), delay = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const s = nameS[Math.floor((i + .5) * nameS.length / N)] ?? 0, d = itS[Math.floor((i + .5) * itS.length / N)] ?? 0;
      aA.set([P[s * 3], P[s * 3 + 1], P[s * 3 + 2]], i * 3); aB.set([P[d * 3], P[d * 3 + 1], P[d * 3 + 2]], i * 3);
      const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
      aSeed.set([r1, r2, r3, r4], i * 4); delay[i] = r4 * .12; stagG[i] = this.cXn[d] * .85 + rnd() * .15; aStag.set([stagG[i], 0], i * 2);
    }
    this.pm = { N, nameP, itP, stagG, delay, gk: new Float32Array(N) };
    this.uRad = { value: new THREE.Vector2(L.W * .52, L.H * .66) }; this.uCenter = { value: new THREE.Vector3(0, 0, L.D / 2) };
    const mkSparks = (count: number, attrs: [string, Float32Array, number][]) => {
      const geo = this.quadGeo(count); for (const [k, v, sz] of attrs) geo.setAttribute(k, new THREE.InstancedBufferAttribute(v, sz));
      const u = { uPopT: { value: 0 }, uGather: { value: 0 }, uSplit: { value: 0 }, uOn: { value: 0 }, uTime: this.uTime, uScale: this.uScale, uRes: this.uRes, uSize: { value: this.pitch * .42 }, uCenter: this.uCenter, uRad: this.uRad };
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: SPARK_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
      mesh.frustumCulled = false; mesh.visible = false; this.root.add(mesh); this.glowOnly.push(mesh); mesh.userData.u = u; return mesh;
    };
    this.sparks = mkSparks(N, [['aA', aA, 3], ['aB', aB, 3], ['aC', aC, 3], ['aSeed', aSeed, 4], ['aStag', aStag, 2]]);
    this.uP = this.sparks.userData.u;
    this.mkSparks = mkSparks; this.flow = null;
    // embers
    const NE = 220, eA = new Float32Array(NE * 3), eV = new Float32Array(NE * 3), eL = new Float32Array(NE * 3);
    for (let i = 0; i < NE; i++) {
      const s = nameS[Math.floor(rnd() * nameS.length)] ?? 0; eA.set([P[s * 3], P[s * 3 + 1], P[s * 3 + 2] + .02], i * 3);
      eV.set([(rnd() - .5) * 2.6, .4 + rnd() * 1.9, .5 + rnd() * 1.6], i * 3); eL.set([.6 + rnd() * .9, rnd() * .14, rnd()], i * 3);
    }
    const eg = this.quadGeo(NE); eg.setAttribute('aA', new THREE.InstancedBufferAttribute(eA, 3)); eg.setAttribute('aV', new THREE.InstancedBufferAttribute(eV, 3)); eg.setAttribute('aL', new THREE.InstancedBufferAttribute(eL, 3));
    this.uE = { uT: { value: -1 }, uScale: this.uScale, uRes: this.uRes, uTime: this.uTime, uSize: { value: this.pitch * .32 } };
    const embers = this.embers = new THREE.Mesh(eg, new THREE.ShaderMaterial({ uniforms: this.uE, vertexShader: EMBER_VERT, fragmentShader: STREAK_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    embers.frustumCulled = false; embers.visible = false; this.root.add(embers); this.glowOnly.push(embers);
    // orbs: each fan's light going home (miss)
    const n = md.target, oA = new Float32Array(n * 3), oO = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const p = this.bPos[i]; oA.set([p.x, p.y, p.z], i * 3); oO.set([(1 - this.bXn[i]) * MISS.wave, rnd(), i], i * 3); }
    const og = new THREE.BufferGeometry(); og.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    og.setAttribute('aA', new THREE.BufferAttribute(oA, 3)); og.setAttribute('aO', new THREE.BufferAttribute(oO, 3));
    this.uO = { uT: { value: -1 }, uFans: { value: 0 }, uScale: this.uScale, uSize: { value: this.rb * 3.2 }, uCore: { value: .62 } };
    const orbs = this.orbs = new THREE.Points(og, new THREE.ShaderMaterial({ uniforms: this.uO, vertexShader: ORB_VERT, fragmentShader: ORB_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    orbs.frustumCulled = false; orbs.visible = false; this.root.add(orbs); this.glowOnly.push(orbs);
  }
  /* money flowing from the lit border bulbs down into the payout signs */
  buildFlow() {
    if (this.flow) { this.root.remove(this.flow); this.flow.geometry.dispose(); this.glowOnly = this.glowOnly.filter(m => m !== this.flow); }
    const amt: AmtCell[] = []; this.smalls.forEach((s, k) => { s.amtCells.slice().sort((a, b) => s.pos[a * 3] - s.pos[b * 3]).forEach(ci => amt.push({ k, ci, x: s.g.position.x + s.pos[ci * 3], y: s.yF + s.pos[ci * 3 + 1], z: s.pos[ci * 3 + 2] })); });
    const n = this.model.target, N = Math.max(1, Math.min(160, amt.length)), rnd = mulberry32((this.model.seed || 7) * 53 + 1);
    const aA = new Float32Array(N * 3), aC = new Float32Array(N * 3), aSeed = new Float32Array(N * 4), aStag = new Float32Array(N * 2), stagS = new Float32Array(N), amtP = new Int32Array(amt.length);
    amt.forEach((_a, j) => amtP[j] = Math.floor(j * N / amt.length));
    // sources: bulbs ordered by x so the left bulbs feed the left sign
    const order = [...Array(n).keys()].sort((a, b) => this.bPos[a].x - this.bPos[b].x);
    for (let i = 0; i < N; i++) {
      const b = this.bPos[order[Math.floor((i + .5) * n / N)]], a = amt[Math.min(amt.length - 1, Math.floor((i + .5) * amt.length / N))] || { x: 0, y: 0, z: 0, k: 0 };
      aA.set([b.x, b.y, b.z], i * 3); aC.set([a.x, a.y, a.z], i * 3);
      aSeed.set([rnd(), rnd(), rnd(), 0], i * 4); stagS[i] = (a.k || 0) * .14 + rnd() * .5; aStag.set([0, stagS[i]], i * 2);
    }
    this.flow = this.mkSparks(N, [['aA', aA, 3], ['aB', aA, 3], ['aC', aC, 3], ['aSeed', aSeed, 4], ['aStag', aStag, 2]]);
    const u = this.flow.userData.u as SparkU; u.uPopT.value = 10; u.uGather.value = 1; u.uOn.value = 1;
    this.fm = { N, amt, amtP, stagS, sk: new Float32Array(N) };
  }
  computeFrames() {
    const L = this.L, S = L.small, th = Math.tan(L.fov * Math.PI / 360), asp = this.aspect || 2;
    const fit = (w: number, h: number) => Math.max(h / 2 / th, w / 2 / (th * asp));
    const totalH = L.H + .22 + S.gap + S.h;
    this.frames = { rest: { ty: .05, d: fit(L.W * L.rest[0], L.H * L.rest[1]) + L.D }, paid: { ty: -(S.gap + S.h) / 2 + .08, d: fit(L.W * 1.1, totalH * 1.2) + L.D } };
  }

  /* ---------- sizing, input, tags ---------- */
  resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight; if (!w || !h) return;
    const pr = this.host.pr, dw = Math.round(w * pr), dh = Math.round(h * pr);
    this.dw = dw; this.dh = dh; this.canvas.width = dw; this.canvas.height = dh; this.host.ensure(dw, dh);
    this.rtBase.setSize(dw, dh); this.rtGlow.setSize(dw, dh); this.bloom.setSize(dw, dh);
    this.aspect = w / h; this.uRes.value.set(dw, dh);
    const layout = this.aspect >= 1.45 ? 'wide' : 'tall';
    if (layout !== this.layout) { this.anim = null; this.build(layout); this.reset(); }
    this.camera.fov = this.L.fov; this.camera.aspect = this.aspect; this.camera.updateProjectionMatrix();
    this.uScale.value = dh / (2 * Math.tan(this.L.fov * Math.PI / 360));
    this.computeFrames(); this.dirty = true;
  }
  onPointer(e: PointerEvent) {
    const r = this.stage.getBoundingClientRect(); const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
    if (!REDUCED) { this.parT.x = (nx * 2 - 1) * .07; this.parT.y = (ny * 2 - 1) * .04; }
    this.ptr = { x: nx * 2 - 1, y: -(ny * 2 - 1) }; this.needPick = true; this.wake(400);
  }
  pick() {
    this.needPick = false; if (!this.ptr || !this.bulbs || !this.opts.tip) return;
    this.ray.setFromCamera(this.ptr as THREE.Vector2, this.camera);
    const hit = this.ray.intersectObject(this.bulbs, false)[0];
    this.setHover(hit && hit.instanceId != null && this.screw[hit.instanceId] > .5 ? hit.instanceId : -1);
  }
  setHover(i: number) {
    const tip = this.opts.tipEl; if (!tip) return;
    if (i === this.hover) { if (i >= 0) this.place(tip, this.bPos[i], 0); return; }
    this.hover = i;
    const text = i >= 0 ? this.opts.tip!(i) : null;
    if (!text) { tip.hidden = true; this.repaint(); return; }
    tip.textContent = text; tip.hidden = false; this.place(tip, this.bPos[i], 0); this.repaint();
  }
  place(el: HTMLElement, v: THREE.Vector3, out: number) {
    const p = v.clone();
    if (out) { const sx = Math.abs(p.x) / (this.tw / 2), sy = Math.abs(p.y) / (this.th / 2); if (sx > sy) p.x += Math.sign(p.x) * out; else p.y += Math.sign(p.y) * out; }
    this.root.updateMatrixWorld(); p.applyMatrix4(this.root.matrixWorld).project(this.camera);
    el.style.left = `${(p.x * .5 + .5) * 100}%`; el.style.top = `${(-p.y * .5 + .5) * 100}%`;
  }
  setTag(slot: number, text: string | null | undefined) { if (text) this.tags.set(slot, text); else this.tags.delete(slot); this.syncTags(); this.dirty = true; }
  clearTags() { this.tags.clear(); this.syncTags(); }
  syncTags() {
    for (const [slot, el] of this.tagEls) if (!this.tags.has(slot)) { el.remove(); this.tagEls.delete(slot); }
    for (const [slot, text] of this.tags) { let el = this.tagEls.get(slot); if (!el) { el = document.createElement('span'); el.className = 'bulb-tag'; el.setAttribute('aria-hidden', 'true'); this.stage.appendChild(el); this.tagEls.set(slot, el); } el.textContent = text; }
  }
  placeTags() { for (const [slot, el] of this.tagEls) { if (!this.bPos[slot]) { el.hidden = true; continue; } el.hidden = !(this.screw[slot] > .9); const v = this.bPos[slot].clone(); v.z += this.screwZ[slot]; this.place(el, v, this.rb * 3.1); } }
  repaint() { if (!this.anim && this.root) this.applyStatic(this.phase, this.fans); }
  tension(on: boolean) { this.tense = on; this.wake(on ? 1400 : 200); }
  wake(ms: number = 300) { this.awake = Math.max(this.awake, performance.now() + ms); }

  /* ---------- state writers ---------- */
  setB(i: number, rgb: RGB, k: number, steady: number, white: number) { const e = this.bEm; e[i * 4] = rgb[0] * k; e[i * 4 + 1] = rgb[1] * k; e[i * 4 + 2] = rgb[2] * k; e[i * 4 + 3] = steady; this.bAux[i * 2 + 1] = white; }
  addB(i: number, rgb: RGB, k: number) { const e = this.bEm; e[i * 4] += rgb[0] * k; e[i * 4 + 1] += rgb[1] * k; e[i * 4 + 2] += rgb[2] * k; }
  setC(i: number, rgb: RGB, k: number, steady: number, white: number) { const e = this.cEm; e[i * 4] = rgb[0] * k; e[i * 4 + 1] = rgb[1] * k; e[i * 4 + 2] = rgb[2] * k; e[i * 4 + 3] = steady; this.cAux[i * 2 + 1] = white; }
  setS(s: Small, i: number, rgb: RGB, k: number, steady: number, white: number) { const e = s.em; e[i * 4] = rgb[0] * k; e[i * 4 + 1] = rgb[1] * k; e[i * 4 + 2] = rgb[2] * k; e[i * 4 + 3] = steady; s.aux[i * 2 + 1] = white; }
  nameLevel(f: number) { return .5 + .5 * clamp(f / this.model.target); }
  commit() {
    const n = this.model.target, mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const s = this.screw[i]; pos.copy(this.bPos[i]); pos.z += this.screwZ[i]; sc.setScalar(Math.max(s, 1e-4));
      if (i === this.hover && s > .5) { const e = this.bEm; e[i * 4] *= 1.6; e[i * 4 + 1] *= 1.6; e[i * 4 + 2] *= 1.6; sc.multiplyScalar(1.08); }
      mtx.compose(pos, q, sc); this.bulbs.setMatrixAt(i, mtx);
    }
    this.bulbs.instanceMatrix.needsUpdate = true;
    for (const m of [this.bulbs, this.lattice, ...this.smalls.map(s => s.lat)]) { m.geometry.attributes.aEm.needsUpdate = true; m.geometry.attributes.aAux.needsUpdate = true; }
    this.layoutSmalls(); this.dirty = true;
  }
  layoutSmalls() {
    const L = this.L, S = L.small, top = -L.H / 2 + .01;
    for (const s of this.smalls) {
      const e = s.drop; s.g.visible = e > .001; s.g.position.y = s.yF + (1 - e) * (S.h + S.gap + .08);
      const gTop = s.g.position.y + S.h / 2 - .01, len = top - gTop;
      s.rods.forEach(r => { r.visible = s.g.visible && len > .005; r.scale.y = Math.max(len, .001); r.position.y = (top + gTop) / 2; });
      s.plateMat.map = s.isPaid ? s.texB : s.texA;
    }
  }
  clearCells() { this.cEm.fill(0); for (let i = 1; i < this.cAux.length; i += 2) this.cAux[i] = 0; }
  reset() { if (!this.root) return; this.anim = null; this.tense = false; const v: { phase: Phase; fans: number } = this.opts.state ? this.opts.state() : { phase: 'held', fans: 0 }; this.applyStatic(v.phase, v.fans); this.wake(200); }
  applyStatic(phase: Phase, fans: number) {
    this.phase = phase; this.fans = fans; this.idleStep = -1;
    const n = this.model.target, lit = phase === 'tipped' || phase === 'paid';
    for (let i = 0; i < n; i++) {
      this.screw[i] = lit ? 1 : phase === 'held' && i < fans ? 1 : 0; this.screwZ[i] = 0;
      if (phase === 'held') this.setB(i, FIL, BH, 0, 0); else if (lit) this.setB(i, LIT, 1, 1, 1); else this.setB(i, ZERO, 0, 1, 0);
    }
    this.clearCells();
    if (phase === 'held') { const nl = this.nameLevel(fans); this.sets.name.forEach(i => this.setC(i, FIL, nl, 0, 0)); }
    else if (lit) this.sets.name.forEach(i => this.setC(i, LIT, 1, 1, 1));
    else this.sets.off.forEach(i => this.setC(i, LILAC, 1, 1, .25));
    for (const s of this.smalls) {
      s.em.fill(0); s.drop = phase === 'paid' ? 1 : 0; s.isPaid = phase === 'paid';
      if (phase === 'paid') s.amtCells.forEach(i => this.setS(s, i, MINT, 1.15, 1, .35));
    }
    for (const m of this.glowOnly) m.userData.want = false;
    this.uP.uOn.value = 0; this.uE.uT.value = -1; this.uO.uT.value = -1; this.uO.uFans.value = fans;
    this.st.frame = phase === 'paid' ? 1 : 0; this.st.push = 0; this.st.flash = 0; this.st.env = phase === 'released' ? .78 : 1; this.st.dim = phase === 'released' ? 1 : 0; this.st.bloom = .8;
    this.commit();
  }

  /* ---------- choreography: pure functions of time ---------- */
  play(kind: AnimKind | 'payoutR', opts: PlayOpts = {}) { if (!this.root) return; if (kind === 'payout' || kind === 'payoutR') this.buildFlow(); this.anim = { kind, t0: performance.now(), opts }; this.wake(400); }
  ring(_t: number, idle: number) { const n = this.model.target; for (let i = 0; i < n; i++) { this.screw[i] = 1; this.screwZ[i] = 0; this.setB(i, LIT, idle >= 0 && (i + idle) % 3 === 0 ? .55 : 1, 1, 1); } }
  run_pledge(t: number, { f0, f1 }: { f0: number; f1: number }) {
    const n = this.model.target, { step, dur } = PLEDGE, cnt = f1 - f0; let landed = 0;
    for (let i = 0; i < n; i++) {
      if (i < f0) { this.screw[i] = 1; this.screwZ[i] = 0; this.setB(i, FIL, BH, 0, 0); continue; }
      if (i >= f1) { this.screw[i] = 0; continue; }
      const k = i - f0, loc = (t - k * step) / dur;
      this.screw[i] = loc <= 0 ? 0 : backOut(loc, 2.1); this.screwZ[i] = (1 - easeOut3(loc * 1.15)) * .26;
      if (loc >= .78) { landed += clamp((loc - .78) / .22); const fl = Math.exp(-(t - k * step - .78 * dur) * 7); this.setB(i, FIL, BH + 2.4 * fl, 0, 0); }
      else this.setB(i, ZERO, 0, 1, 0);
    }
    this.clearCells(); const nl = this.nameLevel(f0 + landed); this.sets.name.forEach(i => this.setC(i, FIL, nl, 0, 0));
    return t > (cnt - 1) * step + dur + .05;
  }
  run_tip(t: number) {
    const T = TIP, n = this.model.target, pm = this.pm;
    const head = clamp(t / T.flare) * (n + 2.5);
    const ft = t - T.flare, env = ft < 0 ? 0 : ft < .1 ? ft / .1 : Math.exp(-(ft - .1) * 5.5);
    const boost = 1 + .55 * env, idle = t > T.done - .5 ? Math.floor(t / .16) : -1;
    for (let i = 0; i < n; i++) {
      this.screw[i] = 1; this.screwZ[i] = 0;
      const hg = t < T.flare + .15 ? Math.max(0, 1 - Math.abs(head - 1.2 - i) / 2.4) : 0;
      if (i < head - 1) this.setB(i, LIT, (idle >= 0 && (i + idle) % 3 === 0 ? .55 : 1) * boost + 1.4 * hg, 1, 1);
      else { this.setB(i, FIL, BH, 0, 0); if (hg > 0) { this.addB(i, LIT, hg * 1.6); this.bAux[i * 2 + 1] = hg; } }
    }
    this.st.bloom = .8 + .3 * env; this.st.push = env; this.st.flash = .6 * env;
    // name: flare, burst into sparks, (IT'S ON), then relight in a wipe
    this.clearCells();
    const nameLit = smooth((t - T.flare) / .1), nl = this.nameLevel(n), popT = t - T.pop, sw = t - T.swap;
    for (const i of this.sets.name) {
      if (popT < pm.delay[pm.nameP[i]]) { const k = nameLit; this.setC(i, k > 0 ? LIT : FIL, k > 0 ? (nl * (1 - k) + k * boost) : nl, k > 0 ? 1 : 0, k); }
      else if (sw > 0) { const r = smooth(((sw - .14) / .45 - this.cXn[i]) * 6); if (r > 0) this.setC(i, LIT, r * (1 + .5 * Math.exp(-Math.max(0, sw - .6) * 5)), 1, r); }
    }
    const uG = clamp((t - T.gather) / .62);
    this.uP.uPopT.value = Math.max(0, popT); this.uP.uGather.value = uG; this.uP.uSplit.value = 0; this.uP.uOn.value = popT >= 0 ? 1 : 0;
    this.sparks.userData.want = popT >= 0 && t < T.itson + .3;
    this.uE.uT.value = popT; this.embers.userData.want = popT >= 0 && popT < 1.8;
    for (let p = 0; p < pm.N; p++) pm.gk[p] = smooth(uG * 1.7 - pm.stagG[p] * .7);
    const itBoost = 1 + .8 * Math.exp(-Math.max(0, t - T.itson) * 5) * (t > T.itson ? 1 : 0);
    for (const i of this.sets.itson) {
      let lv = smooth((pm.gk[pm.itP[i]] - .86) / .14);
      if (sw > 0) lv *= 1 - smooth((sw / .45 - this.cXn[i]) * 6);
      if (lv > 0) { const cur = this.cEm[i * 4 + 3] > 0 ? this.cEm[i * 4] / LIT[0] : 0; this.setC(i, LIT, Math.max(cur, lv * itBoost), 1, Math.max(lv, this.cAux[i * 2 + 1])); }
    }
    return t > T.done;
  }
  run_bonus(t: number, { count }: { count: number }) {
    const n = this.model.target, { step, dur } = BONUS;
    this.ring(t, -1);
    for (let k = 0; k < count; k++) {
      const head = ((t - k * step) / dur) * (n + 3);
      if (head < 0 || head > n + 3) continue;
      for (let i = 0; i < n; i++) { const g = Math.max(0, 1 - Math.abs(head - 1.5 - i) / 2.2); if (g > 0) this.addB(i, LIT, 1.3 * g); }
    }
    this.clearCells(); const pulse = 1 + .3 * Math.exp(-Math.pow((t % step) * 6, 2)) * (t < count * step ? 1 : 0);
    this.sets.name.forEach(i => this.setC(i, LIT, pulse, 1, 1));
    return t > (count - 1) * step + dur + .1;
  }
  run_payout(t: number) {
    const P = PAYOUT, fm = this.fm, idle = Math.floor(t / .16);
    this.ring(t, t > P.paid ? idle : -1);
    this.clearCells(); this.sets.name.forEach(i => this.setC(i, LIT, 1, 1, 1));
    this.smalls.forEach((s, k) => { s.drop = backOut((t - k * .07) / .6, 1.25); s.em.fill(0); s.isPaid = t > P.paid + k * .1 + .12; });
    const uS = clamp((t - P.stream) / .9), u = this.flow!.userData.u as SparkU;
    u.uSplit.value = uS; this.flow!.userData.want = t > P.stream && t < P.paid + .25;
    for (let p = 0; p < fm.N; p++) fm.sk[p] = smooth(uS * 1.6 - fm.stagS[p] * .6);
    fm.amt.forEach((a, j) => {
      const lv = smooth((fm.sk[fm.amtP[j]] - .88) / .12); if (lv <= 0) return; const s = this.smalls[a.k];
      const pt = t - P.paid - a.k * .1;
      if (pt < 0) this.setS(s, a.ci, LIT, lv * 1.2, 1, lv);
      else { const fl = pt < .3 ? (Math.floor(pt / .05) % 2 ? .12 : 1) : 1; this.setS(s, a.ci, pt < .3 ? LIT : MINT, (pt < .3 ? 1.2 : 1.15 + .9 * Math.exp(-(pt - .3) * 4)) * fl, 1, .35); }
    });
    this.st.frame = easeInOut(t / 1.05);
    return t > P.done;
  }
  run_miss(t: number) {
    const n = this.model.target, fans = this.anim!.fans as number, W = MISS.wave;
    for (let i = 0; i < n; i++) {
      this.screw[i] = i < fans ? 1 : 0; this.screwZ[i] = 0; if (i >= fans) continue;
      const ts = (1 - this.bXn[i]) * W;
      if (t < ts) this.setB(i, FIL, BH, 0, 0); else { const c = Math.exp(-(t - ts) * 12); this.setB(i, FIL, BH * c * 1.4, 1, 0); const u = easeInOut((t - ts - .2) / .45); this.screw[i] = 1 - u; this.screwZ[i] = u * .16; }
    }
    this.clearCells(); const nl = this.nameLevel(fans);
    for (const i of this.sets.name) { const ts = (1 - this.cXn[i]) * W; if (t < ts) this.setC(i, FIL, nl, 0, 0); else { const c = Math.exp(-(t - ts) * 12); if (c > .01) this.setC(i, FIL, nl * c * 1.4, 1, 0); } }
    this.uO.uT.value = t; this.uO.uFans.value = fans; this.orbs.userData.want = t < W + 2.2;
    this.st.env = 1 - .22 * smooth((t - .9) / 1.1); this.st.dim = smooth((t - .7) / 1.2);
    const mt = (t - MISS.msg) / .75;
    if (mt > 0) for (const i of this.sets.off) { const k = smooth(mt * 1.35 - this.cXn[i] * .35); if (k > 0) this.setC(i, LILAC, k * (1 + .35 * Math.exp(-Math.max(0, mt - .5) * 3)), 1, .25 * k); }
    return t > MISS.done;
  }
  run_lap(t: number) { // a sign coming alive on "Your show is live"
    const fans = this.anim!.fans as number, nl = this.nameLevel(fans), w = t / .9;
    this.clearCells();
    for (const i of this.sets.name) { const g = Math.exp(-Math.pow((w - this.cXn[i] * 1.2) * 4, 2)); this.setC(i, g > .2 ? LIT : FIL, nl + 1.4 * g, g > .2 ? 1 : 0, g); }
    return t > 1.2;
  }
  run_reduced(t: number, { to }: { to: Phase }) { // reduced motion: switch, then one gentle pulse
    this.applyStatic(to, to === 'released' ? this.anim!.fans as number : this.opts.state ? this.opts.state().fans : this.fans);
    if (to !== 'released') { const k = 1 + .5 * Math.sin(Math.PI * clamp(t / .6)); for (let i = 0; i < this.bEm.length; i++) if (i % 4 < 3) this.bEm[i] *= k; for (let i = 0; i < this.cEm.length; i++) if (i % 4 < 3) this.cEm[i] *= k; this.commit(); }
    return t > .7;
  }

  /* ---------- frame ---------- */
  tick(now: number) {
    if (!this.root) return;
    let active = false;
    if (this.anim) {
      const a = this.anim, t = a.tHold ?? (now - a.t0) / 1000;
      if (a.fans == null) a.fans = this.opts.state ? this.opts.state().fans : this.fans;
      const done = (this as unknown as Runners)['run_' + a.kind](t, a.opts);
      if (a.kind !== 'reduced') this.commit();
      active = true;
      if (done && a.tHold == null) {
        this.anim = null;
        const final = { tip: 'tipped', bonus: 'tipped', payout: 'paid', miss: 'released', lap: 'held', pledge: 'held', reduced: a.opts.to }[a.kind as AnimKind] as Phase;
        const v = this.opts.state ? this.opts.state() : { fans: this.fans };
        this.applyStatic(final, final === 'released' ? a.fans : v.fans);
      }
    } else if ((this.phase === 'tipped' || this.phase === 'paid') && !REDUCED) {
      const step = Math.floor(now / 160);
      if (step !== this.idleStep) { this.idleStep = step; this.ring(0, step); this.commit(); }
    }
    const dx = this.parT.x - this.par.x, dy = this.parT.y - this.par.y, moving = Math.abs(dx) + Math.abs(dy) > 1e-4;
    if (moving) { this.par.x += dx * .08; this.par.y += dy * .08; }
    if (this.needPick) this.pick();
    // idle frames sit on a fixed time grid (not "85 ms after the last render"), so a frozen clock always shows the same frame
    const ambient = !REDUCED && this.onScreen && !document.hidden && this.phase !== 'released';
    const amb = ambient ? Math.floor(now / (this.phase === 'held' ? 85 : 160)) : this.ambStep;
    if (active || this.tense || moving || this.dirty || now < this.awake || amb !== this.ambStep) { this.ambStep = amb; this.render(now); }
  }
  updateCamera() {
    const F = this.frames, f = this.st.frame;
    const ty = F.rest.ty + (F.paid.ty - F.rest.ty) * f, d = (F.rest.d + (F.paid.d - F.rest.d) * f) * (1 - .05 * this.st.push);
    this.camera.position.set(Math.sin(this.par.x) * d, ty - .12 - Math.sin(this.par.y) * d * .6, Math.cos(this.par.x) * d);
    this.camera.lookAt(0, ty, 0);
  }
  render(now: number) {
    if (this.warm) { // compile every program once with everything visible, so the first TIP never hitches
      this.warm = false; const vis = this.smalls.map(s => s.g.visible);
      this.smalls.forEach(s => { s.g.visible = true; s.rods.forEach(r => { r.visible = true; }); });
      this.glowOnly.forEach(o => { o.userData.prev = o.userData.want; o.userData.want = true; });
      this.render(now);
      this.glowOnly.forEach(o => { o.userData.want = o.userData.prev; });
      this.smalls.forEach((s, k) => { s.g.visible = vis[k]; }); this.layoutSmalls();
    }
    this.lastRender = now; this.dirty = false;
    this.uTime.value = this.anim || this.tense ? (now / 1000) * (this.tense ? 2.4 : 1) : Math.floor(now / 85) * .085;
    this.updateCamera();
    this.scene.environmentIntensity = this.st.env;
    this.bloom.strength = this.st.bloom; this.comp.uniforms.uFlash.value = this.st.flash;
    this.M.lacquer.color.copy(this.cRed).lerp(this.cDim, this.st.dim); this.M.lacquer.envMapIntensity = .6 - .22 * this.st.dim;
    const r = this.r;
    // pass 1: emissive-only glow (+ sparks), then bloom
    for (const m of this.boardMeshes) m.material = this.M.black;
    for (const m of this.dotMeshes) m.material = this.M.glow;
    for (const o of this.glowOnly) o.visible = !!o.userData.want;
    for (const s of this.shadows) s.visible = false;
    r.setRenderTarget(this.rtGlow); r.setClearColor(0x000000, 1); r.clear(); r.render(this.scene, this.camera);
    this.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, this.rtGlow, 0, false);
    // pass 2: lit scene with coverage alpha
    for (const m of this.boardMeshes) m.material = m.userData.mat;
    for (const m of this.dotMeshes) m.material = m.userData.mat;
    for (const o of this.glowOnly) o.visible = false;
    for (const s of this.shadows) s.visible = true;
    r.setRenderTarget(this.rtBase); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, this.camera);
    // pass 3: composite into the shared canvas (top-left region), then copy into this sign's canvas
    const H = this.host.h, dw = this.dw, dh = this.dh;
    r.setRenderTarget(null); r.setViewport(0, H - dh, dw, dh); r.setScissor(0, H - dh, dw, dh); r.setScissorTest(true);
    r.setClearColor(0x000000, 0); r.clear(); this.quad.render(r); r.setScissorTest(false);
    this.ctx.clearRect(0, 0, dw, dh); this.ctx.drawImage(this.host.canvas, 0, 0, dw, dh, 0, 0, dw, dh);
    this.placeTags();
    if (this.hover >= 0 && this.opts.tipEl && !this.opts.tipEl.hidden) this.place(this.opts.tipEl, this.bPos[this.hover], 0);
    if (!this.shown) {
      this.shown = true; const ph = this.opts.ph, cv = this.canvas;
      if (REDUCED) { cv.style.opacity = '1'; if (ph) ph.style.opacity = '0'; }
      else tween(700, k => { cv.style.opacity = String(k); if (ph) ph.style.opacity = String(1 - k); });
    }
  }
}
