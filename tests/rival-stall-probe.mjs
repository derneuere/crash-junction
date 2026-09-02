// Deterministic rival-stall probe: boots SILVER LAKE RING headless, pumps the
// race through the fixed step (g.advance) with a wall-blind throttle-only
// synthetic player for N sim seconds, and dumps the full state of any rival
// that sits clean (not crashed, not destabilized) under 1 m/s for over 2 s.
// Unlike tests/ai-probe.mjs this does not depend on wall-clock sampling, so a
// stall reproduces step-for-step.
//
//   node tests/rival-stall-probe.mjs [simSeconds=120]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REPLAY_PORT ?? 5187);
const SIM_SECONDS = Number(process.argv[2] ?? 120);

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
  await page.goto(`http://localhost:${PORT}/?level=race&launch=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.levelId === 'race' && window.__game.mode?.director, { timeout: 30000 });

  const out = await page.evaluate((simSeconds) => {
    const g = window.__game;
    g.launch();
    const dt = 1 / 120;
    const dir = g.mode.director;
    const stall = new Map();
    const events = [];
    let dumps = 0;
    let playerOff = 0;
    const num = (o) => {
      const r = {};
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (typeof v === 'number') r[k] = +v.toFixed(3);
        else if (typeof v === 'boolean' || typeof v === 'string') r[k] = v;
      }
      return r;
    };
    const steps = Math.round(simSeconds / dt);
    // exercise the wreck → repair → respawn path: wreck each rival once at
    // staggered times (the AI probe's stalls followed rival wrecks)
    const wreckAt = [10, 25, 40, 55];
    for (let i = 0; i < steps; i++) {
      g.simKeys = { KeyW: true };
      g.advance(dt, false, []);
      if (i % 60 !== 0) continue; // sample twice per sim second
      const t = i * dt;
      wreckAt.forEach((wt, idx) => {
        if (Math.abs(t - wt) < dt && dir.racers[idx] && !dir.racers[idx].a.crashed) {
          g.markCrashed(dir.racers[idx].a);
          events.push({ t, ev: 'forced wreck', idx });
        }
      });
      dir.racers.forEach((r, idx) => {
        const key = 'wasCrashed' + idx;
        if (r.a.crashed && !stall.get(key)) events.push({ t: +t.toFixed(1), ev: 'crashed', idx });
        if (!r.a.crashed && stall.get(key)) events.push({ t: +t.toFixed(1), ev: 'repaired', idx, fs: num(r.fs), sleep: r.a.body.sleepState });
        stall.set(key, r.a.crashed ? 1 : 0);
      });
      const player = g.player;
      playerOff = !player.crashed && g.mode.playerOffTrackDistance() > 2 ? playerOff + 1 : 0;
      if (playerOff >= 20) { playerOff = 0; dir.respawnPlayer(g.control); events.push({ t, ev: 'player rescued' }); }
      dir.racers.forEach((r, idx) => {
        const b = r.a.body;
        const sp = Math.hypot(b.velocity.x, b.velocity.z);
        const clean = !r.a.crashed && r.a.destabilized <= 0;
        const run = clean && sp < 1 ? (stall.get(idx) ?? 0) + 1 : 0;
        stall.set(idx, run);
        if (run === 4 && dumps < 3) {
          dumps++;
          const contacts = g.phys.world.contacts.filter((c) => c.bi === b || c.bj === b).map((c) => {
            const o = c.bi === b ? c.bj : c.bi;
            return { otherId: o.id, otherMass: o.mass, ni: [+c.ni.x.toFixed(2), +c.ni.y.toFixed(2), +c.ni.z.toFixed(2)] };
          });
          events.push({
            t: +t.toFixed(1),
            ev: 'RIVAL STALLED 2s',
            idx,
            pos: [+b.position.x.toFixed(1), +b.position.y.toFixed(2), +b.position.z.toFixed(1)],
            vel: [+b.velocity.x.toFixed(3), +b.velocity.y.toFixed(3), +b.velocity.z.toFixed(3)],
            angVel: [+b.angularVelocity.x.toFixed(3), +b.angularVelocity.y.toFixed(3), +b.angularVelocity.z.toFixed(3)],
            angularFactor: [b.angularFactor.x, b.angularFactor.y, b.angularFactor.z],
            sleep: b.sleepState,
            inertiaY: +b.inertia.y.toFixed(0),
            ground: +g.heightAt(b.position.x, b.position.z).toFixed(2),
            susp: r.a.susp.map((s) => ({ g: s.grounded ? 1 : 0, load: Math.round(s.load), dist: +s.dist.toFixed(2) })),
            fs: num(r.fs),
            racer: num(r),
            contacts,
            playerDist: +Math.hypot(b.position.x - player.body.position.x, b.position.z - player.body.position.z).toFixed(0),
          });
        }
      });
    }
    const final = dir.racers.map((r) => ({
      sp: +Math.hypot(r.a.body.velocity.x, r.a.body.velocity.z).toFixed(1),
      cr: r.a.crashed ? 1 : 0,
      de: r.a.destabilized > 0 ? 1 : 0,
      maxStall: 0,
    }));
    return { simSeconds, final, worstStallSamples: Math.max(...stall.values()), events };
  }, SIM_SECONDS);
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
} finally {
  try { spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { vite.kill(); }
}
