/* Headed, real-GPU play test — the one the software-rendered probes can't do.

   Every earlier probe ran under SwiftShader at scale 1 and passed on the exact
   build that black-screened on the user's 4060, so none of them were testing
   the thing that broke. This launches a real Chromium on the real GPU through
   ANGLE/D3D11, with no hash flags, and drives with genuine key events.

   The window is placed off-screen: it has to be a real headed window to get a
   real compositor and a real GPU, but it must not steal the desktop.

   node playtest.mjs [seconds]                                                */
import { chromium } from 'playwright';
import './tame.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const SECONDS = +(process.argv[2] || 130);
const ROOT = path.resolve('.');
const srv = http.createServer((rq, rs) => {
  const f = path.join(ROOT, rq.url === '/' ? 'index.html' : decodeURI(rq.url.split('?')[0]));
  fs.readFile(f, (e, d) => e ? (rs.writeHead(404), rs.end())
    : (rs.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }), rs.end(d)));
});
await new Promise(r => srv.listen(0, r));
const URL = `http://localhost:${srv.address().port}/`;

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
  args: ['--use-angle=d3d11',            // the path Brave takes, and the one that broke
         '--window-position=-2400,-1400', // real window, off the visible desktop
         '--window-size=1360,800',
         '--disable-features=CalculateNativeWinOcclusion', // else an unseen window stops painting
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 180)));
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' && !/favicon/.test(t) && !/Failed to load resource/.test(t)) errs.push('CONSOLE ' + t.slice(0, 180));
  if (t.includes('non-finite')) errs.push('NONFINITE ' + t.slice(0, 180));
});
page.on('response', r => {
  // the browser asks for a favicon this static server does not serve; that is
  // the test rig's gap, not the game's
  if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`);
});

console.log('loading', URL, '(no hash flags — testing the shipping defaults)');
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await page.waitForFunction(() => !!window.__game, null, { timeout: 90_000 });

/* Is this actually the GPU? If ANGLE fell back to software the whole test is
   worthless, because software is what already passed. */
const gpu = await page.evaluate(() => {
  const gl = window.__game.renderer.getContext();
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
           samples: window.__game.composer.renderTarget1.samples };
});
console.log('GPU:', gpu.renderer);
console.log('composer samples:', gpu.samples, gpu.samples === 0 ? '(MSAA off by default — correct)' : '(MSAA ON — item 1 FAILED)');
const software = /swiftshader|llvmpipe|software/i.test(gpu.renderer);
if (software) console.log('\n!! ANGLE fell back to software; this run proves nothing about the real path.\n');

/* In-page watchdog. Sampling from node over CDP is far too coarse to catch a
   single bad frame, so the checks live in the page and run off the game's own
   clock, recording the worst case rather than a snapshot. */
await page.evaluate(() => {
  const g = window.__game;
  const M = window.__mon = {
    frames: 0, litFrames: 0, black: 0, litSum: 0, under: 0, worstUnder: 0,
    spins: 0, worstSpinDeg: 0, maxKmh: 0, minFps: 1e9, offroad: 0, nonFinite: 0,
    samples: 0, armed: false, laneSum: 0, laneN: 0, worstLane: 0, reversals: 0, dim: 0,
    deadRun: 0, maxDeadRun: 0,
  };
  const gl = g.renderer.getContext();

  /* Read the frame from inside the render call, not from an interval. Once the
     task ends the compositor has swapped and the default framebuffer reads back
     as zeros unless preserveDrawingBuffer is on — which is why every "the whole
     frame is black" measurement from outside was a false positive. A grid of
     nine points, because the failure being hunted puts a correct image in one
     strip and leaves the rest black, and a centre pixel alone would miss it. */
  const px = new Uint8Array(4);
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) {
    const r = inner(...a);
    if (M.armed) {
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      let lit = 0, n = 0, dead = 0;
      for (let iy = 1; iy <= 3; iy++) for (let ix = 1; ix <= 3; ix++) {
        try {
          gl.readPixels((w * ix / 4) | 0, (h * iy / 4) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const s = px[0] + px[1] + px[2];
          if (s > 18) lit++;
          /* Exactly zero, not merely dark. The failure being hunted leaves the
             buffer untouched, which reads back as a hard 0,0,0; a night scene,
             or a camera clipped inside a tree, is dim but never that. Scoring
             "dark" as "broken" flagged pre-dawn foliage as a dead renderer. */
          if (s === 0) dead++;
          n++;
        } catch (_) {}
      }
      if (n) {
        M.frames++;
        M.litSum += lit / n;
        // Only a frame that should be lit counts as a black frame. The cycle
        // runs into night partway through a long test, and night is supposed
        // to be dark — scoring those as failures hides the real thing.
        if (lit === 0) M.dim++;                 // diagnostic only
        /* Only judge frames the sun is actually up for. "night" is a stylistic
           blend, not a brightness: at dawn it reads 0.12 while the sun is still
           below the horizon and anything under a tree is genuinely black. */
        if (g.SKYST.elev > 3) {
          M.litFrames++;
          if (dead === n) {
            M.deadRun++;
            M.maxDeadRun = Math.max(M.maxDeadRun, M.deadRun);
          } else M.deadRun = 0;
          if (dead === n) {
            M.black++;
            // record the context, or a black frame count is unactionable
            M.blackCtx = { night: +g.SKYST.night.toFixed(2), sky: g.SKYST.name,
                           offroad: +g.car.offroad.toFixed(2), n: +g.car.n.toFixed(1) };
            /* And keep the pixels of the first one. "50 frames were black" is
               either a broken resolve or a car parked inside a tree at dawn,
               and no counter can tell those apart — the picture can. */
            if (!M.blackShot) {
              const bw = w, bh = h, full = new Uint8Array(bw * bh * 4);
              gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, full);
              const cv = document.createElement('canvas');
              cv.width = bw; cv.height = bh;
              const ctx = cv.getContext('2d');
              const img = ctx.createImageData(bw, bh);
              // GL reads bottom-up; flip so the saved image is the right way up
              for (let y = 0; y < bh; y++) {
                const src = (bh - 1 - y) * bw * 4, dst = y * bw * 4;
                img.data.set(full.subarray(src, src + bw * 4), dst);
              }
              ctx.putImageData(img, 0, 0);
              M.blackShot = cv.toDataURL('image/png');
            }
          }
        }
      }
    }
    return r;
  };

  setInterval(() => {
    const c = g.car;
    M.samples++;
    if (![c.y, c.s, c.n, c.yaw, c.vLong].every(Number.isFinite)) { M.nonFinite++; return; }
    const gnd = g.sampleWheels();
    const under = gnd.max - c.y;                       // body beneath the surface
    if (under > 0.30) { M.under++; M.worstUnder = Math.max(M.worstUnder, under); }
    const beta = Math.abs(Math.atan2(c.vLat, Math.max(2, Math.abs(c.vLong)))) * 180 / Math.PI;
    if (beta > 55) M.spins++;                          // past a drift, into a spin
    M.worstSpinDeg = Math.max(M.worstSpinDeg, beta);
    M.maxKmh = Math.max(M.maxKmh, Math.abs(c.vLong) * 3.6);
    if (Math.abs(c.n) > 12) M.offroad++;
    // skip the first couple of seconds: shaders are still compiling and the
    // first frame's "fps" is meaningless
    if (M.armed && g.fps > 0 && M.samples > 60) M.minFps = Math.min(M.minFps, g.fps);
  }, 40);
});

const hold = async (keys, ms) => {
  for (const k of keys) await page.keyboard.down(k);
  await page.waitForTimeout(ms);
  for (const k of keys) await page.keyboard.up(k);
};

// start, then let the spawn lock expire before touching anything
await page.keyboard.press('Space');
await page.waitForTimeout(2500);

/* Startup readability: how much of the frame is blown out? The complaint was
   that the sunrise made the road unreadable, so measure it rather than judge
   a screenshot by eye. */
const startup = await page.evaluate(() => new Promise(res => {
  // same trick: grab the whole frame from inside the render call
  const g = window.__game, gl = g.renderer.getContext();
  const inner = g.composer.render.bind(g.composer);
  g.composer.render = function (...a) {
    const r = inner(...a);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let blown = 0, dark = 0, sum = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const l = buf[i * 4] * 0.30 + buf[i * 4 + 1] * 0.59 + buf[i * 4 + 2] * 0.11;
      sum += l;
      if (l > 247) blown++;
      if (l < 10) dark++;
    }
    g.composer.render = inner;
    res({ blownPct: +(100 * blown / n).toFixed(1), darkPct: +(100 * dark / n).toFixed(1),
          meanLuma: +(sum / n).toFixed(1), sky: g.SKYST.name });
    return r;
  };
}));
console.log('\nstartup frame:', JSON.stringify(startup));
await page.screenshot({ path: 'shots/play_startup.png' });

/* Steering direction, in every camera. +n is screen-left, so holding right must
   drive n down. Checked per camera mode because the ask was explicitly that a
   chase-camera sign convention must never leak into input handling. */
console.log('\nsteering direction by camera mode:');
const nCams = await page.evaluate(() => window.__game.CAMS.length);
let steerFails = 0;
for (let m = 0; m < nCams; m++) {
  await page.evaluate(i => window.__game.setCam(i), m);
  await page.waitForTimeout(250);
  const name = await page.evaluate(i => window.__game.CAMS[i].name, m);
  for (const [key, want] of [['KeyD', 'right'], ['KeyA', 'left']]) {
    await page.evaluate(() => { const g = window.__game; g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0; });
    const before = await page.evaluate(() => window.__game.car.n);
    await hold(['KeyW', key], 1400);
    const after = await page.evaluate(() => window.__game.car.n);
    // n grows to the left, so a right turn must reduce it
    const went = (after - before) < 0 ? 'right' : 'left';
    const ok = went === want;
    if (!ok) steerFails++;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(14)} ${key} -> car went ${went} (want ${want}), dn=${(after - before).toFixed(2)}`);
    await page.evaluate(() => { const g = window.__game; g.car.vLong = 0; g.car.n = 0; g.car.yaw = 0; });
    await page.waitForTimeout(200);
  }
}
await page.evaluate(() => window.__game.setCam(0));

