import * as THREE from 'three';
import type { CoastDef } from '../types';
import { hash01 } from '../textures';

/** Shared geometry context for the coast skirt builders, derived once in
 *  buildCoast: the outline, the mitred per-vertex outward normals + averaged
 *  skirt widths, the per-segment outward normals, the waterline depth scales
 *  and the seaLevel. `cliffKey` is the deterministic jitter counter advanced
 *  across every addCliffSkirt call (it must persist between runs so the rock
 *  jitter stays stable — the refshot poses depend on it). */
export interface CoastCtx {
  scene: THREE.Scene;
  o: CoastDef['outline'];
  n: number;
  sea: number;
  BOT: number;
  botF: number;
  vOut: { x: number; z: number }[];
  vW: number[];
  segOut: { x: number; z: number }[];
  cliffKey: number; // deterministic jitter key, advances per column built
}

/** a simple skirt: one quad strip from the rim (y 0, or the vertex's
 *  authored rim elevation along an elevated road) down past the
 *  waterline. Adjacent runs share their boundary columns bit-for-bit (same
 *  mitred outward, same averaged width), so the ring stays watertight. */
export function addFlatSkirt(ctx: CoastCtx, segs: number[], mat: THREE.Material, tile: number): void {
  const { scene, o, n, BOT, botF, vOut, vW } = ctx;
  const cols = segs.length + 1; // closed runs just duplicate the seam column
  const pos = new Float32Array(cols * 6);
  const uv = new Float32Array(cols * 4);
  let u = 0;
  for (let c = 0; c < cols; c++) {
    const vi = (segs[0] + c) % n;
    if (c > 0) {
      const pv = (segs[0] + c - 1) % n;
      u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / tile;
    }
    const k = c * 6;
    pos[k] = o[vi].x;
    pos[k + 1] = o[vi].y ?? 0;
    pos[k + 2] = o[vi].z;
    pos[k + 3] = o[vi].x + vOut[vi].x * vW[vi] * botF;
    pos[k + 4] = BOT;
    pos[k + 5] = o[vi].z + vOut[vi].z * vW[vi] * botF;
    uv[c * 4] = u;
    uv[c * 4 + 1] = 0;
    uv[c * 4 + 2] = u;
    uv[c * 4 + 3] = 1;
  }
  const idx: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    const a = c * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/** jagged rock face: extra columns every ~7 m and four rows down the face,
 *  interior vertices jittered by index-hash (stable across reloads — the
 *  refshot poses depend on it). Run-boundary columns and the rim row stay
 *  clean so the cliff still butts flush against its neighbours and the
 *  island polygon. */
export function addCliffSkirt(ctx: CoastCtx, segs: number[]): void {
  const { scene, o, n, BOT, botF, vOut, vW, segOut } = ctx;
  const closed = segs.length === n;
  interface Col {
    tx: number;
    tz: number;
    ty: number; // rim elevation (lerped between vertex rim y values)
    bx: number; // bottom offset (added to top), already botF-scaled
    bz: number;
    ox: number; // outward + along directions for jitter
    oz: number;
    ax: number;
    az: number;
    key: number;
    pinned: boolean; // run boundary — no jitter
  }
  const colList: Col[] = [];
  const pushCol = (tx: number, tz: number, ty: number, bx: number, bz: number, i: number, key: number, pinned: boolean) => {
    const l = Math.hypot(bx, bz) || 1;
    colList.push({
      tx,
      tz,
      ty,
      bx,
      bz,
      ox: bx / l,
      oz: bz / l,
      ax: -segOut[i].z,
      az: segOut[i].x,
      key,
      pinned,
    });
  };
  const firstKey = ctx.cliffKey;
  let rimMax = 0; // tallest rim in this run — drives the face row count
  for (let s = 0; s < segs.length; s++) {
    const i = segs[s];
    const j = (i + 1) % n;
    rimMax = Math.max(rimMax, o[i].y ?? 0, o[j].y ?? 0);
    const len = Math.hypot(o[j].x - o[i].x, o[j].z - o[i].z);
    const sub = Math.max(1, Math.round(len / 7));
    const bA = { x: vOut[i].x * vW[i] * botF, z: vOut[i].z * vW[i] * botF };
    const bB = { x: vOut[j].x * vW[j] * botF, z: vOut[j].z * vW[j] * botF };
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      pushCol(
        o[i].x + (o[j].x - o[i].x) * t,
        o[i].z + (o[j].z - o[i].z) * t,
        (o[i].y ?? 0) + ((o[j].y ?? 0) - (o[i].y ?? 0)) * t,
        bA.x + (bB.x - bA.x) * t,
        bA.z + (bB.z - bA.z) * t,
        i,
        ctx.cliffKey++,
        !closed && s === 0 && k === 0,
      );
    }
  }
  // terminal column: the run's last vertex — for a closed run it's the
  // seam duplicate and must reuse column 0's jitter key to stay welded
  const tail = segs[segs.length - 1];
  const tv = (tail + 1) % n;
  pushCol(
    o[tv].x,
    o[tv].z,
    o[tv].y ?? 0,
    vOut[tv].x * vW[tv] * botF,
    vOut[tv].z * vW[tv] * botF,
    tail,
    closed ? firstKey : ctx.cliffKey++,
    !closed,
  );

  // an elevated rim stretches the face from ~3.4 m to 9+ — two extra
  // jittered rows keep the rock chunky instead of stretched (Phase 0's
  // "taller cliff skirt": more rows where the drama is)
  const ROWS = rimMax > 1.5 ? 6 : 4;
  const cols = colList.length;
  const pos = new Float32Array(cols * ROWS * 3);
  const col = new Float32Array(cols * ROWS * 3);
  const rock0 = new THREE.Color(0x857f72); // weathered grey
  const rock1 = new THREE.Color(0xa08e6f); // tan strata
  const tmp = new THREE.Color();
  for (let c = 0; c < cols; c++) {
    const cc = colList[c];
    for (let r = 0; r < ROWS; r++) {
      const t = r / (ROWS - 1);
      let x = cc.tx + cc.bx * t;
      let y = cc.ty + (BOT - cc.ty) * t;
      let z = cc.tz + cc.bz * t;
      if (!cc.pinned && r > 0 && r < ROWS - 1) {
        // mid rows carry the full jitter; the rim (r 0) stays glued to
        // the island and the bottom row is underwater anyway
        const h = cc.key * 13 + r * 5;
        x += cc.ox * (hash01(h + 1) - 0.5) * 2.8 + cc.ax * (hash01(h + 3) - 0.5) * 1.8;
        z += cc.oz * (hash01(h + 1) - 0.5) * 2.8 + cc.az * (hash01(h + 3) - 0.5) * 1.8;
        y += (hash01(h + 2) - 0.5) * 0.8;
      }
      const v = (c * ROWS + r) * 3;
      pos[v] = x;
      pos[v + 1] = y;
      pos[v + 2] = z;
      const shade = 0.85 + hash01(cc.key * 13 + r * 5 + 4) * 0.3;
      tmp.copy(rock0).lerp(rock1, hash01(cc.key * 13 + r * 5 + 5)).multiplyScalar(shade);
      col[v] = tmp.r;
      col[v + 1] = tmp.g;
      col[v + 2] = tmp.b;
    }
  }
  const idx: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < ROWS - 1; r++) {
      const a = c * ROWS + r;
      const b = (c + 1) * ROWS + r;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
  );
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
}
