/* Performance probe. Answers two questions the visual shots cannot:
   how much geometry is actually submitted per frame, and how long the worst
   world-streaming spike is. The second one is what a player feels as the drive
   "hitching in the middle of a corner".
     lowprio.cmd perf.mjs                                                     */
import { run } from './harness.mjs';

await run({ width: 1280, height: 720, extraArgs: [] }, async ({ page }) => {
await page.waitForTimeout(3000);

/* ---- geometry submitted, per quality tier ---- */
const tiers = await page.evaluate(() => window.__game.QTIERS.map(t => t.name));
const SAMPLES = [0, 800, 1700, 3500, 4400];
const peaks = {};
for (let ti = 0; ti < tiers.length; ti++) {
  console.log(`\nâ”€â”€ ${tiers[ti]} â”€â”€`);
  console.log('s(m)     tris   calls  pineNear  pineFar  oakNear  oakFar  grass  rock');
  const rows = [];
  for (const s of SAMPLES) {
    const c = await page.evaluate(([sv, idx]) => {
      const g = window.__game;
      g.setPerf(g.QTIERS.length === 4 ? [0, 2, 4, 6][idx] : 0);   // first PERF slot per tier
      g.car.s = sv; g.placeCar(); g.camSnap();
      g.simulate([{ sec: 2, keys: [], autoSteer: true, autoPedal: true }], 60);
      return g.counts();
    }, [s, ti]);
    rows.push(c);
    const f = (n, w) => String(n).padStart(w);
    console.log(f(s, 4), f((c.tris / 1000).toFixed(0) + 'k', 8), f(c.calls, 6),
      f(c.pineL, 9), f(c.pineF, 8), f(c.oakL, 8), f(c.oakF, 7), f(c.grass, 6), f(c.rock, 5));
  }
  const worst = rows.reduce((a, b) => a.tris > b.tris ? a : b);
  peaks[tiers[ti]] = worst;
  console.log(`peak ${(worst.tris / 1000).toFixed(0)}k tris, ${worst.calls} calls`+
    `  (car ${worst.carParts} meshes, ${worst.tiles} terrain tiles, ${worst.roadChunks} road chunks)`);
  if (ti === 0) {
    console.log('where they go:');
    for (const [k, v] of Object.entries(worst.by).sort((a, b) => b[1] - a[1]).slice(0, 10))
      console.log(`  ${k.padEnd(10)} ${String((v / 1000).toFixed(1) + 'k').padStart(8)}  ${(v / worst.tris * 100).toFixed(0)}%`);
  }
}
console.log('\ntier peaks: ' + tiers.map(t => `${t} ${(peaks[t].tris / 1000).toFixed(0)}k/${peaks[t].calls}`).join('   '));
await page.evaluate(() => window.__game.setPerf(0));

/* ---- streaming cost, measured directly ----
   rAF under SwiftShader runs at a fraction of a frame per second, so the drive
   is stepped by hand: advance along the road at motorway speed and time the
   streaming block each step. This is pure CPU work and translates to real
   hardware far better than a SwiftShader frame time would. */
/* The harness runs pinned to four cores at low priority so it cannot disturb
   whatever the user is doing, which means any single timing can be inflated by
   seconds of descheduling. The work itself is deterministic â€” same road, same
   tiles â€” so repeating the pass and taking the per-frame minimum reports the
   true cost: interference can only ever add. */
const PASSES = 5, STEPS = 1400;
const spikes = await page.evaluate(([passes, steps]) => {
  const g = window.__game;
  const best = [];
  for (let p = 0; p < passes; p++) {
    g.restart();
    for (let i = 0; i < steps; i++) {
      g.car.s += 1.1; g.placeCar();
      const r = g.streamTick();
      if (!best[i] || r.total < best[i].total) { r.s = Math.round(g.car.s); best[i] = r; }
    }
  }
  return best;
}, [PASSES, STEPS]);

const tot = spikes.map(r => r.total).sort((a, b) => a - b);
const pct = q => tot[Math.floor(tot.length * q)].toFixed(2);
console.log(`\nstreaming over 1.5 km (best of ${PASSES}):  median ${pct(0.5)} ms   p95 ${pct(0.95)} ms   p99 ${pct(0.99)} ms   worst ${tot.at(-1).toFixed(1)} ms`);
console.log(`frames over 16 ms: ${spikes.filter(r => r.total > 16).length} of ${spikes.length}   flushes: ${spikes.filter(r => r.flushed).length}`);
console.log('\nworst offenders:');
console.log('   s(m)   total   world   build   flush  flushed  queue');
for (const r of [...spikes].sort((a, b) => b.total - a.total).slice(0, 12))
  console.log(String(r.s).padStart(7), r.total.toFixed(1).padStart(7), r.world.toFixed(1).padStart(7),
    r.build.toFixed(1).padStart(7), r.flush.toFixed(1).padStart(7),
    String(r.flushed).padStart(8), String(r.q + '/' + r.sq).padStart(7));

});
