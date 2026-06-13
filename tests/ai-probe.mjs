// Headless AI probe: boots the dev server, opens SILVER LAKE RING, lets a
// deliberately sloppy synthetic player (throttle pinned, no steering — it
// crashes and respawns like a flailing human) run for a while, and reports
// what the rival AI did: attack runs, wrecks, pack cohesion, rubber band.
//
// This is a diagnosis tool, not a regression test — but it exits 1 on
// structural failures (a rival stuck or lost off-track, NaN positions),
// which is what it was built to catch. Tuning judgments read the report.
//
// Usage: node tests/ai-probe.mjs [seconds]   (default 100)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5176;
const RUN_SECONDS = Number(process.argv[2] ?? 100);

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
    // FAST PATH (menu redesign): jump straight to SILVER LAKE RING (race).
    await page.goto(`http://localhost:${PORT}/?level=race&launch=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__game?.levelId === 'race', { timeout: 30_000, polling: 250 });

    await page.evaluate(() => {
      const g = window.__game;
      const press = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      press('Space'); // launch
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })), 700);
      press('KeyW'); // throttle, held forever
      const probe = {
        samples: [],
        flashes: {},
        rivalWrecks: 0,
        playerCrashes: 0,
        playerRescues: 0, // probe-side backstop behind the in-game 5s rescue
        offMax: 0, // worst rival off-track stint seen (s) — rescue fires at 3
        stuck: 0, // consecutive-sample stall counter per probe check below
      };
      window.__probe = probe;
      g.events.on('flash', (s) => {
        probe.flashes[s] = (probe.flashes[s] ?? 0) + 1;
      });
      let prevCrashed = [];
      let prevPlayerCrashed = false;
      let playerOffRun = 0;
      const stallRuns = new Map(); // rival index -> consecutive slow+clean samples
      setInterval(() => {
        const g2 = window.__game;
        if (!g2) return;
        const dir = g2.mode?.director;
        if (!dir) return;
        const player = g2.player;
        const racers = dir.racers;
        // the wall-blind driver can fly clean over a barrier; the in-game 5s
        // rescue (modes/race.ts) usually fires first — this is a backstop so
        // the probe never wastes a run beached even if that rule changes
        playerOffRun = !player.crashed && g2.mode.playerOffTrackDistance() > 2 ? playerOffRun + 1 : 0;
        if (playerOffRun >= 10) {
          playerOffRun = 0;
          probe.playerRescues++;
          dir.respawnPlayer(g2.control);
        }
        racers.forEach((r, i) => {
          if (r.a.crashed && !prevCrashed[i]) probe.rivalWrecks++;
        });
        prevCrashed = racers.map((r) => r.a.crashed);
        if (player.crashed && !prevPlayerCrashed) probe.playerCrashes++;
        prevPlayerCrashed = player.crashed;
        const pp = player.body.position;
        probe.samples.push({
          t: +g2.simTime.toFixed(1),
          ai: { ...window.__raceAI },
          psp: +Math.hypot(player.body.velocity.x, player.body.velocity.z).toFixed(1),
          pcr: player.crashed ? 1 : 0,
          rivals: racers.map((r, i) => {
            const b = r.a.body;
            const sp = Math.hypot(b.velocity.x, b.velocity.z);
            const clean = !r.a.crashed && r.a.destabilized <= 0;
            const run = clean && sp < 3 && g2.state === 1 ? (stallRuns.get(i) ?? 0) + 1 : 0;
            stallRuns.set(i, run);
            if (run > probe.stuck) probe.stuck = run;
            if (r.offT > probe.offMax) probe.offMax = r.offT;
            return {
              d: Math.round(Math.hypot(b.position.x - pp.x, b.position.z - pp.z)),
              sp: Math.round(sp),
              cr: r.a.crashed ? 1 : 0,
              de: r.a.destabilized > 0 ? 1 : 0,
              rub: +r.rubber.toFixed(2),
              atk: r.attackT > 0 ? r.attackKind : '',
              off: r.offT > 0 ? 1 : 0,
              bad: !isFinite(b.position.x) || !isFinite(b.position.z) ? 1 : 0,
            };
          }),
        });
      }, 500);
    });

    await new Promise((res) => setTimeout(res, RUN_SECONDS * 1000));
    const probe = await page.evaluate(() => window.__probe);

    const s = probe.samples;
    const last = s[s.length - 1];
    const n = s.length;
    const simSpan = last.t - s[0].t;
    const ai = last.ai;
    const nearSamples = s.filter((x) => x.rivals.some((r) => r.d < 35)).length;
    const attackSamples = s.filter((x) => x.rivals.some((r) => r.atk)).length;
    const destabSamples = s.reduce((m, x) => m + x.rivals.filter((r) => r.de).length, 0);
    const offSamples = s.reduce((m, x) => m + x.rivals.filter((r) => r.off).length, 0);
    const badSamples = s.reduce((m, x) => m + x.rivals.filter((r) => r.bad).length, 0);
    const rubMax = Math.max(...s.flatMap((x) => x.rivals.map((r) => r.rub)));
    const rubMin = Math.min(...s.flatMap((x) => x.rivals.map((r) => r.rub)));
    const spMax = Math.max(...s.flatMap((x) => x.rivals.filter((r) => !r.cr).map((r) => r.sp)));

    console.log(`\n==== AI probe: ${n} samples over ${simSpan.toFixed(0)}s of sim ====`);
    console.log(`attacks started     : ${ai.shunts} shunts, ${ai.slams} slams`);
    console.log(`attack-in-progress  : ${((100 * attackSamples) / n).toFixed(0)}% of samples`);
    console.log(`rival destabilized  : ${destabSamples} rival-samples`);
    console.log(`rival wrecks        : ${probe.rivalWrecks}`);
    console.log(`player crashes      : ${probe.playerCrashes} (synthetic driver is wall-blind — expected)`);
    console.log(`player rescues      : ${probe.playerRescues} (probe backstop; the in-game 5s rescue flashes BACK ON TRACK)`);
    console.log(`worst rival offT    : ${probe.offMax.toFixed(1)}s (in-race rescue fires at 3)`);
    console.log(`flashes             : ${JSON.stringify(probe.flashes)}`);
    console.log(`rival within 35m    : ${((100 * nearSamples) / n).toFixed(0)}% of samples`);
    console.log(`rubber band range   : ${rubMin} … ${rubMax}`);
    console.log(`fastest clean rival : ${spMax} m/s`);
    console.log(`off-track samples   : ${offSamples}`);
    console.log(`final rivals        : ${JSON.stringify(last.rivals)}`);

    if (badSamples > 0) {
      failed = true;
      console.error(`FAIL: ${badSamples} non-finite rival positions`);
    }
    if (probe.stuck >= 10) {
      failed = true;
      console.error(`FAIL: a clean rival sat under 3 m/s for ${probe.stuck} consecutive samples (stuck)`);
    }
    if (probe.offMax > 4) {
      failed = true;
      console.error(`FAIL: a rival sat off the road for ${probe.offMax.toFixed(1)}s — the 3s rescue did not fire`);
    }
    if (ai.shunts + ai.slams === 0) {
      failed = true;
      console.error('FAIL: not a single attack run started');
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
console.log(failed ? '\nprobe FAILED' : '\nprobe ok');
process.exit(failed ? 1 : 0);
