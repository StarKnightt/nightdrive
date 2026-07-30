/* Cockpit review: sit in the seat and photograph it at a few speeds and steering
   angles, so the needles and the wheel can be checked against known inputs
   rather than against whatever the car happened to be doing. */
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
  args: ['--use-angle=d3d11', '--window-position=-2400,-1400', '--window-size=1400,820',
         '--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', e => errs.push(String(e.message || e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://localhost:${srv.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
await page.evaluate(() => window.__game.begin());
await page.waitForTimeout(2500);

const pit = await page.evaluate(() => {
  const g = window.__game;
  const i = g.CAMS.findIndex(c => c.id === 'pit');
  g.setCam(i); g.setAuto(true);
  return { idx: i, name: g.CAMS[i] && g.CAMS[i].name, visible: g.cockpit.visible };
});
console.log(`  cockpit cam index ${pit.idx} (${pit.name}), interior visible: ${pit.visible}`);
await page.waitForTimeout(3500);

const tag = process.argv[2] || 'p2-03-cockpit';
const shots = [
  { name: 'cruise', day: 0.06, sec: 3 },
  { name: 'fast', day: 0.10, sec: 8 },
  { name: 'night', day: 0.55, sec: 3 },
];
for (const s of shots) {
  await page.evaluate(v => window.__game.setDay(v), s.day);
  await page.waitForTimeout(s.sec * 1000);
  const st = await page.evaluate(() => {
    const g = window.__game;
    return { kmh: Math.abs(g.car.vLong) * 3.6, rpm: g.car.rpm, steer: g.car.steerVis,
             needleT: g.DIAL.tach && g.DIAL.tach.rotation.z,
             needleS: g.DIAL.speedo && g.DIAL.speedo.rotation.z,
             rim: g.wheelSpin.rotation.z, fps: g.fps };
  });
  await page.screenshot({ path: `shots/${tag}-${s.name}.png` });
  console.log(`  ${s.name.padEnd(7)} ${st.kmh.toFixed(0).padStart(4)} km/h  ${st.rpm.toFixed(0).padStart(4)} rpm  ` +
              `steer ${st.steer.toFixed(2).padStart(5)}  needles ${st.needleT.toFixed(2)}/${st.needleS.toFixed(2)}  ` +
              `rim ${st.rim.toFixed(2)}  ${st.fps} fps   -> shots/${tag}-${s.name}.png`);
}

if (errs.length) { console.log('\n  page errors:'); errs.slice(0, 6).forEach(e => console.log('   ', e.slice(0, 160))); }
else console.log('\n  no page errors');
await bye(0);