/* The drive. Open-loop scripting is the wrong test here: hold W on a road that
   is never straight and you leave it within seconds through no fault of the
   handling, which says nothing about whether the car is controllable. So this
   drives closed-loop the way a person does — look at where the car is, tap a
   key, look again — using only key presses, with the demanded manoeuvres
   layered on top. If a crude bang-bang keyboard driver can hold a lane at
   250 km/h, the "small tap = small lane change" requirement is met; if the car
   is twitchy the same controller will visibly saw at it and run wide. */
console.log(`\ndriving ${SECONDS}s closed-loop ...`);
await page.evaluate(() => window.__mon.armed = true);

const MANOEUVRES = [
  { at: 12, keys: ['KeyD'], ms: 700,  what: 'small tap right at speed' },
  { at: 20, keys: ['KeyA'], ms: 700,  what: 'small tap left at speed' },
  { at: 30, keys: ['ShiftLeft'], ms: 6000, what: 'boost' },
  { at: 44, keys: ['KeyS'], ms: 2400, what: 'hard brake' },
  { at: 56, keys: ['KeyD'], ms: 2000, what: 'sustained hard right' },
  { at: 68, keys: ['KeyA'], ms: 2000, what: 'sustained hard left' },
  { at: 80, keys: ['ShiftLeft'], ms: 5000, what: 'boost again' },
  { at: 92, keys: ['KeyS', 'KeyA'], ms: 1500, what: 'brake while turning' },
  { at: 104, keys: ['Space'], ms: 1100, what: 'deliberate handbrake drift' },
  { at: 116, keys: ['KeyD'], ms: 500,  what: 'flick right' },
];

