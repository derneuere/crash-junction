// Headless HARBOR/DOCKYARD lag probe (perf-harbor). Boots the dev server,
// forces the GANTRY POINT level via the cj-sel localStorage contract BEFORE
// the page scripts run, teleports the player into the dockyard apron (the
// container-canyon / warehouse heart of the port), sets time-of-day + gfx
// tier, lets it settle, then reads the in-game lag tracker (src/game/perf.ts):
// median frame time, draw calls, shader-program high-water + per-frame
// compiles, visible-light count, and any captured spikes.
//
// This is the harbor-specific companion to lag-probe.mjs — same swiftshader
// caveat (judge spikes vs the median, not absolute ms), same "diagnostic, not
// a gate" exit policy. The teleport writes ONLY body position (presentation /
// camera framing) and runs OUTSIDE any recorded take — the probe never records
// a fixture — so determinism is untouched (RENDERING-ONLY contract).
//
// Usage: node tests/harbor-probe.mjs [--day|--dusk|--night] [--fast]
//                                    [--cube-every N] [--port N]
//   default: night + cine. A/B the matrix with --day / --dusk / --fast.
//   --cube-every 1 forces an every-frame cube capture (pre-throttle baseline);
//   the ship default is 2 (throttled) — pass it to A/B the reflection win.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const TOD = args.includes('--day') ? 'day' : args.includes('--dusk') ? 'dusk' : args.includes('--night') ? 'night' : 'night';
const GFX = args.includes('--fast') ? 'fast' : 'cine';
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.HARBOR_PORT ?? 5198);
// cube-reflection refresh interval override (1 = every frame = pre-throttle
// baseline; 2 = the shipped throttle). Lets one session A/B the win.
const cubeFlag = args.indexOf('--cube-every');
const CUBE_EVERY = cubeFlag >= 0 ? Number(args[cubeFlag + 1]) : null;

// dockyard heart: the container canyon / warehouse apron (zone x[60,270]
// z[-105,135]); a spot ringed by stacks, sheds, cranes and floodlight masts.
const DOCK_X = 180;
const DOCK_Z = 0;

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
  for (let i = 0; i < 100; i++) {
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitFrames(page, n, timeout = 240_000) {
  const start = await page.evaluate(() => window.__game.perf.frameId);
  await page.waitForFunction((target) => window.__game.perf.frameId >= target, { timeout, polling: 250 }, start + n);
}

/** Median + percentiles + mean of the recent ring window for a numeric frame
 *  field. Mean matters for throttled work (a cube captured every other frame
 *  has a bimodal 0/cost distribution the median misreads). */
function stat(frames, pick) {
  const v = frames.map(pick).filter((x) => x >= 0).sort((a, b) => a - b);
  if (!v.length) return { med: 0, max: 0, p95: 0, mean: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    med: v[v.length >> 1],
    max: v[v.length - 1],
    p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))],
    mean,
  };
}

