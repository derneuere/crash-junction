// One-off visual-verification harness for the menu-ui branch (Task A font fix +
// Task B loading/warmup flow). Own headless browser (swiftshader), own vite dev
// server — the shared preview window may be hidden/blank, so we drive our own.
//
//   fnm exec --using=22 -- node tools/menucap.mjs --port <port>
//
// Captures, into screenshots/menu-ui/:
//   title.png        — the TITLE screen wordmark (font fix; nothing clipped)
//   main.png         — MAIN MENU "SELECT OPTION" heading
//   events.png       — EVENT SELECT heading
//   garage.png       — CAR SELECT "SELECT YOUR RIDE" heading
//   gantry-load.png  — the LOADING overlay up over a gantry mount (covers the hitch)
//   gantry-run.png   — a beat later: the event is RUNNING directly (no idle preview)
//
// Also asserts (to stdout) that after the menu→gameplay flow the game ends up
// in a launched/driving state (auto-launch), not idle.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5188;
const outDir = path.join(root, 'screenshots', 'menu-ui');

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
  for (let i = 0; i < 120; i++) {
    if (vite.exitCode !== null) throw new Error(`vite exited with code ${vite.exitCode}`);
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`dev server did not come up on port ${PORT}`);
}

async function launchBrowser() {
  const errors = [];
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const target of candidates) {
    try {
      return await puppeteer.launch({
        ...target,
        headless: true,
        args: ['--enable-unsafe-swiftshader', '--mute-audio', '--window-size=1280,800'],
      });
    } catch (e) {
      errors.push(`${target.channel ?? target.executablePath}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome or Edge found:\n${errors.join('\n')}`);
}

async function clickButton(page, reSrc) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const btn = [...document.querySelectorAll('button, .menuRow, .driveBtn, .launchRow')]
      .find((b) => re.test(b.textContent?.trim() ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, reSrc);
}

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  mkdirSync(outDir, { recursive: true });

  const shot = async (name) => {
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`wrote screenshots/menu-ui/${name}.png`);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- TITLE (font fix) ----
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  // bumper plays ~1.6s then the title card; wait it out + a beat for the anim
  await sleep(2400);
  await shot('title');

  // ---- walk the menu flow with explicit waits, capturing each heading ----
  // title → main: click the title screen (advance() handles bumper/title)
  await page.evaluate(() => document.querySelector('.titleScreen')?.click());
  await page.waitForSelector('.menuScreen', { timeout: 5000 });
  await sleep(300);
  await shot('main'); // SELECT OPTION

  // main → events: click the PLAY row (its textContent includes the sub-label,
  // so match the row whose label span is exactly PLAY)
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.menuRow')]
      .find((r) => r.querySelector('.menuRowLabel')?.textContent?.trim() === 'PLAY');
    row?.click();
  });
  await page.waitForSelector('.eventScreen', { timeout: 5000 });
  await sleep(300);
  await shot('events'); // SELECT EVENT / CRASH JUNCTION ISLANDS

  // events → garage: point the highlight at GANTRY first (heavy level), then
  // LAUNCH → CAR SELECT. ArrowRight walks the strip; click the gantry card.
  const launched = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.eventCards .card')]
      .find((c) => /GANTRY/i.test(c.textContent ?? ''));
    if (!card) return false;
    card.click(); // focus the gantry card
    // then fire its own LAUNCH row (advances to CAR SELECT)
    const launch = card.querySelector('.launchRow');
    if (launch) { launch.click(); return true; }
    return false;
  });
  await page.waitForSelector('.garageSel', { timeout: 5000 });
  await sleep(400);
  await shot('garage'); // SELECT YOUR RIDE

  // ---- PLAYER FLOW: CarSelect SELECT → gameplay (AUTO-LAUNCH on gantry) ----
  const selClicked = await clickButton(page, '^SELECT$'); // garage SELECT → gameplay
  // the overlay should be up the instant the mount begins
  await sleep(80);
  await shot('load-firstframe');
  const duringLoad = await page.evaluate(() => ({
    loadingUp: !!document.querySelector('.loadingScreen'),
    level: window.__game?.levelId ?? null,
  }));
  // let warmup + min-beat elapse — overlay dismisses straight INTO the event
  await sleep(3000);
  await shot('run-after-load');
  const afterFlow = await page.evaluate(() => ({
    level: window.__game?.levelId ?? null,
    state: window.__game ? window.__game.state : null,
    loadingGone: !document.querySelector('.loadingScreen'),
  }));
  console.log(`[player-flow] launched=${launched} selClicked=${selClicked} duringLoad=${JSON.stringify(duringLoad)}`);
  console.log(`[player-flow] after: level=${afterFlow.level} state=${afterFlow.state} (1=Launch expected — auto-launch into the event) loadingGone=${afterFlow.loadingGone}`);

  // ---- explicit GANTRY mount via the fast path (warm-mount, idle) to capture
  // the overlay sitting over gantry's heavy construction ----
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  // capture early: the LOADING overlay should be covering the gantry construction
  await sleep(120);
  await shot('gantry-load');
  // wait for the warmed, ready game (fast path = warm-mount, settles in idle)
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => !document.querySelector('.loadingScreen'), { timeout: 30000, polling: 100 });
  await sleep(400);
  await shot('gantry-run');
  const gantry = await page.evaluate(() => ({
    level: window.__game?.levelId ?? null,
    ready: !document.querySelector('.loadingScreen'),
    state: window.__game ? window.__game.state : null,
  }));
  console.log(`[gantry-fastpath] level=${gantry.level} ready=${gantry.ready} state=${gantry.state} (state 0=Idle expected for fast path)`);
} catch (e) {
  console.error(e.stack || e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
