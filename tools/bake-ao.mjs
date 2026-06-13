// OFFLINE AMBIENT-OCCLUSION BAKER for the static built environment.
//
//   fnm exec --using=22 -- node tools/bake-ao.mjs
//
// Computes per-vertex SELF-occlusion (+ ground contact) for each unique static
// prototype in the dockyard — the warehouses, shipping containers, the lattice
// tower cranes, the ship-to-shore gantries and the floodlight masts — and
// writes public/baked-ao.json. The runtime (src/game/ao.ts) folds the result
// into ONLY the indirect/ambient light, so the one geometric bake reads the
// same at day, dusk and night and complements the cine composer's screen-space
// N8AO instead of double-darkening it.
//
// NO NEW DEPENDENCY. The sampler is the built-in THREE.Raycaster doing
// cosine-weighted hemisphere sampling per vertex (technique cribbed from
// pmndrs/react-three-lightmap's GPU hemicube probe — MIT, Poimandres 2021 —
// but reimplemented on the CPU so nothing GPU/R3F lands in the toolchain).
// GLB prototypes load through three's GLTFLoader.parse (works headless in Node
// off a file ArrayBuffer); the procedural cranes/masts come from the runtime's
// own src/game/builtins.ts, transpiled on the fly with esbuild so the bake and
// the game build byte-identical geometry.
//
// VISUAL ONLY: emits an aoMap-equivalent vertex attribute. Touches no physics,
// camera or RNG artifact.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = '/models/props';

// ---- bake parameters -------------------------------------------------------
const RAYS = 96; // hemisphere rays per vertex — enough for clean low-noise AO
const AO_DISTANCE = 6.0; // metres a ray reaches before it counts as "open sky"
const NORMAL_BIAS = 0.02; // lift the ray origin off the surface to dodge self-hit
const GROUND_Y = 0.0; // contact-shadow ground plane (props sit on the apron)

// Deterministic hemisphere directions (a fixed Fibonacci-ish set, cosine
// weighted toward the normal): identical every run so the artifact is stable.
function hemisphereDirs(n) {
  const dirs = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // cosine-weighted: z = sqrt(1 - u) maps uniform u to a cos-distributed
    // elevation, so rays cluster toward the normal the way irradiance weights
    const u = (i + 0.5) / n;
    const z = Math.sqrt(1 - u); // up component (along local normal)
    const r = Math.sqrt(u);
    const phi = i * golden;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), z]);
  }
  return dirs;
}
const LOCAL_DIRS = hemisphereDirs(RAYS);

// ---- prototype geometry collection ----------------------------------------
/** Pull every mesh out of a built Object3D in WORLD space (matrices applied),
 *  returning per-mesh { count, positions, normals } in TRAVERSAL ORDER (the
 *  exact order src/game/ao.ts walks the cloned instance, so the runtime can
 *  match baked arrays to meshes by (order, vertex-count)) plus a flat world-
 *  space TRIANGLE soup (index-resolved) for the occluder/grid. */
function collectMeshes(object) {
  object.updateMatrixWorld(true);
  const out = [];
  const triangles = []; // [ax,ay,az, bx,by,bz, cx,cy,cz, ...]
  object.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const geo = o.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return;
    const count = posAttr.count;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(o.matrixWorld);
    const nAttr = geo.getAttribute('normal');
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
      if (nAttr) {
        v.fromBufferAttribute(nAttr, i).applyNormalMatrix(nm).normalize();
        normals[i * 3] = v.x;
        normals[i * 3 + 1] = v.y;
        normals[i * 3 + 2] = v.z;
      }
    }
    // resolve the index into world-space triangles for the occluder grid
    const idx = geo.getIndex();
    const triCount = idx ? idx.count / 3 : count / 3;
    for (let t = 0; t < triCount; t++) {
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        triangles.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
      }
    }
    out.push({ count, positions, normals });
  });
  return { meshes: out, triangles };
}

