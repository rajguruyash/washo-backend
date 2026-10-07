// Original soundtrack + SFX for the WASHO Navratri promo, synthesized from scratch (no samples, no licensing).
// 120 BPM dhol-style groove, tanpura-like drone, santoor-like plucks (Karplus-Strong) in D major pentatonic,
// and UI sound design timed to the video. Writes a 48 kHz stereo WAV.
import { writeFileSync } from 'node:fs';

const SR = 48000, DUR = 15, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N); // reverb send
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function add(buf, t0, gain = 1, pan = 0, send = 0) {
  const i0 = Math.round(t0 * SR); const gl = gain * Math.cos((pan + 1) * Math.PI / 4), gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < buf.length; i++) { const j = i0 + i; if (j < 0 || j >= N) continue; L[j] += buf[i] * gl; R[j] += buf[i] * gr; if (send) { sendL[j] += buf[i] * gl * send; sendR[j] += buf[i] * gr * send; } }
}
function biquad(type, f, q = 0.707) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q); let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; } else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; } else { b0 = a; b1 = 0; b2 = -a; }
  a0 = 1 + a; a1 = -2 * c; a2 = 1 - a;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

/* instruments */
function kick(g = 1) { const n = SR * 0.45, b = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const t = i / SR; const f = 45 + 95 * Math.exp(-t / 0.035); ph += 2 * Math.PI * f / SR; b[i] = Math.sin(ph) * env(t, 0.002, 0.16) * g + rnd() * 0.15 * Math.exp(-t / 0.004); } return b; }
function dagga(g = 1) { // dhol bass side
  const n = SR * 0.5, b = new Float32Array(n), lp = biquad('lp', 600); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; const f = 62 + 70 * Math.exp(-t / 0.05); ph += 2 * Math.PI * f / SR; b[i] = (Math.sin(ph) * 0.9 + lp(rnd()) * 0.5 * Math.exp(-t / 0.03)) * env(t, 0.001, 0.2) * g; }
  return b;
}
function tilli(g = 1) { // dhol treble slap
  const n = SR * 0.18, b = new Float32Array(n), bp = biquad('bp', 1800, 1.4); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (390 + 60 * Math.exp(-t / 0.01)) / SR; b[i] = (bp(rnd()) * 1.6 * Math.exp(-t / 0.025) + Math.sin(ph) * 0.35 * Math.exp(-t / 0.05)) * g; }
  return b;
}
function clap(g = 1) { const n = SR * 0.25, b = new Float32Array(n), bp = biquad('bp', 1500, 0.9); for (let i = 0; i < n; i++) { const t = i / SR; const e = Math.exp(-t / 0.06) + (t < 0.02 ? 0.6 * Math.exp(-((t % 0.0075) / 0.002)) : 0); b[i] = bp(rnd()) * e * 1.4 * g; } return b; }
function shaker(g = 1) { const n = SR * 0.07, b = new Float32Array(n), hp = biquad('hp', 7000); for (let i = 0; i < n; i++) { const t = i / SR; b[i] = hp(rnd()) * env(t, 0.008, 0.02) * g; } return b; }
function pluck(f, g = 1, dur = 1.4) { // Karplus-Strong, two detuned strings: santoor-ish
  const n = Math.round(SR * dur), b = new Float32Array(n);
  for (const det of [1, 1.004]) {
    const p = Math.round(SR / (f * det)); const line = new Float32Array(p); for (let i = 0; i < p; i++) line[i] = rnd() * (i < p / 2 ? 1 : 0.5);
    let k = 0, prev = 0;
    for (let i = 0; i < n; i++) { const cur = line[k]; const nv = 0.4985 * (cur + prev) * 1.0 + 0; prev = cur; line[k] = nv; k = (k + 1) % p; b[i] += cur * 0.5 * g; }
  }
  for (let i = 0; i < 200 && i < n; i++) b[i] *= i / 200;
  return b;
}
function bell(f, g = 1, dur = 2) { const n = Math.round(SR * dur), b = new Float32Array(n); const parts = [[1, 1, 0.9], [2.0, 0.5, 0.6], [2.76, 0.35, 0.4], [5.4, 0.18, 0.2], [8.93, 0.08, 0.1]]; for (let i = 0; i < n; i++) { const t = i / SR; let v = 0; for (const [m, a, d] of parts) v += Math.sin(2 * Math.PI * f * m * t) * a * Math.exp(-t / d); b[i] = v * g * Math.min(1, t / 0.002); } return b; }
function sub(f, g = 1, dur = 1.5) { const n = Math.round(SR * dur), b = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; b[i] = Math.sin(2 * Math.PI * (f + 30 * Math.exp(-t / 0.08)) * t) * env(t, 0.004, dur / 3) * g; } return b; }
function whoosh(dur, g = 1, f0 = 400, f1 = 5000, shape = 'up') {
  const n = Math.round(SR * dur), b = new Float32Array(n); let fl = biquad('bp', f0, 0.8); let lastF = f0;
  for (let i = 0; i < n; i++) { const p = i / n; const f = f0 * Math.pow(f1 / f0, shape === 'up' ? p : 1 - p); if (i % 64 === 0) { fl = rebp(fl, f); lastF = f; } const a = shape === 'up' ? Math.pow(p, 2) * (1 - Math.pow(p, 12)) : Math.sin(p * Math.PI); b[i] = fl(rnd()) * a * g * 1.8; }
  return b;
}
const bpState = new WeakMap();
function rebp(old, f) { // keep continuity roughly by just making a new filter (fine for noise)
  return biquad('bp', f, 0.9);
}
function click(g = 1) { const n = SR * 0.05, b = new Float32Array(n), hp = biquad('hp', 2500); for (let i = 0; i < n; i++) { const t = i / SR; b[i] = (hp(rnd()) * Math.exp(-t / 0.0025) * 0.9 + Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t / 0.012) * 0.6) * g; } return b; }
function tick(f = 3200, g = 1) { const n = SR * 0.03, b = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / SR; b[i] = Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.006) * g; } return b; }
function riser(dur, g = 1) { const n = Math.round(SR * dur), b = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const p = i / n; ph += 2 * Math.PI * (300 + 900 * p * p) / SR; b[i] = (Math.sin(ph) * 0.5 + Math.sin(ph * 1.5) * 0.2) * p * p * g; } return b; }

