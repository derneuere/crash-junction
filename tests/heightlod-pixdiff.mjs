// Visual A/B for the height-LOD ladder: renders each pose with the ladder OFF
// (forced full) and ON, captures the canvas, and pixel-diffs the two frames
// in-page. Small changed-% + low magnitudes = the switches are invisible.
// Usage: node tests/heightlod-pixdiff.mjs [--port N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5197;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POSES = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  straight: { cam: [-30, 3.0, -226], look: [120, 1.0, -222] },
  ontrack: { cam: [200, 3.0, 0], look: [240, 1.0, 60] },
};

const vite = spawn(process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) break; } catch {} await sleep(200); }
  let browser;
  for (const t of [{ channel: 'chrome' }, { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' }]) {
    try { browser = await puppeteer.launch({ ...t, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); break; } catch {}
  }
  if (!browser) throw new Error('no browser');
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4500);
  const out = await page.evaluate(async (POSES) => {
    const g = window.__game;
    const r = g.renderer;
    const c = g.camera;
    g.director.update = () => {};
    r.setPixelRatio(1);
    r.setSize(1280, 720, false);
    c.aspect = 16 / 9;
    c.updateProjectionMatrix();
    const lod = g.propLod;
    const snap = () => { r.render(g.scene, c); return r.domElement.toDataURL('image/png'); };
    const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = u; });
    const results = {};
    for (const [name, p] of Object.entries(POSES)) {
      c.position.set(p.cam[0], p.cam[1], p.cam[2]);
      c.lookAt(p.look[0], p.look[1], p.look[2]);
      c.updateMatrixWorld();
      lod.update(c, 1e9); // full detail
      const off = snap();
      lod.update(c, 720); // real ladder
      const on = snap();
      const ia = await load(off), ib = await load(on);
      const cv = document.createElement('canvas'); cv.width = ia.width; cv.height = ia.height;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(ia, 0, 0); const da = cx.getImageData(0, 0, cv.width, cv.height).data;
      cx.clearRect(0, 0, cv.width, cv.height);
      cx.drawImage(ib, 0, 0); const db = cx.getImageData(0, 0, cv.width, cv.height).data;
      let changed = 0, maxd = 0, sumd = 0, over8 = 0, over32 = 0;
      for (let i = 0; i < da.length; i += 4) {
        let pd = 0;
        for (let k = 0; k < 3; k++) { const d = Math.abs(da[i + k] - db[i + k]); if (d > pd) pd = d; }
        if (pd > 0) { changed++; if (pd > maxd) maxd = pd; sumd += pd; if (pd > 8) over8++; if (pd > 32) over32++; }
      }
      const px = cv.width * cv.height;
      results[name] = { px, changed, pct: +(100 * changed / px).toFixed(3), maxd, mean: changed ? +(sumd / changed).toFixed(1) : 0, over8, over32 };
    }
    return results;
  }, POSES);
  console.log('=== HEIGHT-LOD visual A/B (full vs ladder, 1280x720) ===');
  for (const [name, e] of Object.entries(out)) {
    console.log(`  ${name.padEnd(10)} changed ${e.changed}/${e.px} px (${e.pct}%), >8: ${e.over8}, >32: ${e.over32}, max ${e.maxd}, mean ${e.mean}`);
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
