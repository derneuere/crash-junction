// Fixed-pose screenshot harness for the GANTRY POINT dressing passes.
//
//   fnm exec --using=22 -- node tools/refshot.mjs <zone> --port <port>
//   zone ∈ { dockyard, harbor, cliff, beach }
//
// Boots a vite dev server, drives a headless Chrome/Edge onto the level
// select, loads GANTRY POINT in day lighting, waits for the async GLB props
// to land, freezes the camera and captures ONE 1920x1080 frame from the
// zone's CANONICAL pose into screenshots/gantry-point/current-<zone>.png.
//
// THE POSES BELOW ARE THE CONTRACT. They match the "before" screenshots and
// the docs/concept-art targets pixel-for-pixel framing-wise — zone agents
// validate by diffing their current-<zone>.png against the concept art and
// NEVER move the camera. Page console errors/warnings are echoed to stdout
// so a zone agent can diagnose its own runtime breakage from the output.
//
// Needs Node 18+ (the dev server is vite 6) and an installed Chrome or Edge.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The four canonical poses: camera position + look-at, world metres, day
// lighting, 1920x1080 @ 16/9. Frozen — see header.
const POSES = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  cliff: { cam: [212, 26, 150], look: [275, 2, 212] },
  beach: { cam: [-158, 30, -108], look: [-235, 0, -185] },
  // ART PASS — the SEA. Locked open-water framing off the headland: lots
  // of animated sea filling the lower frame, the horizon line where the sea
  // meets the Preetham sky dome up top, and the cliff toe at frame-left to
  // confirm the waterline/foam seam reads. Frozen for the water art agent.
  water: { cam: [248, 20, 246], look: [338, -3, 322] },
  // merge-pass seam views (NOT canonical — the four poses above are the
  // contract and stay frozen; these exist to eyeball zone-border stitching)
  // seam-1: the headland crag + the cliff→quay-wall coast seam + the
  // kerb→guardrail handover where the gold grass meets the apron
  'seam-1': { cam: [243, 14, 178], look: [288, 6, 214] },
  // seam-2: the chicane verge — beach→bank skirt seam masks + the NW
  // drygrass tongue fading the headland gold into the shared turf
  'seam-2': { cam: [-218, 22, 40], look: [-285, 0, -10] },
};

// ---- CLI ----
const args = process.argv.slice(2);
const zone = args[0];
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5181;
if (!POSES[zone] || !Number.isInteger(PORT)) {
  console.error('usage: node tools/refshot.mjs <dockyard|harbor|cliff|beach|water|seam-1|seam-2> --port <port>');
  process.exit(1);
}
if (parseInt(process.versions.node, 10) < 18) {
  console.error(`Node ${process.versions.node} is too old for the vite dev server — use Node 18+ (fnm exec --using=22).`);
  process.exit(1);
}

// Refuse a busy port up front: with --strictPort vite would die mid-boot
// and the failure reads as a server timeout instead of the real cause.
try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already in use — pick a free one with --port (another refshot/replay run?)`);
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
    // channel lookup can fail even with Edge installed (registry quirks) —
    // fall back to the standard Windows install paths
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
        // software WebGL — headless machines have no GPU
        args: ['--enable-unsafe-swiftshader', '--mute-audio'],
      });
    } catch (e) {
      errors.push(`${target.channel ?? target.executablePath}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome or Edge found for puppeteer-core:\n${errors.join('\n')}`);
}

/** Click the first button whose visible text matches — the HUD has no test
 *  ids, and matching text keeps the harness honest about what a player sees. */
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

const vite = startVite();
let browser = null;
let failed = false;
try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();

  // echo the page's own diagnostics — a zone agent's broken module shows up
  // here (vite overlay errors, GLB 404s, three.js warnings), not in the png
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') console.log(`[page ${type}] ${msg.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  page.on('requestfailed', (req) => console.log(`[request failed] ${req.url()} (${req.failure()?.errorText})`));
  // 404s are responses, not failures — without the URL a missing GLB is
  // just "Failed to load resource" noise, useless for diagnosing a zone
  page.on('response', (res) => {
    if (res.status() >= 400) console.log(`[http ${res.status()}] ${res.url()}`);
  });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30_000, polling: 100 });

  // day lighting + the GANTRY POINT level (persisted App state, so the order
  // is safe: the level remount re-applies the time of day)
  await clickButton(page, /\bDAY\b/);
  await clickButton(page, /^GANTRY POINT$/);
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30_000, polling: 100 });

  // the colliders are synchronous but the GLB visuals are not — give the
  // network/parse pipeline time to drape every model over its collider
  await new Promise((res) => setTimeout(res, 5_000));

  const pose = POSES[zone];
  const dataUrl = await page.evaluate(({ cam, look }) => {
    const g = window.__game;
    // freeze: the idle orbit must never fight the canonical pose
    g.director.update = () => {};
    const r = g.renderer;
    const c = g.camera;
    r.setPixelRatio(1);
    r.setSize(1920, 1080, false);
    c.aspect = 16 / 9;
    c.updateProjectionMatrix();
    c.position.set(cam[0], cam[1], cam[2]);
    c.lookAt(look[0], look[1], look[2]);
    // render + read back in the same task — the drawing buffer is only
    // guaranteed until control returns to the browser.
    // CINE tier: the composer owns tone mapping (the renderer runs
    // NoToneMapping while it's active — toneMapping 0), so a raw
    // renderer.render would capture a washed-out linear frame. Render
    // through the chain instead, twice: the first composed frame after the
    // camera teleport smears the velocity-based motion blur; the second has
    // a settled velocity buffer.
    if (r.toneMapping === 0 && g.postfx) {
      g.postfx.setSize(1920, 1080);
      g.postfx.render(1 / 60);
      g.postfx.render(1 / 60);
    } else {
      r.render(g.scene, c);
    }
    return r.domElement.toDataURL('image/png');
  }, pose);

  const outDir = path.join(root, 'screenshots', 'gantry-point');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `current-${zone}.png`);
  writeFileSync(outFile, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  console.log(`wrote ${path.relative(root, outFile)} (${zone}: cam ${pose.cam.join(',')} look ${pose.look.join(',')})`);
} catch (e) {
  console.error(e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