// ---- uniform-grid ray occlusion (dependency-free acceleration) -------------
// A brute-force raycaster is O(verts × rays × tris) and chokes on the 10k-tri
// lattice cranes. Bin the world-space triangle soup into a uniform grid and
// walk it with 3D-DDA so each ray only tests the handful of triangles in the
// cells it crosses — what three-mesh-bvh would buy us, without the dep.
function buildGrid(triArray, withGround) {
  // bounds
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triArray.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], triArray[i + a]);
      max[a] = Math.max(max[a], triArray[i + a]);
    }
  }
  let tris = triArray;
  if (withGround) {
    const ext = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[2]), Math.abs(max[2])) + AO_DISTANCE + 2;
    // two big ground triangles at y=GROUND_Y so bottom edges read a contact shadow
    tris = Float32Array.from([
      ...triArray,
      -ext, GROUND_Y, -ext, ext, GROUND_Y, -ext, ext, GROUND_Y, ext,
      -ext, GROUND_Y, -ext, ext, GROUND_Y, ext, -ext, GROUND_Y, ext,
    ]);
    min[0] = Math.min(min[0], -ext); min[2] = Math.min(min[2], -ext); min[1] = Math.min(min[1], GROUND_Y);
    max[0] = Math.max(max[0], ext); max[2] = Math.max(max[2], ext); max[1] = Math.max(max[1], GROUND_Y);
  }
  const triCount = tris.length / 9;
  // cell size ~ a fraction of AO_DISTANCE keeps cells small but the grid sane
  const cell = Math.max(0.5, AO_DISTANCE / 4);
  const dim = [0, 0, 0];
  for (let a = 0; a < 3; a++) dim[a] = Math.max(1, Math.ceil((max[a] - min[a]) / cell) + 1);
  const cellOf = (x, y, z) => {
    const cx = Math.min(dim[0] - 1, Math.max(0, Math.floor((x - min[0]) / cell)));
    const cy = Math.min(dim[1] - 1, Math.max(0, Math.floor((y - min[1]) / cell)));
    const cz = Math.min(dim[2] - 1, Math.max(0, Math.floor((z - min[2]) / cell)));
    return (cz * dim[1] + cy) * dim[0] + cx;
  };
  const buckets = new Map(); // cellIndex -> [triIndex...]
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    // bin by the triangle's AABB cell span
    const tmin = [Infinity, Infinity, Infinity];
    const tmax = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) {
      const val = tris[b + k * 3 + a];
      tmin[a] = Math.min(tmin[a], val);
      tmax[a] = Math.max(tmax[a], val);
    }
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(dim[a] - 1, Math.max(0, Math.floor((tmin[a] - min[a]) / cell)));
      hi[a] = Math.min(dim[a] - 1, Math.max(0, Math.floor((tmax[a] - min[a]) / cell)));
    }
    for (let cz = lo[2]; cz <= hi[2]; cz++)
      for (let cy = lo[1]; cy <= hi[1]; cy++)
        for (let cx = lo[0]; cx <= hi[0]; cx++) {
          const ci = (cz * dim[1] + cy) * dim[0] + cx;
          let arr = buckets.get(ci);
          if (!arr) buckets.set(ci, (arr = []));
          arr.push(t);
        }
  }
  return { tris, min, max, cell, dim, buckets, cellOf };
}

// Möller–Trumbore — does ray (o,d) hit triangle (a,b,c) within `maxT`?
// returns hit distance or -1. Double-sided (our boxes are closed but the
// ground quad and thin slats want both faces lit).
function rayTri(o, d, tris, b, maxT) {
  const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
  const e1x = tris[b + 3] - ax, e1y = tris[b + 4] - ay, e1z = tris[b + 5] - az;
  const e2x = tris[b + 6] - ax, e2y = tris[b + 7] - ay, e2z = tris[b + 8] - az;
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-8 && det < 1e-8) return -1;
  const inv = 1 / det;
  const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-4 && t < maxT ? t : -1;
}

/** Nearest occluder hit distance along a ray within AO_DISTANCE, walking the
 *  grid cells front-to-back (3D-DDA) and returning the first cell's nearest
 *  hit — then one more cell of slack so a triangle straddling a boundary is
 *  not missed. -1 if the ray reaches "open sky". */
function rayOcclusion(grid, o, d) {
  const { tris, min, cell, dim, buckets } = grid;
  // current cell
  let cx = Math.min(dim[0] - 1, Math.max(0, Math.floor((o[0] - min[0]) / cell)));
  let cy = Math.min(dim[1] - 1, Math.max(0, Math.floor((o[1] - min[1]) / cell)));
  let cz = Math.min(dim[2] - 1, Math.max(0, Math.floor((o[2] - min[2]) / cell)));
  const step = [d[0] > 0 ? 1 : -1, d[1] > 0 ? 1 : -1, d[2] > 0 ? 1 : -1];
  const tDelta = [0, 0, 0];
  const tMax = [0, 0, 0];
  const c = [cx, cy, cz];
  const oArr = [o[0], o[1], o[2]];
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) {
      tDelta[a] = Infinity;
      tMax[a] = Infinity;
    } else {
      tDelta[a] = Math.abs(cell / d[a]);
      const boundary = min[a] + (c[a] + (step[a] > 0 ? 1 : 0)) * cell;
      tMax[a] = (boundary - oArr[a]) / d[a];
    }
  }
  let traveled = 0;
  let best = -1;
  while (traveled <= AO_DISTANCE) {
    const ci = (cz * dim[1] + cy) * dim[0] + cx;
    const bucket = buckets.get(ci);
    if (bucket) {
      for (const t of bucket) {
        const hit = rayTri(o, d, tris, t * 9, AO_DISTANCE);
        if (hit > 0 && (best < 0 || hit < best)) best = hit;
      }
    }
    // a hit inside the current cell span is final (front-to-back guarantee)
    const nextT = Math.min(tMax[0], tMax[1], tMax[2]);
    if (best >= 0 && best <= nextT) return best;
    // advance to the next cell
    if (tMax[0] <= tMax[1] && tMax[0] <= tMax[2]) {
      cx += step[0]; traveled = tMax[0]; tMax[0] += tDelta[0];
      if (cx < 0 || cx >= dim[0]) break;
    } else if (tMax[1] <= tMax[2]) {
      cy += step[1]; traveled = tMax[1]; tMax[1] += tDelta[1];
      if (cy < 0 || cy >= dim[1]) break;
    } else {
      cz += step[2]; traveled = tMax[2]; tMax[2] += tDelta[2];
      if (cz < 0 || cz >= dim[2]) break;
    }
  }
  return best >= 0 && best <= AO_DISTANCE ? best : -1;
}

