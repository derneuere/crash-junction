// Multi-pose draw-call + triangle probe (perf-geo). Boots GANTRY POINT, day,
// cine, lets props stream, then for each canonical pose freezes the camera,
// renders, and reads renderer.info.render.{calls,triangles} for BOTH the main
// frame and a full cube capture (the ×6 reflection where chunking pays). Pure
// rendering; never records a fixture. Usage: node tests/drawcall-poses.mjs [--port N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5199;
const wallFlag = args.indexOf('--wall');
const WALL = wallFlag >= 0 ? Number(args[wallFlag + 1]) : 0; // 0 = use code default
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// poses: cam + look. dockyard/harbor match harbor-probe vantage; the straights
// look down the lap so most of the chained walls fall behind/beside the camera
// (where chunking lets frustum culling drop them).
const POSES = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  // a chase-cam-height pose looking down the start straight (most of the lap
  // is behind/beside -> culled when walls are chunked)
  straight: { cam: [-30, 3.0, -226], look: [120, 1.0, -222] },
  // a low on-track pose mid-lap aimed along the road
  ontrack: { cam: [200, 3.0, 0], look: [240, 1.0, 60] },
};

function startVite() {
  const proc = spawn(process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {} await sleep(200); }
  throw new Error('no server');
}
async function launchBrowser() {
  for (const target of [{ channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); } catch {}
  }
  throw new Error('no browser');
}

const vite = startVite();
try {
  await waitForServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  await page.evaluateOnNewDocument((wall) => {
    localStorage.setItem('cj-sel', JSON.stringify({ level: 'gantry', tod: 'day', perEvent: {} }));
    localStorage.setItem('cj-tod', 'day');
    localStorage.setItem('cj-gfx', 'cine');
    if (wall) window.__WALL_CHUNK = wall;
  }, WALL);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4500);
  const out = await page.evaluate((POSES) => {
    const g = window.__game;
    const r = g.renderer;
    const c = g.camera;
    g.director.update = () => {};
    r.setPixelRatio(1);
    r.setSize(1280, 720, false);
    c.aspect = 16 / 9;
    c.updateProjectionMatrix();
    const info = r.info;
    info.autoReset = false;
    const results = {};
    // a 90° FOV cube-face camera to emulate the reflection probe's per-face cost
    // (reuse the game camera's PerspectiveCamera class — THREE isn't on window)
    const PerspCam = c.constructor;
    const cube = new PerspCam(90, 1, 0.5, 800);
    const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    for (const [name, p] of Object.entries(POSES)) {
      c.position.set(p.cam[0], p.cam[1], p.cam[2]);
      c.lookAt(p.look[0], p.look[1], p.look[2]);
      c.updateMatrixWorld();
      // MAIN frame draw calls
      info.reset();
      r.render(g.scene, c);
      const main = { calls: info.render.calls, tris: info.render.triangles };
      // CUBE: 6 faces from the player position (~mid-track), summed — this is
      // where chunking pays (each face sees ~1/6 of the loop)
      cube.position.set(p.cam[0], Math.max(2, p.cam[1] * 0.4), p.cam[2]);
      let cCalls = 0, cTris = 0;
      info.reset();
      for (const d of DIRS) {
        cube.lookAt(cube.position.x + d[0], cube.position.y + d[1], cube.position.z + d[2]);
        cube.updateMatrixWorld();
        r.render(g.scene, cube);
      }
      cCalls = info.render.calls; cTris = info.render.triangles;
      results[name] = { main, cube: { calls: cCalls, tris: cTris } };
    }
    // decompose VISIBLE draw sources at the dockyard pose: count meshes/instanced
    // that pass a frustum test, grouped by name prefix, to size the real env slice
    c.position.set(POSES.dockyard.cam[0], POSES.dockyard.cam[1], POSES.dockyard.cam[2]);
    c.lookAt(POSES.dockyard.look[0], POSES.dockyard.look[1], POSES.dockyard.look[2]);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    const Frustum = c.constructor; // not used; build frustum from matrices below
    const proj = c.projectionMatrix.clone().multiply(c.matrixWorldInverse);
    // crude frustum: use three's Frustum via the renderer? simpler — bounding
    // sphere center-in-front + within a generous radius isn't a real cull. Skip.
    const bySource = {};
    g.scene.traverse((o) => {
      if (!o.visible) return;
      if (!o.isMesh && !o.isInstancedMesh) return;
      const nm = (o.name || o.material?.name || (Array.isArray(o.material) ? 'multi' : o.material?.type) || 'plain');
      const key = nm.startsWith('cj-') ? nm : (o.isInstancedMesh ? 'other-instanced' : 'other-plain');
      bySource[key] = (bySource[key] || 0) + 1;
    });
    return { results, bySource };
  }, POSES);
  console.log(`\n=== DRAW-CALL by POSE (gantry day cine, WALL_CHUNK=${WALL || 'default'}) ===`);
  let sumMain = 0, sumCube = 0;
  for (const [name, e] of Object.entries(out.results)) {
    sumMain += e.main.calls; sumCube += e.cube.calls;
    console.log(`  ${name.padEnd(10)} MAIN calls=${String(e.main.calls).padStart(5)} tris=${String(e.main.tris.toLocaleString()).padStart(11)}   CUBE(6f) calls=${String(e.cube.calls).padStart(5)} tris=${e.cube.tris.toLocaleString()}`);
  }
  console.log(`  TOTAL main calls=${sumMain}  cube(6f) calls=${sumCube}`);
  console.log(`=== SCENE OBJECT COUNT by source (all, not culled) ===`);
  for (const [k, n] of Object.entries(out.bySource).sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${k}`);
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
