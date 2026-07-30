// Beauty-shot rig for reviewing the car model from several angles, headless.
// usage: lowprio.cmd car.mjs [tag] [--day 0.06] [--w 1000] [--h 620]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tag = (args[0] && !args[0].startsWith('--')) ? args[0] : 'car';
const getf = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const day = Number(getf('day', 0.06));
const W = Number(getf('w', 1000)), H = Number(getf('h', 620));

const VIEWS = [
  { name: '3q-rear',  az: 0.55, dist: 8.2,  height: 1.9,  fov: 34 },
  { name: 'side',     az: 1.57, dist: 9.5,  height: 1.2,  fov: 34 },
  { name: '3q-front', az: 2.55, dist: 8.4,  height: 1.7,  fov: 34 },
  { name: 'front',    az: 3.14, dist: 9.0,  height: 1.1,  fov: 34 },
  { name: 'low-rear', az: 0.30, dist: 6.4,  height: 0.62, fov: 40, aim: 0.55 },
  // wheels are the part most likely to be wrong after a geometry change and
  // the part the driving cameras never show
  { name: 'wheel',    az: 1.10, dist: 4.4,  height: 0.55, fov: 30, aim: 0.35 },
];

fs.mkdirSync(path.join(DIR, 'shots'), { recursive: true });

await run({ width: W, height: H }, async ({ page }) => {
  await page.waitForTimeout(6000);
  await page.evaluate(d => {
    const g = window.__game;
    g.setDay(d); g.setAuto(true); g.warp(14, 1);
    // hold it still so the beauty rig frames a settled car
    g.car.vLong = 0; g.car.vLat = 0; g.car.omega = 0;
    g.warp(1.0, 0);
    g.car.vLong = 0; g.car.vLat = 0; g.car.omega = 0;
    g.bakeEnv();
  }, day);

  for (const v of VIEWS) {
    await page.evaluate(v => window.__game.lockCam(v), v);
    await page.waitForTimeout(1200);
    await capture(page, path.join(DIR, 'shots', `${tag}_${v.name}.png`));
    console.log('  shot', v.name);
  }
  await page.evaluate(() => window.__game.lockCam(null));
});
