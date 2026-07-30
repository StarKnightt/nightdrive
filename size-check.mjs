/* Assert that every buffer in the post chain agrees on one integer size, at the
   fractional display scalings that trigger the D3D11 resolve bug, and that it
   still agrees after a resize and after the adaptive scaler moves. */
import { chromium } from 'playwright';
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
const BASE = `http://localhost:${srv.address().port}/`;

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
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--renderer-process-limit=1', '--disable-dev-shm-usage'],
});

const SIZES = () => {
  const g = window.__game, r = g.renderer, gl = r.getContext(), c = r.domElement;
  const rt = g.composer.renderTarget1;
  return {
    canvas: [c.width, c.height],
    drawBuf: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    composerRT: [rt.width, rt.height],
    glViewport: Array.from(gl.getParameter(gl.VIEWPORT)),
    cssPx: [c.clientWidth, c.clientHeight],
    integral: Number.isInteger(rt.width) && Number.isInteger(rt.height),
  };
};

let bad = 0;
const check = (label, s) => {
  const [cw, ch] = s.canvas, [dw, dh] = s.drawBuf, [rw, rh] = s.composerRT;
  const [, , vw, vh] = s.glViewport;
  const ok = cw === dw && ch === dh && rw === dw && rh === dh && vw === dw && vh === dh && s.integral;
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(22)} canvas ${cw}x${ch}  drawBuf ${dw}x${dh}  ` +
              `composerRT ${rw}x${rh}  viewport ${vw}x${vh}  css ${s.cssPx.join('x')}`);
};

for (const dsf of [1, 1.25, 1.5]) {
  console.log(`\ndeviceScaleFactor ${dsf}`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: dsf });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });
  await page.evaluate(() => window.__game.begin());
  await page.waitForTimeout(4000);
  check('at load', await page.evaluate(SIZES));

  await page.setViewportSize({ width: 1101, height: 661 });   // deliberately odd
  await page.waitForTimeout(2000);
  check('after odd resize', await page.evaluate(SIZES));

  // walk the adaptive scaler by hand through every step
  for (const i of [1, 3, 4]) {
    await page.evaluate(n => window.__game.setPerf?.(n), i);
    await page.waitForTimeout(700);
    check(`perf step ${i}`, await page.evaluate(SIZES));
  }
  await page.close();
}

console.log(bad ? `\n${bad} MISMATCHES` : '\nall sizes agree');
await bye(bad ? 1 : 0);
