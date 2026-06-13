// Boost-flame capture harness (nitrous branch). Boots a vite dev server,
// drives headless Chrome/Edge onto a level, parks the player BOOSTING via
// window.__game.__debugBoostPose(), frames a chase camera behind the car so
// the blue nitrous jet out the back is in shot, and captures stills:
//
//   fnm exec --using=22 -- node tools/boostshot.mjs --port <port>
//
// Writes screenshots/boost/boost-<tod>.png for day + night (flame ON) plus a
// boost-off control (flame OFF, same pose). Echoes page console errors.
// Harness-only path: __debugBoostPose writes state directly and never touches
// the recorder/replay (see Game.ts) — determinism pins are unaffected.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5193;

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
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode}`);
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

async function clickButton(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const re2 = new RegExp(reSrc);
    const btn = [...document.querySelectorAll('button')].find((b) => re2.test(b.textContent?.trim() ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, re.source);
  if (!clicked) throw new Error(`no button matching ${re} on the page`);
}

/** Render one frame at the requested tod with the player parked. boost=true
 *  forces the nitrous jet on (via __debugBoostPose); boost=false leaves it off
 *  for the control shot. Chase camera sits behind + above the car's rear. */
async function capture(page, { tod, boost, burnout }) {
  return page.evaluate(
    async ({ tod, boost, burnout }) => {
      const g = window.__game;
      g.setGfx('cine');
      g.setTimeOfDay(tod);
      // settle the env swap
      await new Promise((res) => setTimeout(res, 600));
      g.director.update = () => {}; // freeze the idle orbit
      // always pose the car (clears scenery + parks it); boost flag drives the
      // jet on/off. Off-shot still parks but leaves boosting false afterwards.
      g.__debugBoostPose(burnout ? 44 : 36, burnout);
      const car = g.__debugPlayer();
      car.group.updateMatrixWorld(true);
      const p = car.group.position;
      const q = car.group.quaternion;
      // rotate the local backward axis (0,0,1) by the car quaternion — the rear
      // direction the jet points, in world space (no three import needed)
      const rot = (vx, vy, vz) => {
        const { x, y, z, w } = q;
        const ix = w * vx + y * vz - z * vy;
        const iy = w * vy + z * vx - x * vz;
        const iz = w * vz + x * vy - y * vx;
        const iw = -x * vx - y * vy - z * vz;
        return [
          ix * w + iw * -x + iy * -z - iz * -y,
          iy * w + iw * -y + iz * -x - ix * -z,
          iz * w + iw * -z + ix * -y - iy * -x,
        ];
      };
      const [bx, by, bz] = rot(0, 0, 1); // world backward axis
      if (!boost) {
        g.control.boosting = false; // control shot: jet off, same pose
        for (let i = 0; i < 30; i++) g.updateBoostFlames(1 / 60); // let it fade out
      }
      const r = g.renderer;
      const c = g.camera;
      r.setPixelRatio(1);
      r.setSize(1280, 720, false);
      c.aspect = 16 / 9;
      c.updateProjectionMatrix();
      // chase pose: behind the rear (along +back), lifted, looking just behind
      // the car at exhaust height so the jet fills the lower-centre frame.
      c.position.set(p.x + bx * 6.4, p.y + 1.7, p.z + bz * 6.4);
      c.lookAt(p.x + bx * 1.2, p.y + 0.3, p.z + bz * 1.2);
      c.updateMatrixWorld();
      if (g.skyRig) g.skyRig.renderClouds(r, c);
      if (r.toneMapping === 0 && g.postfx) {
        g.postfx.setSize(1280, 720);
        g.postfx.render(1 / 60);
        g.postfx.render(1 / 60);
      } else {
        r.render(g.scene, c);
      }
      return r.domElement.toDataURL('image/png');
    },
    { tod, boost, burnout },
  );
}

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.log(`[page ${t}] ${msg.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30_000, polling: 100 });
  await clickButton(page, /\bDAY\b/);
  await clickButton(page, /^CRASH JUNCTION$/);
  await page.waitForFunction(() => window.__game?.levelId === 'junction', { timeout: 30_000, polling: 100 });
  await new Promise((res) => setTimeout(res, 2500)); // settle the scene

  const outDir = path.join(root, 'screenshots', 'boost');
  mkdirSync(outDir, { recursive: true });

  const shots = [
    { name: 'day-on', tod: 'day', boost: true, burnout: false },
    { name: 'night-on', tod: 'night', boost: true, burnout: false },
    { name: 'night-burnout', tod: 'night', boost: true, burnout: true },
    { name: 'day-off', tod: 'day', boost: false, burnout: false },
  ];
  for (const s of shots) {
    const dataUrl = await capture(page, s);
    const out = path.join(outDir, `boost-${s.name}.png`);
    writeFileSync(out, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    console.log(`wrote ${path.relative(root, out)}`);
  }
} catch (e) {
  console.error(e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
