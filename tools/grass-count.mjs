// Grass-in-viewport counter for the GANTRY POINT instanced-blade grass.
//
//   fnm exec --using=22 -- node tools/grass-count.mjs --port <port>
//
// Boots a vite dev server, drives a headless Chrome/Edge onto GANTRY POINT in
// day lighting, waits for the async GLB props to land, then for a battery of
// camera POSES (the refshot canonical poses PLUS a set of on-track driving
// positions a real player passes through) it:
//   * sets the camera to the pose,
//   * runs the grass field's own per-frame distance cull (grass.update with
//     the live camera position) so tile visibility matches the real game,
//   * builds the camera frustum and counts how many blade INSTANCES are
//     actually drawn AND inside the frustum (visible tile + index < count +
//     world-space position inside the frustum).
//
// This is the measurement the grass fix is judged on: blades-in-viewport per
// scenario, before and after. It reads only render-time state (scene graph,
// camera, instance matrices) — it never touches sim/physics/RNG, so running
// it can't perturb a replay pin.
//
// Needs Node 18+ (vite 6 dev server) and an installed Chrome or Edge.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The four canonical refshot poses (cam + look-at, world metres) PLUS the
// grass-sand art pose, PLUS a set of ON-TRACK driving poses: each is a real
// point on the racing line (from the gantryPoint waypoints) with the camera
// seated where a chase cam sits — a few metres back, ~3 m up, looking down
// the road ahead. These are the positions a PLAYER actually drives past, so
// counting grass at them proves the verges read while racing.
const POSES = {
  // canonical refshot framings (frozen — see tools/refshot.mjs)
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  cliff: { cam: [212, 26, 150], look: [275, 2, 212] },
  beach: { cam: [-158, 30, -108], look: [-235, 0, -185] },
  'grass-sand': { cam: [-198, 8, -120], look: [-238, 0, -180] },
  // ON-TRACK driving poses (chase-cam seat behind a point on the racing line,
  // looking down the road). Coordinates straddle the loop so we sample verges
  // all the way round, not just the SW beach.
  'drive-start-straight': { cam: [-30, 3.2, -230], look: [120, 1, -222] }, // south straight, START/FINISH
  'drive-cannery': { cam: [232, 3.2, -150], look: [250, 1, -120] }, // east horseshoe
  'drive-dockyard': { cam: [120, 3.2, -30], look: [95, 1, 0] }, // warehouse rows
  'drive-quay-climb': { cam: [240, 4.5, 120], look: [258, 3, 160] }, // gold-grass climb
  'drive-cliff': { cam: [240, 8, 215], look: [200, 6, 240] }, // headland rim
  'drive-lookout': { cam: [70, 8, 245], look: [10, 5, 235] }, // lookout ess
  'drive-nw-sweep': { cam: [-180, 4, 220], look: [-228, 2, 175] }, // NW sweepers
  'drive-roadblock': { cam: [-215, 3.2, 60], look: [-238, 1, 20] }, // chicane
  'drive-beach-fork': { cam: [-250, 3.2, -45], look: [-235, 1, -86] }, // beach fork
  'drive-village': { cam: [-150, 3.2, -100], look: [-130, 1, -150] }, // village snake
};

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5191;
// optional: restrict to one pose, e.g. --pose drive-start-straight
const poseIdx = args.indexOf('--pose');
const ONLY = poseIdx >= 0 ? args[poseIdx + 1] : null;
// optional: also write a 1280x720 PNG per pose into <dir> (verification aid)
const shotIdx = args.indexOf('--shot');
const SHOT_DIR = shotIdx >= 0 ? args[shotIdx + 1] : null;

if (!Number.isInteger(PORT)) {
  console.error('usage: node tools/grass-count.mjs --port <port> [--pose <name>] [--shot <dir>]');
  process.exit(1);
}
if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} is too old for the vite dev server — use Node 18+ (fnm exec --using=22).`);
  process.exit(1);
}

try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already in use — pick a free one with --port`);
  process.exit(1);
} catch {
  // nothing answered — the port is ours
}

function startVite() {
  const proc = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}

