// Temporary detail census: identify the worst PLAIN-mesh draw sources by
// material color/type + a sample world position, so they map back to source.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5194;
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
  // FAST PATH (menu redesign): jump straight to GANTRY POINT day/cine gameplay;
  // the old cj-sel localStorage auto-mount path no longer mounts a level.
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4000);
  const out = await page.evaluate(() => {
    const g = window.__game;
    // group plain meshes by (vertCount, materialColor/type, multi?) and collect
    // count + a few sample positions + tri count
    const groups = new Map();
    g.scene.traverse((o) => {
      if (o.isInstancedMesh || !o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute('position');
      const vc = pos ? pos.count : 0;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const desc = mats.map((m) => {
        if (!m) return 'null';
        const c = m.color ? '#' + m.color.getHexString() : '';
        return `${m.type}${c}${m.map ? '+map' : ''}${m.transparent ? '+T' : ''}${m.vertexColors ? '+VC' : ''}`;
      }).join(',');
      const key = `v${vc}|${desc}`;
      let e = groups.get(key);
      if (!e) groups.set(key, (e = { n: 0, tris: 0, samples: [] }));
      e.n++;
      const tri = (o.geometry.index ? o.geometry.index.count : vc) / 3;
      e.tris += tri;
      o.updateWorldMatrix(true, false);
      if (e.samples.length < 3) {
        e.samples.push([Math.round(o.matrixWorld.elements[12]), Math.round(o.matrixWorld.elements[13]), Math.round(o.matrixWorld.elements[14])]);
      }
    });
    const top = [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30)
      .map(([k, e]) => ({ k, n: e.n, tris: Math.round(e.tris), samples: e.samples }));
    // level def counts (so we know how many environment.ts meshes to expect)
    const lvl = g.level || g.__level || (g.levelDef);
    let counts = null;
    try {
      const L = window.__game.level || window.__game.levelDef;
      counts = {
        buildings: L?.buildings?.length ?? -1,
        patches: L?.patches?.length ?? -1,
        ramps: L?.ramps?.length ?? -1,
        outline: L?.outline?.length ?? -1,
        decals: L?.decals?.length ?? -1,
        shortcuts: (L?.mode?.race?.shortcuts ?? []).length,
      };
    } catch (e) { counts = { err: String(e) }; }
    // patch chunk distribution (40m chunks) to see how many merge
    let patchChunks = null;
    try {
      const L = window.__game.level;
      const m = {};
      for (const p of (L.patches ?? [])) {
        let cx = 0, cz = 0; for (const [x, z] of p.poly) { cx += x; cz += z; }
        cx /= p.poly.length; cz /= p.poly.length;
        const k = `${p.kind}@${Math.floor(cx / 40)},${Math.floor(cz / 40)}`;
        m[k] = (m[k] || 0) + 1;
      }
      patchChunks = m;
    } catch (e) { patchChunks = { err: String(e) }; }
    // InstancedMesh bounding-sphere radii — a level-spanning wall batch has a
    // huge radius (wraps the whole lap) = frustum culling can't drop it.
    const bigInst = [];
    g.scene.traverse((o) => {
      if (!o.isInstancedMesh) return;
      if (!o.boundingSphere) o.computeBoundingSphere();
      const r = o.boundingSphere ? Math.round(o.boundingSphere.radius) : -1;
      bigInst.push({ name: o.name || '?', count: o.count, radius: r });
    });
    bigInst.sort((a, b) => b.radius - a.radius);
    // name tally of ALL instanced meshes (count of meshes + max radius per name)
    const nameTally = {};
    for (const b of bigInst) {
      const e = nameTally[b.name] || (nameTally[b.name] = { meshes: 0, maxR: 0, instances: 0 });
      e.meshes++; e.maxR = Math.max(e.maxR, b.radius); e.instances += b.count;
    }
    return { top, counts, patchChunks, bigInst: bigInst.slice(0, 18), nameTally };
  });
  console.log(`\n=== LEVEL DEF COUNTS === ${JSON.stringify(out.counts)}`);
  console.log(`=== PATCH CHUNKS === ${JSON.stringify(out.patchChunks)}`);
  console.log(`=== BIGGEST INSTANCED (name | count | sphere-radius m) ===`);
  for (const b of out.bigInst) console.log(`  r=${String(b.radius).padStart(5)}m  n=${String(b.count).padStart(4)}  ${b.name}`);
  console.log(`=== INSTANCED-MESH NAME TALLY (name | #meshes | totalInstances | maxRadius) ===`);
  for (const [name, e] of Object.entries(out.nameTally).sort((a, b) => b[1].maxR - a[1].maxR))
    console.log(`  ${String(e.meshes).padStart(4)} meshes  ${String(e.instances).padStart(6)} inst  maxR=${String(e.maxR).padStart(5)}m  ${name}`);
  console.log(`\n=== PLAIN-MESH DETAIL (dockyard, day) ===`);
  for (const e of out.top) {
    console.log(`  n=${String(e.n).padStart(3)}  tris=${String(e.tris).padStart(6)}  ${e.k}`);
    console.log(`        samples: ${e.samples.map((s) => `(${s.join(',')})`).join(' ')}`);
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
