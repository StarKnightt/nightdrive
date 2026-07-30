/* Screenshots of the two moments that were broken: mid-air, and hard at speed.
   Headed and on the real GPU, because the whole point is what it looks like. */
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
const bye = async (c, why) => { if (why) console.error(why); try { await browser?.close(); } catch {} srv.close(); process.exit(c); };
process.on('SIGINT', () => bye(130)); process.on('SIGTERM', () => bye(143));
process.on('uncaughtException', e => bye(1, e));

browser = await chromium.launch({
  headless: false,
  args: ['--use-angle=d3d11', '--window-position=-2400,-1400', '--window-size=1640,980',
         '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
await page.keyboard.press('Space');
await page.waitForTimeout(2500);
// midday, so the framing is readable rather than a silhouette against dawn
await page.evaluate(() => window.__game.setDay(0.30));
await page.waitForTimeout(1500);

await page.evaluate(() => window.__game.setAuto(true));
await page.waitForTimeout(6000);
await page.screenshot({ path: 'shot-speed.png' });
console.log('shot-speed.png');

// launch, then catch it at the top of the arc
await page.evaluate(() => { const c = window.__game.car; c.y += 4.2; c.vy = 5.5; c.air = true; });
await page.waitForTimeout(340);
await page.screenshot({ path: 'shot-air.png' });
console.log('shot-air.png   airborne =', await page.evaluate(() => window.__game.car.air));

await bye(0);
