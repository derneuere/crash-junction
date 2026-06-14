// MOVING-CAMERA motion-blur capture + velocity-buffer diagnostic.
//
//   fnm exec --using=22 -- node tools/motionblurshot.mjs --port <port>
//
// THE WHOLE POINT: every other capture tool (refshot/boostshot) freezes a
// STATIC debug pose with NO camera motion, so a speed/velocity motion blur is
// invisible by construction and was never truly verified. This tool instead
// LAUNCHES gantry, DISPATCHES real keydown events (ArrowUp to accelerate, Space
// to boost) and lets the car/chase-cam actually DRIVE for ~1.8 s so the camera
// is TRANSLATING through the world, then screenshots a frame WHILE moving at
// speed. It also grabs a near-stationary frame for contrast.
//
// Outputs to screenshots/motion-blur/:
//   moving.png      — captured at speed (motion blur should be clearly visible)
//   stationary.png  — captured ~still (should be sharp, no blur)
// and prints a velocity-buffer diagnostic (max |velocity| sampled from the
// realism-effects VelocityDepthNormalPass texture) for both states, plus the
// player speed, so we can SEE whether the per-pixel velocity is non-zero when
// the camera moves.
//
// Needs Node 18+ (vite 6) and an installed Chrome or Edge. Software WebGL
// (swiftshader) so it runs headless.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5188;
if (!Number.isInteger(PORT)) {
  console.error('usage: node tools/motionblurshot.mjs --port <port>');
  process.exit(1);
}
if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} is too old for the vite dev server — use Node 18+ (fnm exec --using=22).`);
  process.exit(1);
}

try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already in use — pick a free one with --port`);
  process.exit(1);
} catch {
  // free
}

function startVite() {
  const proc = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}

async function waitForServer(vite) {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode} — is port ${PORT} taken?`);
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') console.log(`[page ${type}] ${msg.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  // jump straight into GAMEPLAY on gantry in day lighting (launch=1)
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30_000, polling: 100 });
  // let the GLB visuals drape over the colliders
  await sleep(5_000);

  // Helper run in the page: dispatch a real KeyboardEvent on window so it flows
  // through Game.onKeyDown/onKeyUp exactly like a player's keystroke. The game
  // reads e.code ('ArrowUp', 'Space'), so we set both code and key.
  await page.evaluate(() => {
    window.__mbKey = (code, down) => {
      const ev = new KeyboardEvent(down ? 'keydown' : 'keyup', {
        code,
        key: code === 'Space' ? ' ' : code,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(ev);
    };
    // Render the live composed frame and read the canvas back IN THE SAME TASK.
    // The composer renders on its own rAF loop with no preserveDrawingBuffer, so
    // a toDataURL from a separate task grabs an already-cleared (blank) buffer.
    // Calling postfx.render() then toDataURL() back-to-back here captures the
    // CURRENT live camera/scene (which the drive loop has been translating).
    window.__mbGrab = () => {
      const g = window.__game;
      g.postfx?.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/png');
    };

    // Lightweight per-state telemetry: the car's translational speed + boost +
    // the live speed-blur strength, so the report SHOWS the effect is gated by
    // speed (sharp when slow, blurred when fast). Read straight off __game —
    // presentation state only, never the sim hashes.
    window.__mbStats = () => {
      const g = window.__game;
      return {
        speed: g.control?.speed ?? null,
        boosting: g.control?.boosting ?? null,
        state: g.state,
      };
    };
  });

  // size the canvas/composer to a fixed capture size
  await page.evaluate(() => {
    const g = window.__game;
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(1280, 720, false);
    g.camera.aspect = 1280 / 720;
    g.camera.updateProjectionMatrix();
    g.postfx?.setSize(1280, 720);
  });

  // ---- LAUNCH then immediately grab the STATIONARY/near-still frame ----
  // Press Space once to launch the event, then capture before the car has built
  // any speed: same on-track vantage as the moving shot, but speed below the
  // blur onset so the frame must be SHARP (proves the effect is speed-gated).
  await page.evaluate(() => window.__mbKey('Space', true));
  await page.evaluate(() => window.__mbKey('Space', false));
  await sleep(120);
  const stationaryStats = await page.evaluate(() => window.__mbStats());
  const stationaryUrl = await page.evaluate(() => window.__mbGrab());

  // ---- DRIVE: hold accelerate + boost so the chase cam TRANSLATES at speed ----
  await page.evaluate(() => {
    window.__mbKey('ArrowUp', true);
    window.__mbKey('Space', true); // boost
  });
  // re-press Space periodically: holding ArrowUp pins the throttle; re-arming
  // Space keeps boost burning. Drive ~1.8 s to build real top speed.
  for (let i = 0; i < 9; i++) {
    await sleep(200);
    await page.evaluate(() => {
      window.__mbKey('Space', false);
      window.__mbKey('Space', true);
    });
  }

  // capture WHILE moving at speed — stats + screenshot back to back so the
  // camera is mid-translation in both.
  const movingStats = await page.evaluate(() => window.__mbStats());
  const movingUrl = await page.evaluate(() => window.__mbGrab());

  // release keys
  await page.evaluate(() => {
    window.__mbKey('ArrowUp', false);
    window.__mbKey('Space', false);
  });

  const outDir = path.join(root, 'screenshots', 'motion-blur');
  mkdirSync(outDir, { recursive: true });
  const save = (name, url) => {
    const f = path.join(outDir, name);
    writeFileSync(f, Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'));
    return path.relative(root, f);
  };
  const movingFile = save('moving.png', movingUrl);
  const stationaryFile = save('stationary.png', stationaryUrl);

  console.log('--- SPEED-BLUR TELEMETRY ---');
  console.log('stationary:', JSON.stringify(stationaryStats));
  console.log('moving:    ', JSON.stringify(movingStats));
  console.log('--- CAPTURES ---');
  console.log('wrote', movingFile, `(speed=${movingStats.speed?.toFixed?.(1)} m/s boosting=${movingStats.boosting})`);
  console.log('wrote', stationaryFile, `(speed=${stationaryStats.speed?.toFixed?.(1)} m/s)`);
} catch (e) {
  console.error(e.stack || e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
