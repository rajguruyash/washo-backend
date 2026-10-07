// Renders promo.html frame by frame with headless Chrome (DevTools protocol), deterministic: render(t) per frame.
// usage: node render.mjs <outDir> [fps=30] [dur=15] [times=comma list for stills]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || join(here, 'frames');
const fps = Number(process.argv[3] || 30);
const dur = Number(process.argv[4] || 15);
const stills = process.argv[5] ? process.argv[5].split(',').map(Number) : null;
mkdirSync(out, { recursive: true });

const port = 9400 + Math.floor(Math.random() * 400);
const profile = join(here, 'chrome-profile-' + port);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-device-scale-factor=1',
  '--window-size=1080,1920', '--allow-file-access-from-files', '--disable-gpu-vsync', '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); } catch {}
}
if (!target) { chrome.kill(); throw new Error('chrome did not start'); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + join(here, 'promo.html') });
for (let i = 0; i < 120; i++) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'window.READY === true', returnByValue: true }).catch(() => null);
  if (r?.result?.value) break;
}
await sleep(400);

const times = stills ?? Array.from({ length: Math.round(fps * dur) }, (_, i) => i / fps);
let n = 0;
for (const t of times) {
  await send('Runtime.evaluate', { expression: `render(${t})` });
  await send('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
  const { data } = await send('Page.captureScreenshot', { format: stills ? 'png' : 'jpeg', quality: stills ? undefined : 95, clip: { x: 0, y: 0, width: 1080, height: 1920, scale: 1 } });
  const name = stills ? `still_${t.toFixed(2)}.png` : `f_${String(n).padStart(4, '0')}.jpg`;
  writeFileSync(join(out, name), Buffer.from(data, 'base64'));
  n++;
  if (!stills && n % 60 === 0) console.log(`${n}/${times.length}`);
}
ws.close();
chrome.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
console.log('done', n, 'frames ->', out);
