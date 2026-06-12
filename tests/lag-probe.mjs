// Headless lag-spike probe: boots the dev server, opens the junction level
// (crash mode), sets time-of-day + gfx tier, drives a short run that wrecks
// traffic, fires sandbox explosions (B), and prints what the in-game
// lag-spike tracker (src/game/perf.ts) recorded: rolling median frame time,
// every captured spike (wall ms vs median, shader-compile count, program /
// light-count deltas, event tags) and the tag timeline around them.
//
// Swiftshader note: software GL exaggerates shader-compile cost — good for
// DETECTING recompile storms, but judge spikes relative to the median, not
// by absolute ms.
//
// This is a diagnostic, not a pass/fail gate — it exits non-zero only on
// script/page failure.
//
// Usage: node tests/lag-probe.mjs [--day|--dusk] [--fast] [--port N]
//   default: night + cine. A/B the four-way matrix with --day / --fast.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const TOD = args.includes('--day') ? 'day' : args.includes('--dusk') ? 'dusk' : 'night';
const GFX = args.includes('--fast') ? 'fast' : 'cine';
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.LAG_PORT ?? 5199);

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

/** Wait until the tracker has advanced `n` more frames (works at any FPS). */
async function waitFrames(page, n, timeout = 240_000) {
  const start = await page.evaluate(() => window.__game.perf.frameId);
  await page.waitForFunction((target) => window.__game.perf.frameId >= target, { timeout, polling: 250 }, start + n);
}

async function waitSimSeconds(page, s, timeout = 240_000) {
  const start = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((target) => window.__game.simTime >= target, { timeout, polling: 250 }, start + s);
}

const key = (code, type) => `window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' }))`;

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
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30_000, polling: 250 });
    await sleep(2000); // models stream in async — let the junction dress up

    const vis = await page.evaluate(() => document.visibilityState);
    console.log(`lag-probe: tod=${TOD} gfx=${GFX} port=${PORT} visibility=${vis}`);

    await page.evaluate(
      (tod, gfx) => {
        window.__game.setTimeOfDay(tod);
        window.__game.setGfx(gfx);
      },
      TOD,
      GFX,
    );
    // the relight/tier flip recompiles once by design; let that storm pass
    // and refill the spike detector's median window before measuring
    await waitFrames(page, 45);

    // launch + throttle: ram the junction traffic so wrecks (and the tanker
    // fuse) happen — the user's "crash mode at night" repro
    await page.evaluate(`${key('Space', 'keydown')}; setTimeout(() => ${key('Space', 'keyup')}, 200); ${key('ArrowUp', 'keydown')}`);
    await waitSimSeconds(page, 4);
    await page.evaluate(key('ArrowUp', 'keyup'));

    // three sandbox explosions (B = deterministic command path), spaced out
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`${key('KeyB', 'keydown')}; ${key('KeyB', 'keyup')}`);
      await waitSimSeconds(page, 0.8);
    }
    await waitFrames(page, 15); // spike windows finalize 10 frames after detection

    const out = await page.evaluate(() => {
      const r = window.__game.perfReport();
      return {
        median: r.medianWallMs,
        frames: r.frameId,
        spikes: window.__lagSpikes,
        tagged: r.frames.filter((f) => f.tags.length).map((f) => ({ id: f.id, wall: +f.wall.toFixed(1), tags: f.tags })),
      };
    });

    console.log(`\n==== lag probe: ${TOD} + ${GFX} — ${out.frames} frames, median wall ${out.median}ms ====`);
    console.log(`spikes captured: ${out.spikes.length}`);
    for (const s of out.spikes) {
      console.log(
        `\nSPIKE @ frame ${s.frameId}: wall ${s.wallMs}ms work ${s.workMs}ms = ${s.ratio}x median (${s.medianMs}ms)` +
          (s.followOnFrames ? `  (+${s.followOnFrames} follow-on spike frames)` : ''),
      );
      console.log(`  sections: sim ${s.simMs}ms cube ${s.cubeMs}ms post ${s.postMs}ms`);
      console.log(
        `  compiles +${s.compiles}  programs ${s.programs.before}->${s.programs.after}` +
          `  lights ${s.lights.before}->${s.lights.after}` +
          `  geom ${s.geometries.before}->${s.geometries.after}  tex ${s.textures.before}->${s.textures.after}`,
      );
      console.log(`  tags: [${s.tags.join(', ')}]  state: ${JSON.stringify(s.state)}`);
      const near = s.window.filter((f) => f.tags.length || f.id === s.frameId);
      for (const f of near) {
        console.log(`    f${f.id}${f.id === s.frameId ? ' *' : '  '} wall ${f.wall.toFixed(0)}ms compiles@${f.maxProgramId} lights ${f.lights} [${f.tags.join(', ')}]`);
      }
    }
    console.log(`\ntag timeline (ring): ${out.tagged.map((t) => `f${t.id}:${t.tags.join('+')}(${t.wall}ms)`).join('  ') || 'none'}`);
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
console.log(failed ? '\nlag-probe FAILED (script error)' : '\nlag-probe done');
process.exit(failed ? 1 : 0);
