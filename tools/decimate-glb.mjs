// OFFLINE GLB DECIMATOR (dockyard-perf). Simplifies the heavy dockyard prop
// meshes IN PLACE with meshoptimizer's edge-collapse simplifier, preserving
// silhouette / material / (where load-bearing) UVs. Per-asset target ratios are
// tuned so the prop still reads from the race camera. Originals are backed up
// in tools/_glb-backup. VISUAL ONLY: never touches colliders, sim, RNG, camera.
//
//   fnm exec --using=22 -- node tools/decimate-glb.mjs
//
// AFTER running this, RE-BAKE AO (tools/bake-ao.mjs) so the per-vertex AO
// artifact's vertex counts match the new geometry (src/game/ao.ts matches AO
// arrays to meshes by vertex count).
//
// Two preservation modes per asset:
//   * keepUV: weld by FULL attribute identity (pos+normal+uv) so atlas/texture
//     seams stay split; carry POSITION+NORMAL+TEXCOORD_0 through the collapse by
//     gathering surviving welded verts. Used for atlas/texture-mapped props
//     (containers green/red, wheels-stack, the boats, the lighthouse) whose look
//     comes ENTIRELY from a UV-sampled texture (baseColor 1,1,1).
//   * flat (default): drop UVs, weld by position, and recompute one normal per
//     triangle — the kits' faceted matte look, for flat-baseColor props.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const io = new NodeIO();
await MeshoptSimplifier.ready;

const P = 'public/models/props';
const JOBS = [
  // --- TEXTURED (keepUV): look is a UV-sampled atlas/texture, must keep UVs ---
  { file: `${P}/quaternius-cargo/container-green.glb`, ratio: 0.45, error: 0.02, keepUV: true },
  { file: `${P}/quaternius-cargo/container-red.glb`, ratio: 0.45, error: 0.02, keepUV: true },
  { file: `${P}/quaternius-cargo/wheels-stack.glb`, ratio: 0.3, error: 0.04, keepUV: true },
  { file: `${P}/polypizza-coastal/fishing-boat-white.glb`, ratio: 0.3, error: 0.04, keepUV: true },
  { file: `${P}/polypizza-coastal/fishing-boat-green.glb`, ratio: 0.3, error: 0.04, keepUV: true },
  { file: `${P}/polypizza-coastal/lighthouse.glb`, ratio: 0.45, error: 0.03, keepUV: true },
  // --- FLAT (drop UVs): flat-baseColor props, faceted look ---
  { file: `${P}/quaternius-cargo/container-shipping.glb`, ratio: 0.5, error: 0.02 },
  { file: `${P}/quaternius-cargo/container-small.glb`, ratio: 0.55, error: 0.02 },
  { file: `${P}/quaternius-cargo/container-structure.glb`, ratio: 0.4, error: 0.03 },
  { file: `${P}/quaternius-cargo/container-train-cargo.glb`, ratio: 0.4, error: 0.03 },
  { file: `${P}/quaternius-cargo/crate.glb`, ratio: 0.18, error: 0.04 },
  { file: `${P}/quaternius-cargo/tires.glb`, ratio: 0.3, error: 0.04 },
  { file: `${P}/quaternius-cargo/silo.glb`, ratio: 0.5, error: 0.03 },
  { file: `${P}/polypizza-dockyard-ccby/crane-tower-jtoastie.glb`, ratio: 0.35, error: 0.03 },
  { file: `${P}/polypizza-dockyard-ccby/crane-harbor-hancock.glb`, ratio: 0.35, error: 0.03 },
  { file: `${P}/polypizza-dockyard-ccby/forklift-kolosstudios.glb`, ratio: 0.4, error: 0.04 },
  { file: `${P}/polypizza-coastal/life-preserver.glb`, ratio: 0.25, error: 0.05 },
];

const qpos = 1e4; // 0.1 mm grid for position welding (model units)
const quv = 1e4;

/** Weld vertices by a key. flat → key on quantized position only (collapses
 *  split-normal seams). keepUV → key on pos+uv (and normal) so texture seams
 *  stay split. Returns remap (old→welded), and the welded attribute table. */
function weld(pos, nrm, uv, count, keepUV) {
  const map = new Map();
  const remap = new Uint32Array(count);
  const wp = [], wn = [], wu = [];
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let key = `${Math.round(x * qpos)},${Math.round(y * qpos)},${Math.round(z * qpos)}`;
    if (keepUV && uv) key += `|${Math.round(uv[i * 2] * quv)},${Math.round(uv[i * 2 + 1] * quv)}`;
    let ni = map.get(key);
    if (ni === undefined) {
      ni = wp.length / 3;
      map.set(key, ni);
      wp.push(x, y, z);
      if (nrm) wn.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); else wn.push(0, 0, 0);
      if (uv) wu.push(uv[i * 2], uv[i * 2 + 1]); else wu.push(0, 0);
    }
    remap[i] = ni;
  }
  return { remap, wp: Float32Array.from(wp), wn: Float32Array.from(wn), wu: Float32Array.from(wu), wc: wp.length / 3 };
}

