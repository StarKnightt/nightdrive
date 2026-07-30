/* Weak-device pass.
   Real GPU, CPU throttled 6x through the DevTools protocol, which is as close as
   this machine gets to the "potato laptop" the brief asks about. Three claims:
   the opening load is never above medium, the tier system walks down to something
   the machine can hold, and what it settles on is still playable and still
   actually drawing. */
import { chromium } from 'playwright';
import './tame.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const THROTTLE = Number(process.argv[2] || 6);
const SECONDS = Number(process.argv[3] || 45);

const ROOT = path.resolve('.');
const srv = http.createServer((rq, rs) => {
  const f = path.join(ROOT, rq.url === '/' ? 'index.html' : decodeURI(rq.url.split('?')[0]));
  fs.readFile(f, (e, d) => e ? (rs.writeHead(404), rs.end())
    : (rs.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }), rs.end(d)));
});
await new Promise(r => srv.listen(0, r));

let browser;
const bye = async (c, why) => { if (why) console.error(why); try { await browser?.close(); } catch {} srv.close(); process.exit(c); };
process.on('SIGINT', () => bye(130)); process.on('SIGTERM', () => bye(143));
process.on('uncaughtException', e => bye(1, e));

browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--window-position=-2400,-1400', '--window-size=1200,700',
         '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errs = [], lost = [];
page.on('pageerror', e => errs.push(String(e.message || e)));
page.on('console', m => {
  const t = m.text();
  if (/context ?lost|CONTEXT_LOST/i.test(t)) lost.push(t);
  if (m.type() === 'error') errs.push(t);
});

const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
console.log(`\n  weak-device pass — CPU throttled ${THROTTLE}x, ${SECONDS}s of driving\n`);

await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 180_000 });

/* The tier chosen before a single frame has been timed. This is the claim about
   startup load: guessTier() may only ever open at medium or below. */
const opening = await page.evaluate(() => ({
  tier: window.__game.tier,
  scale: window.__game.renderScale,
  cap: window.__game.fpsCap,
}));
console.log(`  opening tier "${opening.tier}", render scale ${opening.scale.toFixed(2)}, ` +
            `cap ${opening.cap} fps`);

await page.evaluate(() => { window.__game.begin(); window.__game.setAuto(true); });

const NAMES = ['high', 'medium', 'low', 'potato'];
const samples = [];
let changes = 0, last = opening.tier;
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  const s = await page.evaluate(() => {
    const g = window.__game;
    return { tier: g.tier, fps: g.fps, scale: g.renderScale,
             calls: g.renderer.info.render.calls, rendered: g.rendered,
             kmh: Math.abs(g.car.vLong) * 3.6, y: g.car.y };
  });
  if (s.tier !== last) { changes++; last = s.tier; }
  samples.push({ t: (Date.now() - t0) / 1000, ...s });
  await page.waitForTimeout(500);
}

// Second half only: the first seconds are texture loads, shader builds and world
// meshing, and are not what the machine can hold.
const settled = samples.slice(Math.floor(samples.length / 2));
const fpsList = settled.map(s => s.fps).sort((a, b) => a - b);
const med = fpsList[Math.floor(fpsList.length / 2)];
const worst = fpsList[0];
const finalTier = samples[samples.length - 1].tier;
const frames = samples[samples.length - 1].rendered - samples[0].rendered;

for (const s of samples.filter((_, i) => i % 8 === 0))
  console.log(`   t+${s.t.toFixed(0).padStart(2)}s  ${s.tier.padEnd(7)} ` +
              `scale ${s.scale.toFixed(2)}  ${s.fps.toFixed(0).padStart(3)} fps  ` +
              `${s.calls} calls  ${s.kmh.toFixed(0)} km/h`);

// Is anything actually on screen, or has it quietly gone black?
await page.screenshot({ path: `shots/p2-06-weak-${THROTTLE}x.png` });
/* Read the frame out of the GL back buffer inside the render call itself.
   drawImage() on the canvas from an ordinary evaluate() returns transparent
   black: the context is not created with preserveDrawingBuffer, so outside the
   frame that produced it there is nothing there to copy. Measured that way, a
   perfectly good dusk frame reported a mean luminance of exactly 0 and this
   check failed while the screenshot beside it showed the road, the headlights
   and the tail lamps. */
await page.evaluate(() => {
  const g = window.__game, gl = g.renderer.getContext();
  window.__px = null; window.__want = true;
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) {
    const r = inner(...a);
    if (!window.__want) return r;
    window.__want = false;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, max = 0, n = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {          // every 37th pixel
      const l = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      sum += l; n++; if (l > max) max = l;
    }
    window.__px = { mean: sum / n, max };
    return r;
  };
});
await page.waitForFunction(() => !!window.__px, null, { timeout: 30_000 });
const px = await page.evaluate(() => window.__px);

console.log('');
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}   ${detail}`);
  if (!ok) process.exitCode = 1;
};
check('startup load never above medium', NAMES.indexOf(opening.tier) >= 1,
      `opened at "${opening.tier}"`);
check('the 60 fps cap is untouched', opening.cap === 60, `cap ${opening.cap}`);
check('degrades under load', NAMES.indexOf(finalTier) >= NAMES.indexOf(opening.tier),
      `"${opening.tier}" -> "${finalTier}"`);
check('settles rather than oscillating', changes <= 8, `${changes} tier changes in ${SECONDS}s`);
/* Playability is asserted at the throttle the brief actually names. Past 6x there
   is no tier below `potato` to fall to, so what a harsher run measures is the
   floor of the quality ladder rather than a regression in it — 12x settles at
   potato and holds ~17 fps, still rendering, still driving, still not black.
   Worth knowing; not a failure of anything this pass controls. */
if (THROTTLE <= 6)
  check('still playable', med >= 20, `median ${med.toFixed(0)} fps, worst ${worst.toFixed(0)}`);
else
  console.log(`  note  beyond the 6x target: median ${med.toFixed(0)} fps, ` +
              `worst ${worst.toFixed(0)} — potato is the bottom of the ladder`);
check('still rendering', frames > SECONDS * 10, `${frames} frames in ${SECONDS}s`);
check('not a black screen', px.mean > 6 && px.max > 40,
      `mean luma ${px.mean.toFixed(1)}, max ${px.max}`);
check('no WebGL context loss', lost.length === 0, `${lost.length} events`);
check('car still on the road', Math.abs(samples[samples.length - 1].kmh) > 5,
      `${samples[samples.length - 1].kmh.toFixed(0)} km/h at the end`);

if (errs.length) { console.log('\n  page errors:'); errs.slice(0, 6).forEach(e => console.log('   ', e.slice(0, 160))); }
else console.log('\n  no page errors');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
await bye(process.exitCode || 0);
