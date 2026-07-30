/* Headless physics + camera probe.
   Runs a scripted key sequence through the game's fixed-step simulator and
   prints the telemetry curves, so throttle/brake/drift/boost feel can be
   judged from numbers instead of vibes.
     lowprio.cmd drive.mjs [--shots]

   --shots also renders the beauty/camera/tier frames. That path rebuilds the
   whole world a dozen times, which is the one thing that has been able to
   exhaust SwiftShader, so it is opt-in and phase-flagged.                    */
import fs from 'node:fs';
import { run } from './harness.mjs';

/* Each render phase rebuilds the world several times. Running all of them in
   one session is what has crashed SwiftShader, so they can be taken one at a
   time: --beauty, --cams, --tiers. --shots means all three. */
const arg = f => process.argv.includes('--' + f);
const ALL = arg('shots');
const WANT = { beauty: ALL || arg('beauty'), cams: ALL || arg('cams'), tiers: ALL || arg('tiers') };
const WANT_SHOTS = WANT.beauty || WANT.cams || WANT.tiers;

await run({ width: 1600, height: 900 }, async ({ page, errs }) => {
await page.waitForTimeout(2500);

const A = true;   // autopilot holds the lane; scripted keys ride on top
const P = true;   // â€¦and works the pedals too, i.e. a competent driver
const PLAN = [
  { tag: 'launch',   sec: 8,  keys: ['KeyW'], autoSteer: A },
  { tag: 'flow',     sec: 14, keys: [], autoSteer: A, autoPedal: P },
  { tag: 'boost',    sec: 4,  keys: ['KeyW', 'ShiftLeft'], autoSteer: A },
  { tag: 'coast',    sec: 2,  keys: [], autoSteer: A },
  { tag: 'brake',    sec: 3,  keys: ['KeyS'], autoSteer: A },
  { tag: 'flow2',    sec: 10, keys: [], autoSteer: A, autoPedal: P },
  { tag: 'turnL',    sec: 3,  keys: ['KeyW', 'KeyA'], autoSteer: A },
  { tag: 'brake2',   sec: 2,  keys: ['KeyS'], autoSteer: A },
  { tag: 'drift',    sec: 3.5,keys: ['KeyW', 'KeyD', 'Space'] },
  { tag: 'catch',    sec: 3,  keys: ['KeyW'], autoSteer: A },
  { tag: 'settle',   sec: 4,  keys: [], autoSteer: A, autoPedal: P },
];

const tel = await page.evaluate(p => window.__game.simulate(p, 10), PLAN);

/* ---- report ---- */
const bySeg = new Map();
for (const s of tel) {
  if (!bySeg.has(s.tag)) bySeg.set(s.tag, []);
  bySeg.get(s.tag).push(s);
}
const f = (n, w = 6) => String(n).padStart(w);
console.log('\nseg        t0    t1   kmh_in kmh_out  |slip|max  yawMax  rollMax  airFr  fovRng      camD      camY   |off|max');
for (const [tag, rows] of bySeg) {
  const mx = k => Math.max(...rows.map(r => Math.abs(r[k])));
  const fovs = rows.map(r => r.fov), cds = rows.map(r => r.camD), cys = rows.map(r => r.camY);
  console.log(
    tag.padEnd(9),
    f(rows[0].t, 5), f(rows.at(-1).t, 5),
    f(rows[0].kmh, 7), f(rows.at(-1).kmh, 7),
    f(mx('slip').toFixed(1) + 'Â°', 10),
    f(mx('yawRate').toFixed(2), 7),
    f((mx('roll') * 57.3).toFixed(1) + 'Â°', 8),
    f((rows.filter(r => r.air).length / rows.length).toFixed(2), 6),
    f(Math.min(...fovs).toFixed(0) + '-' + Math.max(...fovs).toFixed(0), 7),
    f(Math.min(...cds).toFixed(1) + '-' + Math.max(...cds).toFixed(1), 9),
    f(Math.min(...cys).toFixed(1) + '-' + Math.max(...cys).toFixed(1), 9),
    f(mx('off').toFixed(1), 8));
}

const kmh = tel.map(r => r.kmh);
const t60 = tel.find(r => r.kmh >= 60), t100 = tel.find(r => r.kmh >= 100), t200 = tel.find(r => r.kmh >= 200);
console.log('\n0-60 %s s   0-100 %s s   0-200 %s s   vmax %s km/h',
  t60 ? t60.t : 'â€”', t100 ? t100.t : 'â€”', t200 ? t200.t : 'â€”', Math.max(...kmh).toFixed(0));
const drift = bySeg.get('drift') || [];
console.log('drift: peak rear slip %sÂ°  peak yaw rate %s rad/s  exit speed %s km/h',
  Math.max(...drift.map(r => Math.abs(r.slip))).toFixed(1),
  Math.max(...drift.map(r => Math.abs(r.yawRate))).toFixed(2),
  drift.length ? drift.at(-1).kmh : 'â€”');
const airFrames = tel.filter(r => r.air).length;
console.log('airtime: %s of %s samples (%s%%)', airFrames, tel.length, (airFrames / tel.length * 100).toFixed(1));

/* ---- 2-minute runs: continuous-steer autopilot, then WASD only ---- */
const RESET = () => {
  window.__game.car.s = 0; window.__game.car.n = 0; window.__game.car.yaw = 0;
  window.__game.car.vLong = 30; window.__game.car.vLat = 0; window.__game.car.omega = 0;
  // teleporting without re-settling leaves the chassis at the previous run's
  // altitude, and the springs answer by firing it over the treeline
  window.__game.settleSuspension();
  window.__game.placeCar(); window.__game.camSnap();
};
const runs2 = WANT_SHOTS ? null : {
  attract: await page.evaluate(r => { eval('(' + r + ')()');
    return window.__game.simulate([{ tag: 'attract', sec: 120, keys: [], autoSteer: true, autoPedal: true }], 5);
  }, RESET.toString()),
  keyboard: await page.evaluate(r => { eval('(' + r + ')()');
    return window.__game.simulate([{ tag: 'kb', sec: 120, kb: true }], 5);
  }, RESET.toString()),
};
for (const [label, att] of Object.entries(runs2 || {})) {
console.log(`\nâ”€â”€â”€ ${label === 'keyboard' ? 'WASD only (discrete keys, 11 Hz decisions)' : 'continuous-steer autopilot'} â”€â”€â”€`);
const offs = att.map(r => Math.abs(r.off));
const spds = att.map(r => r.kmh);
const bad = att.filter(r => Math.abs(r.off) > 6).length;
console.log('2-min run:     |off| avg %s m  max %s m   off-road %s%% of samples',
  (offs.reduce((a, b) => a + b, 0) / offs.length).toFixed(2), Math.max(...offs).toFixed(1),
  (bad / att.length * 100).toFixed(1));
console.log('               speed avg %s  min %s  max %s km/h   airtime %s%%',
  (spds.reduce((a, b) => a + b, 0) / spds.length).toFixed(0), Math.min(...spds).toFixed(0),
  Math.max(...spds).toFixed(0), (att.filter(r => r.air).length / att.length * 100).toFixed(1));
console.log('               |roll| max %sÂ°  |slip| max %sÂ°  camY %sâ€“%s m',
  (Math.max(...att.map(r => Math.abs(r.roll))) * 57.3).toFixed(1),
  Math.max(...att.map(r => Math.abs(r.slip))).toFixed(1),
  Math.min(...att.map(r => r.camY)).toFixed(1), Math.max(...att.map(r => r.camY)).toFixed(1));
{ // is the car being thrown by the road, or pogoing on its own springs?
  const airRows = att.filter(r => r.air);
  const onRoad = airRows.filter(r => Math.abs(r.off) < 6).length;
  console.log('               suspension: ext %s..%s m  vy %s..%s m/s   airborne %s (%s on tarmac)',
    Math.min(...att.map(r => r.ext)).toFixed(2), Math.max(...att.map(r => r.ext)).toFixed(2),
    Math.min(...att.map(r => r.vy)).toFixed(1), Math.max(...att.map(r => r.vy)).toFixed(1),
    airRows.length, onRoad);
  const w = att.indexOf(att.reduce((a, b) => Math.abs(b.ext) > Math.abs(a.ext) ? b : a));
  if (Math.abs(att[w].ext) > 0.5) {
    console.log('               worst travel around t=%s:', att[w].t);
    console.log('                  t      s     off      kmh      ext       vy       y   air');
    for (const r of att.slice(Math.max(0, w - 5), w + 4))
      console.log('              ', String(r.t).padStart(6), String(r.s).padStart(6),
        r.off.toFixed(1).padStart(7), String(Math.round(r.kmh)).padStart(7),
        r.ext.toFixed(2).padStart(8), r.vy.toFixed(1).padStart(8),
        r.y.toFixed(1).padStart(8), String(r.air).padStart(5));
  }
}

/* Group the excursions into runs so it is clear whether the lane-keeper is
   losing it in one particular kind of corner or drifting everywhere. */
const runs = [];
for (const r of att) {
  const bad = Math.abs(r.off) > 6;
  const last = runs.at(-1);
  if (bad && last && last.open) { last.rows.push(r); }
  else if (bad) runs.push({ open: true, rows: [r] });
  else if (last) last.open = false;
}
if (process.argv.includes('--trace') && label === 'attract') {
  console.log('\ntrace:   t    s     off    kmh   k(1/km)  steer   slipÂ°   omega   air');
  for (const r of att.slice(0, 46))
    console.log('     ', String(r.t).padStart(5), String(r.s).padStart(5),
      r.off.toFixed(1).padStart(7), String(Math.round(r.kmh)).padStart(6),
      r.k.toFixed(2).padStart(8), r.st.toFixed(3).padStart(7),
      r.slip.toFixed(1).padStart(7), r.yawRate.toFixed(2).padStart(7),
      String(r.air).padStart(4));
}
if (runs.length) {
console.log('%s excursions past the tarmac edge; worst three:', runs.length);
console.log('   s(m)   len   |off|max   kmh_in  curvature(1/km)  |slip|max  steer');
for (const run of runs.sort((a, b) => Math.max(...b.rows.map(r => Math.abs(r.off))) -
                                      Math.max(...a.rows.map(r => Math.abs(r.off)))).slice(0, 3)) {
  const mx = k => Math.max(...run.rows.map(r => Math.abs(r[k])));
  console.log(String(run.rows[0].s).padStart(7),
    String(run.rows.at(-1).s - run.rows[0].s + ' m').padStart(6),
    mx('off').toFixed(1).padStart(9), String(Math.round(run.rows[0].kmh)).padStart(8),
    mx('k').toFixed(1).padStart(16), mx('slip').toFixed(0).padStart(10),
    mx('st').toFixed(2).padStart(7));
}
}
}

/* ---- does the car handle the same at 30 fps as at 240? ------------------
   The shipped loop steps physics on a fixed accumulator, so it should â€” but
   only if the integrator itself is not dt-sensitive, because a machine slow
   enough to exhaust the step budget falls back to longer steps. Same scripted
   inputs, four different rates, compare where the car ends up. */
if (!WANT_SHOTS) {
  console.log('\nâ”€â”€â”€ frame-rate independence â”€â”€â”€');
  const PLAN = [{ sec: 4, keys: ['KeyW'] }, { sec: 3, keys: ['KeyW', 'KeyD'] },
                { sec: 2, keys: ['KeyS', 'KeyA'] }, { sec: 3, keys: ['KeyW'] }];
  const base = {};
  console.log('    hz     dist(m)     off(m)     kmh     yaw(deg)    drift vs 120hz');
  for (const hz of [120, 240, 60, 30]) {
    const r = await page.evaluate(([plan, h]) => {
      const g = window.__game;
      g.restart();
      const t = g.simulate(plan, 10, h);
      return { s: g.car.s, n: g.car.n, kmh: Math.abs(g.car.vLong) * 3.6, yaw: g.car.yaw,
               maxSlip: Math.max(...t.map(x => Math.abs(x.slip))) };
    }, [PLAN, hz]);
    if (hz === 120) Object.assign(base, r);
    const drift = Math.hypot(r.s - base.s, r.n - base.n);
    console.log('  %s %s %s %s %s %s', String(hz).padStart(4),
      r.s.toFixed(1).padStart(10), r.n.toFixed(2).padStart(10),
      r.kmh.toFixed(1).padStart(8), (r.yaw * 57.3).toFixed(1).padStart(10),
      (hz === 120 ? 'â€”' : drift.toFixed(2) + ' m').padStart(14));
  }
  const phys = await page.evaluate(() => {
    const g = window.__game;
    g.restart();
    let best = 1e9;
    for (let pass = 0; pass < 5; pass++) {
      const t = performance.now();
      for (let i = 0; i < 2000; i++) g.stepPhysics(1 / 120);
      best = Math.min(best, performance.now() - t);
    }
    return { us: best / 2000 * 1000, hz: g.PHYS_HZ };
  });
  console.log('  shipped loop steps at a fixed %s Hz, so only a machine under %s fps',
    phys.hz, Math.ceil(phys.hz / 10));
  console.log('  ever sees a longer step.  stepPhysics costs %s us -> %s ms/frame at 60 fps',
    phys.us.toFixed(1), (phys.us * phys.hz / 60 / 1000).toFixed(2));

  /* Frame cap. Under SwiftShader the renderer manages about a frame a second,
     so wall-clock timing here measures the software rasteriser, not the pacer.
     Run the pacer over a synthetic vsync grid instead: that is the arithmetic
     that decides whether a 240 Hz panel renders 60 frames or 240. */
  console.log('\nâ”€â”€â”€ frame pacing (synthetic vsync) â”€â”€â”€');
  console.log('  panel    cap 60 ->  fps   frame gap     cap 120 -> fps   uncapped');
  for (const refresh of [60, 75, 100, 120, 144, 165, 200, 240]) {
    const r = await page.evaluate(hz => {
      const g = window.__game;
      return [60, 120, 0].map(c => g.pacerTrial(c, hz, 6));
    }, refresh);
    const gap = r[0].gapMin.toFixed(1) + '-' + r[0].gapMax.toFixed(1) + ' ms';
    console.log('  %s Hz %s %s %s %s', String(refresh).padStart(4),
      r[0].fps.toFixed(1).padStart(12), gap.padStart(14),
      r[1].fps.toFixed(1).padStart(15), r[2].fps.toFixed(1).padStart(11));
  }
}

if (WANT_SHOTS) {
  fs.mkdirSync('shots', { recursive: true });
  page.setDefaultTimeout(120_000);
  /* Keep autoPedal on for the trailing segment too. Holding KeyW flat out for
     three seconds puts the car past 250 km/h, which no lane-keeper survives on
     a mountain road, and every shot came back from a ditch. Shift/Space/steer
     still ride on top, so the boost flame and the drift are real. */
  for (const [tag, keys, sec, day] of WANT.beauty ? [['p_boost', ['ShiftLeft'], 3.0, 0.05],
                                       ['p_drift', ['KeyD', 'Space'], 2.0, 0.18],
                                       ['p_brake', ['KeyS'], 0.9, 0.30],
                                       ['p_forest', [], 0.5, 0.11],
                                       ['p_night', [], 0.5, 0.55]] : []) {
    const off = await page.evaluate(([k, s, d]) => {
      const g = window.__game;
      g.setDay(d); g.restart();
      g.simulate([{ sec: 9, keys: [], autoSteer: true, autoPedal: true },
                  { sec: s, keys: k, autoSteer: true, autoPedal: true }], 60);
      // The fog and reflections read a baked sky cubemap. Jumping the clock
      // does not rebake it, so without this a night shot comes back fogged in
      // whatever light the previous shot was taken in.
      g.bakeEnv();
      g.clearFlash();
      return { n: +g.car.n.toFixed(1), kmh: Math.round(Math.abs(g.car.vLong) * 3.6) };
    }, [keys, sec, day]);
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `shots/${tag}.png`, timeout: 120_000 });
    console.log(`  shot ${tag.padEnd(8)} lateral ${String(off.n).padStart(6)} m   ${off.kmh} km/h`);
  }

  /* Every camera rig, and a stretch the canopy function says is closed forest,
     so the enclosed sections get judged rather than assumed. */
  const forestS = await page.evaluate(() => {
    let best = 0, bestV = -1;
    for (let s = 200; s < 9000; s += 25) {
      const v = window.__game.canopyAt(s);
      if (v > bestV) { bestV = v; best = s; }
    }
    return { s: best, canopy: +bestV.toFixed(2) };
  });
  console.log(`\ndensest canopy at s=${forestS.s} m (canopy ${forestS.canopy})`);

  const cams = WANT.cams ? await page.evaluate(() => window.__game.CAMS.map(c => c.name)) : [];
  for (let i = 0; i < cams.length; i++) {
    await page.evaluate(([idx, s]) => {
      const g = window.__game;
      g.setDay(0.08); g.restart(); g.setCam(idx);
      g.simulate([{ sec: 8, keys: [], autoSteer: true, autoPedal: true }], 60);
      g.car.s = s; g.settleSuspension(); g.placeCar(); g.camSnap();
      g.simulate([{ sec: 3, keys: [], autoSteer: true, autoPedal: true }], 60);
      g.bakeEnv(); g.clearFlash();
    }, [i, forestS.s]);
    await page.waitForTimeout(6500);
    await page.screenshot({ path: `shots/cam_${cams[i].toLowerCase()}.png`, timeout: 120_000 });
    console.log('  cam', cams[i]);
  }
  await page.evaluate(() => window.__game.setCam(0));

  /* The same frame at each quality tier. The tiers exist so a weak machine can
     still be shown something worth looking at, which is only true if the drop
     is graceful â€” so it has to be looked at, not just measured. */
  const tiers = WANT.tiers ? await page.evaluate(() => window.__game.QTIERS.map(q => q.name)) : [];
  // Half-size for this pass only. SwiftShader is a CPU rasteriser, and the top
  // tier at 1600x900 takes longer to draw one frame than the screenshot will
  // wait for. The question here is whether the drop between tiers is graceful,
  // which reads fine at 960x540.
  if (tiers.length) await page.setViewportSize({ width: 960, height: 540 });
  for (let t = 0; t < tiers.length; t++) {
    const info = await page.evaluate(([idx, s]) => {
      const g = window.__game;
      g.setPerf(idx * 2);            // PERF pairs, 2 per tier: scale + world together
      g.setDay(0.08); g.restart();
      g.simulate([{ sec: 8, keys: [], autoSteer: true, autoPedal: true }], 60);
      g.car.s = s; g.settleSuspension(); g.placeCar(); g.camSnap();
      g.simulate([{ sec: 3, keys: [], autoSteer: true, autoPedal: true }], 60);
      g.bakeEnv(); g.clearFlash();
      // Draw the frame here rather than letting page.screenshot wait for one.
      // The top tier takes ~30 s per frame in software, and racing the render
      // loop for it is how this pass used to time out.
      g.setPaused(true); g.renderOnce();
      // preserveDrawingBuffer is off, so the buffer is discarded on the next
      // composite: it has to be read back in this same task, not a later one.
      const png = g.renderer.domElement.toDataURL('image/png');
      g.setPaused(false);
      return { tier: g.tier, png, ...g.counts() };
    }, [t, forestS.s]);
    fs.writeFileSync(`shots/tier_${tiers[t]}.png`,
      Buffer.from(info.png.split(',')[1], 'base64'));
    console.log('  tier', tiers[t].padEnd(7), '->', info.tier,
      ' tris', (info.tris / 1000 | 0) + 'k', ' calls', info.calls);
  }
  await page.evaluate(() => window.__game.setPerf(0));
}
});
