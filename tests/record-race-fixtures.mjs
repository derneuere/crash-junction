// Re-records race-mode bug fixtures against the current rival AI. The
// originals were human takes recorded on an older sim — their input tapes
// still replay, but the rivals are no longer where the tape expects them
// (any AI change shifts the seeded-RNG draws and the whole choreography),
// so the scripted encounter (the takedown / door-to-door / triple ram)
// never happens and the stats asserts starve.
//
// Each fixture is a deterministic synthetic take: a scripted key timeline
// keyed to SIM time, with a success watcher. Every reset rolls a fresh sim
// seed, so the loop simply retries until a seed produces the encounter the
// manifest asserts on, then captures the report at the right beat.
//
//   node tests/record-race-fixtures.mjs [fixture.json ...]
//
// With no args every fixture below is re-recorded; pass file names to
// re-record only the ones whose encounter actually starved (don't churn
// tapes that still pass). Verify with: node tests/run-replay-tests.mjs

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
  {
    file: 'ram-debris-self-crash.json',
    note: 'fixture: full-boost ram sheds debris, the winning rammer drives on clean (re-recorded 2026-06-12 after the rival AI rework)',
    // plow straight through the rival dead ahead at full boost — the hit is
    // hard enough to shed panels right in the rammer's path; succeed once a
    // shunt is won and the player survives 2.5 s among the debris (pins
    // rivalShunts >= 1 with playerWrecks 0: debris is not a wall)
    keys: [
      { t: 0, type: 'keydown', code: 'Space' },
      { t: 0, type: 'keydown', code: 'ArrowUp' },
      { t: 3.2, type: 'keyup', code: 'Space' },
    ],
    watch: `
      const shunted = g.mode.director.racers.some((r) => r.a.destabilized > 0 && r.a.destabilizedByPlayer);
      if (shunted) W.shuntAt = W.shuntAt ?? t;
      if (W.playerCrashed) return { done: true, ok: false, why: 'player wrecked' };
      if (W.shuntAt !== undefined && t - W.shuntAt >= 2.5) return { done: true, ok: true };
      if (t > 9) return { done: true, ok: false, why: 'no shunt won' };
    `,
  },
  {
    file: 'live-wheel-pop.json',
    note: 'fixture: three takedowns in one charge, every wheel still on the live car (re-recorded 2026-06-12 after the rival AI rework)',
    // a long full-throttle brawl through the pack: boost is pinned (every
    // takedown refills the meter), gentle weave pulses rake the grid lanes,
    // and the rubber band keeps beaten rivals coming back for more. Succeed
    // on the third TAKEDOWN with the player never wrecked and every wheel
    // still on (pins takedowns >= 3 with playerPopped 0 — wheels only pop
    // off WRECKED cars, never a live one)
    keys: [
      { t: 0, type: 'keydown', code: 'Space' },
      { t: 0, type: 'keydown', code: 'ArrowUp' },
      { t: 1.6, type: 'keydown', code: 'KeyA' },
      { t: 1.9, type: 'keyup', code: 'KeyA' },
      { t: 2.6, type: 'keydown', code: 'KeyD' },
      { t: 2.95, type: 'keyup', code: 'KeyD' },
      { t: 4.0, type: 'keydown', code: 'KeyA' },
      { t: 4.3, type: 'keyup', code: 'KeyA' },
      { t: 6.0, type: 'keydown', code: 'KeyD' },
      { t: 6.3, type: 'keyup', code: 'KeyD' },
      { t: 8.5, type: 'keydown', code: 'KeyA' },
      { t: 8.8, type: 'keyup', code: 'KeyA' },
      { t: 11.5, type: 'keydown', code: 'KeyD' },
      { t: 11.8, type: 'keyup', code: 'KeyD' },
      { t: 14.5, type: 'keydown', code: 'KeyA' },
      { t: 14.8, type: 'keyup', code: 'KeyA' },
      { t: 18.0, type: 'keydown', code: 'KeyD' },
      { t: 18.3, type: 'keyup', code: 'KeyD' },
    ],
    watch: `
      if (g.player.popped > 0 && !g.player.crashed) return { done: true, ok: false, why: 'live wheel popped' };
      if (W.playerCrashed) return { done: true, ok: false, why: 'player wrecked' };
      const td = W.flashes.TAKEDOWN ?? 0;
      if (td >= 3 && W.thirdAt === undefined) W.thirdAt = t;
      if (W.thirdAt !== undefined && t - W.thirdAt >= 1.5) return { done: true, ok: true };
      if (t > 30) return { done: true, ok: false, why: 'only ' + td + ' takedowns' };
    `,
  },
  {
    file: 'gantry-grid-uturn.json',
    level: { button: '^GANTRY POINT$', id: 'gantry' },
    note: 'fixture: gantry five-deep grid launch — every slot pulls away clean (re-recorded 2026-06-12 on the flow-pass + elevation geometry)',
    // mirror the original tape: a beat of idle, launch, a dab of throttle,
    // then watch the grid sort itself out on the (unchanged) south straight.
    // The bug this pins: grid slots whose first gate sat BEHIND them
    // U-turned into the barrier at launch.
    keys: [
      { t: 1.1, type: 'keydown', code: 'Space' },
      { t: 1.25, type: 'keyup', code: 'Space' },
      { t: 2.0, type: 'keydown', code: 'ArrowUp' },
      { t: 2.45, type: 'keyup', code: 'ArrowUp' },
    ],
    watch: `
      if (W.playerCrashed) return { done: true, ok: false, why: 'player wrecked on the grid' };
      if (g.mode.director.racers.some((r) => r.a.crashed)) return { done: true, ok: false, why: 'a car wrecked off the launch' };
      if (t >= 4.1) return { done: true, ok: true };
    `,
    // rivalWallHits is only counted during replay PLAYBACK (Game.ts guards
    // on this.replay), so the live watcher above can't see it — the verify
    // block replays the captured take in-page and holds the manifest's
    // envelope before the tape is accepted
    verify: { rivalWallHits: 0, playerWrecks: 0 },
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

  // mount a level through the event picker, same contract refshot.mjs uses
  // (regex on trimmed button text); levels persist across fixtures, so only
  // click when the wanted level differs from what's mounted
  const mountLevel = async (level) => {
    if ((await page.evaluate(() => window.__game?.levelId)) === level.id) return;
    const clicked = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc);
      const btn = [...document.querySelectorAll('button')].find((b) => re.test(b.textContent?.trim() ?? ''));
      if (!btn) return false;
      btn.click();
      return true;
    }, level.button);
    if (!clicked) throw new Error(`no button matching ${level.button} on the page`);
    await page.waitForFunction((id) => window.__game?.levelId === id, { timeout: 30_000 }, level.id);
  };

  // optional argv filter: re-record only the named fixtures
  const only = process.argv.slice(2);
  const wanted = only.length ? FIXTURES.filter((f) => only.includes(f.file)) : FIXTURES;
  for (const name of only) {
    if (!FIXTURES.some((f) => f.file === name)) {
      failed = true;
      console.error(`no recorder for ${name}`);
    }
  }
  for (const fixture of wanted) {
    await mountLevel(fixture.level ?? { button: 'SILVER LAKE', id: 'race' });
    let done = false;
    // the triple-takedown brawl needs the luckiest seed of the set — give
    // every fixture the same deep retry budget, cheap takes reject fast
    const MAX_ATTEMPTS = 40;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
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
      if (result.ok && fixture.verify) {
        // replay the candidate tape in-page and hold the manifest envelope —
        // some stats (rivalWallHits) are only counted during playback, so a
        // live take that LOOKED clean can still carry a violation
        const fails = await page.evaluate(async (file, asserts) => {
          delete window.__replayResult;
          const g = window.__game;
          g.startReplay(file, true);
          await new Promise((resolve) => {
            const tick = setInterval(() => {
              if (window.__replayResult !== undefined) {
                clearInterval(tick);
                resolve();
              }
            }, 100);
          });
          const res = window.__replayResult;
          const out = [];
          if (res.framesPlayed !== res.framesTotal) out.push(`played ${res.framesPlayed}/${res.framesTotal} frames`);
          for (const [key, limit] of Object.entries(asserts)) {
            if (typeof res.stats?.[key] !== 'number') out.push(`stats.${key} missing`);
            else if (res.stats[key] > limit) out.push(`stats.${key} = ${res.stats[key]} exceeds ${limit}`);
          }
          return out;
        }, result.file, fixture.verify);
        if (fails.length) {
          console.log(`${fixture.file}: attempt ${attempt} rejected on verify (${fails.join('; ')})`);
          continue;
        }
      }
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
      console.error(`${fixture.file}: FAILED to record in ${MAX_ATTEMPTS} attempts`);
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
