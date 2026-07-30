/* Camera and chassis diagnostics.

   Two complaints, two numbers:

   "once it gets airborne it's all over" — measured as where the car actually
   sits in the frame. Projecting the car into normalised device coordinates says
   exactly when it leaves the shot and by how far, which no screenshot taken
   after the fact can tell you.

   "the car is vibrating" — measured as ride height, pitch and roll sampled once
   per rendered frame. Vibration is direction reversals per second, not
   amplitude: a body that moves 2 cm smoothly looks planted, and one that moves
   2 mm forty times a second looks broken.                                    */
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

/* Per-frame recorder, installed once and reset between takes. */
await page.evaluate(() => {
  const g = window.__game, T = g.THREE;
  const carW = new T.Vector3(), ndc = new T.Vector3();
  window.__rec = { on: false, rows: [] };
  /* Sample once per *rendered* frame by hooking the composer, not once per
     requestAnimationFrame. On a 200 Hz panel with the 60 fps cap in place rAF
     fires three times per drawn frame, so an rAF-driven probe sees the rendered
     transform as a staircase and reports a 66.7 Hz "vibration" that is 200/3 —
     its own sampling rate, and nothing to do with the game. */
  const tick = () => {
    const R = window.__rec;
    if (!R.on) return;
    const c = g.car, f = g.frameAt(c.s);
    carW.set(f.x + Math.cos(f.h) * c.n, c.y + 0.6, f.z - Math.sin(f.h) * c.n);
    ndc.copy(carW).project(g.camera);
    const gnd = g.sampleWheels();
    R.rows.push({
      t: performance.now(),
      ride: c.y - gnd.avg, pitch: c.pitch, roll: c.roll, air: c.air ? 1 : 0,
      ndcx: ndc.x, ndcy: ndc.y, ndcz: ndc.z,
      cx: g.camera.position.x, cy: g.camera.position.y, cz: g.camera.position.z,
      dy: g.camera.position.y - c.y,        // rig height above the car, not above sea level
      kmh: Math.abs(c.vLong) * 3.6,
      /* The *rendered* transform, not the simulation state. car.s is restored
         to the newest physics step before this callback runs, so sampling it
         measures the 120 Hz simulation — which aliases against a 60 Hz display
         by design and always will. What matters is where the body was actually
         drawn, which is what the interpolation exists to smooth. */
      wx: g.carRoot.position.x, wz: g.carRoot.position.z, wyaw: g.carRoot.rotation.y,
      s: c.s,
    });
  };
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) { tick(); return inner(...a); };
});
const record = async (ms, label) => {
  await page.evaluate(() => { window.__rec.rows.length = 0; window.__rec.on = true; });
  await page.waitForTimeout(ms);
  await page.evaluate(() => { window.__rec.on = false; });
  const rows = await page.evaluate(() => window.__rec.rows);
  return { label, rows };
};

/* reversals per second: how often the signal changes direction. This is what
   reads as buzz; peak-to-peak amplitude on its own does not. */
const analyse = (rows, key) => {
  if (rows.length < 3) return { hz: 0, pp: 0, n: 0 };
  let rev = 0, prev = 0, mn = 1e9, mx = -1e9;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i][key] - rows[i - 1][key];
    if (Math.abs(d) > 1e-6) { if (prev && Math.sign(d) !== Math.sign(prev)) rev++; prev = d; }
    mn = Math.min(mn, rows[i][key]); mx = Math.max(mx, rows[i][key]);
  }
  const secs = (rows[rows.length - 1].t - rows[0].t) / 1000;
  return { hz: rev / 2 / Math.max(0.001, secs), pp: mx - mn, n: rows.length };
};
/* Vibration means the body shaking while it is sitting on the road. Frames
   where the car is airborne or out in the scenery are real suspension travel,
   not buzz, and left in they swamp the measurement — the first run of this
   reported twelve metres of "ride height vibration", which was the car driving
   off a bank with nobody steering. */
const settled = rows => rows.filter(r => !r.air && Math.abs(r.ndcz) < 1);

