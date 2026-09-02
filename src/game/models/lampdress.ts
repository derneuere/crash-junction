import * as THREE from 'three';
import { Soup, mergeSoups, type V3 } from './procgen/soup';
import { headlightUnit, taillightUnit, type LampFrame, type P2 } from './procgen/lampkit';

// ────────────────────────────────────────────────────────────────────────────
// Lamp dressing for the baked GLB cars. The car packs paint their lights as
// flat cream / red polygons flush with the fascia — fine at 40 m, a sticker
// up close. This finds each lamp polygon (connected patches of the
// Headlights / TailLights materials on the nose and tail faces), fits a
// local frame to it (its own plane and outline) and builds the same lamp
// kit unit the procedural cars wear on top of it: bezel, housing floor,
// reflector bowls / ribbed lens plate, indicator and reverse segments.
// The original polygon becomes the unit's back wall.
//
// Runs once at bake, before normalisation, in the model's raw space. It is
// pure geometry: the extra prims ride along the same merge / colour-range /
// group pipeline as the pack's own prims (matName decides the role), and
// the bake keeps its size normalisation on the UNDRESSED bounds, so the
// dressing never moves a wheel arch or a panel box.
// ────────────────────────────────────────────────────────────────────────────

export interface LampDressPrim {
  geo: THREE.BufferGeometry;
  matName: 'Headlights' | 'TailLights' | 'ReverseLights' | 'LampBezel';
  colors: Float32Array;
}

interface Patch {
  tris: number[]; // triangle indices into the prim
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
}

const KEY_Q = 1000; // 1 mm weld for the patch connectivity

/** Split a prim's triangles into position-connected patches. */
function patches(geo: THREE.BufferGeometry): Patch[] {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const idx = geo.index;
  const triCount = (idx ? idx.count : pos.count) / 3;
  const vert = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  const key = (i: number) =>
    `${Math.round(pos.getX(i) * KEY_Q)}|${Math.round(pos.getY(i) * KEY_Q)}|${Math.round(pos.getZ(i) * KEY_Q)}`;
  // union-find over triangles through shared (welded) positions
  const parent = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  const find = (t: number): number => {
    while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; }
    return t;
  };
  const owner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const kk = key(vert(t, k));
      const o = owner.get(kk);
      if (o === undefined) owner.set(kk, t);
      else parent[find(o)] = find(t);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const out: Patch[] = [];
  for (const tris of groups.values()) {
    const normal = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    let area = 0;
    for (const t of tris) {
      a.fromBufferAttribute(pos, vert(t, 0));
      b.fromBufferAttribute(pos, vert(t, 1));
      c.fromBufferAttribute(pos, vert(t, 2));
      const n = b.clone().sub(a).cross(c.clone().sub(a)); // 2·area·n̂
      const w = n.length();
      normal.add(n);
      centroid.addScaledVector(a.clone().add(b).add(c).multiplyScalar(1 / 3), w);
      area += w;
    }
    if (area < 1e-9) continue;
    normal.normalize();
    centroid.multiplyScalar(1 / area);
    out.push({ tris, normal, centroid });
  }
  return out;
}

/** Build the dressing prims for a bake's body prims (raw model space, nose
 *  at −z). `indexed` matches the pack's index state so the merge accepts
 *  the extra prims. */
export function dressLamps(
  prims: { geo: THREE.BufferGeometry; matName: string }[],
  isHead: (matName: string) => boolean,
  isTail: (matName: string) => boolean,
  indexed: boolean,
): LampDressPrim[] {
  // body z-extent → only patches on the end faces are lamps (the police
  // roof bar shares the tail material)
  let zMin = Infinity, zMax = -Infinity;
  for (const p of prims) {
    p.geo.computeBoundingBox();
    zMin = Math.min(zMin, p.geo.boundingBox!.min.z);
    zMax = Math.max(zMax, p.geo.boundingBox!.max.z);
  }
  const halfLen = (zMax - zMin) / 2;
  const zMid = (zMin + zMax) / 2;

  const soups = { head: new Soup(), tail: new Soup(), reverse: new Soup(), trim: new Soup() };
  const UP = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  for (const prim of prims) {
    const head = isHead(prim.matName);
    const tailish = !head && isTail(prim.matName);
    if (!head && !tailish) continue;
    const pos = prim.geo.attributes.position as THREE.BufferAttribute;
    const idx = prim.geo.index;
    const vert = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    for (const patch of patches(prim.geo)) {
      const n = patch.normal;
      // must face out the nose (head) or the tail (tail), and sit on that end
      if (head ? n.z > -0.6 : n.z < 0.6) continue;
      if (Math.abs(patch.centroid.z - zMid) < halfLen * 0.55) continue;
      const u = new THREE.Vector3().crossVectors(UP, n).normalize();
      if (u.x * patch.centroid.x < 0) u.negate(); // a runs outboard
      const v = new THREE.Vector3().crossVectors(u, n);
      if (v.y < 0) v.negate();
      // outline: the patch's bounds in its own plane; origin on its proudest point
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity, dMax = -Infinity;
      const seen = new Set<number>();
      for (const t of patch.tris) {
        for (let k = 0; k < 3; k++) {
          const i = vert(t, k);
          if (seen.has(i)) continue;
          seen.add(i);
          p.fromBufferAttribute(pos, i).sub(patch.centroid);
          const a = p.dot(u), b = p.dot(v), d = p.dot(n);
          a0 = Math.min(a0, a); a1 = Math.max(a1, a);
          b0 = Math.min(b0, b); b1 = Math.max(b1, b);
          dMax = Math.max(dMax, d);
        }
      }
      const w = a1 - a0, h = b1 - b0;
      if (w < 0.05 || h < 0.03 || w > 0.9 || h > 0.6) continue; // not a lamp polygon
      const o = patch.centroid.clone().addScaledVector(n, dMax);
      const f: LampFrame = {
        o: [o.x, o.y, o.z] as V3,
        u: [u.x, u.y, u.z] as V3,
        v: [v.x, v.y, v.z] as V3,
        n: [n.x, n.y, n.z] as V3,
      };
      const m = 0.002; // the bezel just covers the polygon's edge
      const outline: P2[] = [[a0 - m, b0 - m], [a1 + m, b0 - m], [a1 + m, b1 + m], [a0 - m, b1 + m]];
      // 8 facets: the packs' lamps are a hand wide, and the crease pass
      // smooths the bowls round either way
      if (head) headlightUnit({ head: soups.head, trim: soups.trim }, f, outline, 8);
      else taillightUnit({ tail: soups.tail, reverse: soups.reverse, trim: soups.trim }, f, outline, 8);
    }
  }

  const out: LampDressPrim[] = [];
  const roles: [Soup, LampDressPrim['matName']][] = [
    [soups.head, 'Headlights'], [soups.tail, 'TailLights'], [soups.reverse, 'ReverseLights'], [soups.trim, 'LampBezel'],
  ];
  for (const [soup, matName] of roles) {
    if (!soup.vertexCount) continue;
    const { geo } = mergeSoups([soup]);
    const colors = Float32Array.from((geo.attributes.color as THREE.BufferAttribute).array as Float32Array);
    geo.deleteAttribute('color'); // the bake owns the colour buffer
    if (indexed) {
      const n = (geo.attributes.position as THREE.BufferAttribute).count;
      const seq = new Uint32Array(n);
      for (let i = 0; i < n; i++) seq[i] = i;
      geo.setIndex(new THREE.BufferAttribute(seq, 1));
    }
    out.push({ geo, matName, colors });
  }
  return out;
}
