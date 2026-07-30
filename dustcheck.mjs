/* Rear-wheel dust: does standing on the throttle actually throw anything up,
   and does a clean cruise stay clean?

   Headed, because particles are only observable through a renderer that is
   actually running — the emitter lives in the frame loop, not in stepPhysics. */
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

const key = (code, down) => page.evaluate(([c, d]) => {
  window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c, bubbles: true }));
}, [code, down]);

/** Hold a key set for `ms`, sampling live particles and the slip signal. */
async function phase(name, keys, ms, prep) {
  if (prep) await page.evaluate(prep);
  for (const k of keys) await key(k, true);
  const t0 = Date.now();
  let peak = 0, slipPeak = 0, n = 0, sum = 0;
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => ({
      dust: window.__game.dustLive,
      slip: window.__game.car.wheelslip,
      kmh: Math.abs(window.__game.car.vLong) * 3.6,
      screech: window.__game.car.screech,
      off: window.__game.car.offroad,
      fps: window.__game.fps,
    }));
    peak = Math.max(peak, s.dust); slipPeak = Math.max(slipPeak, s.slip);
    sum += s.dust; n++;
    if (n === 1 || Date.now() - t0 > ms - 60) global.__last = s;
    await page.waitForTimeout(70);
  }
  for (const k of keys) await key(k, false);
  const s = global.__last;
  console.log(`  ${name.padEnd(22)} peak ${String(peak).padStart(4)}  mean ${(sum / n).toFixed(0).padStart(4)}  ` +
              `wheelslip peak ${slipPeak.toFixed(2)}  ${s.kmh.toFixed(0).padStart(3)} km/h  ` +
              `screech ${s.screech.toFixed(2)}  ${s.fps.toFixed(0)} fps`);
  return { peak, mean: sum / n, slipPeak };
}

console.log('\n  rear-wheel dust\n');

// Rest, no input: the ring should be empty.
await page.evaluate(() => { const g = window.__game; g.setAuto(false); g.resetCar && g.resetCar(); });
await page.waitForTimeout(2200);
const idle = await phase('idle, no throttle', [], 900);

// Standing start on full throttle — the case that produced nothing before.
const launch = await phase('standing-start launch', ['KeyW'], 2600, () => {
  const g = window.__game; g.setAuto(false); g.resetCar && g.resetCar();
});
await page.screenshot({ path: 'shots/p2-04-dust-launch.png' });

/* Steady cruise. Deliberately on autopilot and after a settling delay: holding
   KeyW straight on from the launch phase is still *accelerating*, and a car
   accelerating hard is supposed to be throwing dust. The claim being tested is
   that ordinary driving is clean, so ordinary driving is what has to be measured. */
await page.evaluate(() => window.__game.setAuto(true));
await page.waitForTimeout(5000);
const cruise = await phase('steady cruise (auto)', [], 2600);
await page.screenshot({ path: 'shots/p2-04-dust-cruise.png' });
await page.evaluate(() => window.__game.setAuto(false));

/* Brake to a stop rather than calling resetCar(). resetCar() puts the car back
   at s = 0, and after a kilometre and a half of cruising that means the streamer
   has to rebuild the entire world under it — the page dropped to 1 fps and both
   measurement windows fell inside the stall, reporting zero emission for a
   burnout. Braking keeps the car where the terrain already is. */
await key('KeyS', true);
for (let i = 0; i < 120; i++) {
  const kmh = await page.evaluate(() => Math.abs(window.__game.car.vLong) * 3.6);
  if (kmh < 3) break;
  await page.waitForTimeout(80);
}
await key('KeyS', false);
await page.waitForTimeout(600);

/* Burnout from rest: handbrake and throttle, no steering. This is the shot —
   the car stays on the tarmac and in frame, where a full-lock drift from 150
   leaves the road and photographs a hedge. */
const burn = await phase('standing burnout', ['KeyW', 'Space'], 2000);
await page.screenshot({ path: 'shots/p2-04-dust-burnout.png' });

// Deliberate drift: rolling, then handbrake and a short stab of lock.
await key('KeyW', true); await page.waitForTimeout(2600);
const drift = await phase('handbrake drift', ['Space', 'KeyA'], 1300);
await key('KeyW', false);
await page.screenshot({ path: 'shots/p2-04-dust-drift.png' });

console.log('');
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}   ${detail}`);
  if (!ok) process.exitCode = 1;
};
check('idle throws up nothing', idle.peak <= 2, `peak ${idle.peak} live`);
check('a launch throws up dust', launch.peak >= 25,
      `peak ${launch.peak} live, wheelslip ${launch.slipPeak.toFixed(2)}`);
check('a burnout throws up smoke', burn.peak >= 60, `peak ${burn.peak} live`);
check('a drift throws up dust', drift.peak >= 40, `peak ${drift.peak} live`);
check('cheap: never near the 900 ring cap', Math.max(launch.peak, burn.peak, drift.peak) < 700,
      `worst ${Math.max(launch.peak, burn.peak, drift.peak)} of 900`);
check('a clean cruise stays clean', cruise.mean < launch.mean * 0.7,
      `cruise mean ${cruise.mean.toFixed(0)} vs launch ${launch.mean.toFixed(0)}`);

if (errs.length) { console.log('\n  page errors:'); errs.slice(0, 6).forEach(e => console.log('   ', e.slice(0, 160))); }
else console.log('\n  no page errors');
await bye(process.exitCode || 0);
