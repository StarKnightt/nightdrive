/* Permanent regression assertions for the five bugs in FEEDBACK.md §0.4.

   Driving is done through the game's own fixed-step simulator, which sets
   KEYS_DOWN and calls readInput() — the same path a player's keystrokes take,
   so the input mapping is genuinely under test — but without waiting on the
   renderer. That distinction matters: driven by real-time key events under
   SwiftShader, a full run advanced the simulation by 206 steps in a hundred
   seconds, because one frame of this scene costs seconds on a software
   rasteriser. The car never moved and every handling assertion trivially
   "passed". The DOM listener that fills KEYS_DOWN is the one link this skips,
   so it is checked directly with real key events at the end.

   Ground truth for "never below the surface" is sampled once per physics step
   through the game's stepHook, not once per frame: at 120 Hz simulation a
   frame-rate probe misses every other step, and a one-step excursion is exactly
   the kind of thing that gets missed.

   Every check is an assertion and the process exits non-zero on any failure, so
   a regression breaks the run instead of scrolling past. Thresholds are loose
   on purpose — they exist to catch the bug returning, not to freeze tuning.

     node assert-drive.mjs                                                    */
import { run } from './harness.mjs';
import './tame.mjs';

const results = [];
let failed = 0;
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

/* Per-step invariant recorder, installed once into the page. */
const INSTALL = () => {
  const g = window.__game;
  const M = window.__mon = { steps: 0, sink: 0, worstSink: 0, sinkAt: null, nonFinite: 0, spinPeak: 0 };
  g.setStepHook(gnd => {
    const c = g.car;
    M.steps++;
    if (!Number.isFinite(c.y) || !Number.isFinite(c.s) || !Number.isFinite(c.yaw) ||
        !Number.isFinite(c.vLong) || !Number.isFinite(c.n)) { M.nonFinite++; return; }
    /* The physics clamps to gnd.max - 0.10. More than a further 25 cm under the
       highest contact point is the body inside the world; the margin keeps
       ordinary suspension compression over a crest from reading as a failure. */
    const under = (gnd.max - 0.35) - c.y;
    if (under > 0) {
      M.sink++;
      if (under > M.worstSink) { M.worstSink = under; M.sinkAt = { s: +c.s.toFixed(0), y: +c.y.toFixed(2), gnd: +gnd.max.toFixed(2) }; }
    }
    if (Math.hypot(c.vLong, c.vLat) > 4) {
      const slip = Math.abs(Math.atan2(c.vLat, Math.abs(c.vLong))) * 57.2958;
      if (slip > M.spinPeak) M.spinPeak = slip;
    }
  });
};

