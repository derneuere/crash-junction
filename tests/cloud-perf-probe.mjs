// Volumetric-cloud perf probe (feat-vclouds, scratch — NOT committed).
//
// Boots the dev server, loads GANTRY POINT, parks the camera at the cloud-heavy
// `sky` pose in CINE tier, and times the composer render loop two ways:
//   A) clouds ON  (uCloudDensity at the preset value)
//   B) clouds OFF (uCloudDensity = 0 → the raymarch early-outs to nothing)
// The A-B delta is the honest volumetric-cloud cost per frame. Software GL
// (swiftshader) inflates absolute ms massively, so report the DELTA and ratio,
// not absolutes — a real GPU is far faster.
//
// Usage: node tests/cloud-perf-probe.mjs [--port N] [--tod day|dusk|night]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5205;
const todFlag = args.indexOf('--tod');
const TOD = todFlag >= 0 ? args[todFlag + 1] : 'day';

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
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('dev server did not come up');
}

async function launchBrowser() {
  const candidates = [
    { channel: 'chrome' },
    { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const t of candidates) {
    try { return await puppeteer.launch({ ...t, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); }
    catch {}
  }
  throw new Error('no Chrome/Edge for puppeteer');
}

async function clickButton(page, re) {
  await page.evaluate((src) => {
    const r = new RegExp(src);
    const b = [...document.querySelectorAll('button')].find((x) => r.test(x.textContent?.trim() ?? ''));
    if (b) b.click();
  }, re.source);
}

const vite = startVite();
let browser = null;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('console', (m) => { const t = m.type(); if (t === 'error') console.log(`[page error] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30000, polling: 100 });
  await clickButton(page, /\bDAY\b/);
  await clickButton(page, /^GANTRY POINT$/);
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30000, polling: 100 });
  await new Promise((r) => setTimeout(r, 4000));
  await page.evaluate((tod) => { window.__game?.setGfx('cine'); window.__game?.setTimeOfDay(tod); }, TOD);
  await new Promise((r) => setTimeout(r, 1500));

  const result = await page.evaluate(() => {
    const g = window.__game;
    g.director.update = () => {};
    const r = g.renderer, c = g.camera;
    r.setPixelRatio(1); r.setSize(1280, 720, false);
    c.aspect = 16 / 9; c.updateProjectionMatrix();
    c.position.set(248, 26, 246); c.lookAt(330, 22, 322);
    if (g.postfx) g.postfx.setSize(1280, 720);

    // reach the sky material's uCloudDensity uniform through the scene
    let cloudU = null, cloudPreset = 0.9;
    g.scene.traverse((o) => {
      const m = o.material;
      if (m && m.uniforms && m.uniforms.uCloudDensity) cloudU = m.uniforms.uCloudDensity;
    });
    if (cloudU) cloudPreset = cloudU.value;

    const renderFrame = () => { if (g.postfx && r.toneMapping === 0) g.postfx.render(1 / 60); else r.render(g.scene, c); };

    const timeN = (n) => {
      // warm up
      for (let i = 0; i < 5; i++) renderFrame();
      const samples = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        renderFrame();
        // force the GL pipeline to drain so the timing reflects real work
        r.getContext().finish();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      return { median: samples[samples.length >> 1], min: samples[0], max: samples[samples.length - 1] };
    };

    // A: clouds ON
    if (cloudU) cloudU.value = cloudPreset;
    const on = timeN(30);
    // B: clouds OFF
    if (cloudU) cloudU.value = 0;
    const off = timeN(30);
    // restore
    if (cloudU) cloudU.value = cloudPreset;

    return { foundUniform: !!cloudU, cloudPreset, on, off };
  });

  console.log(`[cloud-perf ${TOD}] (1280x720, swiftshader — read the DELTA, not absolutes)`);
  console.log(`  cloud uniform found: ${result.foundUniform}  preset density: ${result.cloudPreset}`);
  console.log(`  clouds ON : median ${result.on.median.toFixed(1)}ms  (min ${result.on.min.toFixed(1)} max ${result.on.max.toFixed(1)})`);
  console.log(`  clouds OFF: median ${result.off.median.toFixed(1)}ms  (min ${result.off.min.toFixed(1)} max ${result.off.max.toFixed(1)})`);
  console.log(`  CLOUD COST: +${(result.on.median - result.off.median).toFixed(1)}ms/frame  (${(result.on.median / result.off.median).toFixed(2)}x composer)`);
} catch (e) {
  console.error('PROBE FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  vite.kill();
}
