// Side-profile GLASS crash-test harness.
//
//   fnm exec --using=22 -- node tools/glass-crash.mjs [--port <port>]
//                                  [--speeds 8,16,28,40] [--tod day|dusk|night]
//                                  [--gfx cine|fast] [--tint <hex>]
//
// A fixed-POV iteration loop for the car-glass work. For each impact speed it
// boots a vite dev server, drives a headless Chrome/Edge onto the junction,
// LOCKS a side-on camera, and calls window.__game.crashTest(speed) — a
// debug-only hook (Game.ts) that drops a wall to the car's +X side, marks the
// player a wreck and shoves it laterally into the wall at that speed. The
// windscreen cracks → frosts → blows; the harness watches the player's X cross
// the wall to anchor an APPROACH → IMPACT → SHATTER → SETTLE frame sequence,
// then composites one labelled CONTACT SHEET per speed into
// screenshots/glass/crash-<tod>-<gfx>-<speed>mps.png.
//
// Modeled on tools/refshot.mjs (same vite-spawn + composer-aware capture). The
// crash hook is determinism-safe: it writes physics state directly and is only
// ever reached here, never during a recorded take or a replay (see Game.ts
// crashTest doc). Contact-sheet compositing is done in-browser on a 2D canvas,
// so the harness needs no image deps beyond puppeteer-core.
//
// Needs Node 18+ (the dev server is vite 6) and an installed Chrome or Edge.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- CLI ----
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const PORT = Number(flag('--port', 5189));
const SPEEDS = String(flag('--speeds', '8,16,28,40'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((s) => s > 0);
const TOD = flag('--tod', 'day'); // day | dusk | night
const GFX = flag('--gfx', 'cine'); // cine | fast
const TINT = flag('--tint', null); // optional hex, e.g. 0x3a4654 privacy
const DETAIL = args.includes('--detail'); // static 4-up: intact→crack→frost→blow

if (!Number.isInteger(PORT) || !SPEEDS.length) {
  console.error('usage: node tools/glass-crash.mjs [--port N] [--speeds 8,16,28,40] [--tod day|dusk|night] [--gfx cine|fast] [--tint 0xRRGGBB]');
  process.exit(1);
}
if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} is too old for the vite dev server — use Node 18+ (fnm exec --using=22).`);
  process.exit(1);
}

// The locked side-on pose: camera on the +Z axis looking straight down -Z at
// the impact zone, so the car crosses frame LEFT→RIGHT (running in along +X
// from x≈-14) and slams the wall at +X≈2.5 on the right. Tight enough to read
// the windscreen cracking; centred a touch left so the approach shows too.
const SIDE_CAM = [0.4, 1.45, 4.8];
const SIDE_LOOK = [0.4, 1.0, 0];

// --detail static close-up on the windscreen (no motion, so glass tint +
// transmission + the crack web read clearly). Slightly high and off-axis.
const DETAIL_CAM = [0.55, 1.62, 2.35];
const DETAIL_LOOK = [0.0, 1.28, 0.45];

const W = 960;
const H = 540;

// Refuse a busy port up front (vite --strictPort would die mid-boot).
try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already in use — pick a free one with --port`);
  process.exit(1);
} catch {
  // nothing answered — the port is ours
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

const CAM = DETAIL ? DETAIL_CAM : SIDE_CAM;
const LOOK = DETAIL ? DETAIL_LOOK : SIDE_LOOK;

/** Freeze the camera director onto the locked pose and size the renderer.
 *  Mirrors refshot's freeze trick; safe to re-run each shot. */
async function lockSidePose(page) {
  await page.evaluate(({ cam, look, w, h, tod, gfx, tint }) => {
    const g = window.__game;
    g.setTimeOfDay?.(tod);
    g.setGfx?.(gfx);
    if (tint != null && g.setGlassParams) g.setGlassParams({ tint });
    g.director.update = () => {}; // freeze: the idle orbit must not fight the pose
    const r = g.renderer;
    const c = g.camera;
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    g.postfx?.setSize(w, h);
    c.aspect = w / h;
    c.updateProjectionMatrix();
    c.position.set(cam[0], cam[1], cam[2]);
    c.lookAt(look[0], look[1], look[2]);
  }, { cam: CAM, look: LOOK, w: W, h: H, tod: TOD, gfx: GFX, tint: TINT == null ? null : Number(TINT) });
}

/** Render one frame through the active path (composer at NoToneMapping in cine,
 *  bare renderer in fast — same branch refshot uses) and return its data URL.
 *  Re-pins the locked pose each call: the frozen director can't, but a wreck
 *  tumble or a respawn could nudge the camera otherwise. */
async function grab(page) {
  return page.evaluate(({ cam, look }) => {
    const g = window.__game;
    const r = g.renderer;
    const c = g.camera;
    c.position.set(cam[0], cam[1], cam[2]);
    c.lookAt(look[0], look[1], look[2]);
    if (r.toneMapping === 0 && g.postfx) {
      g.postfx.render(1 / 60);
      g.postfx.render(1 / 60); // settle the velocity buffer (motion blur)
    } else {
      r.render(g.scene, c);
    }
    return r.domElement.toDataURL('image/png');
  }, { cam: CAM, look: LOOK });
}

const playerXV = (page) =>
  page.evaluate(() => {
    const p = window.__game?.__debugPlayer?.();
    return p ? { x: p.body.position.x, vx: p.body.velocity.x } : null;
  });

/** Composite a row of labelled frames into one contact-sheet PNG, in-browser. */
async function contactSheet(page, frames, heading, scale = 0.5) {
  return page.evaluate(async ({ frames, heading, w, h, scale }) => {
    const cols = frames.length;
    const pad = 8;
    const labelH = 26;
    const headH = 30;
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    const cv = document.createElement('canvas');
    cv.width = cols * cw + (cols + 1) * pad;
    cv.height = headH + ch + labelH + pad * 2;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#cfe0ee';
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText(heading, pad, 20);
    const load = (url) =>
      new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.src = url;
      });
    for (let i = 0; i < frames.length; i++) {
      const im = await load(frames[i].url);
      const x = pad + i * (cw + pad);
      const y = headH + pad;
      ctx.drawImage(im, x, y, cw, ch);
      ctx.fillStyle = '#9fb3c4';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillText(frames[i].label, x + 2, y + ch + 17);
    }
    return cv.toDataURL('image/png');
  }, { frames, heading, w: W, h: H, scale });
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const vite = startVite();
let browser = null;
let failed = false;
const outDir = path.join(root, 'screenshots', 'glass');
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') console.log(`[page ${type}] ${msg.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30_000, polling: 100 });
  // the baked car models stream in async — wait for the player to carry glass
  await page.waitForFunction(
    () => {
      const g = window.__game;
      const p = g?.__debugPlayer?.();
      return !!p && p.deformables.some((d) => d.glass && d.glass.length);
    },
    { timeout: 30_000, polling: 150 },
  ).catch(() => console.log('[warn] player glass not confirmed — capturing anyway'));

  mkdirSync(outDir, { recursive: true });

  if (DETAIL) {
    // static windscreen close-up stepping ONE pane through the three stages,
    // so the glass tint + transmission + the spider-web crack all read with
    // no motion blur. FAST is forced for a crisp frame regardless of --gfx.
    await page.evaluate(() => window.__game?.__debugReset?.());
    await page.evaluate(() => window.__game?.__debugParkForGlass?.());
    await lockSidePose(page);
    await sleep(250);
    const frames = [];
    frames.push({ label: 'INTACT', url: await grab(page) });
    // a gentle tap → spider-web crack
    await page.evaluate(() => window.__game.__debugGlassHit(2));
    await sleep(60);
    frames.push({ label: 'CRACK', url: await grab(page) });
    // a second tap → frost/spall
    await page.evaluate(() => window.__game.__debugGlassHit(2));
    await sleep(60);
    frames.push({ label: 'FROST', url: await grab(page) });
    // a hard hit → blow the pane out (a hole onto the dark interior)
    await page.evaluate(() => window.__game.__debugGlassHit(99));
    await sleep(60);
    frames.push({ label: 'BLOWN', url: await grab(page) });
    const heading = `GLASS DETAIL · windscreen · ${TOD.toUpperCase()} · ${GFX.toUpperCase()}${TINT != null ? ` · tint ${TINT}` : ''}`;
    const sheet = await contactSheet(page, frames, heading, 0.82);
    const tag = TINT != null ? `-tint${Number(TINT).toString(16)}` : '';
    const file = path.join(outDir, `detail-${TOD}-${GFX}${tag}.png`);
    writeFileSync(file, Buffer.from(sheet.slice('data:image/png;base64,'.length), 'base64'));
    console.log(`wrote ${path.relative(root, file)} (${frames.map((f) => f.label).join(' → ')})`);
  } else
  for (const speed of SPEEDS) {
    // fresh take so each speed starts from an intact car
    await page.evaluate(() => window.__game?.__debugReset?.());
    await lockSidePose(page);
    await sleep(150);

    // launch the lateral crash
    await page.evaluate((s) => window.__game.crashTest(s), speed);

    // anchor on impact: the car runs in at +vx; impact is when it reaches the
    // wall (x ≳ 0.6) or its X velocity reverses (it bounced off). Grab the
    // APPROACH frame mid-run so the intact glass + the wall both read.
    const t0 = Date.now();
    const frames = [];
    let approached = false;
    let impactAt = null;
    let maxX = -99;
    const budget = 6000; // ms of wall-clock per speed
    while (Date.now() - t0 < budget) {
      const s = await playerXV(page);
      if (s) {
        maxX = Math.max(maxX, s.x);
        // approach frame the moment the car is moving (and roughly in frame)
        if (!approached && s.x > -4.5) {
          approached = true;
          frames.push({ label: 'APPROACH', url: await grab(page) });
        }
        // impact: reached the wall (x≳0.3) or its X velocity reversed (bounced)
        // or it stalled near the wall (vx≈0 after travelling)
        if (impactAt === null && approached && (s.x > 0.3 || s.vx < -1 || (maxX > -2 && Math.abs(s.vx) < 0.5))) {
          impactAt = Date.now();
          frames.push({ label: 'IMPACT', url: await grab(page) });
          break;
        }
      }
      await sleep(25);
    }
    if (!approached) frames.push({ label: 'APPROACH', url: await grab(page) });
    if (impactAt === null) {
      frames.push({ label: 'IMPACT?', url: await grab(page) });
      impactAt = Date.now();
    }
    // SHATTER a beat after contact (panes frost/blow as the tumble lands more
    // hits), SETTLE once the wreck eases
    await sleep(220);
    frames.push({ label: 'SHATTER', url: await grab(page) });
    await sleep(1100);
    frames.push({ label: 'SETTLE', url: await grab(page) });

    const heading = `GLASS CRASH-TEST · ${speed} m/s · ${TOD.toUpperCase()} · ${GFX.toUpperCase()}${TINT != null ? ` · tint ${TINT}` : ''}`;
    const sheet = await contactSheet(page, frames, heading);
    const file = path.join(outDir, `crash-${TOD}-${GFX}-${String(speed).padStart(2, '0')}mps.png`);
    writeFileSync(file, Buffer.from(sheet.slice('data:image/png;base64,'.length), 'base64'));
    console.log(`wrote ${path.relative(root, file)} (${frames.map((f) => f.label).join(' → ')})`);
  }
} catch (e) {
  console.error(e.stack ?? e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
