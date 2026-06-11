// Replay regression tests: every fixture in tests/replays/ is a recorded
// physics bug report (or a determinism pin). The runner boots the dev server,
// drives a headless Chrome/Edge through ?replay=<fixture>&verify=1 and
// asserts the ReplayStats envelope from tests/replays/manifest.json.
//
// Stats vs checksums: a bug fixture's input tape stays valid forever, but its
// checksums pin the exact sim that recorded it — any physics fix diverges
// them by design. Bug fixtures therefore assert behavior (stats) with
// "checksums": "ignore"; use "require" only for determinism pins recorded on
// the current sim.
//
// Needs Node 18+ (the dev server is vite 6) and an installed Chrome or Edge.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5175;

if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} is too old for the vite dev server — use Node 18+ (fnm use 22).`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(root, 'tests', 'replays', 'manifest.json'), 'utf8'));

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
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await puppeteer.launch({
        channel,
        headless: true,
        // software WebGL — headless machines have no GPU
        args: ['--enable-unsafe-swiftshader', '--mute-audio'],
      });
    } catch (e) {
      errors.push(`${channel}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome or Edge found for puppeteer-core:\n${errors.join('\n')}`);
}

async function runFixture(browser, entry) {
  const page = await browser.newPage();
  const failures = [];
  let dialogText = null;
  page.on('dialog', (d) => {
    dialogText = d.message(); // the app alert()s on replay-load problems
    d.dismiss().catch(() => {});
  });
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  try {
    const fixtureAbs = path.join(root, 'tests', 'replays', entry.file).replace(/\\/g, '/');
    const url = `http://localhost:${PORT}/?replay=${encodeURIComponent(`/@fs/${fixtureAbs}`)}&verify=1`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__replayResult !== undefined, { timeout: 120_000, polling: 250 });
    const res = await page.evaluate(() => window.__replayResult);

    if (res.aborted) failures.push('replay aborted');
    if (res.framesPlayed !== res.framesTotal) failures.push(`played ${res.framesPlayed}/${res.framesTotal} frames`);
    if (entry.checksums === 'require' && res.diverged) {
      failures.push(`diverged at step ${res.diverged.step} (${res.diverged.body?.desc ?? 'unknown body'})`);
    }
    for (const [key, limit] of Object.entries(entry.assert ?? {})) {
      const actual = res.stats?.[key];
      if (typeof actual !== 'number') failures.push(`stats.${key} missing`);
      else if (actual > limit) failures.push(`stats.${key} = ${actual.toFixed(2)} exceeds ${limit}`);
    }
    for (const [key, floor] of Object.entries(entry.assertMin ?? {})) {
      const actual = res.stats?.[key];
      if (typeof actual !== 'number') failures.push(`stats.${key} missing`);
      else if (actual < floor) failures.push(`stats.${key} = ${actual.toFixed(2)} below ${floor}`);
    }
    return { failures, stats: res.stats };
  } catch (e) {
    failures.push(dialogText ? `dialog: ${dialogText}` : e.message);
    return { failures, stats: null };
  } finally {
    await page.close().catch(() => {});
  }
}

const vite = startVite();
let failed = 0;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    for (const entry of manifest) {
      const { failures, stats } = await runFixture(browser, entry);
      const statsStr = stats
        ? `alt ${stats.maxAltitude.toFixed(2)}m, vy ${stats.maxUpwardSpeed.toFixed(2)}m/s, tilt ${stats.maxTiltDeg.toFixed(0)}°`
        : 'no stats';
      if (failures.length === 0) {
        console.log(`PASS  ${entry.name}  (${statsStr})`);
      } else {
        failed++;
        console.error(`FAIL  ${entry.name}  (${statsStr})`);
        for (const f of failures) console.error(`      - ${f}`);
      }
    }
  } finally {
    await browser.close();
  }
} catch (e) {
  console.error(e.message);
  failed++;
} finally {
  vite.kill();
}
console.log(failed ? `\n${failed} fixture(s) failed` : '\nall replay fixtures passed');
process.exit(failed ? 1 : 0);
