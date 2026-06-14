// T-BONE probe: demonstrates the flank-takedown mechanic in isolation.
//
// Boots SILVER LAKE RING and runs three scripted contacts by teleporting a
// rival into the player's path with a controlled speed + angle, then reports
// whether the rival was wrecked and what banner fired:
//
//   1. FAST FLANK  — player at full boost drives square into a rival's side.
//                    Expect: rival WRECKED, banner = T-BONE TAKEDOWN.
//   2. SLOW FLANK  — same 90° geometry but the player crawls in.
//                    Expect: NO wreck (shunt/nudge — under the speed floor).
//   3. DOOR-TO-DOOR — fast, but the player runs PARALLEL alongside the rival.
//                    Expect: NO T-bone wreck (near-parallel is not a T-bone).
//
// This is a diagnosis/demo tool, not a regression test, but it exits 1 if the
// mechanic doesn't behave as specified.
//
// Usage: node tests/tbone-probe.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REPLAY_PORT ?? 5187);

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
    try {
      if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`dev server did not come up on port ${PORT}`);
}

async function launchBrowser() {
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const target of candidates) {
    try {
      return await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
    } catch {
      /* next */
    }
  }
  throw new Error('no Chrome or Edge found');
}

const vite = startVite();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => {
      failed = true;
      console.error(`PAGE ERROR: ${e.message}`);
    });
    await page.goto(`http://localhost:${PORT}/?level=race&launch=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.levelId === 'race', { timeout: 30_000, polling: 250 });

    // run one scripted contact in-page; returns { wrecked, banner }
    const runCase = async (kind) =>
      page.evaluate(
        (kind) =>
          new Promise((resolve) => {
            const g = window.__game;
            // fresh take, settle the launch
            const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
            for (const c of ['Space', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD']) k('keyup', c);
            k('keydown', 'Enter');
            k('keyup', 'Enter');

            const player = g.player;
            const dir = g.mode.director;
            // pick a clean rival to be the victim
            const victim = dir.racers.find((r) => !r.a.crashed)?.a ?? dir.racers[0].a;

            const result = { wrecked: false, banner: null };
            const off = g.events.on('takedown', (info) => {
              result.banner = info.label;
            });

            // The player drives along +x at the test speed; the victim travels
            // along +z (so a +x hit is a clean 90° flank). For door-to-door the
            // player runs +z alongside the victim (near-parallel, not a T-bone).
            const fast = 42; // full-boost-ish closing speed
            const slow = 6; // a nudge, under the T-bone floor
            const cfg = {
              'fast-flank': { psp: fast, pdir: [1, 0], vdir: [0, 1] },
              'slow-flank': { psp: slow, pdir: [1, 0], vdir: [0, 1] },
              'door-to-door': { psp: fast, pdir: [0, 1], vdir: [0, 1] },
            }[kind];

            // anchor the pair on open asphalt near the start, a couple of metres
            // apart along the player's approach line so the next steps collide
            const bx = player.body.position.x;
            const bz = player.body.position.z;
            let steps = 0;
            const hold = g.onStep;
            g.onStep = (g2) => {
              steps++;
              if (steps === 1) {
                // place the victim just ahead of the player along pdir
                const gap = 4.5;
                victim.body.position.x = bx + cfg.pdir[0] * gap;
                victim.body.position.z = bz + cfg.pdir[1] * gap;
                victim.body.position.y = player.body.position.y;
                victim.body.velocity.set(cfg.vdir[0] * 10, 0, cfg.vdir[1] * 10);
                victim.body.wakeUp();
                if (victim.scripted) victim.scripted.dir = { x: cfg.vdir[0], z: cfg.vdir[1] };
                // drive the player straight at the test speed along pdir
                player.body.velocity.set(cfg.pdir[0] * cfg.psp, 0, cfg.pdir[1] * cfg.psp);
                player.body.wakeUp();
              } else if (steps > 1 && steps < 90) {
                // hold the player's approach velocity until contact (cancel
                // steering/AI drift) so the geometry stays the scripted one
                if (!victim.crashed) {
                  player.body.velocity.x = cfg.pdir[0] * cfg.psp;
                  player.body.velocity.z = cfg.pdir[1] * cfg.psp;
                }
              }
              if (victim.crashed) result.wrecked = true;
              if (steps >= 90) {
                g.onStep = hold ?? null;
                off();
                resolve(result);
              }
            };
          }),
        kind,
      );

    const fastFlank = await runCase('fast-flank');
    const slowFlank = await runCase('slow-flank');
    const doorToDoor = await runCase('door-to-door');

    console.log('\n==== T-BONE probe ====');
    console.log(`1. FAST FLANK   : wrecked=${fastFlank.wrecked}  banner=${fastFlank.banner ?? '(none)'}`);
    console.log(`2. SLOW FLANK   : wrecked=${slowFlank.wrecked}  banner=${slowFlank.banner ?? '(none)'}`);
    console.log(`3. DOOR-TO-DOOR : wrecked=${doorToDoor.wrecked}  banner=${doorToDoor.banner ?? '(none)'}`);

    if (!(fastFlank.wrecked && fastFlank.banner === 'T-BONE TAKEDOWN')) {
      failed = true;
      console.error('FAIL: a fast 90° flank hit did NOT produce a T-BONE TAKEDOWN');
    }
    if (slowFlank.wrecked) {
      failed = true;
      console.error('FAIL: a slow flank nudge wrecked the rival — it should stay a shunt');
    }
    if (doorToDoor.banner === 'T-BONE TAKEDOWN') {
      failed = true;
      console.error('FAIL: a near-parallel door-to-door fired a T-BONE — only broadsides should');
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
console.log(failed ? '\nT-bone probe FAILED' : '\nT-bone probe ok');
process.exit(failed ? 1 : 0);
