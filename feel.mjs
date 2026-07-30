/* Handling characterisation, repeated.

   A single measurement of steering response is a curvature lottery: the road is
   never straight, so the same input reads differently depending on which way
   the bend happens to go where the test lands. Earlier runs of the same build
   reported the identical manoeuvre as anything from 8% to 100% of full lock.
   This repeats each test at several places along the road and reports the
   median, which is a number worth quoting.

   Scored against the car's own steady-state yaw rate at full lock, because an
   absolute rad/s threshold means something different at every speed.         */
import { chromium } from 'playwright';
import './tame.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const REPS = +(process.argv[2] || 5);
const ROOT = path.resolve('.');
const srv = http.createServer((rq, rs) => {
  const f = path.join(ROOT, rq.url === '/' ? 'index.html' : decodeURI(rq.url.split('?')[0]));
  fs.readFile(f, (e, d) => e ? (rs.writeHead(404), rs.end())
    : (rs.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }), rs.end(d)));
});
await new Promise(r => srv.listen(0, r));

let browser;
const bye = async (code, why) => {
  if (why) console.error('\n[teardown]', why);
  try { await browser?.close(); } catch {}
  srv.close();
  process.exit(code);
};
process.on('SIGINT', () => bye(130, 'interrupted'));
process.on('SIGTERM', () => bye(143, 'terminated'));
process.on('uncaughtException', e => bye(1, e));
process.on('unhandledRejection', e => bye(1, e));

browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--window-position=-2400,-1400', '--window-size=1360,800',
         '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
await page.keyboard.press('Space');
await page.waitForTimeout(2200);

/* Absolute yaw rate, deliberately. These tests ask the car to respond to a
   steering input, not to follow the road: it starts pointed straight and is
   never asked to track a bend, so the road's own curvature is not part of the
   answer. Subtracting it — which is right when measuring lane keeping — makes a
   car holding a perfectly steady turn look like it is still accelerating,
   because the road underneath keeps changing shape. */
const probe = () => page.evaluate(() => {
  const c = window.__game.car;
  return { n: c.n, omega: c.omega,
           beta: Math.abs(Math.atan2(c.vLat, Math.max(2, Math.abs(c.vLong)))) * 180 / Math.PI,
           kmh: Math.abs(c.vLong) * 3.6 };
});
const place = (kmh, s) => page.evaluate(([v, ds]) => {
  const g = window.__game;
  g.setAuto(false);
  g.car.s += ds; g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0;
  g.car.vLong = v / 3.6; g.car.steer = 0; g.car.offroad = 0;
  g.input.st = 0; g.input.th = 0; g.input.br = 0; g.input.hb = 0;
  g.settleSuspension(); g.placeCar(); g.camSnap();
}, [kmh, s]);
const steady = kmh => page.evaluate(v => {
  const g = window.__game, s = v / 3.6;
  return s * g.steerCapAt(s) / (g.WB + g.KUS * s * s);
}, kmh);
const med = a => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const fmt = a => `${med(a).toFixed(2)}  [${Math.min(...a).toFixed(2)} .. ${Math.max(...a).toFixed(2)}]`;

const tap = [], tapB = [], hold = [], holdB = [], holdFlat = [], settle = [], spin = [];

for (let r = 0; r < REPS; r++) {
  const jump = 1200 + r * 900;

  // --- 250 ms tap at 110 ---
  await place(110, jump);
  const ss110 = await steady(110);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(500);
  const base = (await probe()).omega;
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyD');
  let pk = 0, pb = 0;
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(100);
    const p = await probe();
    pk = Math.max(pk, Math.abs(p.omega - base)); pb = Math.max(pb, p.beta);
  }
  await page.keyboard.up('KeyW');
  tap.push(pk / ss110); tapB.push(pb);

  /* --- 3 s hold at 120: an arc, or a slide that keeps building? Scored on
     whether the sideslip is still growing at the end rather than on whether the
     yaw rate is flat — three seconds of hard cornering puts the car in the
     verge, and out there the terrain keeps nudging the yaw rate around long
     after the car itself has settled into a steady attitude. */
  await place(120, 300);
  const ss120 = await steady(120);
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
  let hp = 0, hb = 0, hbAll = 0, onRoadMs = 0; const bEarly = [], bLate = [];
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const p = await probe();
    hbAll = Math.max(hbAll, p.beta);
    /* Only score while the car is still on the road. Full lock at 120 km/h
       describes a radius the lane cannot contain, so within a second or so the
       car is in the verge by design — and grip, the stability assist and the
       shoulder all change out there. Judging "planted" on that measures the
       ditch, not the car. */
    if (Math.abs(p.n) < 20) {
      onRoadMs += 100;
      hp = Math.max(hp, Math.abs(p.omega)); hb = Math.max(hb, p.beta);
      if (i < 15) bEarly.push(p.beta); else bLate.push(p.beta);
    }
  }
  await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
  const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  hold.push(hp / ss120); holdB.push(hb);
  holdFlat.push(bLate.length === 0 || mean(bLate) < mean(bEarly) * 1.6 + 4 ? 1 : 0);
  spin.push(hbAll > 55 ? 1 : 0);
  process.stdout.write(`      (on road for ${onRoadMs} ms of the 3 s hold; worst sideslip anywhere ${hbAll.toFixed(0)}deg)\n`);

  /* --- release, from its own clean start. Run as a continuation of the hold
     above it measured how long the scenery takes to stop shoving the car, not
     whether the car straightens itself. */
  await place(110, 300);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(1000);
  await page.keyboard.up('KeyD');
  const rel = Math.abs((await probe()).omega);
  let ms = 3000;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    if (Math.abs((await probe()).omega) < Math.max(0.02, rel * 0.25)) { ms = (i + 1) * 100; break; }
  }
  await page.keyboard.up('KeyW');
  settle.push(ms);
  process.stdout.write(`  rep ${r + 1}/${REPS}: tap ${(100 * tap[r]).toFixed(0)}%  hold ${(100 * hold[r]).toFixed(0)}%` +
                       `  sideslip ${hb.toFixed(0)}deg  settle ${ms}ms\n`);
}

console.log('\n--- medians over ' + REPS + ' places on the road ---');
console.log(`250ms tap @110   ${(100 * med(tap)).toFixed(0)}% of full-lock yaw` +
            `   [${(100 * Math.min(...tap)).toFixed(0)} .. ${(100 * Math.max(...tap)).toFixed(0)}]` +
            `   sideslip ${fmt(tapB)} deg`);
console.log(`3s hold  @120    ${(100 * med(hold)).toFixed(0)}% of full-lock yaw` +
            `   [${(100 * Math.min(...hold)).toFixed(0)} .. ${(100 * Math.max(...hold)).toFixed(0)}]` +
            `   sideslip ${fmt(holdB)} deg`);
console.log(`  slide not building ${holdFlat.filter(Boolean).length}/${REPS} reps (sideslip flat or falling by the end)`);
console.log(`  spins            ${spin.filter(Boolean).length}/${REPS}`);
console.log(`release @110     yaw down to a quarter in ${med(settle)} ms   [${Math.min(...settle)} .. ${Math.max(...settle)}]`);

const ok = med(tap) > 0.04 && med(tap) < 0.85 && med(tapB) < 15
        && med(hold) < 1.35 && med(holdB) < 45 && !spin.some(Boolean)
        && holdFlat.filter(Boolean).length >= Math.ceil(REPS * 0.6)
        && med(settle) <= 2500;
console.log(ok ? '\nHANDLING OK' : '\nHANDLING PROBLEM');
await bye(ok ? 0 : 1);