/** Per-vertex AO in [0,1] (1 = open, 0 = buried) for one prototype's meshes,
 *  hemisphere-sampling each vertex against the prototype's occluder grid. */
function bakeMeshAO(meshes, grid) {
  const n = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const altUp = new THREE.Vector3(1, 0, 0);
  const o = [0, 0, 0];
  const dir = [0, 0, 0];

  const result = [];
  for (const m of meshes) {
    const ao = new Array(m.count);
    for (let i = 0; i < m.count; i++) {
      n.set(m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]);
      if (n.lengthSq() < 1e-6) {
        ao[i] = 1; // no normal — leave fully open rather than guess
        continue;
      }
      n.normalize();
      // tangent frame around the normal so LOCAL_DIRS' z component is the normal
      tangent.crossVectors(Math.abs(n.z) < 0.9 ? up : altUp, n).normalize();
      bitangent.crossVectors(n, tangent).normalize();
      o[0] = m.positions[i * 3] + n.x * NORMAL_BIAS;
      o[1] = m.positions[i * 3 + 1] + n.y * NORMAL_BIAS;
      o[2] = m.positions[i * 3 + 2] + n.z * NORMAL_BIAS;

      let occluded = 0;
      for (const dl of LOCAL_DIRS) {
        dir[0] = tangent.x * dl[0] + bitangent.x * dl[1] + n.x * dl[2];
        dir[1] = tangent.y * dl[0] + bitangent.y * dl[1] + n.y * dl[2];
        dir[2] = tangent.z * dl[0] + bitangent.z * dl[1] + n.z * dl[2];
        const len = Math.hypot(dir[0], dir[1], dir[2]);
        dir[0] /= len; dir[1] /= len; dir[2] /= len;
        const hit = rayOcclusion(grid, o, dir);
        // linear distance falloff: a near wall darkens hard, a far one barely
        if (hit >= 0) occluded += 1 - hit / AO_DISTANCE;
      }
      ao[i] = +Math.max(0, 1 - occluded / RAYS).toFixed(4);
    }
    result.push({ count: m.count, ao });
  }
  return result;
}

// ---- prototype loaders -----------------------------------------------------
// GLTFLoader's embedded-image path reaches for the web-worker `self` global
// (and createImageBitmap) to blob textures. We only need GEOMETRY, so stub
// them: `self` aliases globalThis (Node 22 already has URL), and the bitmap
// decode rejects so the texture quietly drops while the mesh still parses.
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = () => Promise.reject(new Error('no-op image decode (geometry-only bake)'));
}

