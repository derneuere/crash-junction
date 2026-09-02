// CRASH probe: scripted contacts, headless, with the outcome read straight off
// window.__game — a diagnosis/demo tool for the crash model, not a regression
// test (it exits 1 only on structural failures: page errors, NaN, a wreck that
// never stops, panicked traffic that never recovers).
//
//   A) WRECK SLIDE   (junction) — the player rear-ends a cruising traffic car
//                    hard enough to wreck it, then the wreck is followed: slide
//                    distance, time to come to rest, peak yaw rate. Burnout's
//                    wrecks slide and settle on their tires — not forever, not
//                    dead on the spot.
//   B) TRAFFIC PANIC (junction) — a knock UNDER the wreck bar on a cruising
//                    traffic car, then the player backs off: does the driver
//                    panic (kind, timer), how far it swings off its lane
//                    heading, and is it back to lane-holding after the timeout.
//                    Run twice: a light tap (a swerve) and a harder one (a
//                    spin-out).
//   C) SLAM CARRY    (race) — the player slams a rival door-to-door and peels
//                    off: the rival's lateral speed sampled over the next
//                    0.6 s. A one-shot hit is a step that then decays;
//                    Burnout's shunt keeps CARRYING the victim sideways for a
//                    beat.
//
// Usage: REPLAY_PORT=5406 node tests/crash-probe.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REPLAY_PORT ?? 5189);

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

