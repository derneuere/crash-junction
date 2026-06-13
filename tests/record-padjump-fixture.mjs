// Records the PROVING GROUND jump-line fixture: launch from (0,-60), swing
// right onto the x=48 lane and take both ramps straight. Practice mode has
// no traffic and no wreck state, so the take is a clean pin of "ramps give
// real, sane air" (manifest asserts altitude floor + ceiling) plus a
// determinism checksum pin.
//
// The steering timeline below was tuned against the trace this script
// prints; re-tune and re-record after deliberate handling changes:
//   node tests/record-padjump-fixture.mjs

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5176;
const OUT = path.join(root, 'tests', 'replays', 'pad-jump-line.json');

// [SIM ms, type, code] — the drive, tuned against the printed trace.
// Sim-time marks, not wall clock: on a slow software renderer the sim runs
// behind real time (the 50 ms frame clamp), so setTimeout-driven input
// lands on different sim frames per machine.
const TIMELINE = [
  [0, 'keydown', 'Space'],
  [0, 'keydown', 'ArrowUp'],
  [700, 'keyup', 'Space'], // short boost off the line, then grip steering
  [940, 'keydown', 'ArrowLeft'], // world +x is screen-left of the +z heading
  [1610, 'keyup', 'ArrowLeft'],
  [2700, 'keydown', 'Space'], // boost — cross ramp 2 on the diagonal
];
const CAPTURE_AT = 5800;

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  let browser;
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const target of candidates) {
    try {
      browser = await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
      break;
    } catch {
      // try the next candidate
    }
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  // FAST PATH (menu redesign): jump straight to PROVING GROUND (track) — the
  // menu flow no longer mounts a level while browsing, so we deep-link past it.
  await page.goto(`http://localhost:${PORT}/?level=track&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.levelId === 'track', { timeout: 30_000 });
  await page.evaluate((timeline, captureAt) => {
    const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
    window.__trace = [];
    window.__done = false;
    const pending = [...timeline];
    let t0 = null;
    window.__game.onStep = (g) => {
      if (t0 === null) t0 = g.simTime;
      const t = (g.simTime - t0) * 1000;
      while (pending.length && t >= pending[0][0]) {
        const [, type, code] = pending.shift();
        k(type, code);
      }
      if (t >= captureAt) window.__done = true;
      if (g.stepIndex % 30 !== 0) return;
      const b = g.player.body;
      window.__trace.push([+g.simTime.toFixed(2), +b.position.x.toFixed(1), +b.position.z.toFixed(1), +b.position.y.toFixed(2)]);
    };
  }, TIMELINE, CAPTURE_AT);
  await page.waitForFunction(() => window.__done, { timeout: 180_000, polling: 250 });
  const { file, trace } = await page.evaluate(() => {
    for (const code of ['Space', 'ArrowUp', 'ArrowLeft', 'ArrowRight']) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    }
    return { file: window.__game.captureReport('fixture: proving-ground jump line'), trace: window.__trace };
  });
  writeFileSync(OUT, JSON.stringify(file));
  console.log(`recorded ${file.dts.length} frames, ${file.checksums.length} checksums → ${OUT}`);
  console.log('trace [t, x, z, alt]:');
  for (const row of trace) console.log(' ', JSON.stringify(row));
  await browser.close();
} finally {
  vite.kill();
}