const vite = startVite();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    page.on('pageerror', (e) => {
      failed = true;
      console.error(`PAGE ERROR: ${e.message}`);
    });
    // force GANTRY POINT before any app code runs (cj-sel contract, storage.ts)
    await page.evaluateOnNewDocument((tod) => {
      localStorage.setItem('cj-sel', JSON.stringify({ level: 'gantry', tod, perEvent: {} }));
      localStorage.setItem('cj-tod', tod);
      localStorage.setItem('cj-gfx', 'cine');
    }, TOD);

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30_000, polling: 250 });
    await sleep(3500); // GLB props stream in async — let the whole port dress up

    const vis = await page.evaluate(() => document.visibilityState);
    const lvl = await page.evaluate(() => window.__game.perfReport().frames.at(-1) && window.__game.perf.frameId, {});
    console.log(`harbor-probe: tod=${TOD} gfx=${GFX} port=${PORT} visibility=${vis}`);

    await page.evaluate(
      (tod, gfx, cubeEvery) => {
        window.__game.setTimeOfDay(tod);
        window.__game.setGfx(gfx);
        if (cubeEvery != null && window.__game.setCubeEvery) window.__game.setCubeEvery(cubeEvery);
      },
      TOD,
      GFX,
      CUBE_EVERY,
    );
    // let the relight/tier flip's by-design recompile storm pass and the
    // median window refill before measuring
    await waitFrames(page, 50);

    // teleport the player into the dockyard apron so the camera frames the
    // container canyon / warehouses / cranes — RENDERING-ONLY, never recorded
    await page.evaluate(
      (x, z) => {
        const p = window.__game.__debugPlayer();
        if (!p) return;
        p.body.position.set(x, 1.0, z);
        p.body.velocity.set(0, 0, 0);
        p.body.angularVelocity.set(0, 0, 0);
        p.body.wakeUp();
      },
      DOCK_X,
      DOCK_Z,
    );
    await waitFrames(page, 120); // settle the camera over the port + fill the ring

    const out = await page.evaluate(() => {
      const r = window.__game.perfReport();
      return {
        median: r.medianWallMs,
        frames: r.frameId,
        spikes: window.__lagSpikes,
        ring: r.frames.map((f) => ({
          wall: f.wall, post: f.post, cube: f.cube, sim: f.sim,
          calls: f.calls, tris: f.triangles, progs: f.programs, maxProg: f.maxProgramId,
          lights: f.lights, geos: f.geometries, texs: f.textures,
        })),
      };
    });

    const r = out.ring;
    const wall = stat(r, (f) => f.wall);
    const post = stat(r, (f) => f.post);
    const cube = stat(r, (f) => f.cube);
    const calls = stat(r, (f) => f.calls);
    const tris = stat(r, (f) => f.tris);
    const lights = stat(r, (f) => f.lights);
    const last = r.at(-1) ?? {};
    // compiles across the measured window = maxProgramId growth
    const progFrames = r.filter((f) => f.maxProg > 0);
    const compiles = progFrames.length ? progFrames.at(-1).maxProg - progFrames[0].maxProg : 0;

    const cubeActive = r.filter((f) => f.cube > 0.01).length;
    console.log(`\n==== HARBOR probe: ${TOD} + ${GFX}${CUBE_EVERY != null ? ` cubeEvery=${CUBE_EVERY}` : ''} — ${out.frames} frames ====`);
    console.log(`  wall  ms : mean ${wall.mean.toFixed(1)}  median ${wall.med.toFixed(1)}  p95 ${wall.p95.toFixed(1)}  max ${wall.max.toFixed(1)}`);
    console.log(`  post  ms : mean ${post.mean.toFixed(1)}  median ${post.med.toFixed(1)}  p95 ${post.p95.toFixed(1)}`);
    console.log(`  cube  ms : mean ${cube.mean.toFixed(1)}  median ${cube.med.toFixed(1)}  (active on ${cubeActive}/${r.length} frames)`);
    console.log(`  draw calls: median ${calls.med}  max ${calls.max}`);
    console.log(`  triangles : median ${tris.med}  max ${tris.max}`);
    console.log(`  programs  : ${last.progs}   maxProgramId ${last.maxProg}   compiles over window: +${compiles}`);
    console.log(`  lights    : median ${lights.med}  max ${lights.max}`);
    console.log(`  geometries: ${last.geos}   textures: ${last.texs}`);
    console.log(`  spikes captured: ${out.spikes.length}`);
    for (const s of out.spikes) {
      console.log(
        `   SPIKE @${s.frameId}: wall ${s.wallMs}ms = ${s.ratio}x  sim ${s.simMs} cube ${s.cubeMs} post ${s.postMs}` +
          `  compiles +${s.compiles}  progs ${s.programs.before}->${s.programs.after}  lights ${s.lights.before}->${s.lights.after}` +
          `  tags [${s.tags.join(', ')}]`,
      );
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.stack || e.message);
} finally {
  vite.kill();
}
console.log(failed ? '\nharbor-probe FAILED (script error)' : '\nharbor-probe done');
process.exit(failed ? 1 : 0);