/* The driver runs in the page. Steering it over CDP polled at ~11 Hz, and at
   170 km/h that is a correction every nine metres — no car is controllable
   under that, so the previous run was measuring the test rig, not the game. It
   still uses nothing but key events, dispatched exactly as the browser would,
   and still reacts on a human-ish 20 Hz with a deadband rather than a perfect
   controller: the point is to find out whether a person tapping keys can hold a
   lane, not whether a solver can. */
await page.evaluate(() => {
  const g = window.__game, M = window.__mon;
  const held = new Set();
  window.__drv = {
    manoeuvre: null,
    key(code, want) {
      if (want === held.has(code)) return;
      want ? held.add(code) : held.delete(code);
      dispatchEvent(new KeyboardEvent(want ? 'keydown' : 'keyup', { code, bubbles: true }));
    },
    releaseAll() { for (const k of [...held]) this.key(k, false); },
  };
  let lastSteer = 0, phase = 0;
  setInterval(() => {
    const c = g.car, D = window.__drv;
    const v = Math.abs(c.vLong), kmh = v * 3.6;
    /* Lane stats only during quiet cruising. The manoeuvre list deliberately
       holds full lock for two seconds and yanks the handbrake at speed, which
       puts the car in the trees on purpose — folding the recovery from that
       into a lane-keeping average measures the manoeuvres, not the cruise. */
    if (!D.manoeuvre && performance.now() > (D.quietAt || 0)) {
      M.laneN++; M.laneSum += Math.abs(c.n); M.worstLane = Math.max(M.worstLane, Math.abs(c.n));
    }
    if (D.manoeuvre) return;                       // node is driving during those

    /* Wanted steer, from the same pure-pursuit-plus-curvature law the game's
       own pilot uses. Bang-bang against a deadband was testing the rig, not the
       car: with no anticipation it entered every bend already late. */
    const La = Math.min(72, Math.max(13, v * 0.9 + 11 + Math.abs(c.n) * 0.95));
    let err = Math.atan2(-c.n, La) - c.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const ppA = Math.atan2(2 * g.WB * Math.sin(err), La) * (g.WB + g.KUS * v * v) / g.WB;
    const ffA = g.steerForCurve(g.curvatureAt(c.s + v * 0.55), v);
    const u = Math.max(-1, Math.min(1, (ppA + ffA) / g.steerCapAt(v)));

    /* A key cannot ask for half lock, so pulse it: duty cycle proportional to
       the angle wanted, which is what a person does on a keyboard without
       thinking about it. */
    phase = (phase + 1) % 6;
    const on = Math.abs(u) > 0.05 && (phase / 6) < Math.abs(u);
    D.key('KeyA', on && u > 0);                    // positive steer is left
    D.key('KeyD', on && u < 0);

    // brake for what is coming, the way a person does
    let kMax = 0;
    for (let d = 15; d < Math.max(70, kmh * 1.7); d += 15) {
      const k = Math.abs(g.curvatureAt(c.s + d));
      if (k > kMax) kMax = k;
    }
    const vSafe = kMax > 1e-6 ? Math.sqrt(1.05 * 9.81 / kMax) : 60;   // m/s
    // 150 is a cruising pace, not a limit — the boost manoeuvres still push
    // past 200. A bot pinning the top speed everywhere only measures the bot.
    const target = Math.min(150, vSafe * 3.6);
    D.key('KeyW', kmh < target - 4);
    D.key('KeyS', kmh > target + 14);

    const s = u > 0.06 ? 1 : u < -0.06 ? -1 : 0;
    if (s !== 0 && s === -lastSteer) M.reversals++;
    if (s !== 0) lastSteer = s;
    M.stAbs = Math.max(M.stAbs || 0, Math.abs(g.input.st));
    M.stSum = (M.stSum || 0) + Math.abs(g.input.st);
    M.wanted = (M.wanted || 0) + (s !== 0 ? 1 : 0);
  }, 16);
});