/* Shimmer, as distinct from motion. Smooth travel has a small, slowly varying
   second difference; a body being nudged off a piecewise-linear path has one
   that flips sign every sample. Reported as the rate of sign flips and the
   typical size of the flip, both of which a plain min/max would hide behind the
   metres of legitimate movement happening at the same time. */
const shimmer = (rows, key) => {
  if (rows.length < 4) return { hz: 0, amp: 0 };
  let flips = 0, prev = 0, sum = 0, k = 0;
  for (let i = 2; i < rows.length; i++) {
    const d2 = rows[i][key] - 2 * rows[i - 1][key] + rows[i - 2][key];
    if (Math.abs(d2) > 1e-9) {
      if (prev && Math.sign(d2) !== Math.sign(prev)) flips++;
      prev = d2;
    }
    sum += Math.abs(d2); k++;
  }
  const secs = (rows[rows.length - 1].t - rows[0].t) / 1000;
  return { hz: flips / 2 / Math.max(0.001, secs), amp: sum / Math.max(1, k) };
};
const framing = rows => {
  let off = 0, worst = 0, behind = 0, wx = 0, wy = 0, offX = 0, offY = 0, ySum = 0, n = 0;
  for (const r of rows) {
    if (r.ndcz > 1 || r.ndcz < -1) { behind++; continue; }
    const out = Math.max(Math.abs(r.ndcx), Math.abs(r.ndcy));
    if (out > 1) off++;
    if (Math.abs(r.ndcx) > 1) offX++;
    if (Math.abs(r.ndcy) > 1) offY++;
    worst = Math.max(worst, out);
    wx = Math.max(wx, Math.abs(r.ndcx)); wy = Math.max(wy, Math.abs(r.ndcy));
    ySum += r.ndcy; n++;
  }
  return { offPct: 100 * off / Math.max(1, rows.length), worst, wx, wy,
           offXPct: 100 * offX / Math.max(1, rows.length),
           offYPct: 100 * offY / Math.max(1, rows.length),
           meanY: ySum / Math.max(1, n),
           behindPct: 100 * behind / Math.max(1, rows.length) };
};
const place = (kmh, ds) => page.evaluate(([v, d]) => {
  const g = window.__game;
  g.setAuto(false);
  g.car.s += d; g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0;
  g.car.vLong = v / 3.6; g.car.steer = 0; g.car.offroad = 0;
  g.input.st = 0; g.input.th = 0; g.input.br = 0;
  g.settleSuspension(); g.placeCar(); g.camSnap();
}, [kmh, ds]);

const camNames = await page.evaluate(() => window.__game.CAMS.map(c => c.name));

/* Driven by the game's own pilot, which holds the lane to 0.4 m. Steering it
   by hand at 220 km/h puts it in the trees within seconds and then every
   number is about the trees. */
/* What "the car is vibrating" actually means is the body jiggling inside the
   frame, so the number that matters is its position on screen, not in the world.
   A world-space measurement cannot tell the difference between a car that is
   shaking and a camera that is: both move the body in the world, only one of
   them is visible. Screen position in NDC captures exactly what the eye sees.
   Run with the interpolation off and on, so the difference is attributable. */
console.log('=== 1. does the car jiggle in the frame? (autopilot) ===');
console.log('    on-screen shimmer is what you see; world shimmer is mostly frame-time jitter');
await page.evaluate(() => window.__game.setAuto(true));
for (const interp of [false, true]) {
  await page.evaluate(v => window.__game.setInterp(v), interp);
  // same stretch of road for both conditions, so the pilot picks the same
  // speeds and the two runs are actually comparable
  for (const [label, s0] of [['@s3000', 3000], ['@s9000', 9000]]) {
    await page.evaluate(v => { window.__game.car.s = v; window.__game.camSnap(); }, s0);
    await page.waitForTimeout(2500);
    const { rows } = await record(5000, label);
    const s = settled(rows);
    const kmh = s.reduce((a, b) => a + b.kmh, 0) / Math.max(1, s.length);
    const nx = shimmer(s, 'ndcx'), ny = shimmer(s, 'ndcy'), sx = shimmer(s, 'wx');
    let dtsum = 0, dtjit = 0;
    for (let i = 2; i < s.length; i++) {
      const a = s[i].t - s[i - 1].t, b = s[i - 1].t - s[i - 2].t;
      dtsum += a; dtjit += Math.abs(a - b);
    }
    console.log(`  interp ${interp ? 'ON ' : 'OFF'} ${label} @${kmh.toFixed(0)} km/h  ` +
                `ON SCREEN x ${(nx.amp * 1000).toFixed(3)} y ${(ny.amp * 1000).toFixed(3)} mNDC/frame²  ` +
                `| world posX ${(sx.amp * 1000).toFixed(1)}mm  ` +
                `frame ${(dtsum / Math.max(1, s.length - 2)).toFixed(1)}ms jitter ${(dtjit / Math.max(1, s.length - 2)).toFixed(2)}ms`);
  }
}
await page.evaluate(() => { window.__game.setInterp(true); window.__game.setAuto(false); });

