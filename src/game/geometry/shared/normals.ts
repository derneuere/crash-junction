import * as THREE from 'three';

// ---------- creased normal smoothing ----------
// The PS2-era car look: low-poly geometry, SMOOTH vertex normals — that's
// what lets an env-map streak sweep across a hood instead of stamping one
// tint per facet. The baked hulls arrive with hard-edge split normals, so
// we weld them back together wherever neighboring faces are flatter than
// the crease angle; true edges (panel lines, window frames) stay sharp.

const CREASE_COS = 0.55; // ≈57° — facet pairs flatter than this smooth together

/** Cluster position-welded vertex copies whose normals agree within the
 *  crease angle: slot → cluster representative. Built from pristine
 *  normals; reusable after deformation (membership is fixed). */
export function buildNormalSmoothing(pos: THREE.BufferAttribute, norm: THREE.BufferAttribute): Uint32Array {
  const n = pos.count;
  const map = new Uint32Array(n);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1000)}|${Math.round(pos.getY(i) * 1000)}|${Math.round(pos.getZ(i) * 1000)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  for (const g of groups.values()) {
    // greedy: each unclaimed copy seeds a cluster and absorbs the rest
    // whose normals lie within the crease angle of the seed
    const claimed = new Array<boolean>(g.length).fill(false);
    for (let a = 0; a < g.length; a++) {
      if (claimed[a]) continue;
      const i = g[a];
      map[i] = i;
      claimed[a] = true;
      for (let b = a + 1; b < g.length; b++) {
        if (claimed[b]) continue;
        const j = g[b];
        const dot = norm.getX(i) * norm.getX(j) + norm.getY(i) * norm.getY(j) + norm.getZ(i) * norm.getZ(j);
        if (dot > CREASE_COS) {
          map[j] = i;
          claimed[b] = true;
        }
      }
    }
  }
  return map;
}

/** Average normals inside each smoothing cluster, in place. Run after any
 *  computeVertexNormals() — which always rebuilds flat split normals. */
export function applyNormalSmoothing(norm: THREE.BufferAttribute, map: Uint32Array): void {
  for (let i = 0; i < map.length; i++) {
    const rep = map[i];
    if (rep === i) continue;
    norm.setXYZ(rep, norm.getX(rep) + norm.getX(i), norm.getY(rep) + norm.getY(i), norm.getZ(rep) + norm.getZ(i));
  }
  for (let i = 0; i < map.length; i++) {
    if (map[i] !== i) continue;
    const x = norm.getX(i);
    const y = norm.getY(i);
    const z = norm.getZ(i);
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-6) norm.setXYZ(i, x / l, y / l, z / l);
    else norm.setXYZ(i, 0, 1, 0);
  }
  for (let i = 0; i < map.length; i++) {
    const rep = map[i];
    if (rep !== i) norm.setXYZ(i, norm.getX(rep), norm.getY(rep), norm.getZ(rep));
  }
  norm.needsUpdate = true;
}