const t0 = Date.now();
let mi = 0;
while ((Date.now() - t0) / 1000 < SECONDS) {
  const t = (Date.now() - t0) / 1000;
  const m = MANOEUVRES[mi];
  if (m && t >= m.at) {
    console.log(`  ${t.toFixed(0).padStart(3)}s  ${m.what}`);
    // hand control to the manoeuvre, then give it back
    await page.evaluate(k => {
      const D = window.__drv;
      D.manoeuvre = k;
      D.key('KeyA', false); D.key('KeyD', false);
      for (const c of k) D.key(c, true);
    }, m.keys);
    await page.waitForTimeout(m.ms);
    await page.evaluate(k => {
      const D = window.__drv;
      for (const c of k) D.key(c, false);
      D.manoeuvre = null;
      D.quietAt = performance.now() + 5000;        // let it get back on the road first
    }, m.keys);
    mi++;
    continue;
  }
  await page.waitForTimeout(200);
}
await page.evaluate(() => window.__drv.releaseAll());

const M = await page.evaluate(() => window.__mon);
await page.screenshot({ path: 'shots/play_end.png' });
if (M.blackShot) {
  fs.writeFileSync('shots/play_blackframe.png', Buffer.from(M.blackShot.split(',')[1], 'base64'));
  console.log('\nwrote shots/play_blackframe.png — the first frame scored as black');
}
delete M.blackShot;

