// Height-LOD A/B probe (perf-heightlod). Boots GANTRY POINT day/cine, lets the
// props stream, then for each canonical pose: forces the ladder FULL (a huge
// viewport makes every projected height enormous -> every entry level 0),
// measures main-frame + 6-face-cube draw calls/triangles, then walks the
// ladder at a real 720 px viewport from the SAME camera and measures again.
// The delta is exactly what the height-LOD saves at that vantage. Pure
// rendering; never records a fixture. Usage: node tests/heightlod-probe.mjs [--port N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5198;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// same vantages as drawcall-poses.mjs so numbers are comparable across probes
const POSES = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  straight: { cam: [-30, 3.0, -226], look: [120, 1.0, -222] },
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
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4500); // let the prop GLBs stream + flush into the batcher
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
    const lod = g.propLod; // TS-private, runtime-reachable (dev probe only)
    const PerspCam = c.constructor;
    const cube = new PerspCam(90, 1, 0.5, 800);
    const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const measure = () => {
      info.reset();
      r.render(g.scene, c);
      const main = { calls: info.render.calls, tris: info.render.triangles };
      cube.position.set(c.position.x, Math.max(2, c.position.y * 0.4), c.position.z);
      info.reset();
      for (const d of DIRS) {
        cube.lookAt(cube.position.x + d[0], cube.position.y + d[1], cube.position.z + d[2]);
        cube.updateMatrixWorld();
        r.render(g.scene, cube);
      }
      return { main, cube: { calls: info.render.calls, tris: info.render.triangles } };
    };
    const results = {};
    for (const [name, p] of Object.entries(POSES)) {
      c.position.set(p.cam[0], p.cam[1], p.cam[2]);
      c.lookAt(p.look[0], p.look[1], p.look[2]);
      c.updateMatrixWorld();
      // OFF: a huge viewport height makes every projected height enormous, so
      // the ladder walks every entry back to level 0 (full render+shadows)
      lod.update(c, 1e9);
      const off = measure();
      // ON: the real ladder at a 720 px viewport from the same camera
      lod.update(c, 720);
      const on = measure();
      results[name] = { off, on, stats: g.lodStats() };
    }
    return { results, total: g.lodStats().total };
  }, POSES);
  console.log(`\n=== HEIGHT-LOD A/B by POSE (gantry day cine, ${out.total} targets) ===`);
  for (const [name, e] of Object.entries(out.results)) {
    const pct = (a, b) => (b === 0 ? '0%' : `${(((b - a) / b) * 100).toFixed(0)}%`);
    console.log(`  ${name.padEnd(10)} MAIN ${e.off.main.calls}->${e.on.main.calls} calls (-${pct(e.on.main.calls, e.off.main.calls)}), ${e.off.main.tris.toLocaleString()}->${e.on.main.tris.toLocaleString()} tris` +
      `   CUBE(6f) ${e.off.cube.calls}->${e.on.cube.calls} calls   ladder: ${e.stats.noShadow} no-shadow, ${e.stats.hidden} hidden`);
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
