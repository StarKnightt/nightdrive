// Headless capture harness. Runs entirely off-screen (SwiftShader), never
// opens a window, and never leaves a tab rendering: see harness.mjs for the
// CPU constraints every probe shares.
// usage: lowprio.cmd shoot.mjs [tag] [--day 0.22,0.5,...] [--warm 9] [--drive 6]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './harness.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tag  = (args[0] && !args[0].startsWith('--')) ? args[0] : 'run';
const getf = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const days  = getf('day', '0.03,0.22,0.30,0.50,0.82').split(',').map(Number);
const warm  = Number(getf('warm', 10));
const drive = Number(getf('drive', 5));
const W = Number(getf('w', 1600)), H = Number(getf('h', 900));

const shotsDir = path.join(DIR, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

await run({ width: W, height: H }, async ({ page, errs }) => {
  // let textures stream + tiles build
  await page.waitForTimeout(warm * 1000);

  const results = [];
  for (const d of days) {
    await page.evaluate(([d, drive]) => {
      const g = window.__game;
      g.setDay(d);
      g.setAuto(true);
      // software GL runs far below real-time, so advance the sim deterministically
      g.warp(drive, 1);
      g.bakeEnv();
    }, [d, drive]);
    await page.waitForTimeout(2200);   // let springs/cameras/streaming settle

    const st = await page.evaluate(() => {
      const g = window.__game, i = g.info(), c = g.car;
      return {
        fps: +g.fps.toFixed(1),
        kmh: +(Math.abs(c.vLong) * 3.6).toFixed(0),
        dist: +c.dist.toFixed(0),
        phase: g.SKYST.name, elev: +g.SKYST.elev.toFixed(1),
        tier: g.tier,
        calls: i.calls, tris: i.triangles, tex: i.textures, geo: i.geometries, prog: i.programs,
        hdr: g.probe(),
        phys: { air: c.air, y: +c.y.toFixed(2), vy: +c.vy.toFixed(2), n: +c.n.toFixed(2),
                th: +g.input.th.toFixed(2), off: +c.offroad.toFixed(2), slip: +c.slip.toFixed(2),
                pitch: +c.pitch.toFixed(3), roll: +c.roll.toFixed(3) },
        post: { bloomThr: g.bloom.threshold, bloomStr: +g.bloom.strength.toFixed(2),
                rays: +g.godRays.comp.uniforms.uStrength.value.toFixed(2) },
      };
    });
    const file = path.join(shotsDir, `${tag}_${String(d).replace('.', 'p')}.png`);
    await page.screenshot({ path: file, timeout: 120_000 });
    results.push({ day: d, file: path.basename(file), ...st });
    const h = st.hdr;
    console.log(`  ${String(d).padEnd(5)} ${st.phase.padEnd(12)} ${String(st.kmh).padStart(3)}km/h ` +
                `${st.tier.padEnd(6)} calls=${String(st.calls).padStart(4)} tris=${(st.tris / 1000).toFixed(0)}k`);
    console.log(`        HDR med=${h.median} p90=${h.p90} p99=${h.p99} max=${h.max} sky=${h.skyAvg} gnd=${h.groundAvg}` +
                `  | bloomThr=${st.post.bloomThr} rays=${st.post.rays}`);
    console.log(`        phys ${JSON.stringify(st.phys)}`);
  }

  fs.writeFileSync(path.join(shotsDir, `${tag}.json`),
    JSON.stringify({ results, logs: [...new Set(errs)] }, null, 2));
});
