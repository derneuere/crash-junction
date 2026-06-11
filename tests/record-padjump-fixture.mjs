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

// [ms, type, code] — the drive, tuned against the printed trace
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
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await puppeteer.launch({ channel, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
      break;
    } catch {
      // try the next channel
    }
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game, { timeout: 30_000 });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.levels button')].find((b) => b.textContent.includes('PROVING'));
    btn.click();
  });
  await page.waitForFunction(() => !!window.__game, { timeout: 30_000 });
  await page.evaluate((timeline) => {
    const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
    window.__trace = [];
    window.__game.onStep = (g) => {
      if (g.stepIndex % 30 !== 0) return;
      const b = g.player.body;
      window.__trace.push([+g.simTime.toFixed(2), +b.position.x.toFixed(1), +b.position.z.toFixed(1), +b.position.y.toFixed(2)]);
    };
    for (const [ms, type, code] of timeline) setTimeout(() => k(type, code), ms);
  }, TIMELINE);
  await new Promise((r) => setTimeout(r, CAPTURE_AT));
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
