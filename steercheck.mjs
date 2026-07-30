/* Two questions the aggregate numbers cannot answer.

   1. Which way does the car actually go on screen when I press right? The sign
      chain was reasoned about, not seen, and if the reasoning was inverted then
      "fixing" it made things worse. A picture settles it.
   2. Can the game's own pilot hold the lane? It feeds the identical input path,
      so if it also runs wide the fault is in the physics I changed, and if it
      holds then my test driver is the thing that cannot drive.              */
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

/* ---- 1. which way is right? ---- */
// wide camera, so the road ahead and the car's placement on it are both visible
await page.evaluate(() => { window.__game.setCam(1); });
await page.evaluate(() => {
  const g = window.__game;
  g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0; g.car.vLong = 22;
  g.settleSuspension(); g.placeCar(); g.camSnap();
});
await page.waitForTimeout(600);
await page.screenshot({ path: 'shots/steer_0_before.png' });

await page.keyboard.down('KeyW');
await page.keyboard.down('KeyD');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/steer_1_holding_right.png' });
const afterRight = await page.evaluate(() => ({ n: window.__game.car.n, yaw: window.__game.car.yaw }));
await page.keyboard.up('KeyD');
await page.keyboard.up('KeyW');
console.log(`holding RIGHT for 1.5s:  n ${afterRight.n.toFixed(2)}  yaw ${(afterRight.yaw * 57.3).toFixed(1)}deg`);
console.log('  (n<0 means it moved toward -n; the screenshot says which side of the screen that is)');

/* ---- 2. can the game's own pilot hold the lane? ---- */
await page.evaluate(() => {
  const g = window.__game;
  g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0;
  g.setAuto(true);
  const M = window.__m = { n: 0, worst: 0, k: 0, maxKmh: 0 };
  setInterval(() => {
    const c = g.car;
    M.k++; M.n += Math.abs(c.n); M.worst = Math.max(M.worst, Math.abs(c.n));
    M.maxKmh = Math.max(M.maxKmh, Math.abs(c.vLong) * 3.6);
  }, 50);
});
console.log('\nautopilot driving 45s ...');
await page.waitForTimeout(45_000);
const M = await page.evaluate(() => window.__m);
await page.screenshot({ path: 'shots/steer_2_autopilot.png' });
console.log(`autopilot: mean |n| ${(M.n / M.k).toFixed(2)} m   worst ${M.worst.toFixed(1)} m   top ${M.maxKmh.toFixed(0)} km/h`);
console.log(M.n / M.k < 6
  ? '  -> the pilot holds the road, so the physics is fine and my test driver is the problem'
  : '  -> the pilot ALSO runs wide, so something in the vehicle changed');

await bye(0);
