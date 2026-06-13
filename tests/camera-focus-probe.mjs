// Behavioral probe for the crash/takedown camera focus fix (branch fix-camera).
//
//   fnm exec --using=22 -- node tests/camera-focus-probe.mjs --port <port>
//
// THE BUG: a rival-vs-rival / rival-vs-wall crash (or a rival fireball) across
// the map used to copy its contact/blast point into director.focusTarget, so
// during the PLAYER's own crashtime the crash orbit drifted off the player's
// wreck toward the unrelated rival event. The fix gates BOTH focusTarget writes
// (impact in handleContact, blast in explode) on player involvement / proximity.
//
// This probe boots a race, then exercises the two gated paths directly via the
// dev API (window.__game.explode) and asserts focusTarget behaves: a FAR blast
// is ignored, a NEAR blast still grabs the camera. It also runs the race for a
// few seconds (rivals naturally crash) and asserts focusTarget never teleports
// far from the player while the player is alive/mid-crash.
//
// Same headless harness shape as tools/refshot.mjs. Node 18+, Chrome/Edge.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 5186;

try {
  await fetch(`http://localhost:${PORT}/`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already in use — pick a free one with --port`);
  process.exit(1);
} catch {
  /* port is ours */
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
    if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {/* not up */}
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('dev server did not come up');
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
      return await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] });
    } catch (e) {
      errors.push(`${target.channel ?? target.executablePath}: ${e.message}`);
    }
  }
  throw new Error(`no Chrome/Edge:\n${errors.join('\n')}`);
}
async function clickButton(page, re) {
  const clicked = await page.evaluate((reSrc) => {
    const re2 = new RegExp(reSrc);
    const btn = [...document.querySelectorAll('button')].find((b) => re2.test(b.textContent?.trim() ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, re.source);
  if (!clicked) throw new Error(`no button matching ${re}`);
}

const vite = startVite();
let browser = null;
let failed = false;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed = true;
};

try {
  await waitForServer(vite);
  browser = await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game !== undefined, { timeout: 30_000, polling: 100 });

  // a RACE level (rivals crash into walls during the race)
  await clickButton(page, /^GANTRY POINT$/);
  await page.waitForFunction(() => window.__game?.levelId === 'gantry', { timeout: 30_000, polling: 100 });
  await new Promise((res) => setTimeout(res, 3500)); // GLB props land

  // start the race via the dev API (the in-game start is a key press; the
  // labelled button text varies, and launch() is the same entry point)
  await page.evaluate(() => window.__game?.launch?.());
  await new Promise((res) => setTimeout(res, 1500));

  // ---- TEST 1 + 2: distant vs. near explosion focus gating ----
  const blast = await page.evaluate(() => {
    const g = window.__game;
    // ensure we're in a driving state so the camera director is live
    if (g.state === 0 /* Idle */) g.launch();
    const pp = g.player.body.position;
    const ft = g.director.focusTarget;
    // a real THREE.Vector3 to feed explode() (it calls Vector3 methods on p);
    // clone the player group's position vector and .set() it where we want
    const mk = (x, y, z) => g.player.group.position.clone().set(x, y, z);

    // snapshot focus + shake before
    const before = { x: ft.x, y: ft.y, z: ft.z };
    const shake0 = g.director.shakeMag;

    // FAR blast — well outside any plausible blast radius from the player
    const far = mk(pp.x + 200, pp.y, pp.z + 200);
    g.explode(far, 2.2);
    const afterFar = { x: ft.x, y: ft.y, z: ft.z };
    const shakeFar = g.director.shakeMag;
    const farMoved = Math.hypot(afterFar.x - before.x, afterFar.z - before.z);
    const farTookFocus = Math.hypot(afterFar.x - far.x, afterFar.z - far.z) < 1;

    // NEAR blast — right on top of the player (their own crashbreaker / pileup)
    const near = mk(pp.x + 1, pp.y, pp.z + 1);
    g.explode(near, 1.0);
    const afterNear = { x: ft.x, y: ft.y, z: ft.z };
    const shakeNear = g.director.shakeMag;
    const nearTookFocus = Math.hypot(afterNear.x - near.x, afterNear.z - near.z) < 1;

    return {
      pp: { x: pp.x, y: pp.y, z: pp.z },
      far: { x: far.x, z: far.z },
      near: { x: near.x, z: near.z },
      before, afterFar, afterNear,
      farMoved, farTookFocus, nearTookFocus,
      shake0, shakeFar, shakeNear,
    };
  });

  check('far rival fireball does NOT pull focus to the blast', !blast.farTookFocus,
    `focus after far blast = (${blast.afterFar.x.toFixed(1)},${blast.afterFar.z.toFixed(1)}), far blast at (${blast.far.x.toFixed(1)},${blast.far.z.toFixed(1)})`);
  check('far rival fireball does NOT add camera shake', Math.abs(blast.shakeFar - blast.shake0) < 1e-6,
    `shake ${blast.shake0.toFixed(3)} -> ${blast.shakeFar.toFixed(3)}`);
  check('near (player) blast STILL grabs focus', blast.nearTookFocus,
    `focus after near blast = (${blast.afterNear.x.toFixed(1)},${blast.afterNear.z.toFixed(1)}), near blast at (${blast.near.x.toFixed(1)},${blast.near.z.toFixed(1)})`);
  check('near (player) blast STILL adds shake', blast.shakeNear > blast.shakeFar + 1e-3,
    `shake ${blast.shakeFar.toFixed(3)} -> ${blast.shakeNear.toFixed(3)}`);

  // ---- TEST 3: FORCE distant rival wrecks; focus must stay near player ----
  // Actively crash the rivals that are FARTHEST from the player (and detonate a
  // blast next to them) every frame, so the impact + explosion paths fire from
  // far away while the player is the camera subject. Pre-fix this dragged the
  // orbit target out to the rival pileup; gated, focus tracks only the player.
  const stray = await page.evaluate(async () => {
    const g = window.__game;
    let maxDist = 0;
    let samples = 0;
    let forcedRivalWrecks = 0;
    let farBlasts = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = g.player;
      if (!p) continue;
      const pp = p.body.position;

      // pick the rival farthest from the player and slam it: destabilize it,
      // shove it sideways, and pop a blast right on it — a rival-vs-wall /
      // rival fireball happening across the map, exactly the bug scenario
      let far = null, farD = 0;
      for (const a of g.actors) {
        if (a.kind !== 'vehicle' || a.isPlayer || a.crashed) continue;
        const d = Math.hypot(a.body.position.x - pp.x, a.body.position.z - pp.z);
        if (d > farD) { farD = d; far = a; }
      }
      if (far && farD > 40) {
        // mark it wrecked (rival-vs-rival/wall outcome) and detonate beside it
        if (!far.crashed) { far.crashed = true; forcedRivalWrecks++; }
        const bp = far.group.position.clone().set(far.body.position.x, far.body.position.y + 0.5, far.body.position.z);
        g.explode(bp, 1.0);
        farBlasts++;
      }

      const ft = g.director.focusTarget;
      const d = Math.hypot(ft.x - pp.x, ft.z - pp.z);
      const st = g.state; // 1 Launch, 2 Crash, 3 Settle
      if (st === 1 || st === 2 || st === 3) {
        maxDist = Math.max(maxDist, d);
        samples++;
      }
    }
    return { maxDist, samples, forcedRivalWrecks, farBlasts, finalState: g.state };
  });

  // A rival wreck can be tens-to-hundreds of metres away. Before the fix, the
  // orbit target would jump to it (dist in the 50–300 m range). Gated, the
  // focus only ever tracks the player's own contacts, so it stays close.
  check('focus stays near the player while distant rivals are wrecked + blasted',
    stray.maxDist < 35,
    `maxDist ${stray.maxDist.toFixed(1)}m over ${stray.samples} samples, ${stray.forcedRivalWrecks} forced rival wreck(s) + ${stray.farBlasts} far blast(s), finalState ${stray.finalState}`);

  console.log(`\nSummary: ${results.filter((r) => r.ok).length}/${results.length} checks passed`);
} catch (e) {
  console.error(e.stack || e.message);
  failed = true;
} finally {
  if (browser) await browser.close().catch(() => {});
  vite.kill();
}
process.exit(failed ? 1 : 0);
