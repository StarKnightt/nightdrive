/* What is actually in a wheel after the static merge, and where is it?
   The beauty shots show featureless black discs where the rims should be, and
   a screenshot cannot distinguish "geometry is wrong" from "geometry is fine
   but unlit". This reports both: the scene graph, and a flat-lit render.
     lowprio.cmd wheelprobe.mjs                                              */
import fs from 'node:fs';
import { run } from './harness.mjs';

await run({ width: 900, height: 560 }, async ({ page }) => {
  await page.waitForTimeout(4000);

  const rep = await page.evaluate(() => {
    const g = window.__game, THREE = g.THREE;
    const wh = g.wheelHub[0];
    const out = { parts: [], hub: {}, radius: wh.r };
    const bb = new THREE.Box3();
    wh.spin.traverse(o => {
      if (!o.isMesh) return;
      bb.setFromObject(o);
      const m = o.material;
      out.parts.push({
        name: o.name || '(anon)',
        mat: m.name || m.type,
        color: m.color ? '#' + m.color.getHexString() : '(none)',
        metal: m.metalness, rough: m.roughness,
        env: m.envMapIntensity,
        tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
        min: [+bb.min.x.toFixed(2), +bb.min.y.toFixed(2), +bb.min.z.toFixed(2)],
        max: [+bb.max.x.toFixed(2), +bb.max.y.toFixed(2), +bb.max.z.toFixed(2)],
      });
    });
    bb.setFromObject(wh.spin);
    out.hub = { pos: wh.pivot.position.toArray().map(v => +v.toFixed(2)),
                min: bb.min.toArray().map(v => +v.toFixed(2)),
                max: bb.max.toArray().map(v => +v.toFixed(2)) };
    // does anything else overlap the wheel volume?
    const occl = [];
    g.carBody.traverse(o => {
      if (!o.isMesh || wh.spin === o.parent || o.parent === wh.spin) return;
      const b = new THREE.Box3().setFromObject(o);
      if (b.intersectsBox(bb)) occl.push({
        name: o.name || '(anon)', mat: o.material.name || o.material.type,
        side: o.material.side,
        color: o.material.color ? '#' + o.material.color.getHexString() : '(none)',
      });
    });
    out.overlapping = occl;
    return out;
  });

  console.log('\nfront-left wheel — radius %s, pivot %s', rep.radius, JSON.stringify(rep.hub.pos));
  console.log('bounds %s .. %s', JSON.stringify(rep.hub.min), JSON.stringify(rep.hub.max));
  console.log('\nmeshes under spin:');
  console.log('  material            color     metal rough  env    tris   bounds');
  for (const p of rep.parts)
    console.log('  ' + p.mat.padEnd(20), p.color, String(p.metal).padStart(5),
      String(p.rough).padStart(5), String(p.env).padStart(5),
      String(p.tris).padStart(6), JSON.stringify(p.min), JSON.stringify(p.max));
  console.log('\nother car meshes overlapping the wheel volume:');
  for (const o of rep.overlapping)
    console.log(`  ${String(o.mat).padEnd(20)} ${o.color}  side=${o.side}  ${o.name}`);

  // Park it so the wheel is not rolling through the frame, and let the camera
  // rig actually fly to the locked pose — that happens in the render loop, so
  // it needs live frames before anything gets paused for capture.
  await page.evaluate(() => {
    const g = window.__game;
    g.setDay(0.14); g.setAuto(true); g.warp(10, 1);
    g.car.vLong = 0; g.car.vLat = 0; g.car.omega = 0;
    g.warp(0.8, 0);
    g.car.vLong = 0; g.car.vLat = 0; g.car.omega = 0;
    g.bakeEnv();
    g.lockCam({ az: 1.15, dist: 3.2, height: 0.44, fov: 32, aim: 0.30 });
  });

  /* 'lit' is what the player sees; 'ids' paints every material a flat distinct
     colour so a suspicious patch can be attributed to a specific material
     instead of argued about. */
  for (const mode of ['lit', 'ids']) {
    const r = await page.evaluate(mode => {
      const g = window.__game, THREE = g.THREE;
      g.setPaused(true);
      const swap = [], legend = [], seen = new Map();
      if (mode === 'ids') {
        const PAL = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0xff00ff, 0x00ffff,
                     0xff8000, 0x8000ff, 0x00ff80, 0x808080, 0xffffff, 0x004080];
        g.scene.traverse(o => {
          if (!o.isMesh || !o.material || !o.material.color) return;
          const key = o.material.uuid;
          if (!seen.has(key)) {
            const c = PAL[seen.size % PAL.length];
            seen.set(key, c);
            legend.push({ c: '#' + c.toString(16).padStart(6, '0'),
                          mat: '#' + o.material.color.getHexString(),
                          type: o.material.type });
          }
          swap.push([o, o.material]);
          o.material = new THREE.MeshBasicMaterial({ color: seen.get(key),
                                                     side: o.material.side });
        });
      }
      g.renderOnce();
      const url = g.renderer.domElement.toDataURL('image/png');
      for (const [o, m] of swap) o.material = m;
      g.setPaused(false);
      return { url, legend };
    }, mode);
    fs.writeFileSync(`shots/wheel_${mode}.png`, Buffer.from(r.url.split(',')[1], 'base64'));
    if (r.legend.length) {
      console.log('\nid colours:');
      for (const l of r.legend) console.log(`  ${l.c}  <- ${l.mat} ${l.type}`);
    }
    console.log('wrote shots/wheel_%s.png', mode);
  }
  await page.evaluate(() => window.__game.lockCam(null));
});
