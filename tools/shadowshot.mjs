// Chase-cam shadow verification harness (perf-gpu). The fixed refshot poses
// are wide establishing shots that DON'T exercise the follow-player shadow rig
// (its box centres on the idle player at the spawn ~200 m away), so they can't
// show whether a shadow-rig change altered the look. This harness teleports
// the player into the dockyard apron (sun-lit buildings + containers), lets the
// chase cam settle behind the car, and captures ONE composed frame from the
// gameplay chase view — exactly where directional shadows read on screen.
//
// RENDERING-ONLY: writes only body position (camera framing), never records a
// fixture — determinism untouched, same contract as harbor-probe.mjs.
//
//   fnm exec --using=22 -- node tools/shadowshot.mjs --port <port> [--tod day|dusk|night] [--tag before|after]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5188;
const todIdx = args.indexOf('--tod');
const TOD = todIdx >= 0 ? args[todIdx + 1] : 'day';
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : 'shadow';

// dockyard apron: a container/warehouse spot the sun rakes across so the
// follow-shadow box has crisp ground shadows to cast.
const DOCK_X = 200;
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
      return await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
    } catch (e) {
      errors.push(`${target.channel ?? target.executablePath}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome or Edge found for puppeteer-core:\n${errors.join('\n')}`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function waitFrames(page, n, timeout = 120_000) {
  const start = await page.evaluate(() => window.__game.perf.frameId);
  await page.waitForFunction((t) => window.__game.perf.frameId >= t, { timeout, polling: 250 }, start + n);
}

const vite = startVite();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => { failed = true; console.error(`PAGE ERROR: ${e.message}`); });
    await page.evaluateOnNewDocument((tod) => {
      localStorage.setItem('cj-sel', JSON.stringify({ level: 'gantry', tod, perEvent: {} }));
      localStorage.setItem('cj-tod', tod);
      localStorage.setItem('cj-gfx', 'cine');
    }, TOD);
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30_000, polling: 250 });
    await sleep(4000); // GLB props stream in

    await page.evaluate((tod) => { window.__game.setTimeOfDay(tod); window.__game.setGfx('cine'); }, TOD);
    await waitFrames(page, 40);

    // teleport into the dockyard so the follow-shadow box has buildings to
    // shadow, and let the chase cam settle behind the car
    await page.evaluate((x, z) => {
      const p = window.__game.__debugPlayer();
      if (!p) return;
      p.body.position.set(x, 1.0, z);
      p.body.velocity.set(0, 0, 0);
      p.body.angularVelocity.set(0, 0, 0);
      p.body.wakeUp();
    }, DOCK_X, DOCK_Z);
    await waitFrames(page, 90);

    const dataUrl = await page.evaluate(({ x, z }) => {
      const g = window.__game;
      const r = g.renderer;
      const c = g.camera;
      // Freeze the director and frame the teleported car from a fixed,
      // chase-like offset so the player + the follow-shadow box's ground
      // shadows fill the lower frame. updateShadowRig still centres the box on
      // the player each loop, so this is exactly the rig under gameplay.
      g.director.update = () => {};
      const p = g.__debugPlayer();
      const px = p ? p.body.position.x : x;
      const py = p ? p.body.position.y : 1;
      const pz = p ? p.body.position.z : z;
      r.setPixelRatio(1);
      r.setSize(1280, 720, false);
      c.aspect = 1280 / 720;
      // low, close chase vantage: ~9 m back along -x, 4 m up, look at the car
      c.position.set(px - 9, py + 4, pz - 2);
      c.lookAt(px + 6, py + 0.5, pz + 1);
      c.updateProjectionMatrix();
      c.updateMatrixWorld();
      if (g.skyRig) g.skyRig.renderClouds(r, c);
      if (r.toneMapping === 0 && g.postfx) {
        g.postfx.setSize(1280, 720);
        g.postfx.render(1 / 60);
        g.postfx.render(1 / 60);
      } else {
        r.render(g.scene, c);
      }
      return r.domElement.toDataURL('image/png');
    }, { x: DOCK_X, z: DOCK_Z });

    const outDir = path.join(root, 'screenshots', 'gantry-point');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `${TAG}-chase-${TOD}.png`);
    writeFileSync(outFile, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    console.log(`wrote ${path.relative(root, outFile)} (chase ${TOD})`);
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.stack || e.message);
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
