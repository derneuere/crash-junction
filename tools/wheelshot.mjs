// In-game wheel screenshot + triangle census harness.
//
//   node tools/wheelshot.mjs [--port N] [--out dir] [--steer] [--roll] [--tag name]
//
// Boots the junction level headless (verify=1 = the FAST render tier), drives
// the player for ~2.5 s (ArrowUp, plus ArrowLeft with --steer so the fronts
// are turned), freezes the sim + director, then parks the camera low at the
// front three-quarter of the PLAYER car and of the nearest TRAFFIC car and
// captures each as a PNG. Also prints a per-actor triangle census (hull vs
// wheels) so a wheel-geometry change can be budgeted.
//
// --roll captures the player twice, a few sim steps apart, so the wheel roll
// about the axle can be checked frame-to-frame. --steer also adds a head-on
// frame so the steered fronts read against the body. The traffic sedan is
// captured twice: as drawn up close (full wheel) and with its coarse LOD
// twin forced on, so the far-ring wheel can be judged at close range.
//
// Pure read-out: never records a tape, never touches a fixture.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('--port', process.env.REPLAY_PORT ?? 5301));
const OUT = path.resolve(root, opt('--out', 'screenshots/wheels'));
const TAG = opt('--tag', 'current');
const STEER = args.includes('--steer');
const ROLL = args.includes('--roll');
mkdirSync(OUT, { recursive: true });

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { await sleep(200); }
  }
  let browser;
  for (const target of [
    { channel: 'chrome' }, { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ]) {
    try { browser = await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); break; } catch {}
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page:${m.type()}]`, m.text()); });
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  await page.goto(`http://localhost:${PORT}/?level=junction&launch=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.levelId === 'junction', { timeout: 20000 });
  await sleep(1500); // let the async models land

  // drive
  await page.evaluate((steer) => {
    const g = window.__game;
    g.launch();
    const dt = 1 / 120;
    for (let i = 0; i < 300; i++) {
      g.simKeys = { ArrowUp: true, ArrowLeft: steer && i > 150 };
      g.advance(dt, false, []);
    }
  }, STEER);

  // triangle census before freezing (wheels are always visible on the
  // player; traffic wheels may already be LOD-hidden, so count regardless of
  // visibility)
  const census = await page.evaluate(() => {
    const g = window.__game;
    const tris = (m) => {
      const geo = m.geometry;
      return Math.round((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
    };
    return g.actors
      .filter((a) => a.kind === 'vehicle' && a.spec)
      .map((a) => {
        let total = 0;
        a.group.traverse((o) => { if (o.isMesh) total += tris(o); });
        const wheels = a.wheels.reduce((s, w) => s + tris(w), 0);
        const wheelLod = a.wheels[0]?.userData?.lodGeometry;
        return {
          variant: a.spec.variant,
          player: a.isPlayer,
          total,
          wheels,
          perWheel: tris(a.wheels[0]),
          coarsePerWheel: wheelLod ? Math.round((wheelLod.index ? wheelLod.index.count : wheelLod.attributes.position.count) / 3) : null,
          x: +a.group.position.x.toFixed(1),
          z: +a.group.position.z.toFixed(1),
        };
      });
  });
  console.log('census:', JSON.stringify(census, null, 1));

  // pose the camera low at the front three-quarter of an actor, aimed at its
  // front-left wheel. Wheel-local: the car faces local -z, +x is right.
  const pose = async (which, file, extraSteps = 0, mode = 'quarter') => {
    await page.evaluate((which, extraSteps, mode) => {
      const g = window.__game;
      if (extraSteps) {
        const adv = g.__adv ?? g.advance;
        for (let i = 0; i < extraSteps; i++) { g.simKeys = { ArrowUp: true }; adv.call(g, 1 / 120, false, []); }
      }
      // freeze
      if (!g.__adv) { g.__adv = g.advance; g.advance = () => {}; g.director.update = () => {}; }
      const actors = g.actors.filter((a) => a.kind === 'vehicle' && a.spec);
      const player = actors.find((a) => a.isPlayer);
      let target = player;
      if (which !== 'player') {
        // nearest traffic car of the requested variant to the player
        const cands = actors.filter((a) => !a.isPlayer && a.spec.variant === which);
        cands.sort((a, b) => a.group.position.distanceTo(player.group.position) - b.group.position.distanceTo(player.group.position));
        target = cands[0];
        if (!target) throw new Error(`no ${which} in level`);
        // hop the target next to the camera's frame of interest: leave it be,
        // we move the camera instead
      }
      const wh = target.wheels[0]; // front-left
      target.group.updateMatrixWorld(true);
      if (mode === 'front') {
        // head-on, low, aimed at the front axle midpoint: steered fronts read as angled discs
        const wr = target.wheels[1];
        const mid = new THREE.Vector3((wh.position.x + wr.position.x) / 2, wh.position.y, wh.position.z);
        const cp = target.group.localToWorld(new THREE.Vector3(mid.x - 1.1, mid.y + 0.9, mid.z - 3.4));
        g.camera.position.copy(cp);
        g.camera.lookAt(target.group.localToWorld(mid.clone()));
      } else {
        const wp = wh.getWorldPosition(new THREE.Vector3());
        const off = new THREE.Vector3(-1.7, 0.45, -1.5); // front-left, low, ahead
        const cp = target.group.localToWorld(new THREE.Vector3(wh.position.x + off.x, wh.position.y + off.y, wh.position.z + off.z));
        g.camera.position.copy(cp);
        g.camera.lookAt(wp);
      }
      g.camera.updateMatrixWorld(true);
      window.__wheelTarget = target;
      return target.wheels.map((w) => `${w.rotation.order} x=${w.rotation.x.toFixed(2)} y=${w.rotation.y.toFixed(2)}`);
    }, which, extraSteps, mode).then((rots) => console.log(`${which} wheel rotations (FL FR RL RR):`, rots.join(' | ')));
    // one frame so the car LOD settles for the new camera, then (coarse mode)
    // force the coarse twin on — the LOD only writes geometry on a ring
    // transition, so the override sticks for the capture
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    if (mode === 'coarse') {
      await page.evaluate(() => {
        for (const w of window.__wheelTarget.wheels) if (w.userData.lodGeometry) w.geometry = w.userData.lodGeometry;
      });
    }
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
    const out = path.join(OUT, file);
    await page.screenshot({ path: out });
    console.log('wrote', out);
  };

  const suffix = STEER ? '-steer' : '';
  await page.addScriptTag({ content: 'window.THREE = window.THREE || null;' });
  // three is bundled; reach it through a mesh's constructor chain
  await page.evaluate(() => {
    const g = window.__game;
    const V = g.camera.position.constructor;
    window.THREE = { Vector3: V };
  });
  await pose('player', `${TAG}-player${suffix}.png`);
  if (STEER) await pose('player', `${TAG}-player-front${suffix}.png`, 0, 'front');
  await pose('sedan', `${TAG}-traffic-sedan${suffix}.png`);
  await pose('sedan', `${TAG}-traffic-sedan-coarse${suffix}.png`, 0, 'coarse');
  const hasBus = census.some((c) => c.variant === 'bus');
  if (hasBus) await pose('bus', `${TAG}-traffic-bus${suffix}.png`);
  const hasTanker = census.some((c) => c.variant === 'tanker');
  if (hasTanker) await pose('tanker', `${TAG}-traffic-tanker${suffix}.png`);
  if (ROLL) {
    await pose('player', `${TAG}-player-roll-a.png`);
    await pose('player', `${TAG}-player-roll-b.png`, 6);
  }
  await browser.close();
} finally {
  vite.kill();
}