let totalBefore = 0, totalAfter = 0;
for (const job of JOBS) {
  const abs = path.join(root, job.file);
  const doc = await io.read(abs);
  let before = 0, after = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const count = posAcc.getCount();
      const pos = posAcc.getArray();
      const nrm = prim.getAttribute('NORMAL')?.getArray() ?? null;
      const uv = prim.getAttribute('TEXCOORD_0')?.getArray() ?? null;
      const idxAcc = prim.getIndices();
      const srcIdx = idxAcc ? Uint32Array.from(idxAcc.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
      const tris0 = srcIdx.length / 3;
      before += tris0;

      const { remap, wp, wn, wu, wc } = weld(pos, nrm, uv, count, job.keepUV);
      const weldedIdx = Uint32Array.from(srcIdx, (i) => remap[i]);
      const target = Math.max(3, Math.floor(tris0 * job.ratio)) * 3;
      const [simpIdx] = MeshoptSimplifier.simplify(weldedIdx, wp, 3, target, job.error, ['LockBorder']);

      // renumber the surviving welded verts to a dense 0..N-1 in first-use order
      const seen = new Int32Array(wc).fill(-1);
      let next = 0;
      const finalIdx = new Uint32Array(simpIdx.length);
      for (let i = 0; i < simpIdx.length; i++) {
        const ov = simpIdx[i];
        let nv = seen[ov];
        if (nv === -1) { nv = next++; seen[ov] = nv; }
        finalIdx[i] = nv;
      }
      after += finalIdx.length / 3;

      // clear existing attributes
      for (const sem of prim.listSemantics()) prim.setAttribute(sem, null);
      prim.setIndices(null);

      if (job.keepUV) {
        // gather surviving welded verts' pos/normal/uv into dense arrays; keep
        // the indexed result (smooth normals carried from the source weld).
        const fp = new Float32Array(next * 3);
        const fn = new Float32Array(next * 3);
        const fu = new Float32Array(next * 2);
        for (let ov = 0; ov < wc; ov++) {
          const nv = seen[ov];
          if (nv === -1) continue;
          fp[nv * 3] = wp[ov * 3]; fp[nv * 3 + 1] = wp[ov * 3 + 1]; fp[nv * 3 + 2] = wp[ov * 3 + 2];
          fn[nv * 3] = wn[ov * 3]; fn[nv * 3 + 1] = wn[ov * 3 + 1]; fn[nv * 3 + 2] = wn[ov * 3 + 2];
          fu[nv * 2] = wu[ov * 2]; fu[nv * 2 + 1] = wu[ov * 2 + 1];
        }
        prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(fp));
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(fn));
        prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(fu));
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(finalIdx));
      } else {
        // flat-shade: explode to per-face verts + one normal per triangle
        const wpFlat = new Float32Array(next * 3);
        for (let ov = 0; ov < wc; ov++) {
          const nv = seen[ov];
          if (nv === -1) continue;
          wpFlat[nv * 3] = wp[ov * 3]; wpFlat[nv * 3 + 1] = wp[ov * 3 + 1]; wpFlat[nv * 3 + 2] = wp[ov * 3 + 2];
        }
        const { pos2, nrm2, ix2 } = explodeFlat(finalIdx, wpFlat);
        prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos2));
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm2));
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(ix2));
      }
    }
  }
  // prune orphaned accessors and write back
  await doc.transform();
  await io.write(abs, doc);
  totalBefore += before; totalAfter += after;
  const tag = job.keepUV ? 'UV' : '  ';
  console.log(`[${tag}] ${job.file.replace(P + '/', '').padEnd(46)} ${String(Math.round(before)).padStart(6)} -> ${String(Math.round(after)).padStart(6)} tris  (${Math.round((1 - after / before) * 100)}% cut)`);
}
console.log(`\nTOTAL prop tris (per-asset, 1x): ${Math.round(totalBefore)} -> ${Math.round(totalAfter)}  (${Math.round((1 - totalAfter / totalBefore) * 100)}% cut)`);

function explodeFlat(idx, pos) {
  const triN = idx.length / 3;
  const pos2 = new Float32Array(triN * 9);
  const nrm2 = new Float32Array(triN * 9);
  const ix2 = new Uint32Array(triN * 3);
  for (let t = 0; t < triN; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const src = verts[k];
      const o = (t * 3 + k) * 3;
      pos2[o] = pos[src * 3]; pos2[o + 1] = pos[src * 3 + 1]; pos2[o + 2] = pos[src * 3 + 2];
      nrm2[o] = nx; nrm2[o + 1] = ny; nrm2[o + 2] = nz;
      ix2[t * 3 + k] = t * 3 + k;
    }
  }
  return { pos2, nrm2, ix2 };
}
