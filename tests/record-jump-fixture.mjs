// Records the junction main-ramp jump fixture: launch from the start line,
// hold throttle + boost straight down the lane (x=2.3) — the run crosses the
// main ramp at z −15.4..−8.6 at ~full boost and goes ballistic over the
// junction. Captured as a replay report and written to tests/replays/, where
// the manifest asserts the jump reaches real air (assertMin) without
// catapulting (assert) and pins determinism (checksums: require).
//
// Re-run this after a deliberate physics change to re-record the fixture:
//   node tests/record-jump-fixture.mjs

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5176;
const OUT = path.join(root, 'tests', 'replays', 'junction-main-ramp-jump.json');

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
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game, { timeout: 30_000 });
  await page.evaluate(() => {
    const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
    // capture clock runs on SIM time (slow software renderers fall behind
    // real time, which would slide the capture point along the run)
    window.__done = false;
    let t0 = null;
    window.__game.onStep = (g) => {
      if (t0 === null) t0 = g.simTime;
      if (g.simTime - t0 >= 5.3) window.__done = true;
    };
    k('keydown', 'Space'); // launch + boost, held the whole run
    k('keydown', 'ArrowUp');
  });
  // spawn z=-120 → ramp at z≈-15 (~3.7 s) → ballistic over the junction →
  // capture right after the landing, before the downrange traffic (a crash
  // there would mix legitimate wreck-fling stats into the jump assertions)
  await page.waitForFunction(() => window.__done, { timeout: 180_000, polling: 250 });
  const file = await page.evaluate(() => {
    const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
    k('keyup', 'Space');
    k('keyup', 'ArrowUp');
    return window.__game.captureReport('fixture: straight boost run over the junction main ramp');
  });
  writeFileSync(OUT, JSON.stringify(file));
  console.log(`recorded ${file.dts.length} frames, ${file.checksums.length} checksums → ${OUT}`);
  console.log('snapshot player:', JSON.stringify(file.snapshot.actors.find((a) => a.isPlayer)?.body.p));
  await browser.close();
} finally {
  vite.kill();
}