/* music */
const BEAT = 0.5, S16 = BEAT / 4;
const NOTE = { D2: 73.42, G2: 98.0, A2: 110, D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440, B4: 493.88, D5: 587.33, E5: 659.26, Fs5: 739.99, A5: 880 };
const level = (t) => (t >= 6 && t < 11 ? 0.62 : 1) * (t >= 11.0 && t < 11.5 ? 0 : 1); // lighter under the UI walkthrough; a gap for the success chime
const dagSteps = [0, 6, 8, 11, 14], tilSteps = [2, 4, 7, 10, 12, 13, 15];
for (let bar = 0; bar < 8; bar++) {
  const t0 = bar * 2.0;
  for (let s = 0; s < 16; s++) {
    const t = t0 + s * S16; if (t >= 14.5) continue;
    const lv = level(t);
    if (lv === 0) continue;
    if (s % 8 === 0) add(kick(0.75), t, lv);
    if (dagSteps.includes(s)) add(dagga(0.55), t, lv, -0.15);
    if (tilSteps.includes(s)) add(tilli(s % 4 === 2 ? 0.32 : 0.22), t, lv, 0.25, 0.08);
    if (s === 4 || s === 12) add(clap(0.32), t, lv, 0, 0.15);
    add(shaker(s % 2 ? 0.14 : 0.08), t, lv * (t < 0.5 ? 0 : 1), 0.4);
  }
  // bass
  const root = [NOTE.D2, NOTE.D2, NOTE.G2, NOTE.A2][bar % 4];
  if (t0 < 14.5) for (const off of [0, 0.75, 1.0, 1.5]) { const t = t0 + off; if (level(t) > 0 && t < 14.5) add(sub(root, 0.32, 0.45), t, level(t)); }
}
// melody, two-bar phrase
const phrase = [[0, 'A4'], [2, 'D5'], [4, 'Fs5'], [6, 'E5'], [8, 'D5'], [10, 'B4'], [12, 'A4'], [14, 'B4'], [16, 'D5'], [19, 'E5'], [22, 'Fs5'], [24, 'A5'], [26, 'Fs5'], [28, 'E5'], [30, 'D5']];
for (let rep = 0; rep < 4; rep++) for (const [s, n] of phrase) { const t = rep * 4 + s * S16; if (t >= 14.5) continue; const lv = level(t); if (lv) add(pluck(NOTE[n], 0.34 * lv), t, 1, (s % 3 - 1) * 0.3, 0.35); }
// tanpura-like drone
{
  const b = new Float32Array(N), lp = biquad('lp', 1400); const fs = [73.42, 110, 146.83, 220];
  for (let i = 0; i < N; i++) { const t = i / SR; let v = 0; fs.forEach((f, k) => { for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t + k) * (0.5 / h) * (0.6 + 0.4 * Math.sin(t * (0.7 + k * 0.3) + h)); }); b[i] = lp(v) * 0.022 * Math.min(1, t / 0.3) * (t > 14.2 ? Math.max(0, 1 - (t - 14.2) / 0.8) : 1); }
  add(b, 0, 1, 0, 0.2);
}

