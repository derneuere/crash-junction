// Re-records the three race-mode bug fixtures against the current rival AI.
// The originals were human takes recorded before the AI rework (rubber band,
// lanes, attack runs) — their input tapes still replay, but the rivals are
// no longer where the tape expects them, so the scripted encounter (the
// takedown / door-to-door) never happens and the stats asserts starve.
//
// Each fixture is a deterministic synthetic take: a scripted key timeline
// keyed to SIM time, with a success watcher. Every reset rolls a fresh sim
// seed, so the loop simply retries until a seed produces the encounter the
// manifest asserts on, then captures the report at the right beat.
//
//   node tests/record-race-fixtures.mjs
//
// Verify afterwards with: node tests/run-replay-tests.mjs

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5176;

const FIXTURES = [
  {
    file: 'takedown-self-crash.json',
    note: 'fixture: opening shunt takedown, player races on clean (re-recorded 2026-06-12 after the rival AI rework)',
    // ram the rival dead ahead off the grid, angled so the shove sends him
    // wallward; succeed once the takedown lands and the player survives the
    // next 2 s without wrecking (pins takedownToPlayerCrashMin)
    keys: [
      { t: 0, type: 'keydown', code: 'Space' },
      { t: 0, type: 'keydown', code: 'ArrowUp' },
      { t: 0.55, type: 'keydown', code: 'KeyA' },
      { t: 0.85, type: 'keyup', code: 'KeyA' },
      { t: 2.5, type: 'keyup', code: 'Space' },
    ],
    watch: `
      if (W.takedownAt === null && W.flashes.TAKEDOWN) W.takedownAt = t;
      if (W.playerCrashed && (W.takedownAt === null || t - W.takedownAt < 2)) return { done: true, ok: false, why: 'player wrecked too early' };
      if (W.takedownAt !== null && t - W.takedownAt >= 2) return { done: true, ok: true };
      if (t > 9) return { done: true, ok: false, why: 'no takedown happened' };
    `,
  },
  {
    file: 'takedown-cam-throw.json',
    note: 'fixture: full-boost takedown, cam beat hands the player back on the road (re-recorded 2026-06-12 after the rival AI rework)',
    // same opening at full boost (the cam beat at speed is what used to
    // strand the player); succeed once the cam is over and the player sits
    // on the road (pins finalOffTrack)
    keys: [
      { t: 0, type: 'keydown', code: 'Space' },
      { t: 0, type: 'keydown', code: 'ArrowUp' },
      { t: 0.55, type: 'keydown', code: 'KeyA' },
      { t: 0.9, type: 'keyup', code: 'KeyA' },
      { t: 3.5, type: 'keyup', code: 'Space' },
    ],
    watch: `
      if (W.takedownAt === null && W.flashes.TAKEDOWN) W.takedownAt = t;
      if (W.takedownAt !== null && W.camSeen && g.takedownCamT === 0) W.camOverAt = W.camOverAt ?? t;
      if (g.takedownCamT > 0) W.camSeen = true;
      if (W.camOverAt !== undefined && t - W.camOverAt >= 1.5) {
        if (W.playerCrashed) return { done: true, ok: false, why: 'player wrecked after the cam' };
        if (g.mode.playerOffTrackDistance() > 1) return { done: true, ok: false, why: 'player stranded off the road' };
        return { done: true, ok: true };
      }
      if (t > 11) return { done: true, ok: false, why: 'no takedown/cam happened' };
    `,
  },
  {
    file: 'slam-misjudge.json',
    note: 'fixture: faster player wins a door-to-door — shunt, not SLAMMED (re-recorded 2026-06-12 after the rival AI rework)',
    // boost up the left lane and lean right through the orange rival's door
    // while clearly faster; succeed when a rival is destabilized by the
    // player (rivalShunts) with at most one SLAMMED against us
    keys: [
      { t: 0, type: 'keydown', code: 'Space' },
      { t: 0, type: 'keydown', code: 'ArrowUp' },
      { t: 0.9, type: 'keydown', code: 'KeyA' },
      { t: 1.25, type: 'keyup', code: 'KeyA' },
      { t: 1.9, type: 'keydown', code: 'KeyD' },
      { t: 2.3, type: 'keyup', code: 'KeyD' },
      { t: 3.2, type: 'keyup', code: 'Space' },
    ],
    watch: `
      const shunted = g.mode.director.racers.some((r) => r.a.destabilized > 0 && r.a.destabilizedByPlayer && !r.a.crashed);
      if (shunted) W.shuntAt = W.shuntAt ?? t;
      if (W.playerCrashed) return { done: true, ok: false, why: 'player wrecked' };
      if ((W.flashes.SLAMMED ?? 0) > 1) return { done: true, ok: false, why: 'player slammed twice' };
      if (W.shuntAt !== undefined && t - W.shuntAt >= 1) return { done: true, ok: true };
      if (t > 7) return { done: true, ok: false, why: 'no door-to-door won' };
    `,
  },
];

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let failed = false;
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
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('SILVER LAKE')).click();
  });
  await page.waitForFunction(() => window.__game?.levelId === 'race', { timeout: 30_000 });

  for (const fixture of FIXTURES) {
    let done = false;
    for (let attempt = 1; attempt <= 16 && !done; attempt++) {
      const result = await page.evaluate(
        (keys, watchBody, note) => {
          return new Promise((resolve) => {
            const k = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
            // clean slate: all keys up, fresh take (Enter resets and rerolls the seed)
            for (const code of ['Space', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS']) k('keyup', code);
            k('keydown', 'Enter');
            k('keyup', 'Enter');
            const g = window.__game;
            const W = { flashes: {}, playerCrashed: false, takedownAt: null, camSeen: false };
            const offFlash = g.events.on('flash', (s) => {
              W.flashes[s] = (W.flashes[s] ?? 0) + 1;
            });
            const watch = new Function('W', 'g', 't', watchBody);
            let t0 = null;
            let applied = 0;
            const pending = [...keys].sort((a, b) => a.t - b.t);
            g.onStep = (g2) => {
              if (t0 === null) t0 = g2.simTime;
              const t = g2.simTime - t0;
              while (applied < pending.length && pending[applied].t <= t) {
                k(pending[applied].type, pending[applied].code);
                applied++;
              }
              if (g2.player?.crashed) W.playerCrashed = true;
              const verdict = watch(W, g2, t);
              if (verdict?.done) {
                g.onStep = null;
                offFlash();
                for (const code of ['Space', 'ArrowUp', 'KeyA', 'KeyD']) k('keyup', code);
                resolve({ ok: verdict.ok, why: verdict.why ?? '', file: verdict.ok ? g2.captureReport(note) : null });
              }
            };
          });
        },
        fixture.keys,
        fixture.watch,
        fixture.note,
      );
      if (result.ok) {
        const out = path.join(root, 'tests', 'replays', fixture.file);
        writeFileSync(out, JSON.stringify(result.file));
        console.log(`${fixture.file}: recorded on attempt ${attempt} — ${result.file.dts.length} frames, seed ${result.file.seed}`);
        done = true;
      } else {
        console.log(`${fixture.file}: attempt ${attempt} rejected (${result.why})`);
      }
    }
    if (!done) {
      failed = true;
      console.error(`${fixture.file}: FAILED to record in 16 attempts`);
    }
  }
  await browser.close();
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
