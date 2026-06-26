import type { PropDef } from '../../../types';
import { hash01 } from '../../../textures';
import { NATURE, decor } from '../dressing';

// [art-grass-sand] Low-poly dune-grass TUFT scatter along the grass→sand
// dune lip. The textured grass-fringe overlay (environment.ts addDuneFringe)
// breaks the seam in 2D; these little 3D tufts break it in silhouette too —
// the "scatter tufts at the boundary" technique for stylized transitions, so
// the lawn reads as thinning into the sand with real blades catching the
// light, not a painted line. All collider:'none' (pure decor, zero physics),
// hash-stable jitter so the refshot pose diffs clean. Walks a polyline along
// the lip and drops tufts with a seaward bias that thins as it nears the sand.
export const duneTufts = (pts: [number, number][], spacing: number): PropDef[] => {
  const out: PropDef[] = [];
  let n = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, z0] = pts[s];
    const [x1, z1] = pts[s + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    // seaward normal (toward the sand): rotate the along-lip dir −90°
    const nx = uz;
    const nz = -ux;
    for (let d = spacing / 2; d < len; d += spacing) {
      const h = n * 2.3 + s * 7.7;
      // jitter along + across the lip; positive offset pushes onto the sand,
      // so a couple of straggler tufts sit out past the lip like real dune grass
      const along = (hash01(h + 1) - 0.5) * spacing * 0.8;
      const across = (hash01(h + 2) - 0.35) * 5.5; // biased seaward
      const bx = x0 + ux * (d + along) + nx * across;
      const bz = z0 + uz * (d + along) + nz * across;
      const yaw = hash01(h + 3) * Math.PI * 2;
      // mix three grass GLBs at small scales so the tuft line reads varied,
      // smaller the further it strays onto the sand (dune grass thins out)
      const pick = hash01(h + 4);
      const url = pick < 0.45 ? 'grass.glb' : pick < 0.8 ? 'grass_leafs.glb' : 'grass_large.glb';
      const thin = Math.max(0, across) / 5.5; // 0 on the lip → 1 well onto sand
      const scale = (2.1 + hash01(h + 5) * 1.4) * (1 - thin * 0.45);
      out.push(decor(`${NATURE}/${url}`, bx, bz, yaw, scale));
      n++;
    }
  }
  return out;
};

// Rope-post fencing along the Beach Run path, like the concept's post line:
// chain fence pieces end-to-end along a polyline (every 4th a plank section
// so the run doesn't read as a single extrusion). Visual-only decor — the
// forgiving cut stays unwalled, the posts just SELL the path edge.
export const fenceLine = (pts: [number, number][], scale: number): PropDef[] => {
  const out: PropDef[] = [];
  let i = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, z0] = pts[s];
    const [x1, z1] = pts[s + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    // fence_simple spans local x (1 unit, z-offset pivot cz -0.47): aim
    // local +x down the run. decor maps local x to (cos yaw, -sin yaw).
    const yaw = Math.atan2(-uz, ux);
    for (let d = scale / 2; d + scale / 2 <= len; d += scale) {
      const url = `${NATURE}/${i % 4 === 3 ? 'fence_planks' : 'fence_simple'}.glb`;
      out.push(decor(url, x0 + ux * d, z0 + uz * d, yaw, scale, { cz: -0.47 }));
      i++;
    }
  }
  return out;
};
