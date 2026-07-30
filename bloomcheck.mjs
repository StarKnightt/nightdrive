/* How badly does the sun wash the car out?

   "Washed out" is measurable: over the car's own pixels, a blown highlight is
   high mean luminance *and* low contrast — the paint, the glass and the shadow
   under the sill all converge on the same white. Contrast alone is the honest
   half of it, since a car can be legitimately bright at midday and still read
   as a car. Swept across the day so the worst sun angle is found rather than
   guessed at, and reported next to a patch of road beside the car as a
   reference for how much of the brightness is the scene and how much is the
   flare sitting on top of the bodywork.                                      */
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
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const g = window.__game, T = g.THREE;
  const box = new T.Box3(), v = new T.Vector3();
  window.__lum = null;
  const gl = g.renderer.getContext();
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) {
    const r = inner(...a);
    if (!window.__want) return r;
    window.__want = false;
    // the car's screen box, from its actual world bounds
    box.setFromObject(g.carRoot);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.project(g.camera);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const px = n => Math.max(0, Math.min(W - 1, Math.round((n * 0.5 + 0.5) * W)));
    const py = n => Math.max(0, Math.min(H - 1, Math.round((n * 0.5 + 0.5) * H)));
    const read = (ax0, ay0, ax1, ay1) => {
      const w = Math.max(2, ax1 - ax0), h = Math.max(2, ay1 - ay0);
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(ax0, ay0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let s = 0, s2 = 0, n = 0, blown = 0;
      for (let i = 0; i < buf.length; i += 4) {
        const L = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
        s += L; s2 += L * L; n++;
        if (L > 244) blown++;
      }
      const m = s / n;
      return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)), blown: 100 * blown / n, n };
    };
    const cx0 = px(x0), cx1 = px(x1), cy0 = py(y0), cy1 = py(y1);
    const car = read(cx0, cy0, cx1, cy1);
    // a same-sized patch of road to the left of the car, as a scene reference
    const w = cx1 - cx0;
    const road = read(Math.max(0, cx0 - w - 20), cy0, Math.max(2, cx0 - 20), cy1);
    window.__lum = { car, road, boxW: w, boxH: cy1 - cy0 };
    return r;
  };
});

const probe = async () => {
  await page.evaluate(() => { window.__want = true; window.__lum = null; });
  await page.waitForFunction(() => window.__lum, null, { timeout: 15_000 });
  return page.evaluate(() => window.__lum);
};

await page.evaluate(() => { window.__game.setCam(0); window.__game.setAuto(false); });

/* Drive the car to a stretch of road that points at the sun. Sweeping the day
   with the car wherever it happened to be never produced the failure case: the
   flare only lands on the bodywork when you are driving into the light, and on
   a winding road that is a specific place, not a specific time. Search the
   heading instead of hoping to stumble into it. */
/* No teleporting. Jumping the car to a distant s outruns the world streamer —
   the tiles under the new position have not been built, groundYAt answers from
   nothing and the rig ends up inside the tarmac; two attempts at it produced
   photographs of the underside of the road and of an empty verge. Just drive,
   and wait for the road to point at the sun on its own. The world streams
   continuously while driving, so everything under the camera exists. */
const alignment = () => page.evaluate(() => {
  const g = window.__game, T = g.THREE;
  const sv = g.sky.material.uniforms.sunPosition.value.clone().normalize();
  const fwd = new T.Vector3(); g.camera.getWorldDirection(fwd);
  return { align: fwd.dot(sv), elev: g.SKYST.elev, kmh: Math.abs(g.car.vLong) * 3.6,
           camAboveCar: g.camera.position.y - g.car.y, n: g.car.n };
});

await page.evaluate(() => window.__game.setAuto(true));
const tag = process.argv[2] || 'bloom';
console.log('  dayT   sun elev  align   CAR mean/contrast/blown     road mean   verdict');
const worst = { score: -1 };
for (const d of [0.00, 0.05, 0.10, 0.16, 0.93]) {
  await page.evaluate(v => window.__game.setDay(v), d);
  await page.waitForTimeout(600);
  // drive until the shot is actually into the light, or give up on this time
  let best = { align: -2 }, bestL = null;
  for (let i = 0; i < 90; i++) {
    const a = await alignment();
    if (a.align > best.align && a.camAboveCar > 0.4 && a.camAboveCar < 12 && Math.abs(a.n) < 7) {
      const L = await probe();
      best = a; bestL = L;
      if (a.align > 0.93) break;
    }
    await page.waitForTimeout(220);
  }
  if (!bestL) { console.log(`  ${d.toFixed(2)}   (never faced the sun on the road)`); continue; }
  const bad = bestL.car.sd < 30 && bestL.car.mean > 115;
  const score = bestL.car.mean / Math.max(8, bestL.car.sd);
  if (score > worst.score && best.align > 0.6) {
    worst.score = score; worst.dayT = d;
    await page.screenshot({ path: `shots/${tag}-into-sun.png` });
  }
  console.log(`  ${d.toFixed(2)}   ${best.elev.toFixed(1).padStart(6)}  ${best.align.toFixed(2)}   ` +
              `${bestL.car.mean.toFixed(1).padStart(6)} / ${bestL.car.sd.toFixed(1).padStart(5)} / ${bestL.car.blown.toFixed(1).padStart(5)}%  ` +
              `${bestL.road.mean.toFixed(1).padStart(8)}   ${bad ? '<-- washed out' : ''}`);
}
console.log(`\n  worst: dayT ${(worst.dayT ?? 0).toFixed(2)}, bright/flat score ${worst.score.toFixed(2)}` +
            `  (higher is more washed out)   shots/${tag}-into-sun.png`);

await bye(0);
