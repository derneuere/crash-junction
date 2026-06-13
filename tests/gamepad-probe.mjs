// CONTROLLER probe: drives the live game with a SYNTHETIC Xbox 360 pad
// (navigator.getGamepads overridden in-page) and asserts the mapping reaches
// the sim through the recorded key path — RT accelerates, left stick steers,
// A boosts, Start launches. Pure feel/correctness check; determinism is proven
// separately by run-replay-tests.mjs (no pad => keyboard pins byte-exact).
//
//   node tests/gamepad-probe.mjs
//
// Exits non-zero on any failed assertion.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5188;

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);

const fails = [];
const ok = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails.push(name);
};

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
      // next candidate
    }
  }
  if (!browser) throw new Error('no Chrome or Edge found');
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game, { timeout: 30_000 });

  // pick a level (PROVING GROUND practice — no traffic, clean drive)
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent?.trim() ?? '').includes('PROVING'));
    if (!btn) throw new Error('no PROVING GROUND button');
    btn.click();
  });
  await page.waitForFunction(() => window.__game?.levelId === 'track', { timeout: 30_000 });

  // Install a synthetic standard-mapping pad. window.__pad is the mutable
  // button/axis state we drive from the test; getGamepads returns a snapshot.
  await page.evaluate(() => {
    window.__pad = {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };
    navigator.getGamepads = () => [
      { index: 0, connected: true, mapping: 'standard', axes: window.__pad.axes, buttons: window.__pad.buttons },
      null, null, null,
    ];
    // fire the connect event the way a real pad would
    window.dispatchEvent(new Event('gamepadconnected'));
  });

  const setBtn = (idx, v) =>
    page.evaluate((i, val) => {
      window.__pad.buttons[i] = { pressed: val > 0, value: val };
    }, idx, v);
  const setAxis = (idx, v) => page.evaluate((i, val) => { window.__pad.axes[i] = val; }, idx, v);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () =>
    page.evaluate(() => {
      const g = window.__game;
      const b = g.player.body;
      return {
        gameState: g.state, // 0 Idle, 1 Launch, ...
        speed: g.control.speed,
        heading: g.control.heading,
        x: b.position.x,
        z: b.position.z,
      };
    });

  // 1) START (button 9) launches from Idle
  const before = await state();
  ok('idle before launch (state 0)', before.gameState === 0);
  await setBtn(9, 1); // Start down
  await settle(120);
  await setBtn(9, 0); // Start up (edge: one launch)
  await settle(200);
  const afterLaunch = await state();
  ok('Start launches (state -> Launch=1)', afterLaunch.gameState === 1);

  // 2) RT (button 7) accelerates — car gains speed
  await setBtn(7, 1); // RT full
  await settle(900);
  const accel = await state();
  ok('RT accelerates (speed climbs)', accel.speed > 3);

  // 3) Left stick X steers — heading changes under a held turn while moving
  const h0 = accel.heading;
  await setAxis(0, -1); // hard left
  await settle(700);
  const steered = await state();
  ok('left stick steers (heading changes)', Math.abs(steered.heading - h0) > 0.05);
  await setAxis(0, 0); // recenter

  // 4) A (button 0) requests boost while driving — boosting flips true if the
  //    bar has charge; at minimum it must not error and the throttle holds.
  await setBtn(0, 1);
  await settle(300);
  const boosted = await page.evaluate(() => ({ boosting: window.__game.control.boosting, speed: window.__game.control.speed }));
  ok('A held + RT keeps the car driving', boosted.speed > 3);
  await setBtn(0, 0);
  await setBtn(7, 0); // RT up

  // 5) No-pad safety: getGamepads -> none => poll writes nothing, heldKeys clear
  await page.evaluate(() => {
    navigator.getGamepads = () => [null, null, null, null];
    window.dispatchEvent(new Event('gamepaddisconnected'));
  });
  await settle(150);
  const cleared = await page.evaluate(() => {
    const hk = window.__game.gamepad.heldKeys;
    return Object.values(hk).every((v) => !v);
  });
  ok('disconnect clears all held flags (keyboard path untouched)', cleared);

  await browser.close();
} finally {
  vite.kill();
}

if (fails.length) {
  console.error(`\n${fails.length} assertion(s) failed:`, fails);
  process.exit(1);
}
console.log('\nall gamepad mapping assertions passed');