async function waitForServer(vite) {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode} — is port ${PORT} taken?`);
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`dev server did not come up on port ${PORT}`);
}

async function launchBrowser() {
  const errors = [];
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    ...(process.platform === 'win32'
      ? [
          { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
          { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
        ]
      : []),
  ];
  for (const target of candidates) {
    try {
      return await puppeteer.launch({
        ...target,
        headless: true,
        args: ['--enable-unsafe-swiftshader', '--mute-audio'],
      });
    } catch (e) {
      errors.push(`${target.channel ?? target.executablePath}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome or Edge found for puppeteer-core:\n${errors.join('\n')}`);
}

async function clickButton(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const re2 = new RegExp(reSrc);
    const btn = [...document.querySelectorAll('button')].find((b) => re2.test(b.textContent?.trim() ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, re.source);
  if (!clicked) throw new Error(`no button matching ${re} on the page`);
}

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30_000, polling: 100 });

  await clickButton(page, /\bDAY\b/);
  await clickButton(page, /^GANTRY POINT$/);
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30_000, polling: 100 });
  await new Promise((res) => setTimeout(res, 5_000));

  const poses = ONLY ? { [ONLY]: POSES[ONLY] } : POSES;
  if (ONLY && !POSES[ONLY]) throw new Error(`unknown pose '${ONLY}'`);

  const results = await page.evaluate((posesArg) => {
    const g = window.__game;
    const c = g.camera;
    const scene = g.scene;
    // freeze the idle orbit so the pose holds while we measure
    g.director.update = () => {};
    c.aspect = 16 / 9;
    c.updateProjectionMatrix();

    // grass meshes are named 'cj-grass-blades' by buildGrass
    const meshes = [];
    scene.traverse((o) => {
      if (o.name === 'cj-grass-blades' && o.isInstancedMesh) meshes.push(o);
    });

    // total allocated blades across all tiles (== sum of geometry instance
    // capacity) and total currently-active (sum of mesh.count)
    let allocated = 0;
    let active = 0;
    for (const m of meshes) {
      allocated += m.instanceMatrix.count;
      active += m.count;
    }

    // Build the view-projection matrix by hand from the camera (no three import
    // needed): frustum planes from the combined matrix, classic Gribb/Hartmann.
    const out = {};

    function countAt(cam, look) {
      c.position.set(cam[0], cam[1], cam[2]);
      c.lookAt(look[0], look[1], look[2]);
      c.updateMatrixWorld(true);
      c.updateProjectionMatrix();
      // run the field's real per-frame cull so tile.visible matches the game
      g.grass?.update(0, c.position);

      // combined = projection * viewInverse(world)  => use matrixWorldInverse
      const p = c.projectionMatrix.elements;
      const v = c.matrixWorldInverse.elements;
      // m = p * v  (column-major 4x4 multiply)
      const m = new Array(16).fill(0);
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += p[row + k * 4] * v[k + col * 4];
          m[row + col * 4] = s;
        }
      }
      // six frustum planes from the clip matrix rows (a,b,c,d), normalized
      const planes = [];
      const addPlane = (a, b, cc, d) => {
        const len = Math.hypot(a, b, cc) || 1;
        planes.push([a / len, b / len, cc / len, d / len]);
      };
      // rows of m: m[r + col*4]
      const r0 = (col) => m[0 + col * 4];
      const r1 = (col) => m[1 + col * 4];
      const r2 = (col) => m[2 + col * 4];
      const r3 = (col) => m[3 + col * 4];
      addPlane(r3(0) + r0(0), r3(1) + r0(1), r3(2) + r0(2), r3(3) + r0(3)); // left
      addPlane(r3(0) - r0(0), r3(1) - r0(1), r3(2) - r0(2), r3(3) - r0(3)); // right
      addPlane(r3(0) + r1(0), r3(1) + r1(1), r3(2) + r1(2), r3(3) + r1(3)); // bottom
      addPlane(r3(0) - r1(0), r3(1) - r1(1), r3(2) - r1(2), r3(3) - r1(3)); // top
      addPlane(r3(0) + r2(0), r3(1) + r2(1), r3(2) + r2(2), r3(3) + r2(3)); // near
      addPlane(r3(0) - r2(0), r3(1) - r2(1), r3(2) - r2(2), r3(3) - r2(3)); // far

      const inFrustum = (x, y, z) => {
        for (const pl of planes) if (pl[0] * x + pl[1] * y + pl[2] * z + pl[3] < 0) return false;
        return true;
      };

      let inView = 0;
      let tilesDrawn = 0;
      let activeBlades = 0;
      for (const mesh of meshes) {
        if (!mesh.visible) continue; // distance-culled tile draws nothing
        tilesDrawn++;
        const n = mesh.count; // active instances (tier budget)
        activeBlades += n;
        const arr = mesh.instanceMatrix.array;
        for (let i = 0; i < n; i++) {
          // translation column of instance matrix i (col 3 => elements 12,13,14)
          const base = i * 16;
          const x = arr[base + 12];
          const y = arr[base + 13];
          const z = arr[base + 14];
          // grass blades stand up to ~2.5 m; sample the mid-height so a blade
          // whose base is just below the bottom plane but body is in view counts
          if (inFrustum(x, y + 0.8, z)) inView++;
        }
      }
      return { inView, tilesDrawn, tilesTotal: meshes.length, activeBlades };
    }

    for (const [name, pose] of Object.entries(posesArg)) {
      out[name] = countAt(pose.cam, pose.look);
    }
    return { perPose: out, allocated, active, meshCount: meshes.length };
  }, poses);

  // pretty report
  console.log('');
  console.log(`GRASS COUNT — GANTRY POINT (day)`);
  console.log(`  tiles (InstancedMesh): ${results.meshCount}   allocated blades: ${results.allocated}   active (tier): ${results.active}`);
  console.log('');
  const names = Object.keys(results.perPose);
  const pad = Math.max(...names.map((n) => n.length));
  console.log(`  ${'pose'.padEnd(pad)}  blades-in-view  tiles-drawn  active-in-drawn`);
  for (const n of names) {
    const r = results.perPose[n];
    console.log(
      `  ${n.padEnd(pad)}  ${String(r.inView).padStart(13)}  ${String(`${r.tilesDrawn}/${r.tilesTotal}`).padStart(11)}  ${String(r.activeBlades).padStart(15)}`,
    );
  }
  console.log('');
  // machine-readable line for diffing before/after
  console.log('JSON ' + JSON.stringify(results));

  // optional verification screenshots — render each pose through the live
  // chain (CINE composer if active, else the bare renderer) and write a PNG so
  // the grass can be eyeballed on the verges. Same two-frame settle as refshot.
  if (SHOT_DIR) {
    const outDir = path.isAbsolute(SHOT_DIR) ? SHOT_DIR : path.join(root, SHOT_DIR);
    mkdirSync(outDir, { recursive: true });
    for (const [name, pose] of Object.entries(poses)) {
      const dataUrl = await page.evaluate(({ cam, look }) => {
        const g = window.__game;
        g.director.update = () => {};
        const r = g.renderer;
        const c = g.camera;
        r.setPixelRatio(1);
        r.setSize(1280, 720, false);
        c.aspect = 16 / 9;
        c.updateProjectionMatrix();
        c.position.set(cam[0], cam[1], cam[2]);
        c.lookAt(look[0], look[1], look[2]);
        c.updateMatrixWorld(true);
        // refresh the grass distance cull for THIS pose before drawing
        g.grass?.update(0, c.position);
        if (r.toneMapping === 0 && g.postfx) {
          g.postfx.setSize(1280, 720);
          g.postfx.render(1 / 60);
          g.postfx.render(1 / 60);
        } else {
          r.render(g.scene, c);
        }
        return r.domElement.toDataURL('image/png');
      }, pose);
      const outFile = path.join(outDir, `grass-${name}.png`);
      writeFileSync(outFile, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
      console.log(`shot ${path.relative(root, outFile)}`);
    }
  }
} catch (e) {
  console.error(e.stack || e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
