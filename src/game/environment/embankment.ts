import * as THREE from 'three';
import type { CoastDef, LevelDef } from '../types';
import { makeDuneBlendTexture, makePatchTexture } from '../textures';
import { EMBANKMENT_FADE, ROAD_SHOULDER } from './elevation';

/** Embankment drape: the VISUAL ground for the road-base elevation field.
 *  Without it an elevated ribbon floats over flat island grass. One quad
 *  strip per side of every elevated chain span, columns at the sampler's
 *  own lateral breakpoints (road edge → shoulder → fade → grade). Every
 *  vertex takes its height, color AND normal from the FIELD ITSELF
 *  (base(x,z) + finite-difference gradient): on the inside of bends
 *  tighter than the fade reach the lateral fans self-intersect, and
 *  field-sampled folds land coincident — same depth, same shading — so
 *  the overlap is invisible where per-fan lerps drew black creases.
 *  Textured with the SAME world-tiled drygrass the gold ground patches
 *  use — same texture, same (x, −z) UV rule, same 8 m tile — so where
 *  the drape surfaces through a flat patch the intersection contour is
 *  pattern-identical and disappears. Columns that would cross the coast
 *  outline are clipped to it, with the clip vertex on the outline's rim
 *  line (the same lerp the skirts use), so the drape hands off to the
 *  raised cliff skirt watertight instead of hovering over the sea.
 *  PURE VISUAL: no bodies, build-time sampler reads only, zero
 *  determinism cost. */
