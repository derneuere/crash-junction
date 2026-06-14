// Headless screenshot harness for the GARAGE showroom (CarSelect scene).
//
//   fnm exec --using=22 -- node tools/garageshot.mjs --port <port> [--tag before]
//
// Boots a vite dev server, opens tools/garageshot-page.html (which bakes the
// vehicle library and mounts a GarageScene), then for every PLAYER_CAR pins a
// three-quarter orbit and captures the canvas into
// screenshots/garage/<tag>-<carId>.png. Mirrors tools/refshot.mjs: own
// puppeteer-core + swiftshader, page diagnostics echoed to stdout.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5188;
const tagIdx = args.indexOf('--tag');
const TAG = tagIdx >= 0 ? args[tagIdx + 1] : 'shot';

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
  await page.setViewport({ width: 960, height: 720, deviceScaleFactor: 1 });
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') console.log(`[page ${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  page.on('requestfailed', (req) => console.log(`[request failed] ${req.url()} (${req.failure()?.errorText})`));
  page.on('response', (res) => {
    if (res.status() >= 400) console.log(`[http ${res.status()}] ${res.url()}`);
  });

  await page.goto(`http://localhost:${PORT}/tools/garageshot-page.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__garage?.ready === true, { timeout: 30_000, polling: 100 });

  const cars = await page.evaluate(() => window.__garage.cars);
  const outDir = path.join(root, 'screenshots', 'garage');
  mkdirSync(outDir, { recursive: true });

  // two orbit angles: a three-quarter front (default) and a near-side profile
  // so the wheels + sill seating are visible on a flat flank.
  const POSES = [
    { name: '', orbit: Math.PI * 0.22 },
    { name: '-side', orbit: Math.PI * 0.5 },
  ];

  for (const c of cars) {
    await page.evaluate((id) => window.__garage.setCar(id), c.id);
    for (const pose of POSES) {
      const dataUrl = await page.evaluate((orbit) => {
        window.__garage.renderPose(orbit);
        return document.getElementById('cv').toDataURL('image/png');
      }, pose.orbit);
      const outFile = path.join(outDir, `${TAG}-${c.id}${pose.name}.png`);
      writeFileSync(outFile, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
      console.log(`wrote ${path.relative(root, outFile)} (${c.label})`);
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