/* ---- handling, measured against the brief rather than inferred from a lap ----
   "at 100+ km/h a small tap = a small, smooth lane change; holding a direction
   = a wide stable arc, not a spin; the car straightens itself when I release."
   Each of those is a number, so measure it instead of arguing about feel.    */
console.log('\n--- handling ---');
const setup = kmh => page.evaluate(v => {
  const g = window.__game;
  g.setAuto(false);
  g.car.n = 0; g.car.yaw = 0; g.car.vLat = 0; g.car.omega = 0; g.car.vLong = v / 3.6;
  g.input.st = 0; g.input.th = 0; g.input.br = 0; g.input.hb = 0;
  g.car.steer = 0; g.car.offroad = 0;
  g.settleSuspension(); g.placeCar(); g.camSnap();
}, kmh);
const probe = () => page.evaluate(() => {
  const g = window.__game, c = g.car;
  /* Yaw rate relative to the road, not to the world. car.omega is absolute, so
     a car perfectly tracking a bend still shows a healthy yaw rate — measuring
     that, "settled" is unreachable on a road that is never straight, and every
     stability number is really a curvature reading. */
  return { n: c.n, yaw: c.yaw,
           omega: c.omega - g.curvatureAt(c.s) * c.vLong,
           beta: Math.abs(Math.atan2(c.vLat, Math.max(2, Math.abs(c.vLong)))) * 180 / Math.PI,
           kmh: Math.abs(c.vLong) * 3.6 };
});
const feel = {};

/* 1 — a 250 ms tap at 110 km/h. Measured as yaw rate and sideslip, not as a
   change in n: the road is curving underneath, so n moves on its own and would
   read as steering response that isn't there. */
/* Judged against the car's own steady-state yaw rate at full lock — the most
   the steering can ask for at this speed. An absolute rad/s threshold is
   meaningless: it is a different number at every speed, and the road bending
   one way or the other moves it before the driver touches anything. */
const steady = kmh => page.evaluate(v => {
  const g = window.__game, s = v / 3.6;
  return s * g.steerCapAt(s) / (g.WB + g.KUS * s * s);
}, kmh);

