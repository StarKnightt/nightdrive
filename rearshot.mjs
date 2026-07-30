/* Photograph the rear end, which is what the chase camera frames for most of the
   run: coasting, on the brakes, and at night. Close orbit behind the car so the
   cluster is actually resolvable rather than four pixels of red. */
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
const errs = [];
page.on('pageerror', e => errs.push(String(e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
await page.evaluate(() => window.__game.begin());
await page.waitForTimeout(2600);
await page.evaluate(() => window.__game.setAuto(true));
await page.waitForTimeout(3000);

const key = (code, down) => page.evaluate(([c, d]) => {
  window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
}, [code, down]);

/* Park the camera in close behind the car for these shots. The chase rig is 6.7 m
   back with a 60-degree lens, which is the right shot for driving and the wrong
   one for inspecting a light cluster. */
const closeUp = (dist, high, lead, fov) => page.evaluate(([d, h, l, fv]) => {
  const g = window.__game;
  const near = g.CAMS.findIndex(c => c.id === 'near');
  g.setCam(near);
  /* `lead` is what actually decides whether this is a photograph of the tail or
     of the road over the roof: the rig aims at a point that far up the road, so
     the default 14 m looks straight past the car. Pulled in to a couple of
     metres it looks down at the back of it instead. */
  g.CAMS[near].dist = d; g.CAMS[near].high = h;
  g.CAMS[near].lead = l; g.CAMS[near].fov = fv;
  g.camSnap();
}, [dist, high, lead, fov]);

const shots = [
  { name: 'coast', day: 0.09, dist: 9.0, high: 1.62, lead: 2.0, fov: 26, keys: [], sec: 2.2 },
  { name: 'braking', day: 0.09, dist: 9.0, high: 1.62, lead: 2.0, fov: 26, keys: ['KeyS'], sec: 1.3 },
  { name: 'night-braking', day: 0.58, dist: 9.0, high: 1.66, lead: 2.0, fov: 26, keys: ['KeyS'], sec: 1.5 },
  { name: 'threequarter', day: 0.11, dist: 8.0, high: 2.10, lead: 6.0, fov: 34, keys: [], sec: 2.0 },
];
console.log('\n  rear end\n');
for (const s of shots) {
  await page.evaluate(v => window.__game.setDay(v), s.day);
  await closeUp(s.dist, s.high, s.lead, s.fov);
  // autopilot rewrites the input vector every frame, so a held brake key never
  // reaches the car; hand control back for the shots that need the pedal
  await page.evaluate(b => window.__game.setAuto(b), s.keys.length === 0);
  await page.waitForTimeout(900);
  for (const k of s.keys) await key(k, true);
  await page.waitForTimeout(s.sec * 1000);
  const st = await page.evaluate(() => {
    const g = window.__game;
    return { kmh: Math.abs(g.car.vLong) * 3.6, fps: g.fps,
             tail: g.tailMat ? g.tailMat.emissiveIntensity : -1,
             parts: g.info() && g.info().carParts };
  });
  await page.screenshot({ path: `shots/p2-05-rear-${s.name}.png` });
  for (const k of s.keys) await key(k, false);
  console.log(`  ${s.name.padEnd(14)} ${st.kmh.toFixed(0).padStart(3)} km/h  ` +
              `tail emissive ${st.tail.toFixed(2).padStart(5)}  ${st.fps.toFixed(0)} fps` +
              `   -> shots/p2-05-rear-${s.name}.png`);
}

const draws = await page.evaluate(() => {
  const g = window.__game, i = g.info();
  return { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles,
           carParts: i && i.carParts };
});
console.log(`\n  draw calls ${draws.calls}, triangles ${draws.tris.toLocaleString()}, ` +
            `visible car meshes ${draws.carParts}`);

if (errs.length) { console.log('\n  page errors:'); errs.slice(0, 6).forEach(e => console.log('   ', e.slice(0, 160))); }
else console.log('  no page errors');
await bye(0);
