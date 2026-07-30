/* Which object is drawing artefacts across the sky?
   Boots once, drives to a representative frame, then re-renders that frame with
   one top-level object hidden at a time and reports which removals change the
   sky band. One browser session rather than one per hypothesis — SwiftShader
   boots are the expensive part, extra renders are nearly free.
   usage: lowprio.cmd probe-streak.mjs                                        */
import { run } from './harness.mjs';
import fs from 'node:fs';

fs.mkdirSync('shots', { recursive: true });

await run({ width: 900, height: 520 }, async ({ page }) => {
  await page.waitForTimeout(1500);
  console.log('driving to the frame under suspicion…');
  await page.evaluate(() => {
    const g = window.__game;
    g.setDay(0.05); g.restart();
    g.simulate([{ sec: 9, keys: [], autoSteer: true, autoPedal: true },
                { sec: 3, keys: ['KeyW', 'ShiftLeft'], autoSteer: true }], 60);
    g.bakeEnv(); g.clearFlash();
  });
  await page.waitForTimeout(2500);

  // Inventory the scene so the candidate list is derived, not assumed.
  const inv = await page.evaluate(() => ({
    top: window.__game.scene.children.map(c =>
      ({ name: c.name || '(anon)', type: c.type, kids: c.children.length, visible: c.visible })),
  }));
  console.log('\nscene top level:');
  for (const t of inv.top) console.log(`  ${t.type.padEnd(16)} ${String(t.name).padEnd(20)} kids=${t.kids}`);

  const skyShot = async () =>
    (await page.screenshot({ clip: { x: 0, y: 0, width: 900, height: 190 }, timeout: 120_000 }))
      .toString('base64');
  const baseline = await skyShot();

  const results = [];
  for (let i = 0; i < inv.top.length; i++) {
    const hid = await page.evaluate(idx => {
      const c = window.__game.scene.children[idx];
      if (!c.visible) return null;
      c.visible = false; return c.type + ' ' + (c.name || '(anon)');
    }, i);
    if (!hid) continue;
    await page.waitForTimeout(600);
    const shot = await skyShot();
    await page.evaluate(idx => { window.__game.scene.children[idx].visible = true; }, i);
    results.push({ hid, changed: shot !== baseline });
  }
  await page.waitForTimeout(400);

  console.log('\nhiding each top-level object — did the sky band change?');
  for (const r of results) console.log(`  ${r.changed ? 'CHANGED' : '   same'}  ${r.hid}`);

  await page.screenshot({ path: 'shots/streak_probe.png', timeout: 120_000 });
  console.log('\nwrote shots/streak_probe.png');
});