/* Lifting the body clear of its springs is the only reliable way to get air on
   demand: pushing vy up instead is cancelled within three physics steps by the
   rebound damping, which is why the first version of this test never got the
   car off the ground at all. In play the same thing happens naturally when the
   ground drops away over a crest. */
console.log('\n=== 2. is the car in frame while airborne? ===');
for (let m = 0; m < camNames.length; m++) {
  if (camNames[m] === 'HOOD') { console.log('  HOOD       skipped — the camera is the car'); continue; }
  await page.evaluate(i => window.__game.setCam(i), m);
  await place(150, 500);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(900);
  await page.evaluate(() => { const c = window.__game.car; c.y += 4.5; c.vy = 3; c.air = true; });
  const { rows } = await record(2600, 'air');
  await page.keyboard.up('KeyW');
  const airRows = rows.filter(r => r.air);
  const fr = framing(rows), frAir = framing(airRows);
  const ch = analyse(rows, 'dy');
  console.log(`  ${camNames[m].padEnd(10)} airborne ${airRows.length}/${rows.length}  ` +
              `off-frame ${fr.offPct.toFixed(0)}% (airborne only ${frAir.offPct.toFixed(0)}%,` +
              ` x ${fr.offXPct.toFixed(0)}% / y ${fr.offYPct.toFixed(0)}%)  ` +
              `worst x ${fr.wx.toFixed(2)} y ${fr.wy.toFixed(2)}  rig above car pp ${ch.pp.toFixed(2)}m` +
              `   ${fr.offPct > 5 || fr.behindPct > 0 ? '<-- car leaves the shot' : 'OK'}`);
}

/* Autopilot again, so the car is genuinely on the road at speed and any lost
   framing is the rig losing the car rather than the car losing the road. */
console.log('\n=== 3. is the car in frame at high speed on the road? ===');
await page.evaluate(() => window.__game.setAuto(true));
for (let m = 0; m < camNames.length; m++) {
  if (camNames[m] === 'HOOD') { console.log('  HOOD       skipped — the camera is the car'); continue; }
  await page.evaluate(i => window.__game.setCam(i), m);
  await page.waitForTimeout(2200);
  const { rows } = await record(6000, 'fast');
  const fr = framing(rows);
  const c = analyse(rows, 'dy');                       // height above the car
  const kmh = rows.reduce((a, b) => a + b.kmh, 0) / Math.max(1, rows.length);
  console.log(`  ${camNames[m].padEnd(10)} @${kmh.toFixed(0)} km/h  off-frame ${fr.offPct.toFixed(0)}%` +
              ` (x ${fr.offXPct.toFixed(0)}% / y ${fr.offYPct.toFixed(0)}%)  worst x ${fr.wx.toFixed(2)} y ${fr.wy.toFixed(2)}` +
              `  mean ndcY ${fr.meanY.toFixed(2)}  rig height above car pp ${c.pp.toFixed(2)}m` +
              `   ${fr.offPct > 5 || c.pp > 3 ? '<-- rig unstable' : 'OK'}`);
}
await page.evaluate(() => window.__game.setAuto(false));

await page.evaluate(() => window.__game.setCam(0));
await bye(0);