/* sound design */
add(sub(48, 0.9, 1.8), 0.0); add(bell(587.33, 0.22, 2.2), 0.0, 1, 0, 0.6); add(whoosh(0.5, 0.25, 6000, 800, 'down'), 0.0, 1, 0, 0.3);
add(whoosh(0.35, 0.22, 500, 6000, 'down'), 1.32, 1, 0.2, 0.2);
add(dagga(0.6), 1.86, 1, 0); add(bell(880, 0.12, 1.2), 1.86, 1, 0.2, 0.5);
add(whoosh(0.55, 0.55, 300, 7000, 'down'), 2.78, 1, -0.2, 0.3); // the water wipe
add(sub(52, 0.6, 1.2), 3.05); add(bell(1174.66, 0.12, 1.6), 3.1, 1, 0, 0.6);
for (let i = 0; i < 7; i++) add(bell(2400 + i * 330, 0.03, 0.4), 3.55 + i * 0.08, 1, (i % 2 ? 0.5 : -0.5), 0.6); // logo sparkle
for (let i = 0; i < 10; i++) add(tick(1800 + i * 160, 0.22), 4.5 + i * 0.08, 1, 0); // ₹150 counting down
add(bell(1174.66, 0.2, 1.6), 5.3, 1, 0, 0.5); add(bell(1479.98, 0.14, 1.4), 5.3, 1, 0.2, 0.5); add(clap(0.25), 5.3);
add(whoosh(0.4, 0.35, 400, 6000, 'down'), 5.75, 1, 0.2, 0.25);
for (let i = 0; i < 12; i++) add(tick(4200, 0.08), 6.0 + i * 0.042, 1, 0.3); // typing the URL
for (const t of [6.95, 8.15, 8.62, 9.18, 9.46, 9.76, 10.04]) add(click(0.4), t, 1, 0.1, 0.05);
for (let i = 0; i < 11; i++) add(tick(3800, 0.08), 8.68 + i * 0.038, 1, -0.2); // typing the number
add(riser(0.45, 0.16), 10.38, 1, 0); add(whoosh(0.45, 0.18, 800, 4000, 'up'), 10.38, 1, 0);
// success: a bright major arpeggio
[[587.33, 0], [739.99, 0.07], [880, 0.14], [1174.66, 0.21]].forEach(([f, d]) => add(bell(f, 0.2, 1.6), 11.0 + d, 1, (d - 0.1) * 3, 0.6));
add(sub(55, 0.5, 1.0), 11.0);
add(whoosh(0.4, 0.35, 500, 6000, 'down'), 12.85, 1, -0.2, 0.3);
add(sub(48, 0.85, 2.0), 13.0); add(bell(587.33, 0.24, 2.4), 13.0, 1, 0, 0.6); add(bell(880, 0.14, 2.2), 13.02, 1, 0.3, 0.6);
for (let i = 0; i < 7; i++) add(bell(2600 + i * 300, 0.03, 0.4), 14.15 + i * 0.08, 1, (i % 2 ? 0.5 : -0.5), 0.6);
add(click(0.25), 14.3, 1, 0, 0.1);
add(dagga(0.8), 14.5); add(kick(0.8), 14.5); add(bell(293.66, 0.2, 1.5), 14.5, 1, 0, 0.6); add(whoosh(0.5, 0.15, 7000, 1500, 'down'), 14.5, 1, 0, 0.5);

/* reverb (Schroeder) on the send bus */
function reverb(inp) {
  const out = new Float32Array(N); const combs = [1557, 1617, 1491, 1422].map((d) => ({ d: Math.round(d * SR / 44100), buf: null, i: 0, fb: 0.8 }));
  combs.forEach((c) => (c.buf = new Float32Array(c.d)));
  const aps = [225, 556].map((d) => ({ d: Math.round(d * SR / 44100), buf: null, i: 0 })); aps.forEach((a) => (a.buf = new Float32Array(a.d)));
  for (let n = 0; n < N; n++) { let s = 0; for (const c of combs) { const y = c.buf[c.i]; c.buf[c.i] = inp[n] + y * c.fb; c.i = (c.i + 1) % c.d; s += y; } s /= 4; for (const a of aps) { const y = a.buf[a.i]; const v = -0.5 * s + y; a.buf[a.i] = s + 0.5 * y; a.i = (a.i + 1) % a.d; s = v; } out[n] = s; }
  return out;
}
const rl = reverb(sendL), rr = reverb(sendR);
let peak = 0;
for (let i = 0; i < N; i++) { L[i] = Math.tanh((L[i] + rl[i] * 0.55) * 1.1); R[i] = Math.tanh((R[i] + rr[i] * 0.55) * 1.1); peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
const norm = 0.89 / peak; // about -1 dBFS
const fadeOut = (i) => { const t = i / SR; return t > 14.75 ? Math.max(0, (15 - t) / 0.25) : 1; };
const data = Buffer.alloc(44 + N * 4);
data.write('RIFF', 0); data.writeUInt32LE(36 + N * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { const f = fadeOut(i); data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm * f)) * 32767), 44 + i * 4); data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm * f)) * 32767), 46 + i * 4); }
writeFileSync(new URL('./soundtrack.wav', import.meta.url), data);
console.log('soundtrack.wav written, peak before norm', peak.toFixed(3));
