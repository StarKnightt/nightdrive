/* Exactly which side of the screen is +n, and which side does the right key
   send the car? Decided by projecting the road-frame offset onto the camera's
   own right vector, in every camera mode, rather than by squinting at a frame.
   A positive dot product means +n appears on the right of the screen.        */
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

const nCams = await page.evaluate(() => window.__game.CAMS.length);
console.log('is +n on the right of the screen?');
let bad = 0;
for (let m = 0; m < nCams; m++) {
  const r = await page.evaluate(async i => {
    const g = window.__game, T = g.THREE;
    g.setCam(i);
    g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0; g.car.vLong = 20;
    g.settleSuspension(); g.placeCar(); g.camSnap();
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => requestAnimationFrame(r));
    g.camera.updateMatrixWorld();
    const right = new T.Vector3().setFromMatrixColumn(g.camera.matrixWorld, 0).normalize();
    const f = g.frameAt(g.car.s);
    // world displacement produced by one metre of +n
    const d = new T.Vector3(Math.cos(f.h), 0, -Math.sin(f.h));
    return { name: g.CAMS[i].name, dot: +d.dot(right).toFixed(3) };
  }, m);
  const side = r.dot > 0 ? 'RIGHT' : 'LEFT';
  // the whole sign chain assumes +n is screen-left
  const ok = r.dot < 0;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${r.name.padEnd(12)} +n appears on the ${side} of screen (dot ${r.dot})`);
}
console.log(bad
  ? `\n${bad} camera(s) disagree with the assumption that +n is screen-left.`
  : '\n+n is screen-left in every camera, so a right turn must reduce n. Key mapping is correct.');

await bye(0);
