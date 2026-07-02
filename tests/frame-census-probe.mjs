// Frame census probe (regression bisect): boots a level on the CURRENT
// checkout, lets it warm up, then reports wall/sim/cube/post medians+p95 from
// the perf ring (180 frames), draw calls, triangles, programs, meshes — for an
// idle phase and a driving phase. Deterministic-ish scenario so numbers are
// comparable ACROSS COMMITS on the same machine (SwiftShader: absolute GPU ms
// is inflated; compare deltas, and trust calls/tris absolutely).
//
// Usage: node tests/frame-census-probe.mjs [--root <repo>] --level <id> [--port N] [--label X]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5217;
const levelFlag = args.indexOf('--level');
const LEVEL = levelFlag >= 0 ? args[levelFlag + 1] : 'junction';
const labelFlag = args.indexOf('--label');
const LABEL = labelFlag >= 0 ? args[labelFlag + 1] : 'run';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startVite() {
  const proc = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}
async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('no server');
}
async function launchBrowser() {
  const candidates = [
    { channel: 'chrome' }, { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const t of candidates) {
    try { return await puppeteer.launch({ ...t, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); } catch {}
  }
  throw new Error('no browser');
}

const key = (code, type) => `window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' }))`;
async function waitSimSeconds(page, s, timeout = 240_000) {
  const start = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((t) => window.__game.simTime >= t, { timeout, polling: 250 }, start + s);
}

async function census(page) {
  return page.evaluate(() => {
    const g = window.__game;
    const r = g.perfReport();
    const q = (arr, p) => {
      const a = [...arr].sort((x, y) => x - y);
      return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
    };
    const wall = r.frames.map((f) => f.wall);
    const sim = r.frames.map((f) => f.sim);
    const cube = r.frames.map((f) => f.cube ?? 0);
    const post = r.frames.map((f) => f.post ?? 0);
    let meshes = 0;
    g.scene.traverse((o) => { if (o.isMesh || o.isInstancedMesh) meshes++; });
    const info = g.renderer.info;
    const world = g.phys.world;
    let awake = 0;
    for (const b of world.bodies) if ((b.type & 2) === 0 && b.sleepState !== 2) awake++;
    return {
      ringFrames: r.frames.length,
      wall: { p50: q(wall, 0.5), p95: q(wall, 0.95) },
      sim: { p50: q(sim, 0.5), p95: q(sim, 0.95) },
      cube: { p50: q(cube, 0.5), p95: q(cube, 0.95) },
      post: { p50: q(post, 0.5), p95: q(post, 0.95) },
      calls: info.render.calls, tris: info.render.triangles,
      programs: info.programs.length, meshes,
      bodies: world.bodies.length, awake,
    };
  });
}

const fmt = (c) =>
  `wall p50 ${c.wall.p50.toFixed(1)} p95 ${c.wall.p95.toFixed(1)} | sim p50 ${c.sim.p50.toFixed(2)} p95 ${c.sim.p95.toFixed(2)} | ` +
  `cube p50 ${c.cube.p50.toFixed(1)} | post p50 ${c.post.p50.toFixed(1)} | calls ${c.calls} tris ${(c.tris / 1000).toFixed(0)}k ` +
  `progs ${c.programs} meshes ${c.meshes} | bodies ${c.bodies} awake ${c.awake}`;

const vite = startVite();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    page.on('pageerror', (e) => { failed = true; console.error(`PAGE ERROR: ${e.message}`); });
    await page.goto(`http://localhost:${PORT}/?level=${LEVEL}&launch=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30_000, polling: 250 });
    await sleep(3000); // async model streaming
    await page.evaluate(() => window.__game.setTimeOfDay('day'));
    await waitSimSeconds(page, 8); // warmup + fill the ring past the relight storm

    const idle = await census(page);
    console.log(`[${LABEL}] ${LEVEL} idle    ${fmt(idle)}`);

    // driving phase: launch + hold throttle
    await page.evaluate(`${key('Space', 'keydown')}; setTimeout(() => ${key('Space', 'keyup')}, 200); ${key('ArrowUp', 'keydown')}`);
    await waitSimSeconds(page, 8);
    const driving = await census(page);
    await page.evaluate(key('ArrowUp', 'keyup'));
    console.log(`[${LABEL}] ${LEVEL} driving ${fmt(driving)}`);
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
