// CPU hotspot probe: boots a level, drives the lag-probe scenario, and records
// a V8 sampling profile (CDP Profiler) over ~20s of gameplay. Prints the top
// functions by SELF time, aggregated by function name + script. This is the
// honest "where does the main thread actually go" readout for picking CPU
// optimizations. SwiftShader note: GL calls burn CPU in-process here, so
// WebGL-related C++/GL time shows up as renderer JS self time — still useful
// for ranking JS-side work; ignore anything living in swiftshader frames.
//
// Usage: node tests/cpu-profile-probe.mjs [--root <repo>] [--level id] [--port N] [--gfx cine|fast]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5223;
const levelFlag = args.indexOf('--level');
const LEVEL = levelFlag >= 0 ? args[levelFlag + 1] : 'gantry';
const gfxFlag = args.indexOf('--gfx');
const GFX = gfxFlag >= 0 ? args[gfxFlag + 1] : 'cine';
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
    await sleep(3000);
    await page.evaluate((g) => window.__game.setGfx(g), GFX);
    await waitSimSeconds(page, 5); // warm

    const client = await page.createCDPSession();
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: 200 }); // µs
    await client.send('Profiler.start');

    // scenario: launch, drive, explode, keep driving
    await page.evaluate(`${key('Space', 'keydown')}; setTimeout(() => ${key('Space', 'keyup')}, 200); ${key('ArrowUp', 'keydown')}`);
    await waitSimSeconds(page, 6);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(`${key('KeyB', 'keydown')}; ${key('KeyB', 'keyup')}`);
      await waitSimSeconds(page, 1);
    }
    await waitSimSeconds(page, 8);
    await page.evaluate(key('ArrowUp', 'keyup'));

    const { profile } = await client.send('Profiler.stop');

    // aggregate self time per node (name@url:line), and per file
    const totalUs = profile.endTime - profile.startTime;
    const hitTime = {}; // nodeId -> samples
    for (const id of profile.samples) hitTime[id] = (hitTime[id] ?? 0) + 1;
    const nSamples = profile.samples.length;
    const byFn = new Map();
    const byFile = new Map();
    for (const node of profile.nodes) {
      const hits = hitTime[node.id] ?? 0;
      if (!hits) continue;
      const cf = node.callFrame;
      const url = (cf.url || '').replace(/^.*\/node_modules\//, 'nm:').replace(/^https?:\/\/[^/]+/, '');
      const fn = `${cf.functionName || '(anon)'}  ${url}:${cf.lineNumber + 1}`;
      byFn.set(fn, (byFn.get(fn) ?? 0) + hits);
      const file = url || '(native/unknown)';
      byFile.set(file, (byFile.get(file) ?? 0) + hits);
    }
    const ms = (hits) => ((hits / nSamples) * totalUs / 1000).toFixed(0);
    const pct = (hits) => ((hits / nSamples) * 100).toFixed(1);
    console.log(`\n==== CPU profile: ${LEVEL} ${GFX} — ${(totalUs / 1e6).toFixed(1)}s wall, ${nSamples} samples ====`);
    console.log('\n-- top 30 functions by self time --');
    [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
      .forEach(([k, v]) => console.log(`${pct(v).padStart(5)}%  ${ms(v).padStart(6)}ms  ${k}`));
    console.log('\n-- top 15 files by self time --');
    [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .forEach(([k, v]) => console.log(`${pct(v).padStart(5)}%  ${ms(v).padStart(6)}ms  ${k}`));
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
