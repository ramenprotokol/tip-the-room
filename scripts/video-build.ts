// Builds the submission video from the recording: lays the PayPal popup over the main video (picture in picture),
// squeezes the slow waits, plays the popup at 2x, and writes test-results/video/tip-the-room.mp4 (H.264, no audio).
// Fails unless the result is under 3 minutes. Needs ffmpeg and ffprobe on PATH; it never installs anything.
// Run: npm run video:build
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Timeline } from "../tests/video/captions";

const DIR = "test-results/video";
const SQUEEZED_S = 3;
const FAST = 2;
const LIMIT_S = 175;

const have = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
if (!have("ffmpeg") || !have("ffprobe")) {
  console.error("ffmpeg and ffprobe are needed and were not found. This script never installs anything.");
  process.exit(2);
}
const tl = JSON.parse(readFileSync(`${DIR}/timeline.json`, "utf8")) as Timeline;
const main = `${DIR}/main.webm`;
const popup = `${DIR}/popup.webm`;
const s = (ms: number) => (ms / 1000).toFixed(3);

interface Part { start: number; end: number; speed: number }
const parts: Part[] = [];
let cur = 0;
for (const m of [...tl.segments].sort((a, b) => a.start - b.start)) {
  if (m.start < cur || m.end <= m.start) continue; // overlapping marks: the earlier one wins
  if (m.start > cur) parts.push({ start: cur, end: m.start, speed: 1 });
  const dur = m.end - m.start;
  parts.push({ start: m.start, end: m.end, speed: m.kind === "squeeze" ? Math.max(1, dur / (SQUEEZED_S * 1000)) : FAST });
  cur = m.end;
}
if (cur < tl.total) parts.push({ start: cur, end: tl.total, speed: 1 });
const planned = parts.reduce((n, p) => n + (p.end - p.start) / p.speed, 0) / 1000;
console.log(`${parts.length} parts → about ${planned.toFixed(1)} s`);
if (planned >= LIMIT_S) {
  console.error(`Too long (${planned.toFixed(1)} s). Shorten the dwell() times in tests/video/judge-video.spec.ts and record again.`);
  process.exit(1);
}

const f: string[] = [];
const withPopup = tl.popup !== null && existsSync(popup);
if (withPopup) {
  const p = tl.popup!;
  f.push(`[1:v]setpts=PTS-STARTPTS+${s(p.start)}/TB,scale=560:-2[pp]`);
  f.push(`[0:v][pp]overlay=x=W-w-24:y=24:enable='between(t,${s(p.start)},${s(p.end)})':eof_action=pass[base]`);
} else f.push("[0:v]null[base]");
f.push(`[base]split=${parts.length}${parts.map((_, i) => `[s${i}]`).join("")}`);
parts.forEach((p, i) => f.push(`[s${i}]trim=start=${s(p.start)}:end=${s(p.end)},setpts=(PTS-STARTPTS)/${p.speed.toFixed(4)}[p${i}]`));
f.push(`${parts.map((_, i) => `[p${i}]`).join("")}concat=n=${parts.length}:v=1:a=0,fps=30,format=yuv420p[out]`);

const out = `${DIR}/tip-the-room.mp4`;
execFileSync("ffmpeg", ["-y", "-i", main, ...(withPopup ? ["-i", popup] : []), "-filter_complex", f.join(";"), "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", out], { stdio: "inherit" });
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", out]).toString().trim());
console.log(`${out}: ${dur.toFixed(1)} s, no audio track`);
if (!(dur > 0 && dur < 180)) {
  console.error("The finished video must be under 3 minutes.");
  process.exit(1);
}
