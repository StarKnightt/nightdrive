/* How long does one frame take, per quality tier, at a given size?
   SwiftShader is a CPU rasteriser so these numbers are nothing like real GPU
   times — the useful signal is the ratio between tiers, which says whether the
   quality ladder actually buys a weak machine anything.
     lowprio.cmd tiercost.mjs [w] [h]                                        */
import { run } from './harness.mjs';

const W = +(process.argv[2] || 960), H = +(process.argv[3] || 540);

await run({ width: W, height: H }, async ({ page }) => {
  await page.waitForTimeout(3000);
  const tiers = await page.evaluate(() => window.__game.QTIERS.map(q => q.name));

  console.log(`\none frame at ${W}x${H} (software raster — read the ratios, not the ms)`);
  console.log('tier      frame(ms)   post(ms)    tris   calls');
  for (let t = 0; t < tiers.length; t++) {
    const r = await page.evaluate(idx => {
      const g = window.__game;
      g.setPerf(idx * 2);
      g.setDay(0.08);
      g.warp(2, 1);
      const t0 = performance.now(); g.renderOnce();      // full pipe, post included
      const t1 = performance.now(); g.renderOnce(true);  // scene only, no post
      const t2 = performance.now();
      const c = g.counts();
      return { full: t1 - t0, scene: t2 - t1, tris: c.tris, calls: c.calls, tier: g.tier };
    }, t);
    console.log(tiers[t].padEnd(9),
      r.full.toFixed(0).padStart(8), (r.full - r.scene).toFixed(0).padStart(10),
      ((r.tris / 1000 | 0) + 'k').padStart(8), String(r.calls).padStart(7));
  }
  await page.evaluate(() => window.__game.setPerf(0));
});
