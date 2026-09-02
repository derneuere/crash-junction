// Driving-model probe: boots the junction level headless, flattens the height
// field, teleports the player to open ground and runs scripted manoeuvres
// through the real fixed step (g.advance), reporting what the force model did:
//   accel      — straight-line throttle from rest (speed at 1/2/3/4 s, gear)
//   brake      — full stop from cruise (time + distance)
//   cornerL    — held gripped corner at ~25 m/s (slip, yaw rate, radius, speed)
//   driftL/R   — tap-to-drift then hold 3 s, release 1.5 s (slip hold, speed
//                retention, yaw rate, front-wheel angle sign = countersteer,
//                exit time after straightening)
//   driftCoast — the same slide with the throttle lifted (speed bleed)
// Pure read-out — never records a tape, so it can't pollute a fixture.
//
//   node tests/drive-probe.mjs            (JSON report on stdout)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.REPLAY_PORT ?? 5189);

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

  await page.goto(`http://localhost:${PORT}/?level=junction&launch=1&verify=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.levelId === 'junction', { timeout: 15000 });

  // Install the harness once: flat ground, a teleport/reset helper and a
  // sampling runner that pumps fixed steps with a key script.
  await page.evaluate(() => {
    const g = window.__game;
    g.launch();
    const flat = (x, z) => 0;
    flat.base = () => 0;
    flat.feature = () => 0;
    g.heightAt = flat;
    if (g.director) g.director.update = () => {};
    window.__probe = {
      place(x, z) {
        const b = g.player.body;
        g.control.reset(0);
        b.position.set(x, 0.8, z);
        b.velocity.set(0, 0, 0);
        b.angularVelocity.set(0, 0, 0);
        // hull forward is -z local: yaw π faces +z (heading 0)
        b.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
        b.wakeUp();
      },
      // script = [[keysObject, seconds], ...]; samples every `every` seconds
      run(script, every = 0.25) {
        const dt = 1 / 120;
        const c = g.control;
        const b = g.player.body;
        const samples = [];
        let t = 0;
        let nextSample = 0;
        const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
        let maxSlip = 0;
        let minSpeed = Infinity;
        let maxSpeed = 0;
        let maxUpTilt = 0;
        let headingStart = c.heading;
        let exitAt = null; // first time drifting reads false after the hold phase
        let holdEnd = null;
        let phase = 0;
        for (const [keys, secs] of script) {
          const steps = Math.round(secs / dt);
          for (let i = 0; i < steps; i++) {
            g.simKeys = { ...keys };
            g.advance(dt, false, []);
            t += dt;
            const planar = Math.hypot(b.velocity.x, b.velocity.z);
            const slip = (wrap(c.heading - c.velAngle) * 180) / Math.PI;
            if (Math.abs(slip) > Math.abs(maxSlip) && planar > 3) maxSlip = slip;
            minSpeed = Math.min(minSpeed, planar);
            maxSpeed = Math.max(maxSpeed, planar);
            if (holdEnd !== null && exitAt === null && !c.drifting) exitAt = +(t - holdEnd).toFixed(3);
            if (t >= nextSample - 1e-9) {
              samples.push({
                t: +t.toFixed(2),
                v: +planar.toFixed(1),
                slip: +slip.toFixed(1),
                yaw: +b.angularVelocity.y.toFixed(2),
                drift: c.drifting ? 1 : 0,
                ds: +c.driftScale.toFixed(2),
                gear: c.gear,
                wheel: +((c.steerAngle * 180) / Math.PI).toFixed(0),
              });
              nextSample += every;
            }
          }
          phase++;
          if (phase === script.length - 1) holdEnd = t; // the last phase is the release
        }
        const headingTurn = (wrap(c.heading - headingStart) * 180) / Math.PI;
        return {
          samples,
          maxSlip: +maxSlip.toFixed(1),
          minSpeed: +minSpeed.toFixed(1),
          maxSpeed: +maxSpeed.toFixed(1),
          headingTurn: +headingTurn.toFixed(0),
          exitAfterRelease: exitAt,
          finalDrifting: c.drifting,
          pos: { x: +b.position.x.toFixed(1), y: +b.position.y.toFixed(2), z: +b.position.z.toFixed(1) },
          nan: !Number.isFinite(b.position.x + b.position.y + b.position.z + b.velocity.x),
        };
      },
    };
  });

  const scenario = (name, script, every) =>
    page.evaluate(
      (script, every) => {
        window.__probe.place(600, 600);
        return window.__probe.run(script, every);
      },
      script,
      every,
    );

  const UP = { ArrowUp: true };
  const out = {};
  out.accel = await scenario('accel', [[UP, 4]], 0.5);
  out.brake = await scenario('brake', [[UP, 4], [{ ArrowDown: true }, 3]], 0.25);
  out.cornerL = await scenario('cornerL', [[UP, 3], [{ ArrowUp: true, ArrowLeft: true }, 3]], 0.5);
  out.cornerR = await scenario('cornerR', [[UP, 3], [{ ArrowUp: true, ArrowRight: true }, 3]], 0.5);
  const driftScript = (dir) => [
    [UP, 3.5],
    [{ ArrowUp: true, ArrowDown: true, [dir]: true }, 0.25],
    [{ ArrowUp: true, [dir]: true }, 3],
    [UP, 1.5],
  ];
  out.driftL = await scenario('driftL', driftScript('ArrowLeft'), 0.25);
  out.driftR = await scenario('driftR', driftScript('ArrowRight'), 0.25);
  out.driftCoast = await scenario('driftCoast', [
    [UP, 3.5],
    [{ ArrowDown: true, ArrowLeft: true }, 0.25],
    [{ ArrowLeft: true }, 3],
    [{}, 1.5],
  ], 0.25);
  // countersteer mid-drift: hold the slide 1.5 s then steer the OTHER way
  out.driftCounter = await scenario('driftCounter', [
    [UP, 3.5],
    [{ ArrowUp: true, ArrowDown: true, ArrowLeft: true }, 0.25],
    [{ ArrowUp: true, ArrowLeft: true }, 1.5],
    [{ ArrowUp: true, ArrowRight: true }, 1.5],
    [UP, 1],
  ], 0.25);

  console.log(JSON.stringify(out, null, 1));
  await browser.close();
} finally {
  try {
    spawn('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    vite.kill();
  }
}
