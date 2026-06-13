// Boost-system verification probe (feat-boost). Boots the junction level
// headless, drives the player with scripted inputs by writing window.__game
// keys, and reads window.__game.control to measure the new boost economy:
//   A) engine-only CRUISE top speed vs boosted/Burnout top speed (tiers)
//   B) the EARN rate from drifting (boost is no longer free)
//   C) the takedown bar EXTENSION (segments 1→4) + instant refill
// Pure read-out — never records a tape, so it can't pollute a fixture.
//
//   node tests/boost-probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REPLAY_PORT ?? 5188);

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { await sleep(200); }
  }
  let browser;
  for (const target of [
    { channel: 'chrome' }, { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ]) {
    try { browser = await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); break; } catch {}
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  await page.goto(`http://localhost:${PORT}/?verify=1`, { waitUntil: 'load' });
  // wait for the game handle
  await page.waitForFunction(() => !!window.__game, { timeout: 15000 });

  // Helper: set the sim key mask the game reads, advance N fixed steps via
  // its own loop by faking key state + letting rAF/timeout drive. We instead
  // drive the sim directly with a deterministic fixed-step pump.
  const run = async (keys, steps) => {
    return await page.evaluate((keys, steps) => {
      const g = window.__game;
      g.launch(); // no-op if already launched
      // drive: write simKeys directly and pump fixed steps through advance()
      const dt = 1 / 120;
      for (let i = 0; i < steps; i++) {
        g.simKeys = { ...keys };
        // advance one fixed step worth of sim time
        g.advance(dt, false, []);
      }
      const c = g.control;
      return {
        speed: +c.speed.toFixed(2),
        boostMeter: +c.boostMeter.toFixed(3),
        boostCap: +c.boostCap.toFixed(3),
        segments: c.boostSegments,
        boosting: c.boosting,
        burnout: c.burnout,
        chain: c.burnoutChain,
        gear: c.gear,
      };
    }, keys, steps);
  };

  const out = {};

  // --- ensure launched ---
  await page.evaluate(() => { const g = window.__game; g.launch(); });

  // A) engine-only cruise: throttle, no boost, from rest for 6 s
  out.cruise = await run({ ArrowUp: true }, 720);

  // B) regular boost ceiling: keep the bar topped (so it never tips into a
  // Burnout — we clamp just under full), boost on a long straight, read the
  // ceiling it settles at
  await page.evaluate(() => { const g = window.__game; g.reset(); g.launch(); });
  const boostTier = await page.evaluate(() => {
    const g = window.__game; const c = g.control; const dt = 1 / 120;
    for (let i = 0; i < 600; i++) {
      c.boostMeter = c.boostCap * 0.9; // kept fed but below the Burnout arm
      g.simKeys = { ArrowUp: true, Space: true };
      g.advance(dt, false, []);
    }
    return { speed: +c.speed.toFixed(2), boosting: c.boosting, burnout: c.burnout, gear: c.gear };
  });
  out.boostTier = boostTier;

  // C) Burnout tier: keep the bar FULL so it tips into the sustained Burnout
  await page.evaluate(() => { const g = window.__game; g.reset(); g.launch(); });
  const burn = await page.evaluate(() => {
    const g = window.__game; const c = g.control; const dt = 1 / 120;
    let burnFrames = 0; let maxSpeed = 0; let maxChain = 0;
    for (let i = 0; i < 600; i++) {
      c.boostMeter = c.boostCap; // dangerous driving keeps it full → Burnout
      g.simKeys = { ArrowUp: true, Space: true };
      g.advance(dt, false, []);
      if (c.burnout) burnFrames++;
      maxSpeed = Math.max(maxSpeed, c.speed);
      maxChain = Math.max(maxChain, c.burnoutChain);
    }
    return { speed: +c.speed.toFixed(2), maxSpeed: +maxSpeed.toFixed(2), burnout: c.burnout, burnFrames, maxChain, gear: c.gear };
  });
  out.burnoutTier = burn;

  // D) drift earn rate: measure boostMeter gained per second while drifting
  await page.evaluate(() => { const g = window.__game; g.reset(); g.launch(); });
  const driftEarn = await page.evaluate(() => {
    const g = window.__game; const c = g.control; const dt = 1 / 120;
    // get up to speed first
    for (let i = 0; i < 240; i++) { g.simKeys = { ArrowUp: true }; g.advance(dt, false, []); }
    c.boostMeter = 0;
    const before = c.boostMeter;
    // tap-drift: brake + steer to enter a slide, hold for 1 s
    for (let i = 0; i < 120; i++) { g.simKeys = { ArrowUp: true, ArrowDown: true, ArrowLeft: true }; g.advance(dt, false, []); }
    return { drifting: c.drifting, gained: +(c.boostMeter - before).toFixed(3), perSec: +(c.boostMeter - before).toFixed(3) };
  });
  out.driftEarn = driftEarn;

  // E) takedown bar EXTENSION: call addBoostSegment() up to 5x, read segments + cap
  await page.evaluate(() => { const g = window.__game; g.reset(); g.launch(); });
  const ext = await page.evaluate(() => {
    const c = window.__game.control;
    const snaps = [{ seg: c.boostSegments, cap: +c.boostCap.toFixed(2), meter: +c.boostMeter.toFixed(2) }];
    for (let i = 0; i < 5; i++) {
      c.boostMeter = 0; // spend it down to prove takedown REFILLS
      c.addBoostSegment();
      snaps.push({ seg: c.boostSegments, cap: +c.boostCap.toFixed(2), meter: +c.boostMeter.toFixed(2) });
    }
    return snaps;
  });
  out.extension = ext;

  // F) crash collapses the bar back to 1x
  await page.evaluate(() => { const g = window.__game; g.reset(); g.launch(); });
  const collapse = await page.evaluate(() => {
    const g = window.__game; const c = g.control;
    c.addBoostSegment(); c.addBoostSegment(); c.addBoostSegment();
    const grown = c.boostSegments;
    g.resetBoostBar ? c.resetBoostBar() : g.markCrashed(g.player);
    return { grown, afterCrash: c.boostSegments };
  });
  out.collapse = collapse;

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
} finally {
  // kill the vite process TREE (vite spawns workers that keep the port)
  try {
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    vite.kill();
  }
}
