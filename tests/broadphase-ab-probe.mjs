// Broadphase A/B probe: boots the game on the CURRENT checkout (expects
// StaticAwareSAPBroadphase from PR #25 installed), then per world.step times
// BOTH implementations on the identical world state:
//   stock  = SAPBroadphase.prototype.collisionPairs  -> throwaway arrays
//   custom = StaticAwareSAPBroadphase.collisionPairs -> the real arrays (sim consumes it)
// Pair lists are compared for identity every call. Drives the lag-probe
// scenario (launch + throttle + 3 sandbox explosions) so we cover both the
// quiet phase (~6 awake) and the pileup phase (many awake bodies).
//
// Usage: node tests/broadphase-ab-probe.mjs [--root <repo>] [--port N]

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5211;
const levelFlag = args.indexOf('--level');
const LEVEL = levelFlag >= 0 ? args[levelFlag + 1] : 'junction';
const REPS = 20; // timing repetitions per implementation per step (beats 0.1ms timer quantization)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('no server');
}
async function launchBrowser() {
  const candidates = [
    { channel: 'chrome' }, { channel: 'msedge' },
    { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  for (const t of candidates) {
    try { return await puppeteer.launch({ ...t, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); } catch {}
  }
  throw new Error('no browser');
}

const key = (code, type) => `window.dispatchEvent(new KeyboardEvent('${type}', { code: '${code}' }))`;

async function waitSimSeconds(page, s, timeout = 240_000) {
  const start = await page.evaluate(() => window.__game.simTime);
  await page.waitForFunction((t) => window.__game.simTime >= t, { timeout, polling: 250 }, start + s);
}

const vite = startVite();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    page.on('pageerror', (e) => { failed = true; console.error(`PAGE ERROR: ${e.message}`); });
    page.on('console', (m) => { if (m.text().startsWith('[ab]')) console.log(m.text()); });
    await page.goto(`http://localhost:${PORT}/?level=${LEVEL}&launch=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30_000, polling: 250 });
    await sleep(2000);
    await page.evaluate(() => window.__game.setGfx('fast'));

    // install the A/B shim
    const installed = await page.evaluate((REPS) => {
      const g = window.__game;
      const world = g.phys.world;
      const bp = world.broadphase;
      const customProto = Object.getPrototypeOf(bp);
      const stockProto = Object.getPrototypeOf(customProto);
      if (typeof stockProto.collisionPairs !== 'function') return 'no stock proto';
      const rec = (window.__ab = {
        name: bp.constructor.name,
        calls: 0, mismatches: 0,
        stockMs: 0, customMs: 0,
        frames: [], // {n, awake, stock, custom} per call
        s1: [], s2: [],
      });
      bp.collisionPairs = function (w, p1, p2) {
        if (this.dirty) { this.sortList(); this.dirty = false; }
        const s1 = rec.s1, s2 = rec.s2;
        // timed: REPS repetitions of each implementation into throwaway arrays
        let t0 = performance.now();
        for (let r = 0; r < REPS; r++) {
          s1.length = 0; s2.length = 0;
          stockProto.collisionPairs.call(this, w, s1, s2);
        }
        const tStock = (performance.now() - t0) / REPS;
        const base1 = p1.length;
        t0 = performance.now();
        for (let r = 0; r < REPS; r++) {
          p1.length = base1; p2.length = base1;
          customProto.collisionPairs.call(this, w, p1, p2);
        }
        const tCustom = (performance.now() - t0) / REPS;
        let ok = s1.length === p1.length - base1;
        if (ok) {
          for (let i = 0; i < s1.length; i++) {
            if (s1[i] !== p1[base1 + i] || s2[i] !== p2[base1 + i]) { ok = false; break; }
          }
        }
        if (!ok) rec.mismatches++;
        const bodies = this.axisList;
        let awake = 0;
        for (let i = 0; i < bodies.length; i++) {
          const b = bodies[i];
          if ((b.type & 2) === 0 && b.sleepState !== 2) awake++;
        }
        rec.calls++;
        rec.stockMs += tStock; rec.customMs += tCustom;
        rec.frames.push({ n: bodies.length, awake, stock: tStock, custom: tCustom, pairs: s1.length });
        return undefined;
      };
      return `ok: ${rec.name}`;
    }, REPS);
    console.log(`shim: ${installed}`);
    if (!String(installed).startsWith('ok')) throw new Error('shim install failed');

    // quiet phase: 5 sim seconds idle-ish
    await waitSimSeconds(page, 5);
    await page.evaluate(() => { window.__ab.quietEnd = window.__ab.calls; });

    // action: launch + throttle into traffic, then 3 explosions
    await page.evaluate(`${key('Space', 'keydown')}; setTimeout(() => ${key('Space', 'keyup')}, 200); ${key('ArrowUp', 'keydown')}`);
    await waitSimSeconds(page, 4);
    await page.evaluate(key('ArrowUp', 'keyup'));
    for (let i = 0; i < 3; i++) {
      await page.evaluate(`${key('KeyB', 'keydown')}; ${key('KeyB', 'keyup')}`);
      await waitSimSeconds(page, 0.8);
    }
    // let the pileup evolve + settle back to sleep
    await waitSimSeconds(page, 15);

    const out = await page.evaluate(() => {
      const r = window.__ab;
      const agg = (rows) => {
        if (!rows.length) return null;
        const st = rows.map((f) => f.stock).sort((a, b) => a - b);
        const cu = rows.map((f) => f.custom).sort((a, b) => a - b);
        const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
        const sum = (a) => a.reduce((x, y) => x + y, 0);
        return {
          calls: rows.length,
          awakeMin: Math.min(...rows.map((f) => f.awake)),
          awakeMax: Math.max(...rows.map((f) => f.awake)),
          nMax: Math.max(...rows.map((f) => f.n)),
          pairsMax: Math.max(...rows.map((f) => f.pairs)),
          stock: { mean: sum(st) / st.length, p50: q(st, 0.5), p95: q(st, 0.95), max: st[st.length - 1] },
          custom: { mean: sum(cu) / cu.length, p50: q(cu, 0.5), p95: q(cu, 0.95), max: cu[cu.length - 1] },
        };
      };
      const quiet = r.frames.slice(0, r.quietEnd ?? 0);
      const action = r.frames.slice(r.quietEnd ?? 0);
      // bucket by awake count
      const buckets = {};
      for (const f of r.frames) {
        const b = f.awake <= 10 ? '0-10' : f.awake <= 40 ? '11-40' : f.awake <= 120 ? '41-120' : '120+';
        (buckets[b] ??= []).push(f);
      }
      const bucketAgg = {};
      for (const [k, v] of Object.entries(buckets)) bucketAgg[k] = agg(v);
      return {
        name: r.name, calls: r.calls, mismatches: r.mismatches,
        totalStockMs: r.stockMs, totalCustomMs: r.customMs,
        quiet: agg(quiet), action: agg(action), buckets: bucketAgg,
      };
    });

    console.log('\n==== broadphase A/B (same world states, per world.step call) ====');
    console.log(`class: ${out.name}   calls: ${out.calls}   PAIR MISMATCHES: ${out.mismatches}`);
    console.log(`total stock: ${out.totalStockMs.toFixed(1)} ms   total custom: ${out.totalCustomMs.toFixed(1)} ms   ratio: ${(out.totalStockMs / out.totalCustomMs).toFixed(2)}x`);
    const show = (label, a) => {
      if (!a) return;
      console.log(
        `${label}: calls ${a.calls}  awake ${a.awakeMin}-${a.awakeMax}  N<=${a.nMax}  pairs<=${a.pairsMax}\n` +
        `   stock  mean ${a.stock.mean.toFixed(4)} p50 ${a.stock.p50.toFixed(4)} p95 ${a.stock.p95.toFixed(4)} max ${a.stock.max.toFixed(3)}\n` +
        `   custom mean ${a.custom.mean.toFixed(4)} p50 ${a.custom.p50.toFixed(4)} p95 ${a.custom.p95.toFixed(4)} max ${a.custom.max.toFixed(3)}`,
      );
    };
    show('quiet ', out.quiet);
    show('action', out.action);
    for (const [k, v] of Object.entries(out.buckets)) show(`awake ${k}`, v);
  } finally {
    await browser.close();
  }
} catch (e) {
  failed = true;
  console.error(e.message);
} finally {
  vite.kill();
}
process.exit(failed ? 1 : 0);