// ---- in-page helpers (serialised into page.evaluate; keep them self-contained) ----
const helpers = `
  const DT = 1 / 60; // two fixed steps per advance
  const step = (g, n) => { for (let i = 0; i < n; i++) g.advance(DT, false, []); };
  // the launch is a recorded COMMAND (what the Space/Enter keydown queues for
  // the next frame) — advance() takes it directly, no frame loop needed
  const launch = (g) => g.advance(DT, false, [{ t: 'launch' }]);
  // a body's hull-forward (local -z) in world space, from its quaternion
  const fwdOf = (q) => {
    const { x, y, z, w } = q;
    return { x: -(2 * (x * z + w * y)), z: -(1 - 2 * (x * x + y * y)) };
  };
  const faceAlong = (body, dx, dz) => body.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(dx, dz) + Math.PI);
  const planar = (v) => Math.hypot(v.x, v.z);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const finite = (b) => Number.isFinite(b.position.x + b.position.y + b.position.z + b.velocity.x + b.velocity.z);
  // a cruising sedan (a same-class victim — a bus would wreck the PLAYER) well
  // clear of the junction box
  const cruisingSedan = (g) => g.actors.find((a) => a.kind === 'vehicle' && !a.isPlayer && a.scripted && a.started && !a.crashed
    && a.spec?.variant === 'sedan' && planar(a.body.velocity) > 3 && Math.hypot(a.body.position.x, a.body.position.z) > 25);
  const touching = (g, a, b) => g.phys.world.contacts.some((c) => (c.bi === a && c.bj === b) || (c.bj === a && c.bi === b));
`;

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
    const open = async (level) => {
      await page.goto(`http://localhost:${PORT}/?level=${level}&launch=1&verify=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((l) => window.__game?.levelId === l, { timeout: 30_000, polling: 250 }, level);
    };

    // ---- A) wreck slide --------------------------------------------------
    await open('junction');
    const slide = await page.evaluate(`(() => {
      ${helpers}
      const g = window.__game;
      launch(g);
      step(g, 240); // 4 s: traffic is rolling
      const player = g.player;
      const t = cruisingSedan(g);
      if (!t) return { error: 'no cruising traffic car found' };
      const d = t.scripted.dir;
      const speed = 30;
      // the player in the traffic car's lane, 16 m behind it, closing at 30 m/s
      player.body.position.set(t.body.position.x - d.x * 16, player.body.position.y, t.body.position.z - d.z * 16);
      faceAlong(player.body, d.x, d.z);
      player.body.velocity.set(d.x * speed, 0, d.z * speed);
      player.body.angularVelocity.set(0, 0, 0);
      player.body.wakeUp();
      let n = 0;
      while (!t.crashed && n < 240) {
        player.body.velocity.x = d.x * speed;
        player.body.velocity.z = d.z * speed;
        step(g, 1); n++;
      }
      if (!t.crashed) return { error: 'the traffic car never wrecked' };
      const impactSpeed = planar(t.body.velocity);
      const x0 = t.body.position.x, z0 = t.body.position.z;
      // park the player (we follow the wreck only)
      player.body.velocity.set(0, 0, 0);
      let maxYaw = 0, restT = -1, stillFor = 0, tEl = 0;
      const speeds = [];
      for (let i = 0; i < 10 * 60 && restT < 0; i++) {
        step(g, 1); tEl += DT;
        const v = planar(t.body.velocity);
        const yaw = Math.abs(t.body.angularVelocity.y);
        if (yaw > maxYaw) maxYaw = yaw;
        if (i % 30 === 0) speeds.push(+v.toFixed(1));
        const asleep = t.body.sleepState === 2;
        stillFor = v < 0.3 || asleep ? stillFor + DT : 0;
        if (stillFor >= 0.5) restT = tEl - 0.5;
        if (!finite(t.body)) return { error: 'NaN on the wreck' };
      }
      const slideDist = Math.hypot(t.body.position.x - x0, t.body.position.z - z0);
      return { impactSpeed: +impactSpeed.toFixed(1), slideDist: +slideDist.toFixed(1), restT: restT < 0 ? null : +restT.toFixed(2),
        maxYaw: +maxYaw.toFixed(2), speedsEvery500ms: speeds, popped: t.popped, variant: t.spec?.variant, playerCrashed: player.crashed };
    })()`);

    // ---- B) traffic panic (a light tap, then a harder knock) -------------
    const knock = async (closing) => {
      await open('junction');
      return page.evaluate(`(() => {
        ${helpers}
        const g = window.__game;
        launch(g);
        step(g, 240);
        const player = g.player;
        const t = cruisingSedan(g);
        if (!t) return { error: 'no cruising traffic car found' };
        const d = t.scripted.dir;
        const lane = Math.atan2(d.x, d.z);
        // the player closes ${closing} m/s faster than the traffic car is going
        // RIGHT NOW (it may be braking for the box) — under the 4 m/s wreck bar
        const closing = ${closing};
        const speedNow = () => planar(t.body.velocity) + closing;
        const panicT = () => t.panicT ?? 0; // (a tree without the freak-out reads 0)
        player.body.position.set(t.body.position.x - d.x * 8, player.body.position.y, t.body.position.z - d.z * 8);
        faceAlong(player.body, d.x, d.z);
        player.body.velocity.set(d.x * speedNow(), 0, d.z * speedNow());
        player.body.angularVelocity.set(0, 0, 0);
        player.body.wakeUp();
        let n = 0;
        let met = false;
        while (!met && !t.crashed && n < 240) {
          const s = speedNow();
          player.body.velocity.x = d.x * s;
          player.body.velocity.z = d.z * s;
          step(g, 1); n++;
          met = panicT() > 0 || touching(g, t.body, player.body);
        }
        const entry = { panicKind: t.panicKind ?? 0, panicT: +panicT().toFixed(2), panicSteer: t.panicSteer ?? 0, crashed: t.crashed, contactSteps: n };
        // one tap, then the player stops dead (a panicked driver may stand on
        // the brakes — a player still rolling up behind would rear-end it)
        player.body.velocity.set(0, 0, 0);
        let maxDev = 0, minSpeed = Infinity, tEl = 0, panicEnd = null;
        const trace = [];
        for (let i = 0; i < 9 * 60; i++) {
          step(g, 1); tEl += DT;
          const f = fwdOf(t.body.quaternion);
          const dev = Math.abs(wrap(Math.atan2(f.x, f.z) - lane));
          if (dev > maxDev) maxDev = dev;
          const v = planar(t.body.velocity);
          if (v < minSpeed) minSpeed = v;
          if (panicEnd === null && panicT() <= 0) panicEnd = +tEl.toFixed(2);
          if (i % 60 === 0) trace.push({ t: +tEl.toFixed(1), devDeg: Math.round(dev * 180 / Math.PI), speed: +v.toFixed(1), panicT: +panicT().toFixed(1) });
          if (!finite(t.body)) return { error: 'NaN on the traffic car' };
        }
        const f = fwdOf(t.body.quaternion);
        const finalDev = Math.abs(wrap(Math.atan2(f.x, f.z) - lane));
        return { entry, maxDevDeg: Math.round(maxDev * 180 / Math.PI), minSpeed: +minSpeed.toFixed(1), panicEnd,
          finalDevDeg: Math.round(finalDev * 180 / Math.PI), finalSpeed: +planar(t.body.velocity).toFixed(1), crashed: t.crashed, trace };
      })()`);
    };
    const tap = await knock(2.2);
    const hardKnock = await knock(3.4);

    // ---- C) slam carry ----------------------------------------------------
    await open('race');
    const carry = await page.evaluate(`(() => {
      ${helpers}
      const g = window.__game;
      launch(g);
      step(g, 150); // 2.5 s: the pack has launched and left the grid, the player idles
      const player = g.player;
      const dir = g.mode.director;
      const victim = dir.racers.find((r) => !r.a.crashed)?.a ?? dir.racers[0].a;
      let banner = null;
      g.events.on('takedown', (info) => { banner = info.label; });
      // both run down a track section well past the grid at the same pace,
      // straddling its centre line (1.15 m either side — nowhere near a
      // barrier) with the victim exactly ALONGSIDE on the player's right; the
      // player drifts 4.5 m/s sideways into its door. A door-to-door slam: the
      // contact normal is lateral, the closing stays under the T-bone floor
      // and the travel axes are parallel, so the side contest goes to the
      // pusher.
      const sec = dir.secs[8];
      const f = { x: sec.dirX, z: sec.dirZ };
      const fl = Math.hypot(f.x, f.z); f.x /= fl; f.z /= fl;
      const r = { x: -f.z, z: f.x }; // right of forward in the road plane
      const p = player.body.position;
      player.body.position.set(sec.x - r.x * 1.15, p.y, sec.z - r.z * 1.15);
      victim.body.position.set(sec.x + r.x * 1.15, p.y, sec.z + r.z * 1.15);
      faceAlong(victim.body, f.x, f.z);
      victim.body.velocity.set(f.x * 20, 0, f.z * 20);
      victim.body.angularVelocity.set(0, 0, 0);
      victim.body.wakeUp();
      faceAlong(player.body, f.x, f.z);
      const pv = { x: f.x * 20 + r.x * 4.5, z: f.z * 20 + r.z * 4.5 };
      player.body.velocity.set(pv.x, 0, pv.z);
      player.body.angularVelocity.set(0, 0, 0);
      player.body.wakeUp();
      const lat = () => victim.body.velocity.x * r.x + victim.body.velocity.z * r.z;
      let n = 0;
      while (victim.destabilized <= 0 && !victim.crashed && n < 120) {
        player.body.velocity.x = pv.x;
        player.body.velocity.z = pv.z;
        step(g, 1); n++;
      }
      if (victim.destabilized <= 0) return { error: 'the rival was never slammed loose', crashed: victim.crashed, banner, playerCrashed: player.crashed };
      // the rival's lateral speed (toward the player's right) over the next
      // 0.6 s — the player PEELS OFF (pulls left) so the victim is free of the
      // contact and only its own carry shows
      const pushes = () => g.shuntPushes?.size ?? 0;
      const samples = [+lat().toFixed(2)];
      const alive = [pushes()];
      for (let i = 1; i <= 36; i++) {
        player.body.velocity.x = f.x * 20 - r.x * 4;
        player.body.velocity.z = f.z * 20 - r.z * 4;
        step(g, 1);
        if (i % 6 === 0) { samples.push(+lat().toFixed(2)); alive.push(pushes()); }
      }
      const peak = Math.max(...samples);
      return { contactSteps: n, destabilized: +victim.destabilized.toFixed(2), latAtContact: samples[0],
        latPeak: peak, peakAt: samples.indexOf(peak) * 0.1, samplesEvery100ms: samples, pushAliveEvery100ms: alive,
        crashed: victim.crashed, banner, playerCrashed: player.crashed };
    })()`);

    console.log('\n==== CRASH probe ====');
    console.log('A) WRECK SLIDE        :', JSON.stringify(slide));
    console.log('B1) TRAFFIC TAP 2.2   :', JSON.stringify(tap));
    console.log('B2) TRAFFIC KNOCK 3.4 :', JSON.stringify(hardKnock));
    console.log('C) SLAM CARRY         :', JSON.stringify(carry));

    if (slide.error) { failed = true; console.error(`FAIL A: ${slide.error}`); }
    else if (slide.restT === null) { failed = true; console.error('FAIL A: the wreck never came to rest within 10 s'); }
    for (const [name, k] of [['B1', tap], ['B2', hardKnock]]) {
      if (k.error) { failed = true; console.error(`FAIL ${name}: ${k.error}`); continue; }
      if (k.crashed) { failed = true; console.error(`FAIL ${name}: a knock under the wreck bar wrecked the traffic car`); }
      if (k.entry.panicKind === 0 && !k.crashed) console.warn(`NOTE ${name}: the knocked traffic car did not panic (no freak-out on this tree?)`);
      if (k.entry.panicKind !== 0 && k.finalDevDeg > 45) { failed = true; console.error(`FAIL ${name}: the traffic car never recovered its lane heading`); }
    }
    if (carry.error) { failed = true; console.error(`FAIL C: ${carry.error}`); }
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
console.log(failed ? '\nCrash probe FAILED' : '\nCrash probe ok');
process.exit(failed ? 1 : 0);