await setup(110);
await page.keyboard.down('KeyW');
await page.waitForTimeout(500);
const ss110 = await steady(110);
const base = (await probe()).omega;
await page.keyboard.down('KeyD');
await page.waitForTimeout(250);
await page.keyboard.up('KeyD');
let tapPeakBeta = 0, tapPeakD = 0;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(100);
  const p = await probe();
  tapPeakBeta = Math.max(tapPeakBeta, p.beta);
  tapPeakD = Math.max(tapPeakD, Math.abs(p.omega - base));
}
await page.keyboard.up('KeyW');
feel.tapFrac = tapPeakD / ss110;
feel.tapBeta = tapPeakBeta;
// enough response to be worth pressing, well short of everything the car has
const tapOK = feel.tapFrac > 0.04 && feel.tapFrac < 0.85 && tapPeakBeta < 15;
console.log(`  250ms tap @110: yaw +${tapPeakD.toFixed(3)} rad/s = ${(100 * feel.tapFrac).toFixed(0)}% of full lock,` +
            ` sideslip ${feel.tapBeta.toFixed(1)}deg   ${tapOK ? 'OK (small and smooth)' : feel.tapFrac <= 0.04 ? '<-- no response' : '<-- too violent'}`);

/* 2 — hold for 3 s. Yaw rate is *supposed* to build here: that is what turning
   is. The question is whether it converges on what was asked for (an arc) or
   runs past it (a spin), so it is scored against the steady state, not against
   its own earlier value. */
await setup(120);
const ss120 = await steady(120);
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyD');
let holdPeakBeta = 0, holdPeak = 0;
const tail = [];
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(100);
  const p = await probe();
  const w = Math.abs(p.omega);
  holdPeak = Math.max(holdPeak, w);
  holdPeakBeta = Math.max(holdPeakBeta, p.beta);
  if (i >= 20) tail.push(w);
}
await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
feel.holdFrac = holdPeak / ss120;
feel.holdBeta = holdPeakBeta;
const settledArc = Math.max(...tail) - Math.min(...tail) < 0.30 * ss120;   // flat, not still climbing
feel.arcStable = settledArc && feel.holdFrac < 1.35;
console.log(`  3s hold  @120: peak yaw ${holdPeak.toFixed(2)} rad/s = ${(100 * feel.holdFrac).toFixed(0)}% of full lock,` +
            ` sideslip ${feel.holdBeta.toFixed(1)}deg, tail ${settledArc ? 'flat' : 'still climbing'}` +
            `   ${feel.arcStable && feel.holdBeta < 45 ? 'OK (stable arc)' : '<-- diverging'}`);

/* 3 — release. Measured from a clean start on the road, and as a decay ratio
   rather than an absolute yaw rate: run this straight after the hold above and
   the car is already out in the scenery, where the verge keeps generating yaw
   and nothing ever reads as settled. */
await setup(110);
await page.keyboard.down('KeyW');
await page.waitForTimeout(600);
await page.keyboard.down('KeyD');
await page.waitForTimeout(1000);
await page.keyboard.up('KeyD');
const atRelease = Math.abs((await probe()).omega);
let settleMs = -1;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(100);
  if (Math.abs((await probe()).omega) < atRelease * 0.25) { settleMs = (i + 1) * 100; break; }
}
await page.keyboard.up('KeyW');
feel.settleMs = settleMs;
console.log(`  release @110:  yaw ${atRelease.toFixed(3)} rad/s decayed to a quarter in ` +
            `${settleMs < 0 ? '>3000' : settleMs} ms   ${settleMs >= 0 && settleMs <= 2500 ? 'OK (self-centres)' : '<-- does not settle'}`);

