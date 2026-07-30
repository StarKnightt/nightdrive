/* How hard are the foliage edges against the sky?

   A binary alpha cut puts a full-contrast step between sky and leaf in a single
   pixel. Antialiased coverage spreads the same step over two or three. So the
   measurement is the shape of the transition: walk horizontal scanlines across
   the upper part of the frame, find pixels where luminance changes sharply, and
   ask how many of them land at an intermediate value rather than snapping
   straight from sky to leaf. More intermediate pixels means softer edges.

   Confined to the sky band at the top of the frame, where foliage is silhouetted
   against a bright, near-flat background and nothing else generates that kind of
   step.                                                                        */
import { chromium } from 'playwright';
import './tame.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
  args: ['--use-angle=d3d11', '--window-position=-2400,-1400', '--window-size=1400,820',
         '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
await page.evaluate(() => window.__game.begin());
await page.waitForTimeout(2500);

await page.evaluate(() => {
  const g = window.__game;
  const gl = g.renderer.getContext();
  window.__edge = null;
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) {
    const r = inner(...a);
    if (!window.__want) return r;
    window.__want = false;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    // upper third only: sky and the trees standing in it
    const y0 = Math.floor(H * 0.55), h = Math.floor(H * 0.42);
    const buf = new Uint8Array(W * h * 4);
    gl.readPixels(0, y0, W, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const L = (x, y) => {
      const i = (y * W + x) * 4;
      return 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    };
    let steps = 0, soft = 0, sumRun = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < W - 3; x++) {
        const a = L(x, y), b = L(x + 1, y);
        if (Math.abs(b - a) < 34) continue;            // not an edge
        /* Walk the transition: how many pixels does it take to get from the
           lighter side to the darker one? One means a binary cut. */
        const lo = Math.min(a, b), hi = Math.max(a, b);
        let run = 1;
        for (let k = 2; k < 6 && x + k < W; k++) {
          const v = L(x + k, y);
          if (v > lo + 0.12 * (hi - lo) && v < hi - 0.12 * (hi - lo)) run++; else break;
        }
        steps++; sumRun += run;
        if (run >= 2) soft++;
        x += run;
      }
    }
    window.__edge = { steps, softPct: 100 * soft / Math.max(1, steps), meanRun: sumRun / Math.max(1, steps) };
    return r;
  };
});

const probe = async () => {
  await page.evaluate(() => { window.__want = true; window.__edge = null; });
  await page.waitForFunction(() => window.__edge, null, { timeout: 15_000 });
  return page.evaluate(() => window.__edge);
};

await page.evaluate(() => { window.__game.setCam(1); window.__game.setDay(0.06); window.__game.setAuto(true); });
await page.waitForTimeout(4000);

const tag = process.argv[2] || 'foliage';
let steps = 0, soft = 0, run = 0, n = 0, fps = 0;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(700);
  const e = await probe();
  if (!e.steps) continue;
  steps += e.steps; soft += e.softPct; run += e.meanRun; n++;
  fps += await page.evaluate(() => window.__game.fps);
}
console.log(`  sky-edge samples: ${(steps / Math.max(1, n)).toFixed(0)} steps/frame`);
console.log(`  soft edges:       ${(soft / Math.max(1, n)).toFixed(1)} %   (higher is softer)`);
console.log(`  mean transition:  ${(run / Math.max(1, n)).toFixed(2)} px  (1.00 == binary cut)`);
console.log(`  fps:              ${(fps / Math.max(1, n)).toFixed(0)}`);
await page.screenshot({ path: `shots/${tag}.png` });
console.log(`  shots/${tag}.png`);

await bye(0);