export async function suite(page) {
  await page.evaluate(INSTALL);

  /* Run a scripted key plan at the real 120 Hz physics rate and return both the
     telemetry and the per-step monitor. */
  const sim = (plan, opts = {}) => page.evaluate(([p, o]) => {
    const g = window.__game;
    if (o.reset !== false) {
      g.setAuto(false);
      // absolute when given, so two runs can be compared on identical road
      if (o.at !== undefined) g.car.s = o.at;
      else g.car.s += (o.ds === undefined ? 300 : o.ds);
      g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0;
      g.car.vLong = (o.kmh || 0) / 3.6;
      g.car.steer = 0; g.car.steerVis = 0; g.car.offroad = 0;
      g.input.st = 0; g.input.th = 0; g.input.br = 0; g.input.hb = 0; g.input.bo = false;
      g.settleSuspension(); g.placeCar(); g.camSnap();
    }
    if (o.clearPeak !== false) window.__mon.spinPeak = 0;
    const rows = g.simulate(p, 60, 120);
    const c = g.car, T = g.THREE, fr = g.frameAt(c.s);
    // screen-space truth: which way does +n point, camera-left or camera-right?
    /* Sampled 25 m up the road, not at the car. The bonnet camera sits slightly
       ahead of the car's own origin, so projecting the car put the reference
       point behind the near plane, where project() mirrors the result and
       reported +n as screen-right in that one mode alone. Anywhere ahead is in
       front of every rig. */
    const ah = g.frameAt(c.s + 25);
    const p0 = new T.Vector3(ah.x + Math.cos(ah.h) * c.n, c.y, ah.z - Math.sin(ah.h) * c.n);
    const p1 = new T.Vector3(ah.x + Math.cos(ah.h) * (c.n + 1), c.y, ah.z - Math.sin(ah.h) * (c.n + 1));
    p0.project(g.camera); p1.project(g.camera);
    return { rows, mon: { ...window.__mon },
             car: { s: c.s, n: c.n, yaw: c.yaw, vLong: c.vLong, vLat: c.vLat, omega: c.omega },
             nScreenX: p1.x - p0.x };
  }, [plan, opts]);

  const peak = (rows, key) => rows.reduce((a, r) => Math.max(a, Math.abs(r[key])), 0);

  /* (1) rendering defaults ------------------------------------------------- */
  console.log('\n(1) rendering defaults — no-MSAA must be the default');
  const rt = await page.evaluate(() => ({
    samples: window.__game.composer.renderTarget1.samples | 0,
    hash: location.hash,
    optIn: window.__game.composer.renderTarget1.samples > 0,
  }));
  check('no-MSAA by default (no #msaa in the URL)', rt.samples === 0,
        `composer target samples=${rt.samples}, hash="${rt.hash || '(none)'}"`);
  /* A black screen on ANGLE/D3D11 is a driver-side multisample resolve failure
     that a software rasteriser cannot reproduce, so the honest headless test is
     that the setting is off — the pixels are checked headed by playtest.mjs. */

  /* (2) ground containment ------------------------------------------------- */
  console.log('\n(2) the car can never end up under the world');
  const abuse = [
    { tag: 'launch', sec: 6, keys: ['KeyW'] },
    { tag: 'boost', sec: 8, keys: ['KeyW', 'ShiftLeft'] },
    { tag: 'hard left', sec: 4, keys: ['KeyW', 'KeyA'] },
    { tag: 'hard right', sec: 4, keys: ['KeyW', 'KeyD'] },
    { tag: 'boost+turn', sec: 5, keys: ['KeyW', 'ShiftLeft', 'KeyD'] },
    { tag: 'handbrake', sec: 3, keys: ['KeyW', 'Space'] },
    { tag: 'brake', sec: 3, keys: ['KeyS'] },
    { tag: 'offroad blast', sec: 8, keys: ['KeyW', 'ShiftLeft', 'KeyA'] },
    { tag: 'recover', sec: 6, keys: ['KeyW'] },
  ];
  let r = await sim(abuse, { kmh: 40 });
  check('car never sinks below the sampled surface', r.mon.sink === 0,
        `${r.mon.sink} steps under of ${r.mon.steps}, worst ${r.mon.worstSink.toFixed(3)} m` +
        (r.mon.sinkAt ? ` at s=${r.mon.sinkAt.s}` : ''));
  check('car state stays finite', r.mon.nonFinite === 0, `${r.mon.nonFinite} non-finite steps`);

  /* The root cause the user suspected: the tier system re-segmenting the ground
     mesh under a moving car. Drive fast and change tier underneath, repeatedly,
     which is the exact sequence adaptive quality performs on a struggling
     machine. setPerf takes an index into PERF, not a tier name. */
  let tierSink = 0, tierSteps = 0;
  for (const idx of [0, 3, 7, 4, 1, 6, 2]) {
    await page.evaluate(i => window.__game.setPerf(i), idx);
    const t = await sim([{ tag: 'retile', sec: 3.5, keys: ['KeyW', 'ShiftLeft'] }],
                        { kmh: 140, ds: 400 });
    tierSink += t.mon.sink; tierSteps = t.mon.steps;
  }
  check('no sink while quality tiers re-segment the ground underneath', tierSink === 0,
        `7 tier changes at 140 km/h, ${tierSink} steps under of ${tierSteps}`);
  await page.evaluate(() => window.__game.setPerf(2));   // back to the medium start

  /* (3) steering direction ------------------------------------------------- */
  console.log('\n(3) left key turns the car left, in every camera');
  const camNames = await page.evaluate(() => window.__game.CAMS.map(c => c.name));
  /* Measured against a straight-ahead run over the identical stretch of road,
     because the road's own curvature swamps the input otherwise: a 1.5 s run
     through a bend moves the car further sideways than the steering does, and
     the first version of this check was mostly reporting which way the road
     went. Same start s, same speed, same duration — only the key differs, so
     the difference is the key. */
  const AT = 4000, SEC = 1.5, KMH = 90;
  for (let i = 0; i < camNames.length; i++) {
    await page.evaluate(k => window.__game.setCam(k), i);
    const base = await sim([{ sec: 0.6, keys: ['KeyW'] }, { sec: SEC, keys: ['KeyW'] }],
                           { kmh: KMH, at: AT });
    for (const [key, want] of [['KeyA', 'left'], ['KeyD', 'right']]) {
      const res = await sim([{ sec: 0.6, keys: ['KeyW'] }, { sec: SEC, keys: ['KeyW', key] }],
                            { kmh: KMH, at: AT });
      const dn = res.car.n - base.car.n;               // + is roadside-left
      const dYaw = res.car.yaw - base.car.yaw;
      // +n is screen-left when a +n offset projects to a smaller screen x
      const plusNisScreenLeft = res.nScreenX < 0;
      const wentScreenLeft = (dn > 0) === plusNisScreenLeft;
      const moved = Math.abs(dn) > 0.25;
      const ok = moved && ((want === 'left') === wentScreenLeft) &&
                 (dn > 0) === (dYaw > 0);              // heading and path agree
      check(`${camNames[i].padEnd(9)} ${key} steers ${want}`, ok,
            `dn ${dn >= 0 ? '+' : ''}${dn.toFixed(2)} m, dyaw ${(dYaw * 57.3).toFixed(1)}deg, ` +
            `+n screen-x ${res.nScreenX.toFixed(3)}`);
    }
  }
  await page.evaluate(() => window.__game.setCam(0));

  /* (4) stability at speed ------------------------------------------------- */
  console.log('\n(4) planted by default — no spins from ordinary input');

  /* Fixed start positions throughout this section. Left to drift, each test
     began wherever the previous one abandoned the car — frequently well off the
     road on a slope, where terrain contact rotates the body and the numbers
     describe a hillside rather than the handling. */
  const tap = await sim([{ sec: 1.2, keys: ['KeyW'] },
                         { tag: 'tap', sec: 0.25, keys: ['KeyW', 'KeyD'] },
                         { tag: 'settle', sec: 2.2, keys: ['KeyW'] }], { kmh: 115, at: 4000 });
  const tapRows = tap.rows.filter(r => r.tag === 'tap' || r.tag === 'settle');
  check('a 250 ms tap at 115 km/h is a lane change, not a slide',
        peak(tapRows, 'yawRate') < 0.55 && tap.mon.spinPeak < 12,
        `peak yaw ${peak(tapRows, 'yawRate').toFixed(3)} rad/s, peak sideslip ${tap.mon.spinPeak.toFixed(1)}deg`);

  /* Absolute yaw rate, deliberately. Hands off, the car should stop rotating in
     the world and run in a straight line — it should not keep following the
     lane, which is why the road-relative version of this measurement was wrong:
     it demanded the car keep turning with the bend and failed the car for going
     straight. Traced, the release phase holds omega at 0.000 while the road
     curves away underneath, which is exactly the behaviour wanted. */
  const settleRows = tap.rows.filter(x => x.tag === 'settle');
  const relPeak = Math.max(...tap.rows.filter(x => x.tag === 'tap').map(x => Math.abs(x.yawRate)));
  const relEnd = Math.abs(settleRows[settleRows.length - 1].yawRate);
  check('yaw decays once the key comes up (self-centring)',
        relEnd < Math.max(0.05, relPeak * 0.5),
        `peak under input ${relPeak.toFixed(3)} -> ${relEnd.toFixed(3)} rad/s after ${settleRows.length} samples`);

  const flickPlan = [{ sec: 1.2, keys: ['KeyW'] }];
  for (let i = 0; i < 8; i++) {
    flickPlan.push({ tag: 'flick', sec: 0.12, keys: ['KeyW', i % 2 ? 'KeyA' : 'KeyD'] });
    flickPlan.push({ tag: 'flick', sec: 0.10, keys: ['KeyW'] });
  }
  flickPlan.push({ tag: 'after', sec: 1.6, keys: ['KeyW'] });
  const flick = await sim(flickPlan, { kmh: 130, at: 6000 });
  check('rapid alternating taps do not build into a spin', flick.mon.spinPeak < 35,
        `peak sideslip ${flick.mon.spinPeak.toFixed(1)}deg`);

  const brake = await sim([{ sec: 1.2, keys: ['KeyW'] },
                           { tag: 'turn', sec: 0.8, keys: ['KeyW', 'KeyD'] },
                           { tag: 'brake', sec: 1.4, keys: ['KeyS', 'KeyD'] },
                           { tag: 'coast', sec: 1.2, keys: [] }], { kmh: 140, at: 8000 });
  check('hard braking mid-corner does not spin the car', brake.mon.spinPeak < 45,
        `peak sideslip ${brake.mon.spinPeak.toFixed(1)}deg`);

  const lock = await sim([{ sec: 1.0, keys: ['KeyW'] },
                          { tag: 'lock', sec: 2.4, keys: ['KeyW', 'KeyA'] },
                          { tag: 'out', sec: 2.0, keys: ['KeyW'] }], { kmh: 170, at: 10000 });
  check('full lock at 170 km/h slides but does not spin', lock.mon.spinPeak < 60,
        `peak sideslip ${lock.mon.spinPeak.toFixed(1)}deg`);

  const auth = await page.evaluate(() => ({
    slow: window.__game.steerCapAt(8), fast: window.__game.steerCapAt(60),
  }));
  check('steering authority falls with speed', auth.fast < auth.slow * 0.75,
        `${auth.slow.toFixed(3)} rad at 29 km/h -> ${auth.fast.toFixed(3)} at 216 km/h`);

  /* (5) spawn and startup -------------------------------------------------- */
  console.log('\n(5) a calm, readable start');
  const spawn = await page.evaluate(() => {
    const g = window.__game;
    g.car.s = 0; g.car.n = 0; g.car.vLong = 0; g.car.vLat = 0; g.car.omega = 0;
    g.settleSuspension(); g.placeCar();
    const gnd = g.sampleWheels();
    return { y: g.car.y, gnd: gnd.avg, vLong: g.car.vLong, omega: g.car.omega,
             air: g.car.air, vy: g.car.vy };
  });
  check('car spawns settled, still and grounded',
        Math.abs(spawn.vLong) < 1e-6 && Math.abs(spawn.omega) < 1e-6 &&
        Math.abs(spawn.vy) < 1e-6 && !spawn.air,
        `v=${spawn.vLong.toFixed(3)} omega=${spawn.omega.toFixed(4)} vy=${spawn.vy.toFixed(3)} air=${spawn.air}`);

  const dawn = await page.evaluate(() => {
    const g = window.__game;
    g.setDay(0.0); g.simulate([{ sec: 0.1, keys: [] }], 60, 120);
    return { bloom: g.bloom.strength, exposure: g.renderer.toneMappingExposure };
  });
  check('dawn is not blown out', dawn.bloom <= 0.45 && dawn.exposure <= 1.0,
        `bloom ${dawn.bloom.toFixed(2)}, exposure ${dawn.exposure.toFixed(2)}`);

  /* (6) the one link simulate() skips: the DOM listener -------------------- */
  console.log('\n(6) real key events reach the game');
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(60);
  const downA = await page.evaluate(() => !!window.__game.KEYS_DOWN.KeyA);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(60);
  const upA = await page.evaluate(() => !!window.__game.KEYS_DOWN.KeyA);
  check('keydown/keyup wire through to KEYS_DOWN', downA && !upA,
        `down=${downA} up=${upA}`);

  const m = await page.evaluate(() => window.__mon.steps);
  console.log(`\n  ${m} physics steps asserted`);
}

let completed = false;
await run({ width: 1280, height: 720 }, async ({ page }) => {
  await suite(page);
  completed = true;
});

console.log('\n================ ASSERTIONS ================');
console.log(`  ${results.length - failed} passed, ${failed} failed`);
/* A suite that threw halfway is not a pass, however green the checks it did
   reach happen to look. The first version of this printed PASS after aborting
   on a TypeError three assertions in. */
if (!completed) {
  console.log(`\n  SUITE DID NOT COMPLETE — only ${results.length} of the assertions ran`);
  console.log('\nFAIL');
  process.exitCode = 1;
} else if (failed) {
  console.log('\n  FAILURES:');
  results.filter(x => !x.ok).forEach(x => console.log(`   x ${x.name}   ${x.detail || ''}`));
  console.log('\nFAIL');
  process.exitCode = 1;
} else {
  console.log('\nPASS');
  process.exitCode = 0;
}