async function loadGLB(rel) {
  const buf = readFileSync(path.join(root, 'public', rel.replace(/^\//, '')));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return await new Promise((res, rej) => loader.parse(ab, '', (gltf) => res(gltf.scene), rej));
}

/** Transpile src/game/builtins.ts → a temp ESM module and import it, so the
 *  procedural cranes/masts are the runtime's own geometry, not a copy. */
async function loadBuiltins() {
  const src = readFileSync(path.join(root, 'src', 'game', 'builtins.ts'), 'utf8');
  const { code } = await esbuild.transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
  const tmp = path.join(mkdtempSync(path.join(os.tmpdir(), 'cj-ao-')), 'builtins.mjs');
  // rewrite the bare `three` import to the resolved install so the temp file imports cleanly
  const threeUrl = pathToFileURL(path.join(root, 'node_modules', 'three', 'build', 'three.module.js')).href;
  writeFileSync(tmp, code.replace(/from\s*['"]three['"]/g, `from '${threeUrl}'`));
  return await import(pathToFileURL(tmp).href);
}

/** A unit building block sat on its sidewalk slab — the bake's 'building'
 *  prototype. BoxGeometry is always 24 verts in a fixed order, so the bottom-
 *  ring contact darkening drapes onto any building height the runtime scales
 *  it to (src/game/environment.ts keys the corner blocks on 'building'). */
function buildBuildingProto() {
  const g = new THREE.Group();
  // matches environment.ts: BoxGeometry(11, h, 11) at y = h/2 + 0.16, on a
  // 14×0.16×14 sidewalk at y 0.08. Use h = 11 (a mid building) for the bake;
  // the contact pattern is dominated by the bottom ring either way.
  const h = 11;
  const bld = new THREE.Mesh(new THREE.BoxGeometry(11, h, 11));
  bld.position.set(0, h / 2 + 0.16, 0);
  g.add(bld);
  return g;
}

// The static built prototypes that get AO. Keys MUST match what the runtime
// passes: GLB urls verbatim (aoKeyForUrl returns the url), builtin names bare,
// and 'building' for the procedural corner blocks. The dockyard set is the
// priority (the locked refshot POV); the rest of the island's reused GLBs ride
// along for free since the bake is per-prototype.
const PROTOTYPES = [
  // --- procedural dockyard furniture (builtins.ts) ---
  { key: 'gantry-crane', kind: 'builtin', name: 'buildGantryCrane', ground: true },
  { key: 'floodlight-mast', kind: 'builtin', name: 'buildFloodlightMast', ground: true },
  { key: 'lamp-post', kind: 'builtin', name: 'buildLampPost', ground: true },
  { key: 'bollard', kind: 'builtin', name: 'buildBollard', ground: true },
  // --- shipping containers (Quaternius cargo) — the canyon + stacks ---
  { key: `${P}/quaternius-cargo/container-red.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/container-green.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/container-shipping.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/container-small.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/container-structure.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/container-train-cargo.glb`, kind: 'glb', ground: true },
  { key: `${P}/quaternius-cargo/silo.glb`, kind: 'glb', ground: true },
  // --- the lattice tower cranes (PolyPizza dockyard) ---
  { key: `${P}/polypizza-dockyard-ccby/crane-tower-jtoastie.glb`, kind: 'glb', ground: true },
  { key: `${P}/polypizza-dockyard-ccby/crane-harbor-hancock.glb`, kind: 'glb', ground: true },
  // --- corrugated warehouses / sheds (Kenney city-kit-industrial) ---
  { key: `${P}/kenney-city-kit-industrial/building-s.glb`, kind: 'glb', ground: true },
  { key: `${P}/kenney-city-kit-industrial/building-k.glb`, kind: 'glb', ground: true },
  { key: `${P}/kenney-city-kit-industrial/building-j.glb`, kind: 'glb', ground: true },
  { key: `${P}/kenney-city-kit-industrial/chimney-large.glb`, kind: 'glb', ground: true },
  // --- procedural corner blocks (environment.ts buildings — non-gantry levels) ---
  { key: 'building', kind: 'proc', build: buildBuildingProto, ground: true },
];

async function main() {
  const builtins = await loadBuiltins();
  const prototypes = {};
  let totalVerts = 0;
  const t0 = Date.now();

  for (const proto of PROTOTYPES) {
    let object;
    try {
      if (proto.kind === 'glb') object = await loadGLB(proto.key);
      else if (proto.kind === 'builtin') object = builtins[proto.name]();
      else object = proto.build();
    } catch (e) {
      console.warn(`SKIP ${proto.key} — ${e.message}`);
      continue;
    }
    const { meshes, triangles } = collectMeshes(object);
    if (!meshes.length) {
      console.warn(`SKIP ${proto.key} — no meshes`);
      continue;
    }
    const grid = buildGrid(Float32Array.from(triangles), proto.ground);
    const baked = bakeMeshAO(meshes, grid);
    const vcount = baked.reduce((s, m) => s + m.count, 0);
    totalVerts += vcount;
    // mean AO for a quick sanity read (lower = more occluded)
    let sum = 0, n = 0;
    for (const m of baked) for (const a of m.ao) { sum += a; n++; }
    prototypes[proto.key] = { meshes: baked };
    console.log(`baked ${proto.key.padEnd(56)} meshes=${baked.length} verts=${vcount} meanAO=${(sum / n).toFixed(3)}`);
  }

  const artifact = {
    version: 1,
    strength: 0.85, // documented baseline; runtime scales via AO_STRENGTH (ao.ts)
    rays: RAYS,
    aoDistance: AO_DISTANCE,
    note: 'per-vertex self+ground AO; applied ambient-only at runtime. tools/bake-ao.mjs',
    prototypes,
  };
  const outFile = path.join(root, 'public', 'baked-ao.json');
  writeFileSync(outFile, JSON.stringify(artifact));
  const kb = (readFileSync(outFile).length / 1024).toFixed(0);
  console.log(`\nwrote public/baked-ao.json — ${Object.keys(prototypes).length} prototypes, ${totalVerts} verts, ${kb} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
