// Multi-pose studio screenshot harness for PROCEDURAL cars.
//
//   fnm exec --using=22 -- node tools/procshot.mjs [--car metro] [--tag work]
//                                 [--poses side,front,...] [--color 0xRRGGBB]
//                                 [--port 5195] [--wheel five-spoke]
//
// The procgen iteration loop: boots a vite dev server, opens
// tools/procshot-page.html (which builds the recipe's VehicleModel directly —
// no game boot, so it's FAST), captures every pose into
// screenshots/proc/<tag>-<pose>.png, and exits. Poses include full views
// (side/front/rear/front34/rear34/top) and part close-ups (nose/tail/wheel).
// Compare the outputs against references/ and iterate on the part modules.
//
// Modeled on tools/garageshot.mjs: own puppeteer-core + swiftshader, page
// diagnostics echoed to stdout. Needs Node 18+ and Chrome or Edge.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const PORT = Number(flag('--port', 5195));
const CAR = flag('--car', 'metro');
const TAG = flag('--tag', 'shot');
const ONLY = flag('--poses', null);
const COLOR = flag('--color', null);
// --wheel <style>: render the recipe with another WheelStyle (wheel-builder iteration)
const WHEEL = flag('--wheel', null);
// --ref <image>: ALSO write <tag>-<pose>-vs.png with the render stacked over
// the reference photo at matched width — the precise-comparison view.
const REF = flag('--ref', null);
// --tod night: moonlit studio with the lenses at the game's night emissive
const TOD = flag('--tod', 'day');
// --lamps brake,reverse: light the brake / reverse lenses (lamp-behaviour preview)
const LAMPS = (flag('--lamps', '') || '').split(',').map((s) => s.trim());

if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} too old — use fnm exec --using=22.`);
  process.exit(1);
}

try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} already in use — pick a free one with --port`);
  process.exit(1);
} catch {
  // ours
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
      // not up
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`dev server did not come up on ${PORT}`);
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
  throw new Error(`no Chrome or Edge for puppeteer-core:\n${errors.join('\n')}`);
}

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') console.log(`[page ${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/tools/procshot-page.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__proc?.ready === true, { timeout: 30_000, polling: 100 });

  const ok = await page.evaluate(
    (id, color, wheel) => window.__proc.setCar(id, color ? Number(color) : undefined, wheel ?? undefined),
    CAR,
    COLOR,
    WHEEL,
  );
  if (!ok) throw new Error(`unknown recipe id '${CAR}' (page cars: ${await page.evaluate(() => window.__proc.cars.join(','))})`);

  await page.evaluate((tod, brake, reverse) => {
    window.__proc.setLighting(tod);
    window.__proc.setLamps(brake, reverse);
  }, TOD === 'night' ? 'night' : 'day', LAMPS.includes('brake') ? 1 : 0, LAMPS.includes('reverse') ? 1 : 0);
  console.log(`tris ${JSON.stringify(await page.evaluate(() => window.__proc.stats()))}`);

  const poses = ONLY ? ONLY.split(',').map((s) => s.trim()) : await page.evaluate(() => window.__proc.poses);
  const outDir = path.join(root, 'screenshots', 'proc');
  mkdirSync(outDir, { recursive: true });

  let refUrl = null;
  if (REF) {
    const refPath = path.isAbsolute(REF) ? REF : path.join(root, REF);
    const ext = path.extname(refPath).toLowerCase();
    const mime = ext === '.webp' ? 'image/webp' : ext === '.png' ? 'image/png' : 'image/jpeg';
    refUrl = `data:${mime};base64,${readFileSync(refPath).toString('base64')}`;
  }

  for (const pose of poses) {
    const dataUrl = await page.evaluate((p) => window.__proc.shoot(p), pose);
    if (!dataUrl) {
      console.log(`unknown pose '${pose}' — skipped`);
      continue;
    }
    const outFile = path.join(outDir, `${TAG}-${pose}.png`);
    writeFileSync(outFile, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    console.log(`wrote ${path.relative(root, outFile)}`);
    if (refUrl) {
      // composite render-over-reference at matched width, in the page's 2D canvas
      const vsUrl = await page.evaluate(async (shot, ref, label) => {
        const load = (src) => new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = src;
        });
        const [a, b] = await Promise.all([load(shot), load(ref)]);
        const W = 1280;
        const ah = Math.round((a.height * W) / a.width);
        const bh = Math.round((b.height * W) / b.width);
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = ah + bh + 26;
        const g = cv.getContext('2d');
        g.fillStyle = '#101216';
        g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(a, 0, 0, W, ah);
        g.drawImage(b, 0, ah + 26, W, bh);
        g.fillStyle = '#d8dde3';
        g.font = '16px sans-serif';
        g.fillText(`render · ${label}`, 8, ah + 18);
        return cv.toDataURL('image/png');
      }, dataUrl, refUrl, pose);
      const vsFile = path.join(outDir, `${TAG}-${pose}-vs.png`);
      writeFileSync(vsFile, Buffer.from(vsUrl.slice('data:image/png;base64,'.length), 'base64'));
      console.log(`wrote ${path.relative(root, vsFile)}`);
    }
  }
} catch (e) {
  console.error(e.stack || e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
