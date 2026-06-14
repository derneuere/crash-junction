// Offender census (dockyard-perf): boot GANTRY POINT day/cine, let props
// stream, then at each of the dockyard + harbor canonical poses do a REAL
// frustum cull and rank the geometry groups by VISIBLE rendered triangles
// (per-mesh tris, or per-instance tris x visible-instance count). Prints the
// top sources with sample world positions so each maps back to a prop.
// RENDERING-ONLY; never records a fixture. Usage: node tests/offender-census.mjs [--port N]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const PORT = portFlag >= 0 ? Number(args[portFlag + 1]) : 5212;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POSES = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
};

function startVite() {
  const proc = spawn(process.execPath,
    [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return proc;
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://localhost:${PORT}/`); if (r.ok) return; } catch {} await sleep(200); }
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
  await page.goto(`http://localhost:${PORT}/?level=gantry&tod=day&launch=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__game && window.__game.actors?.length > 0, { timeout: 30000, polling: 250 });
  await sleep(4500);
  const out = await page.evaluate((POSES) => {
    const g = window.__game;
    const c = g.camera;
    const r = g.renderer;
    g.director.update = () => {};
    r.setPixelRatio(1);
    r.setSize(1280, 720, false);
    c.aspect = 16 / 9;
    c.near = 0.5; c.far = 800;
    c.updateProjectionMatrix();

    // build a THREE.Frustum off window — grab THREE classes from a known object
    const Vec3 = c.position.constructor;
    const Sphere = (g.scene.children.find((o) => o.geometry?.boundingSphere)?.geometry.boundingSphere || null)?.constructor;
    // fallback: reach THREE via a mesh's geometry boundingSphere ctor; if null, compute one
    function frustumPlanes() {
      // 6 planes from the view-projection matrix (Gribb/Hartmann), world space
      const m = c.projectionMatrix.clone().multiply(c.matrixWorldInverse).elements;
      const pl = [];
      const add = (a, b, cc, d) => { const n = Math.hypot(a, b, cc); pl.push([a / n, b / n, cc / n, d / n]); };
      add(m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]); // left
      add(m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]); // right
      add(m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]); // bottom
      add(m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]); // top
      add(m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]); // near
      add(m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]); // far
      return pl;
    }
    function sphereInFrustum(pl, cx, cy, cz, rad) {
      for (const [a, b, cc, d] of pl) if (a * cx + b * cy + cc * cz + d < -rad) return false;
      return true;
    }
    const trisOfGeo = (geo) => {
      const pos = geo.getAttribute && geo.getAttribute('position');
      if (!pos) return 0;
      return (geo.index ? geo.index.count : pos.count) / 3;
    };
    const tmp = new Vec3();

    const report = {};
    for (const [name, p] of Object.entries(POSES)) {
      c.position.set(p.cam[0], p.cam[1], p.cam[2]);
      c.lookAt(p.look[0], p.look[1], p.look[2]);
      c.updateMatrixWorld();
      c.updateMatrixWorldInverse?.();
      c.matrixWorldInverse.copy(c.matrixWorld).invert();
      const pl = frustumPlanes();
      const groups = new Map(); // key -> { tris, n, samples }
      g.scene.traverse((o) => {
        if (!o.visible) return;
        if (!o.isMesh && !o.isInstancedMesh) return;
        if (!o.geometry) return;
        const geo = o.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        const triPer = trisOfGeo(geo);
        if (!triPer) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const col = mats[0]?.color ? '#' + mats[0].color.getHexString() : (mats[0]?.type || '?');
        const vc = geo.getAttribute('position').count;
        if (o.isInstancedMesh) {
          // cull per-instance: bounding sphere center transformed by instance matrix
          const bs = geo.boundingSphere;
          let visN = 0; const samp = [];
          const im = o.instanceMatrix.array;
          for (let i = 0; i < o.count; i++) {
            const off = i * 16;
            // instance translation + (world matrix of the InstancedMesh itself)
            tmp.set(bs.center.x, bs.center.y, bs.center.z);
            // apply instance matrix (column-major)
            const ix = im[off + 12], iy = im[off + 13], iz = im[off + 14];
            // approx: instances are translations (+rot); use translation for center
            o.updateWorldMatrix(true, false);
            const wm = o.matrixWorld.elements;
            // world = meshWorld * instanceMatrix * center; cheap: meshWorld*(instTrans+center)
            const lx = ix + bs.center.x, ly = iy + bs.center.y, lz = iz + bs.center.z;
            const wx = wm[0] * lx + wm[4] * ly + wm[8] * lz + wm[12];
            const wy = wm[1] * lx + wm[5] * ly + wm[9] * lz + wm[13];
            const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
            if (sphereInFrustum(pl, wx, wy, wz, bs.radius * 1.5)) {
              visN++;
              if (samp.length < 3) samp.push([Math.round(wx), Math.round(wy), Math.round(wz)]);
            }
          }
          if (visN === 0) return;
          const key = `INST v${vc} ${col} (${o.name || '?'})`;
          let e = groups.get(key); if (!e) groups.set(key, (e = { tris: 0, n: 0, samples: [] }));
          e.tris += triPer * visN; e.n += visN;
          for (const s of samp) if (e.samples.length < 3) e.samples.push(s);
        } else {
          o.updateWorldMatrix(true, false);
          const bs = geo.boundingSphere;
          const wm = o.matrixWorld.elements;
          const wx = wm[0] * bs.center.x + wm[4] * bs.center.y + wm[8] * bs.center.z + wm[12];
          const wy = wm[1] * bs.center.x + wm[5] * bs.center.y + wm[9] * bs.center.z + wm[13];
          const wz = wm[2] * bs.center.x + wm[6] * bs.center.y + wm[10] * bs.center.z + wm[14];
          const sc = Math.max(Math.hypot(wm[0], wm[1], wm[2]), Math.hypot(wm[4], wm[5], wm[6]), Math.hypot(wm[8], wm[9], wm[10]));
          if (!sphereInFrustum(pl, wx, wy, wz, bs.radius * sc)) return;
          const key = `MESH v${vc} ${col} (${o.name || '?'})`;
          let e = groups.get(key); if (!e) groups.set(key, (e = { tris: 0, n: 0, samples: [] }));
          e.tris += triPer; e.n += 1;
          if (e.samples.length < 3) e.samples.push([Math.round(wx), Math.round(wy), Math.round(wz)]);
        }
      });
      const top = [...groups.entries()].sort((a, b) => b[1].tris - a[1].tris).slice(0, 24)
        .map(([k, e]) => ({ k, tris: Math.round(e.tris), n: e.n, samples: e.samples }));
      const totalVisTris = [...groups.values()].reduce((a, e) => a + e.tris, 0);
      report[name] = { top, totalVisTris: Math.round(totalVisTris) };
    }
    return report;
  }, POSES);

  for (const [pose, rep] of Object.entries(out)) {
    console.log(`\n================ OFFENDER CENSUS @ ${pose} pose ================`);
    console.log(`approx visible triangles (frustum-culled): ${rep.totalVisTris.toLocaleString()}`);
    console.log(`top visible-triangle sources (tris | n | key):`);
    for (const e of rep.top) {
      console.log(`  ${String(e.tris).padStart(7)}  n=${String(e.n).padStart(3)}  ${e.k}`);
      console.log(`        @ ${e.samples.map((s) => `(${s.join(',')})`).join(' ')}`);
    }
  }
  await browser.close();
} finally { vite.kill(); }
process.exit(0);