export function addEmbankments(
  scene: THREE.Scene,
  chains: { secs: { x: number; z: number; y: number; dirX: number; dirZ: number }[]; halfW: number; closed: boolean }[],
  coast: CoastDef | undefined,
  base: (x: number, z: number) => number,
): void {
  const LIFT = 0.004; // under every paint slot, above the y-0 island sheet
  const o = coast?.outline;
  const inIsland = (x: number, z: number): boolean => {
    if (!o) return true;
    let inside = false;
    for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
      const a = o[i];
      const b = o[j];
      if (a.z > z !== b.z > z && x < a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z)) inside = !inside;
    }
    return inside;
  };
  /** Clip the segment p→q (p inside, q outside) against the outline; returns
   *  the intersection plus the rim elevation lerped along the crossed edge. */
  const clipToRim = (px: number, pz: number, qx: number, qz: number): { x: number; z: number; y: number } => {
    if (o) {
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
        const a = o[j];
        const b = o[i];
        const rx = qx - px;
        const rz = qz - pz;
        const sx = b.x - a.x;
        const sz = b.z - a.z;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a.x - px) * sz - (a.z - pz) * sx) / den;
        const u = ((a.x - px) * rz - (a.z - pz) * rx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          return { x: px + rx * t, z: pz + rz * t, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * u };
        }
      }
    }
    return { x: qx, z: qz, y: 0 };
  };

  const posArr: number[] = [];
  const uvArr: number[] = [];
  const nrmArr: number[] = [];
  const idx: number[] = [];
  /** Field-derived vertex: position, patch-aligned UV, gradient normal. */
  const pushVertex = (x: number, z: number, y: number): void => {
    posArr.push(x, y + LIFT, z);
    uvArr.push(x, -z); // ShapeGeometry's raw shape coords — repeat does the tiling
    const e = 0.75;
    const nx = (base(x - e, z) - base(x + e, z)) / (2 * e);
    const nz = (base(x, z - e) - base(x, z + e)) / (2 * e);
    const l = Math.hypot(nx, 1, nz);
    nrmArr.push(nx / l, 1 / l, nz / l);
  };
  for (const { secs, halfW, closed } of chains) {
    const N = secs.length;
    // elevated spans, dilated 2 sections so the strip feathers onto grade
    const hot = secs.map((s) => s.y > 0.001);
    const elev = secs.map((_, i) => {
      for (let k = -2; k <= 2; k++) {
        const j = closed ? (i + k + N) % N : i + k;
        if (j >= 0 && j < N && hot[j]) return true;
      }
      return false;
    });
    const runs: number[][] = [];
    let start = 0;
    if (closed) {
      // start at a cold section so no run straddles the array seam
      start = elev.findIndex((e) => !e);
      if (start < 0) start = 0;
    }
    let cur: number[] | null = null;
    for (let k = 0; k < N; k++) {
      const i = closed ? (start + k) % N : k;
      if (elev[i]) {
        if (!cur) runs.push((cur = []));
        cur.push(i);
      } else cur = null;
    }
    // column offsets across the embankment band. The fade is now a filleted
    // C1 curve (not a straight ramp), so the strip needs columns where the
    // curvature lives — clustered at the two fillet corners (plateau lip and
    // grade toe) — or the smooth fade would render as flat facets. Fractions
    // of the fade band: 0 (lip), .18 + .09 (entry fillet), .5 (core), .82 +
    // .91 (exit fillet), 1 (toe). Every vertex still samples base() directly,
    // so the visual exactly tracks the physics field at these stations.
    const lip = halfW + ROAD_SHOULDER;
    const fr = [0, 0.18, 0.27, 0.5, 0.73, 0.82, 0.91, 1];
    const offs = [halfW - 0.5, ...fr.map((f) => lip + f * EMBANKMENT_FADE)];
    for (const run of runs) {
      for (const side of [1, -1]) {
        const rowBase = posArr.length / 3;
        for (let r = 0; r < run.length; r++) {
          const s = secs[run[r]];
          let clipped: { x: number; z: number; y: number } | null = null;
          for (let j = 0; j < offs.length; j++) {
            let x = s.x - side * s.dirZ * offs[j];
            let z = s.z + side * s.dirX * offs[j];
            if (clipped) {
              x = clipped.x;
              z = clipped.z;
            } else if (j > 0 && !inIsland(x, z)) {
              const px = s.x - side * s.dirZ * offs[j - 1];
              const pz = s.z + side * s.dirX * offs[j - 1];
              clipped = clipToRim(px, pz, x, z);
              x = clipped.x;
              z = clipped.z;
            }
            // clipped vertices take the outline's rim lerp (watertight with
            // the skirt top row); everything else samples the field
            pushVertex(x, z, clipped ? clipped.y : base(x, z));
          }
        }
        const C = offs.length;
        for (let r = 0; r < run.length - 1; r++) {
          for (let j = 0; j < C - 1; j++) {
            const a = rowBase + r * C + j;
            const b = rowBase + (r + 1) * C + j;
            // wind so the up-faces face up regardless of side
            if (side === 1) idx.push(a, b, a + 1, a + 1, b, b + 1);
            else idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
      }
    }
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArr), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrmArr), 3));
  geo.setIndex(idx);
  const tex = makePatchTexture('drygrass');
  tex.repeat.setScalar(1 / 8); // the GroundPatchDef drygrass tile (TILE table)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/** [art-grass-sand] Dune-lip transition overlay — the GRASS side of the
 *  grass→sand boundary. Builds a thin alpha-masked grass-tongue strip that
 *  rides just above the sand at the beach, so the island lawn appears to
 *  THIN into the sand in broken fingers instead of stopping at a polygon
 *  seam. Pure visual (no bodies, build-time only, zero determinism cost).
 *
 *  Seam contract: this OWNS the grass side only. The SAND patch is the
 *  sand-water sibling's; we read its (and the dune band's) existing geometry
 *  and align our fringe to it — we never edit the sand material/patch here.
 *  The strip is generated from the beach DUNE BAND (the thin 'drygrass'
 *  patch authored in beach.ts): its loop is split at the two narrow ends
 *  (min/max x) into a SEAWARD polyline and an INLAND polyline; the fringe is
 *  a quad strip between them with v=0 inland (full grass) → v=1 seaward
 *  (bare). makeDuneBlendTexture supplies the height-thresholded grass tongues.
 */
