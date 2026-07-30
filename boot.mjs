/* Boot exactly like a real user: open, start, wait, screenshot. No warp, no
   autopilot — this is the first-run path, and the one where sizing bugs and
   the opening quality tier show up.
   usage: lowprio.cmd boot.mjs [w] [h]                                        */
import fs from 'node:fs';
import { run } from './harness.mjs';

const W = +(process.argv[2] || 1024), H = +(process.argv[3] || 493);

await run({ width: W, height: H }, async ({ page }) => {
  for (const wait of [4000, 8000]) {
    await page.waitForTimeout(wait);
    const st = await page.evaluate(() => {
      const g = window.__game, r = g.renderer, c = r.domElement;
      const dz = r.getDrawingBufferSize(new g.THREE.Vector2());
      const vp = r.getViewport(new g.THREE.Vector4());
      return {
        inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
        canvasAttr: [c.width, c.height], canvasCss: [c.clientWidth, c.clientHeight],
        drawBuf: [dz.x, dz.y], viewport: [vp.x, vp.y, vp.z, vp.w],
        pixelRatio: r.getPixelRatio(),
        // the point of this probe: what did the machine open at, and did the
        // adaptive system move it?
        tier: g.tier, fpsCap: g.fpsCap, fps: +g.fps.toFixed(1),
        shadowMap: r.shadowMap.type,
        info: g.info(),
        carKmh: +(Math.abs(g.car.vLong) * 3.6).toFixed(1),
        ctxLost: r.getContext().isContextLost(),
      };
    });
    console.log(`\nafter ${wait}ms`, JSON.stringify(st, null, 1));
  }

  fs.mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: `shots/boot_${W}x${H}.png`, timeout: 120_000 });
  console.log('\nshot → shots/boot_%dx%d.png', W, H);
});
