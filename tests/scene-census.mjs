// One-shot scene census (perf-drawcalls): boots GANTRY POINT, teleports to the
// dockyard, waits for the GLB props to stream in, then walks the scene graph and
// reports how many MESHES exist, grouped by a coarse "source" key (geometry uuid
// + material count). Tells us exactly which repeated props dominate the draw
// count so the instancing pass targets the real hot set. RENDERING-ONLY; never
// records a fixture. Usage: node tests/scene-census.mjs [--port N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5193;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startVite() {
  const proc = spawn(process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('no server');
}
async function launchBrowser() {
  for (const target of [{ channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await puppeteer.launch({ ...target, headless: true, args: ['--enable-unsafe-swiftshader', '--mute-audio'] }); } catch {}
  }
  throw new Error('no browser');
}

const vite = startVite();
try {
  await waitForServer();
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360 });
  // FAST PATH (menu redesign): jump straight to GANTRY POINT day gameplay; the
  // menu flow no longer auto-mounts a level from cj-sel.
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4000);
  const out = await page.evaluate(() => {
    const g = window.__game;
    let meshes = 0, instanced = 0, instancedInstances = 0, tris = 0;
    const byKey = new Map();
    // how many PLAIN meshes share each geometry uuid (a repeated geometry still
    // drawn N times = a missed instancing opportunity)
    const plainByGeo = new Map();
    g.scene.traverse((o) => {
      if (o.isInstancedMesh) {
        instanced++; instancedInstances += o.count;
        const k = `INSTANCED:${o.name || o.geometry?.uuid?.slice(0, 6)}`;
        byKey.set(k, (byKey.get(k) || 0) + 1);
        return;
      }
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      const pos = o.geometry.getAttribute && o.geometry.getAttribute('position');
      if (pos) tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const mname = mats.map((m) => m && (m.name || m.type)).join('+');
      const vc = pos ? pos.count : 0;
      const k = `v${vc}|${mname}`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
      const gk = o.geometry.uuid;
      plainByGeo.set(gk, (plainByGeo.get(gk) || 0) + 1);
    });
    const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    // geometries still drawn as N>=2 plain meshes = remaining batch targets
    const dupGeo = [...plainByGeo.values()].filter((n) => n >= 2);
    const dupGeoMeshes = dupGeo.reduce((a, b) => a + b, 0);
    // for the top dup geometries: how many DISTINCT materials + tris each, to
    // see whether per-material splitting (tint clones / per-build materials) is
    // what's blocking the batch
    const geoInfo = new Map(); // uuid -> { n, mats:Set, vc, name }
    g.scene.traverse((o) => {
      if (o.isInstancedMesh || !o.isMesh || !o.geometry) return;
      const gk = o.geometry.uuid;
      let e = geoInfo.get(gk);
      if (!e) geoInfo.set(gk, (e = { n: 0, mats: new Set(), vc: o.geometry.getAttribute('position')?.count || 0, name: o.name }));
      e.n++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) e.mats.add(m && m.uuid);
    });
    const topGeo = [...geoInfo.values()].filter((e) => e.n >= 2).sort((a, b) => b.n - a.n).slice(0, 14)
      .map((e) => ({ n: e.n, mats: e.mats.size, vc: e.vc }));
    return { meshes, instanced, instancedInstances, tris: Math.round(tris), top,
      dupGeoGroups: dupGeo.length, dupGeoMeshes, dupGeoMax: Math.max(0, ...dupGeo), topGeo };
  });
  console.log(`\n=== SCENE CENSUS (dockyard, day) ===`);
  console.log(`plain meshes: ${out.meshes}   instancedMeshes: ${out.instanced} (covering ${out.instancedInstances} instances)`);
  console.log(`total triangles in graph: ${out.tris.toLocaleString()}`);
  console.log(`PLAIN meshes still sharing a geometry (missed batch targets): ${out.dupGeoMeshes} meshes across ${out.dupGeoGroups} geometries (largest dup group: ${out.dupGeoMax})`);
  console.log(`\ntop plain dup-geometries (n meshes | distinct materials | verts):`);
  for (const e of out.topGeo) console.log(`  n=${String(e.n).padStart(3)}  mats=${String(e.mats).padStart(3)}  v${e.vc}`);
  console.log(`\ntop mesh groups (count  key):`);
  for (const [k, n] of out.top) console.log(`  ${String(n).padStart(4)}  ${k}`);
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