export function addDuneFringe(scene: THREE.Scene, level: LevelDef): void {
  // the dune band = the 'drygrass' patch sitting in the SW beach quadrant
  // (the headland drygrass tongues are drygrass too, but they live NE/E and
  // meet gold grass, not sand — scope by the beach zone bounds x<-78,z<-60).
  const band = (level.patches ?? []).find(
    (p) =>
      p.kind === 'drygrass' &&
      p.poly.length >= 6 &&
      p.poly.every(([x, z]) => x <= -78 && z <= -60),
  );
  if (!band) return;
  const poly = band.poly;
  const M = poly.length;
  // split the thin loop into two long edges at its narrow ends (min/max x):
  // walking from the min-x vertex to the max-x vertex one way is one edge,
  // the other way is the other. One edge runs nearer the sea, one inland.
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < M; i++) {
    if (poly[i][0] < poly[iMin][0]) iMin = i;
    if (poly[i][0] > poly[iMax][0]) iMax = i;
  }
  const walk = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % M) {
      out.push(poly[i]);
      if (i === to) break;
    }
    return out;
  };
  const edgeA = walk(iMin, iMax);
  const edgeB = walk(iMax, iMin);
  // the inland edge sits at higher (less negative) z on average — the band
  // is authored ~10 m up the lawn on its inland side; the seaward side hugs
  // the sand. Use mean z to label them robustly.
  const meanZ = (e: [number, number][]): number => e.reduce((s, p) => s + p[1], 0) / e.length;
  let inland = meanZ(edgeA) > meanZ(edgeB) ? edgeA : edgeB;
  let seaward = inland === edgeA ? edgeB : edgeA;
  // resample both edges to the SAME column count so the strip pairs cleanly,
  // and orient them to run the same direction (by their first vertex x)
  if (inland[0][0] > inland[inland.length - 1][0]) inland = [...inland].reverse();
  if (seaward[0][0] > seaward[seaward.length - 1][0]) seaward = [...seaward].reverse();
  const COLS = 48;
  const lerpEdge = (e: [number, number][], t: number): [number, number] => {
    const f = t * (e.length - 1);
    const i = Math.min(e.length - 2, Math.floor(f));
    const k = f - i;
    return [e[i][0] + (e[i + 1][0] - e[i][0]) * k, e[i][1] + (e[i + 1][1] - e[i][1]) * k];
  };
  // push the seaward row a few metres FURTHER onto the sand than the band's
  // own seaward edge, so the tongues finger past the existing drygrass→sand
  // line and break that seam too (not just the green→drygrass one)
  const pos: number[] = [];
  const uv: number[] = [];
  let u = 0;
  let prevX = 0;
  let prevZ = 0;
  for (let cIdx = 0; cIdx < COLS; cIdx++) {
    const t = cIdx / (COLS - 1);
    const inP = lerpEdge(inland, t);
    const seP = lerpEdge(seaward, t);
    // extend ~4 m seaward along the inland→seaward direction
    const dx = seP[0] - inP[0];
    const dz = seP[1] - inP[1];
    const dl = Math.hypot(dx, dz) || 1;
    const seX = seP[0] + (dx / dl) * 4;
    const seZ = seP[1] + (dz / dl) * 4;
    if (cIdx > 0) u += Math.hypot(inP[0] - prevX, inP[1] - prevZ) / 9; // tile u every ~9 m
    prevX = inP[0];
    prevZ = inP[1];
    // two rows: inland (v0) then seaward (v1)
    pos.push(inP[0], 0, inP[1], seX, 0, seZ);
    uv.push(u, 0, u, 1);
  }
  const idx: number[] = [];
  for (let cIdx = 0; cIdx < COLS - 1; cIdx++) {
    const a = cIdx * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: makeDuneBlendTexture(),
    transparent: true,
    alphaTest: 0.35, // cut the tongues crisply so they take light + shadow
    roughness: 1,
    side: THREE.DoubleSide,
    polygonOffset: true, // float just over the sand patch (0.006) without z-fight
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const fringe = new THREE.Mesh(geo, mat);
  fringe.position.y = 0.0068; // above the sand patch (0.006), below the ribbons (0.010)
  fringe.rotation.x = 0; // positions are already world (x, y, z)
  fringe.receiveShadow = true;
  scene.add(fringe);
}
