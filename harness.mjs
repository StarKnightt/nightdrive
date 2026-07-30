/* Shared plumbing for every headless probe: a static file server, a Chromium
   launched under tight CPU constraints, and a teardown that actually runs.

   The constraints are not optional politeness. SwiftShader is a software
   rasteriser — there is no GPU involved — so a headless run of this game will
   take every thread it can reach and hold them at 100%. The machine these
   tests run on is usually also being played on, and an unconstrained run makes
   that unplayable. Three separate mechanisms, because each covers a different
   gap:

     · lowprio.cmd sets affinity and priority on the node process before it
       starts, which Chromium children inherit.
     · the launch flags below stop Chromium spawning the sprawl in the first
       place, which is better than throttling it afterwards.
     · pinChildren() catches the workers Chromium spawns late, which inherit
       nothing useful if node was started directly rather than via lowprio.cmd.

   Import `run()` and put the body of the probe inside it. Anything that throws
   still closes the browser, which is the difference between a failed test and
   a headless tab quietly rendering at full tilt until the machine is rebooted. */
import { chromium } from 'playwright';
/* Process-level net under all of the above: signal and uncaught-exception
   handlers, and an unref on every server this process opens. run()'s own
   try/finally covers a throw inside the probe body; this covers the rest,
   including Ctrl-C and anything that fails before run() is reached. */
import './tame.mjs';
import { exec } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/* Four of the twelve logical cores, at the bottom of the scheduler. Matches
   lowprio.cmd's /AFFINITY F00 so the two agree. */
const AFFINITY = 0xF00, CORES = 4;

/* Chromium keeps renaming the headless binary between versions, and Playwright
   may use either depending on channel; pin whichever shows up. */
const PIN = 'powershell -NoProfile -Command "' +
  "Get-Process chrome-headless-shell,chrome,headless_shell -ErrorAction SilentlyContinue | " +
  `ForEach-Object { try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }"`;

function pinChildren() {
  const go = () => exec(PIN, () => {});
  go();
  const t = setInterval(go, 2500);
  t.unref();
  return () => clearInterval(t);
}

export const LAUNCH_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--disable-lcd-text',
  '--autoplay-policy=no-user-gesture-required',
  // One renderer process rather than one per frame/site. Chromium sizes its
  // process and thread pools from the machine's core count, then fights
  // itself over the four cores affinity actually allows it.
  '--renderer-process-limit=1', '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  // SwiftShader has no thread-count flag — it sizes its pool from
  // hardware_concurrency — so affinity is the only real cap on it, and that is
  // applied to the processes rather than passed in here.
  '--js-flags=--single-threaded-gc',
];

/** Serve the project directory on an ephemeral port. */
export function serve(root = path.resolve('.')) {
  const srv = http.createServer((rq, rs) => {
    const f = path.join(root, rq.url === '/' ? 'index.html' : decodeURI(rq.url.split('?')[0]));
    fs.readFile(f, (e, d) => e
      ? (rs.writeHead(404), rs.end())
      : (rs.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }),
         rs.end(d)));
  });
  return srv;
}

/**
 * Render exactly one frame and save it.
 *
 * page.screenshot() waits for the compositor to produce a fresh frame, which
 * it shares with the game's own render loop. A frame of this scene costs tens
 * of seconds on a software rasteriser, so the two racing for the GL context
 * routinely blows the screenshot timeout. Pausing the loop and reading the
 * canvas back makes capture deterministic and roughly twice as fast.
 *
 * The readback has to happen in the same task as the draw: the renderer has no
 * preserveDrawingBuffer, so the buffer is gone by the next task.
 */
export async function capture(page, file) {
  const png = await page.evaluate(() => {
    const g = window.__game;
    g.setPaused(true);
    g.renderOnce();
    const url = g.renderer.domElement.toDataURL('image/png');
    g.setPaused(false);
    return url;
  });
  fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
}

/**
 * Boot server + browser + page, hand them to `body`, and guarantee teardown.
 * @param {{width?:number,height?:number,waitReady?:boolean,extraArgs?:string[]}} opts
 * @param {(ctx:{page:any,url:string,errs:string[],browser:any}) => Promise<void>} body
 */
export async function run(opts, body) {
  const { width = 1280, height = 720, waitReady = true, extraArgs = [] } = opts || {};
  const srv = serve();
  await new Promise(r => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}/`;

  const unpin = pinChildren();
  const browser = await chromium.launch({
    headless: true,
    args: [...LAUNCH_ARGS, ...extraArgs],
  });
  const errs = [];
  let code = 0;
  try {
    const page = await browser.newPage({
      viewport: { width, height }, deviceScaleFactor: 1,
    });
    page.on('pageerror', e => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    page.on('requestfailed', r => errs.push('[netfail] ' + r.url().slice(0, 110)));
    // A dead renderer is the failure this whole file exists to make visible;
    // without it the probe just hangs until Playwright's timeout.
    page.on('crash', () => errs.push('[crash] renderer process died'));

    console.log(`→ ${url}   ${width}x${height}   ${CORES} cores, idle priority`);
    // 'load' would also wait on the streamed Poly Haven textures, which are
    // optional progressive upgrades; gate on the game object instead.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    if (waitReady) {
      await page.waitForFunction(() => !!window.__game, null, { timeout: 120_000 });
      await page.evaluate(() => window.__game.begin());
    }
    await body({ page, url, errs, browser });
  } catch (err) {
    console.error('\n✗ probe failed:', err && err.message || err);
    code = 1;
  } finally {
    // Order matters: kill the renderer before releasing the port, and never
    // let a teardown error leave the browser running.
    await browser.close().catch(() => {});
    srv.close();
    unpin();
  }
  if (errs.length) {
    console.log('\n─── page errors ───');
    errs.slice(0, 12).forEach(e => console.log(' ', e));
  }
  process.exitCode = code;
}