// 4 — can it get back from the verge under its own steering?
await setup(90);
await page.evaluate(() => { window.__game.car.n = 26; });   // out on the shoulder
await page.keyboard.down('KeyW');
let recovered = -1;
for (let i = 0; i < 60; i++) {
  await page.keyboard.down('KeyD');                          // +n is left, so steer right
  await page.waitForTimeout(80);
  const p = await probe();
  if (p.n < 6) { recovered = (i + 1) * 80; break; }
  if (p.n < 12) await page.keyboard.up('KeyD');
}
await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
feel.recoverMs = recovered;
console.log(`  26m off-road:  back on the road after ${recovered < 0 ? 'NEVER' : recovered + ' ms'}   ` +
            `${recovered > 0 ? 'OK' : '<-- cannot recover'}`);

const offPct = 100 * M.offroad / Math.max(1, M.samples);
console.log('\n================ RESULT ================');
console.log(`frames rendered    ${M.frames}   mean lit ${(100 * M.litSum / Math.max(1, M.frames)).toFixed(0)}% of probes`);
/* The resolve failure is not intermittent: it kills every frame for the whole
   session. A handful of isolated dead frames is the chase camera clipping into
   a bush, so the run length is what separates the two. */
console.log(`dead frames        ${M.black} / ${M.litFrames} sunlit, longest unbroken run ${M.maxDeadRun}` +
            `   ${M.maxDeadRun > 30 ? '<-- FAIL (persistent black screen)' : ''}`);
console.log(`merely dim frames  ${M.dim} (night, or camera inside foliage — not a fault)`);
console.log(`fall-throughs      ${M.under}  worst ${M.worstUnder.toFixed(2)} m   ${M.under ? '<-- FAIL' : ''}`);
console.log(`non-finite states  ${M.nonFinite}   ${M.nonFinite ? '<-- FAIL' : ''}`);
console.log(`spins (>55deg)     ${M.spins}  worst sideslip ${M.worstSpinDeg.toFixed(1)}deg   ${M.spins ? '<-- FAIL' : ''}`);
console.log(`steering direction ${steerFails} failures   ${steerFails ? '<-- FAIL' : ''}`);
console.log(`lane keeping       mean |n| ${(M.laneSum / Math.max(1, M.laneN)).toFixed(1)} m,  worst ${M.worstLane.toFixed(1)} m` +
            `  (cruise only, bot driving)`);
console.log(`driver input       peak |st| ${(M.stAbs || 0).toFixed(2)}   ` +
            `${(M.stAbs || 0) < 0.1 ? '<-- KEYS NOT REACHING GAME' : '(synthetic keys reaching the game)'}`);
console.log(`steering reversals ${M.reversals} in ${M.laneN}  ` +
            `${M.reversals > M.laneN * 0.15 ? '<-- twitchy, driver is sawing' : '(smooth)'}`);
// diagnostic, not a gate: how far the bot wanders says as much about the bot
console.log(`off-road           ${offPct.toFixed(1)}% of samples (diagnostic)`);
if (M.blackCtx) console.log(`black frame ctx    ${JSON.stringify(M.blackCtx)}`);
console.log(`top speed          ${M.maxKmh.toFixed(0)} km/h`);
console.log(`min fps            ${M.minFps === 1e9 ? 'n/a' : M.minFps.toFixed(0)}`);
console.log(`startup blown-out  ${startup.blownPct}%  dark ${startup.darkPct}%  mean luma ${startup.meanLuma}` +
            `   ${startup.blownPct > 8 ? '<-- still washed out' : ''}`);
console.log(`page errors        ${errs.length}`);
for (const e of [...new Set(errs)]) console.log('   ', e);

const feelOK = feel.tapFrac > 0.04 && feel.tapFrac < 0.85 && feel.tapBeta < 15
            && feel.arcStable && feel.holdBeta < 45
            && feel.settleMs >= 0 && feel.settleMs <= 2500 && feel.recoverMs > 0;
const pass = M.maxDeadRun <= 30 && !M.under && !M.nonFinite && !M.spins && !steerFails
             && !software && gpu.samples === 0 && startup.blownPct <= 8 && feelOK;
console.log(pass ? '\nPASS' : '\nFAIL');
await bye(pass ? 0 : 1);
