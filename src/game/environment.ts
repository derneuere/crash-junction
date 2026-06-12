import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { CoastDef, LevelDef, RaceWaypoint } from './types';
import { GROUP_DECOR, type PhysicsContext } from './physics';
import { buildOpenSections, SHORTCUT_SPACING } from './race';
import {
  hash01,
  makeChainLinkTexture,
  makeChevronTexture,
  makeFoamTexture,
  makePatchTexture,
  makeQuayTexture,
  makeSeaTexture,
  makeWindowTextures,
  type PatchKind,
} from './textures';
import type { HeightSampler } from './suspension';

// Z-ORDER CONTRACT for coplanar ground paint (the camera never goes under
// the road, so tiny y offsets beat polygonOffset): grass/island ground 0 →
// ground patches 0.006 (GroundPatchDef default) → shortcut ribbons 0.010 →
// main race ribbon 0.012 → decals 0.014 → centre dashes / stripes 0.015.
// New paint must keep to its slot or the junction overlaps will shimmer.

// ---- the road-base elevation field (elevation.md Phase 1) ----
// Full elevation holds across the corridor plus a shoulder (the walls and
// posts at halfW+1.65 must stand on the plateau, not its slope), then an
// embankment fade back to grade. The doc's bounds: fade ≥ 15 m at ≤ ~25%
// slope — 6 m over 26 m ≈ 23%, gentler than ANY feature skirt today (the
// ramp side-skirt is 220%/m). Every number here is a SIM tunable: the
// sampler feeds physics, so retuning either repeats the determinism bill.
const ROAD_SHOULDER = 3.5; // m past the ribbon edge at full elevation
const EMBANKMENT_FADE = 26; // m from the shoulder back down to grade

/** One straight run of elevated road centreline between two sections. */
interface ElevSeg {
  ax: number;
  az: number;
  ux: number; // unit a→b
  uz: number;
  len: number;
  ay: number; // elevation at the a/b ends
  by: number;
  plateau: number; // halfW + shoulder for this chain
  minX: number; // influence bounds (plateau + fade inflated)
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Vertical height field for the suspension rays, decomposed per the
 *  HeightSampler contract (suspension.ts): a smooth road-grade BASE from
 *  the race section chains, plus launchable FEATURES — ramp wedges and the
 *  0.16 m sidewalk plinths — stacked on top. The chassis box ignores all
 *  of it (GROUP_DECOR filtering) — the springs are the only thing that
 *  touches it, so jumps and kerb hops are pure suspension + ballistics.
 *
 *  Determinism: on a track with no elevation profile the segment list is
 *  EMPTY, base() returns literal 0 and total degenerates to the feature
 *  loops alone — bit-identical to the pre-elevation sampler on every flat
 *  level (the two replay pins prove it). The field history of this engine
 *  is one long fight against edges: the base field adds NO new edges, only
 *  C0-continuous grades with a linear lateral fade. */
export function makeHeightSampler(level: LevelDef): HeightSampler {
  const ramps = level.ramps;
  const slabs = level.buildings;
  const feature = (x: number, z: number): number => {
    let h = 0;
    for (const r of ramps) {
      // lateral skirt: the wedge fades out over a metre past its edge, so
      // clipping a ramp side rides up like a steep kerb instead of the
      // height field teleporting a wheel a metre into the air
      const lat = Math.abs(x - r.x) - r.width / 2;
      if (lat > 1) continue;
      const t = (z - r.zStart) / r.length;
      if (t < 0 || t > 1) continue;
      h = Math.max(h, r.height * t * (lat <= 0 ? 1 : 1 - lat));
    }
    for (const s of slabs) {
      // plinth edge blends over 0.35 m — the springs walk up it smoothly
      const edge = Math.max(Math.abs(x - s.x), Math.abs(z - s.z)) - 7;
      if (edge < 0.35) h = Math.max(h, 0.16 * (edge <= 0 ? 1 : 1 - edge / 0.35));
    }
    return h;
  };

  // collect the elevated centreline segments — section pairs where either
  // end carries height — from the main loop and every shortcut chain
  const segs: ElevSeg[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    const collect = (chain: { x: number; z: number; y: number }[], halfW: number, closed: boolean): void => {
      const plateau = halfW + ROAD_SHOULDER;
      const reach = plateau + EMBANKMENT_FADE;
      const last = closed ? chain.length : chain.length - 1;
      for (let i = 0; i < last; i++) {
        const a = chain[i];
        const b = chain[(i + 1) % chain.length];
        if (a.y <= 0 && b.y <= 0) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        segs.push({
          ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, ay: a.y, by: b.y, plateau,
          minX: Math.min(a.x, b.x) - reach, maxX: Math.max(a.x, b.x) + reach,
          minZ: Math.min(a.z, b.z) - reach, maxZ: Math.max(a.z, b.z) + reach,
        });
      }
    };
    collect(race.sections, race.width / 2, true);
    for (const sc of race.shortcuts ?? []) {
      collect(buildOpenSections(sc.waypoints, SHORTCUT_SPACING), sc.width / 2, false);
    }
  }

  if (segs.length === 0) {
    // flat level: total IS the feature field, base is the constant 0 —
    // not just equivalent but the same float ops as before the decompose
    return Object.assign((x: number, z: number) => feature(x, z), { base: () => 0, feature });
  }

  let gMinX = Infinity;
  let gMaxX = -Infinity;
  let gMinZ = Infinity;
  let gMaxZ = -Infinity;
  for (const s of segs) {
    gMinX = Math.min(gMinX, s.minX);
    gMaxX = Math.max(gMaxX, s.maxX);
    gMinZ = Math.min(gMinZ, s.minZ);
    gMaxZ = Math.max(gMaxZ, s.maxZ);
  }
  const base = (x: number, z: number): number => {
    if (x < gMinX || x > gMaxX || z < gMinZ || z > gMaxZ) return 0;
    let e = 0;
    for (const s of segs) {
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      // nearest point on the segment; elevation lerps along it. Adjacent
      // segments share endpoints, so the max over segments is continuous
      // along the chain, and the end-clamp rounds the span ends radially.
      const px = x - s.ax;
      const pz = z - s.az;
      let t = px * s.ux + pz * s.uz;
      t = t < 0 ? 0 : t > s.len ? s.len : t;
      const d = Math.hypot(px - s.ux * t, pz - s.uz * t);
      if (d >= s.plateau + EMBANKMENT_FADE) continue;
      const h = s.ay + ((s.by - s.ay) * t) / s.len;
      const c = d <= s.plateau ? h : h * (1 - (d - s.plateau) / EMBANKMENT_FADE);
      if (c > e) e = c;
    }
    return e;
  };
  return Object.assign((x: number, z: number) => base(x, z) + feature(x, z), { base, feature });
}

/** Painted ground rectangles, one InstancedMesh per color. The road dashes
 *  and checkpoint stripes are all the default off-white, so the existing
 *  call sites still cost a single draw; level decals (DecalDef) ride the
 *  same path with their own colors and a lower y slot. Marks on the
 *  elevated north arc carry their own y (road elevation + slot) and a
 *  pitch about their length axis so a dash lies ON the grade instead of
 *  spearing through it — the coplanar z-order contract above only ever
 *  applied to the flat zones, which pass neither field and stay put. */
function addMarkInstances(
  scene: THREE.Scene,
  marks: { x: number; z: number; w: number; l: number; yaw: number; color?: number; y?: number; pitch?: number }[],
  y = 0.015,
): void {
  const groups = new Map<number, typeof marks>();
  for (const mk of marks) {
    const key = mk.color ?? 0xd9dde2;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(mk);
  }
  const mGeo = new THREE.PlaneGeometry(1, 1);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  for (const [color, mine] of groups) {
    const mMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const inst = new THREE.InstancedMesh(mGeo, mMat, mine.length);
    mine.forEach((mk, i) => {
      e.set(-Math.PI / 2 + (mk.pitch ?? 0), mk.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      s.set(mk.w, mk.l, 1);
      m4.compose(new THREE.Vector3(mk.x, mk.y ?? y, mk.z), q, s);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.receiveShadow = true;
    scene.add(inst);
  }
}

/** Road ribbon for a section chain: a triangle strip between the left and
 *  right edges of every section. Closed chains (the main loop) wrap the
 *  seam; open chains (shortcut branches) just end at their last section.
 *  Each row rides its section's road elevation plus the z-order slot, so
 *  the strip IS the visual of the suspension base field's corridor. */
function addRibbon(
  scene: THREE.Scene,
  secs: { x: number; z: number; y: number; dirX: number; dirZ: number }[],
  width: number,
  y: number,
  color: number,
  closed: boolean,
): void {
  const w2 = width / 2;
  const N = secs.length;
  const rows = closed ? N + 1 : N;
  const pos = new Float32Array(rows * 2 * 3);
  for (let i = 0; i < rows; i++) {
    const s = secs[i % N];
    const o = i * 6;
    pos[o] = s.x - s.dirZ * w2;
    pos[o + 1] = s.y + y;
    pos[o + 2] = s.z + s.dirX * w2;
    pos[o + 3] = s.x + s.dirZ * w2;
    pos[o + 4] = s.y + y;
    pos[o + 5] = s.z - s.dirX * w2;
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ribbon = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.95, side: THREE.DoubleSide }),
  );
  ribbon.receiveShadow = true;
  scene.add(ribbon);
}

/** Horizontal run (m) from the island rim to the waterline, per edge type.
 *  'wall' is a sheer quay face; 'cliff' leans out a touch so the rock reads
 *  as undercut water-worn stone rather than a painted wall. */
const SKIRT_W = { beach: 18, wall: 0, cliff: 1.0, bank: 6 } as const;

/** Island silhouette + sea + coastline skirts (LevelDef.coast). ALL VISUAL:
 *  the physics ground stays the flat y=0 plane out to infinity, so a car
 *  carried past the rim hovers over the water until the off-track rescue
 *  collects it — the accepted arcade tradeoff documented on CoastDef. */
function buildCoast(scene: THREE.Scene, coast: CoastDef): void {
  const o = coast.outline;
  const n = o.length;
  const sea = coast.seaLevel;
  const depth = Math.max(0.5, -sea);
  // every skirt overshoots the waterline along its own slope; the opaque
  // sea hides the hem, so type transitions never flash a raw edge
  const BOT = sea - 1.2;
  const botF = (depth + 1.2) / depth;

  // island ground: the outline polygon replaces the auto-sized grass
  // square. Shape space (x, -z) lands back on world (x, z) under the same
  // rotation.x = -PI/2 the plane ground uses.
  const island = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape(o.map((p) => new THREE.Vector2(p.x, -p.z)))),
    new THREE.MeshStandardMaterial({ color: 0x59614f, roughness: 1 }),
  );
  island.rotation.x = -Math.PI / 2;
  island.receiveShadow = true;
  scene.add(island);

  // the sea: one huge plane with baked whitecaps — a backdrop, never a
  // surface anything lands on, so no animation and no physics
  const seaTex = makeSeaTexture();
  seaTex.repeat.set(40, 40); // ~100 m per tile: streaks read as metres of chop
  const seaMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ map: seaTex, roughness: 0.8 }),
  );
  seaMesh.rotation.x = -Math.PI / 2;
  seaMesh.position.y = sea;
  seaMesh.receiveShadow = true;
  scene.add(seaMesh);

  // per-segment outward normals — the shoelace sign makes the offset robust
  // to either winding even though the CoastDef contract says CCW
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    area2 += a.x * b.z - b.x * a.z;
  }
  const sgn = area2 > 0 ? 1 : -1;
  const segOut: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    segOut.push({ x: (sgn * (b.z - a.z)) / l, z: (-sgn * (b.x - a.x)) / l });
  }

  // per-vertex mitred outward (capped so hairpins don't explode) and skirt
  // width averaged across the two adjacent segments: where a beach meets a
  // quay the sand pinches out against the concrete instead of tearing a
  // hole in the ring
  const vOut: { x: number; z: number }[] = [];
  const vW: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = segOut[(i - 1 + n) % n];
    const c = segOut[i];
    let mx = p.x + c.x;
    let mz = p.z + c.z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) {
      mx = c.x;
      mz = c.z;
    } else {
      const scale = Math.min(2, 1 / Math.max(0.5, (mx / ml) * c.x + (mz / ml) * c.z));
      mx = (mx / ml) * scale;
      mz = (mz / ml) * scale;
    }
    vOut.push({ x: mx, z: mz });
    vW.push((SKIRT_W[o[(i - 1 + n) % n].edge] + SKIRT_W[o[i].edge]) / 2);
  }

  // group consecutive same-edge segments into runs; starting at a type
  // change keeps a run from straddling the array seam (all one type = a
  // single closed run around the whole island)
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (o[i].edge !== o[0].edge) {
      start = i;
      break;
    }
  }
  const runs: { edge: CoastDef['outline'][number]['edge']; segs: number[] }[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const last = runs[runs.length - 1];
    if (last && last.edge === o[i].edge) last.segs.push(i);
    else runs.push({ edge: o[i].edge, segs: [i] });
  }

  // a simple skirt: one quad strip from the rim (y 0, or the vertex's
  // authored rim elevation along an elevated road) down past the
  // waterline. Adjacent runs share their boundary columns bit-for-bit (same
  // mitred outward, same averaged width), so the ring stays watertight.
  const addFlatSkirt = (segs: number[], mat: THREE.Material, tile: number): void => {
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
  };

  // jagged rock face: extra columns every ~7 m and four rows down the face,
  // interior vertices jittered by index-hash (stable across reloads — the
  // refshot poses depend on it). Run-boundary columns and the rim row stay
  // clean so the cliff still butts flush against its neighbours and the
  // island polygon.
  let cliffKey = 0; // deterministic jitter key, advances per column built
  const addCliffSkirt = (segs: number[]): void => {
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
    const firstKey = cliffKey;
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
          cliffKey++,
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
      closed ? firstKey : cliffKey++,
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
  };

  // skirt materials, built once per coast (a level has one coastline)
  const sandTex = makePatchTexture('sand');
  const beachMat = new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1, side: THREE.DoubleSide });
  const quayMat = new THREE.MeshStandardMaterial({ map: makeQuayTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x4f5944, roughness: 1, side: THREE.DoubleSide });
  for (const run of runs) {
    if (run.edge === 'beach') addFlatSkirt(run.segs, beachMat, 7);
    else if (run.edge === 'wall') addFlatSkirt(run.segs, quayMat, 6);
    else if (run.edge === 'bank') addFlatSkirt(run.segs, bankMat, 6);
    else addCliffSkirt(run.segs);
  }

  // foam: a soft ring riding the waterline toe of every skirt, a hair
  // above the sea so the two transparent-vs-opaque planes never z-fight
  {
    const cols = n + 1;
    const pos = new Float32Array(cols * 6);
    const uv = new Float32Array(cols * 4);
    let u = 0;
    for (let c = 0; c < cols; c++) {
      const vi = c % n;
      if (c > 0) {
        const pv = (c - 1) % n;
        u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 3;
      }
      const tx = o[vi].x + vOut[vi].x * vW[vi];
      const tz = o[vi].z + vOut[vi].z * vW[vi];
      const k = c * 6;
      pos[k] = tx - vOut[vi].x * 0.7;
      pos[k + 1] = sea + 0.04;
      pos[k + 2] = tz - vOut[vi].z * 0.7;
      pos[k + 3] = tx + vOut[vi].x * 1.1;
      pos[k + 4] = sea + 0.04;
      pos[k + 5] = tz + vOut[vi].z * 1.1;
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
    const foam = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: makeFoamTexture(),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    foam.renderOrder = 1; // after the sea
    scene.add(foam);
  }
}

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
function addEmbankments(
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
    // column offsets: the sampler's lateral breakpoints plus midpoints, so
    // the linear fade renders with its own crease lines in the right spots
    const offs = [halfW - 0.5, halfW + ROAD_SHOULDER, 0, 0, 0];
    offs[2] = offs[1] + EMBANKMENT_FADE / 3;
    offs[3] = offs[1] + (2 * EMBANKMENT_FADE) / 3;
    offs[4] = offs[1] + EMBANKMENT_FADE;
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

export function buildEnvironment(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): void {
  const race = level.mode.kind === 'race' ? level.mode.race : null;

  if (level.coast) {
    // an island in the sea: the outline polygon IS the grass, with skirts
    // down to the water — the auto-sized square below would poke through it
    buildCoast(scene, level.coast);
  } else {
    // ground plane sized from level content — the hard-coded 320 cropped any
    // circuit bigger than SILVER LAKE RING; sections, shortcut waypoints,
    // props and buildings all count, plus margin so the rim never shows
    let extent = 0;
    const grow = (x: number, z: number) => {
      extent = Math.max(extent, Math.abs(x), Math.abs(z));
    };
    if (race) {
      for (const s of race.sections) grow(s.x, s.z);
      for (const sc of race.shortcuts ?? []) for (const [wx, wz] of sc.waypoints) grow(wx, wz);
    }
    for (const p of level.props ?? []) grow(p.x, p.z);
    for (const b of level.buildings) grow(b.x, b.z);
    const groundSize = Math.max(320, (extent + 60) * 2);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({ color: 0x59614f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ground patches: textured aprons/sand/dry grass UNDER the paving — see
  // the z-order contract at the top of this file (default y 0.006 keeps
  // them beneath the 0.010/0.012 ribbons). Visual only, no grip change.
  if (level.patches?.length) {
    const patchMats = new Map<PatchKind, THREE.MeshStandardMaterial>();
    const TILE: Record<PatchKind, number> = { concrete: 9, sand: 6, drygrass: 8, gravel: 4 };
    for (const p of level.patches) {
      let mat = patchMats.get(p.kind);
      if (!mat) {
        const tex = makePatchTexture(p.kind);
        // ShapeGeometry UVs are raw shape coords (= world metres), so the
        // repeat alone gives seamless world-space tiling across patches
        tex.repeat.setScalar(1 / TILE[p.kind]);
        mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
        patchMats.set(p.kind, mat);
      }
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(p.poly.map(([x, z]) => new THREE.Vector2(x, -z)))),
        mat,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = p.y ?? 0.006;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.95 });

  if (race) {
    // the circuit ribbon: a triangle strip between the left/right edges of
    // every race section, with centre dashes and a start/finish stripe
    const secs = race.sections;
    const w2 = race.width / 2;
    const N = secs.length;
    addRibbon(scene, secs, race.width, 0.012, 0x2e3138, true);

    // paint pitch on a grade: a flat dash 2.2 m long would bury one end in
    // a 6% climb and float the other — tilt it about its length axis to
    // the local chain grade (the mark's length axis points BACKWARDS along
    // the chain after the YXZ euler, hence the minus). 0 on flat ground.
    const gradeAt = (chain: { x: number; z: number; y: number }[], i: number, closed: boolean): number => {
      const n = chain.length;
      const a = chain[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const b = chain[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      return run > 0 ? (b.y - a.y) / run : 0;
    };
    interface Mark {
      x: number;
      z: number;
      w: number;
      l: number;
      yaw: number;
      color?: number;
      y?: number;
      pitch?: number;
    }
    const marks: Mark[] = [];
    secs.forEach((s, i) => {
      if (i % 2 !== 0) return;
      marks.push({
        x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
        y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
      });
    });
    marks.push({
      x: secs[0].x,
      z: secs[0].z,
      w: race.width - 2,
      l: 1.0,
      yaw: Math.atan2(secs[0].dirX, secs[0].dirZ),
      y: secs[0].y + 0.015,
    });

    // checkpoints: a painted stripe + glowing gate posts every 6th section,
    // so the racing line always has a visible next target. Posts and
    // stripes ride the section's road elevation on the north arc.
    const postGeo = new THREE.CylinderGeometry(0.12, 0.16, 2.6, 8);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x22262c,
      emissive: 0xffb327,
      emissiveIntensity: 1.4,
    });
    postMat.userData.night = { intensity: 2.4, day: 1.4 };
    for (let i = 6; i < N; i += 6) {
      const s = secs[i];
      marks.push({
        x: s.x, z: s.z, w: race.width - 2, l: 0.7, yaw: Math.atan2(s.dirX, s.dirZ),
        y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
      });
      for (const side of [1, -1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(s.x - side * s.dirZ * (w2 + 1.1), s.y + 1.3, s.z + side * s.dirX * (w2 + 1.1));
        post.castShadow = true;
        scene.add(post);
      }
    }
    // shortcut branch ribbons: same strip builder, own narrower chain, a
    // dirt or asphalt tint, and a hair LOWER than the main road (0.010 vs
    // 0.012) so the junction overlaps at the mouths never z-fight. No
    // walls along a branch — running out of road is part of the price.
    const shortcuts = race.shortcuts ?? [];
    for (const sc of shortcuts) {
      const chain = buildOpenSections(sc.waypoints, SHORTCUT_SPACING);
      addRibbon(scene, chain, sc.width, 0.01, sc.surface === 'dirt' ? 0x6b5d40 : 0x2e3138, false);
      // sparse centre dashes — enough to read as road at speed, not enough
      // to dress a branch up as the main line
      for (let i = 2; i < chain.length - 1; i += 4) {
        const s = chain[i];
        marks.push({
          x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
          y: s.y + 0.015, pitch: -Math.atan(gradeAt(chain, i, false)),
        });
      }
    }
    addMarkInstances(scene, marks);

    // shortcut mouths punch gaps in the barrier: skip main-loop wall
    // segments [entry-1, entry+1] and [exit-1, exit+1], on the attachment
    // side ONLY — inferred from the cross product of the section direction
    // with (branch endpoint − section centre), so the far wall still pins
    // rivals through the junction
    const gapped = new Set<string>(); // "side:segIndex"
    for (const sc of shortcuts) {
      const mouths: [number, RaceWaypoint][] = [
        [sc.entry, sc.waypoints[0]],
        [sc.exit, sc.waypoints[sc.waypoints.length - 1]],
      ];
      for (const [secIdx, wp] of mouths) {
        const s = secs[secIdx % N];
        // 2D cross dir × offset: positive = the side the +1 wall runs on
        // (its offset is along the left perpendicular (-dirZ, dirX))
        const cross = s.dirX * (wp[1] - s.z) - s.dirZ * (wp[0] - s.x);
        const side = cross >= 0 ? 1 : -1;
        for (let k = -1; k <= 1; k++) gapped.add(`${side}:${(secIdx + k + N) % N}`);
      }
    }

    // barriers: wall segments chained just outside both edges — hard enough
    // to wreck on head-on, perfect for pinning a rival. Deliberately NOT in
    // noCrashIds: a wall is a wall. The default 'race' chain is today's
    // 1.0 m red/white boxes; RaceDef.wallStyles swaps section ranges for a
    // coastal guardrail (0.75 m), a quay kerb (0.45 m), dockyard chain-link
    // (2.2 m) or 'none' (an open gap). Each style sets the matching physics
    // box height too, so a kerb is hoppable where the fence is a cage.
    const wallT = 0.5;
    const WALL_H = { race: 1.0, guardrail: 0.75, kerb: 0.45, fence: 2.2 } as const;
    type WallKind = keyof typeof WALL_H;
    // 'left'/'right' are relative to race direction: side +1 offsets along
    // the left perpendicular (-dirZ, dirX) — same convention as the
    // shortcut-mouth cross product above. Overlapping ranges: last wins.
    const styleFor = (side: 1 | -1, i: number): WallKind | 'none' => {
      let st: WallKind | 'none' = 'race';
      for (const ws of race.wallStyles ?? []) {
        if (ws.side !== 'both' && (ws.side === 'left' ? 1 : -1) !== side) continue;
        // from > to wraps the lap seam, mirroring how section indices loop
        if (ws.from <= ws.to ? i >= ws.from && i <= ws.to : i >= ws.from || i <= ws.to) st = ws.style;
      }
      return st;
    };
    // Wall segments on a grade sit at their section pair's MEAN elevation —
    // stepped seams, not pitched boxes, per elevation.md's costed tradeoff:
    // at the profile's steepest ~7% a 9.5 m segment steps ~±0.3 m, hidden
    // by the 0.5 m overlap, and the embankment shoulder under the wall is
    // at full road elevation so no gap opens beneath the box. wallDirs
    // judging stays 2D and untouched.
    const wallSegs: { x: number; z: number; y0: number; y1: number; len: number; yaw: number; style: WallKind }[] = [];
    for (const side of [1, -1] as const) {
      for (let i = 0; i < N; i++) {
        if (gapped.has(`${side}:${i}`)) continue; // a shortcut mouth opens here
        const style = styleFor(side, i);
        if (style === 'none') continue; // deliberate gap — no wall, no body
        const a = secs[i];
        const b = secs[(i + 1) % N];
        const off = w2 + wallT / 2 + 0.15;
        const ax = a.x - side * a.dirZ * off;
        const az = a.z + side * a.dirX * off;
        const bx = b.x - side * b.dirZ * off;
        const bz = b.z + side * b.dirX * off;
        const len = Math.hypot(bx - ax, bz - az) + 0.5; // overlap hides the seams
        wallSegs.push({ x: (ax + bx) / 2, z: (az + bz) / 2, y0: a.y, y1: b.y, len, yaw: Math.atan2(bx - ax, bz - az), style });
      }
    }
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    const wallColors = [0xd8dde2, 0xc23a2c]; // alternating white/red
    for (const parity of [0, 1]) {
      // parity over the FULL segment array keeps the chain pixel-identical
      // to the pre-wallStyles build when every segment is 'race'
      const mine = wallSegs.filter((sg, i) => sg.style === 'race' && i % 2 === parity);
      const inst = new THREE.InstancedMesh(
        wallGeo,
        new THREE.MeshStandardMaterial({ color: wallColors[parity], roughness: 0.8 }),
        mine.length,
      );
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      mine.forEach((sg, i) => {
        q.setFromAxisAngle(up, sg.yaw);
        sc.set(wallT, WALL_H.race, sg.len);
        m4.compose(new THREE.Vector3(sg.x, (sg.y0 + sg.y1) / 2 + WALL_H.race / 2, sg.z), q, sc);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = inst.receiveShadow = true;
      scene.add(inst);
    }

    // themed wall visuals: everything is batched — boxes by material into
    // InstancedMeshes, the chain-link into one merged cutout mesh
    interface BoxInst {
      x: number;
      y: number;
      z: number;
      sx: number;
      sy: number;
      sz: number;
      yaw: number;
    }
    const addBoxInstances = (color: number, roughness: number, boxes: BoxInst[]): void => {
      if (!boxes.length) return;
      const inst = new THREE.InstancedMesh(
        wallGeo,
        new THREE.MeshStandardMaterial({ color, roughness }),
        boxes.length,
      );
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      boxes.forEach((bx, i) => {
        q.setFromAxisAngle(up, bx.yaw);
        sc.set(bx.sx, bx.sy, bx.sz);
        m4.compose(new THREE.Vector3(bx.x, bx.y, bx.z), q, sc);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = inst.receiveShadow = true;
      scene.add(inst);
    };
    const kerbs: BoxInst[] = [];
    const rails: BoxInst[] = [];
    const woodPosts: BoxInst[] = [];
    const fencePosts: BoxInst[] = [];
    const fPos: number[] = [];
    const fUv: number[] = [];
    const fIdx: number[] = [];
    for (const sg of wallSegs) {
      const dx = Math.sin(sg.yaw);
      const dz = Math.cos(sg.yaw);
      const yMid = (sg.y0 + sg.y1) / 2; // road elevation under the segment
      // per-spot elevation along the segment — posts follow the grade
      // smoothly even though the long boxes step at the seams
      const yAt = (t: number) => sg.y0 + (sg.y1 - sg.y0) * (t + 0.5);
      if (sg.style === 'kerb') {
        // a plain concrete curb — hop it and pay in undercarriage scrape
        kerbs.push({ x: sg.x, y: yMid + WALL_H.kerb / 2, z: sg.z, sx: wallT, sy: WALL_H.kerb, sz: sg.len, yaw: sg.yaw });
      } else if (sg.style === 'guardrail') {
        // coastal highway: weathered wood posts carrying a grey W-rail
        rails.push({ x: sg.x, y: yMid + 0.58, z: sg.z, sx: 0.09, sy: 0.3, sz: sg.len, yaw: sg.yaw });
        const cnt = Math.max(2, Math.round(sg.len / 2.4));
        for (let k = 0; k < cnt; k++) {
          const t = (k + 0.5) / cnt - 0.5; // interior spots only — no seam doubles
          woodPosts.push({
            x: sg.x + dx * sg.len * t,
            y: yAt(t) + 0.36,
            z: sg.z + dz * sg.len * t,
            sx: 0.16,
            sy: 0.72,
            sz: 0.16,
            yaw: sg.yaw,
          });
        }
      } else if (sg.style === 'fence') {
        const cnt = Math.max(1, Math.round(sg.len / 3));
        for (let k = 0; k < cnt; k++) {
          const t = (k + 0.5) / cnt - 0.5;
          fencePosts.push({
            x: sg.x + dx * sg.len * t,
            y: yAt(t) + WALL_H.fence / 2,
            z: sg.z + dz * sg.len * t,
            sx: 0.09,
            sy: WALL_H.fence,
            sz: 0.09,
            yaw: sg.yaw,
          });
        }
        // one vertical quad per segment, u in metres so the mesh tiles;
        // the corners carry their end's road elevation, so the chain-link
        // (unlike the boxes) follows a grade without stepping
        const hx = (dx * sg.len) / 2;
        const hz = (dz * sg.len) / 2;
        const base = fPos.length / 3;
        fPos.push(
          sg.x - hx, sg.y0, sg.z - hz,
          sg.x + hx, sg.y1, sg.z + hz,
          sg.x + hx, sg.y1 + WALL_H.fence, sg.z + hz,
          sg.x - hx, sg.y0 + WALL_H.fence, sg.z - hz,
        );
        fUv.push(0, 0, sg.len, 0, sg.len, WALL_H.fence, 0, WALL_H.fence);
        fIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    addBoxInstances(0xc9cbc7, 0.9, kerbs); // light concrete
    addBoxInstances(0x9aa1a7, 0.55, rails); // galvanized rail
    addBoxInstances(0x77624c, 1.0, woodPosts); // weathered timber
    addBoxInstances(0x474c51, 0.7, fencePosts); // fence steel
    if (fIdx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fPos), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(fUv), 2));
      geo.setIndex(fIdx);
      geo.computeVertexNormals();
      const fence = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          map: makeChainLinkTexture(),
          alphaTest: 0.45,
          side: THREE.DoubleSide,
          roughness: 0.7,
        }),
      );
      // no castShadow: the cutout has no custom depth material, so the sun
      // would project the plane as a solid slab — a lie worse than no shadow
      fence.receiveShadow = true;
      scene.add(fence);
    }

    // physics: one static box per segment regardless of dressing — only the
    // height varies by style. Same chain, same wallDirs judging as always.
    // On a grade the box rides the segment's mean road elevation (stepped,
    // like the visual): the shoulder under it is at full elevation, so the
    // worst seam mismatch is ~0.3 m of box bottom against solid embankment.
    for (const sg of wallSegs) {
      const h = WALL_H[sg.style];
      const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
      wb.addShape(new CANNON.Box(new CANNON.Vec3(wallT / 2, h / 2, sg.len / 2)));
      wb.position.set(sg.x, (sg.y0 + sg.y1) / 2 + h / 2, sg.z);
      wb.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), sg.yaw);
      phys.world.addBody(wb);
      phys.wallDirs.set(wb.id, { x: Math.sin(sg.yaw), z: Math.cos(sg.yaw) });
    }

    // the visual ground under every elevated span (no-op on flat tracks);
    // a fresh sampler instance keeps this builder self-contained — same
    // plain-number inputs, same field, build-time only
    addEmbankments(
      scene,
      [
        { secs, halfW: w2, closed: true },
        ...shortcuts.map((sc) => ({
          secs: buildOpenSections(sc.waypoints, SHORTCUT_SPACING),
          halfW: sc.width / 2,
          closed: false,
        })),
      ],
      level.coast,
      makeHeightSampler(level).base,
    );
  }

  if (level.ground === 'pad') {
    // open practice asphalt with painted skidpad rings and dash lines
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(170, 170), roadMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.005;
    pad.receiveShadow = true;
    scene.add(pad);
    if (level.padDecals) {
      for (const r of level.padDecals.rings) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r.r - 0.35, r.r + 0.35, 64),
          new THREE.MeshBasicMaterial({ color: 0xd9dde2, transparent: true, opacity: 0.4, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(r.x, 0.02, r.z);
        scene.add(ring);
      }
      addMarkInstances(
        scene,
        level.padDecals.dashes.map((d) => ({ x: d.x, z: d.z, w: 0.25, l: 2.0, yaw: d.yaw })),
      );
    }
  } else if (level.ground === 'field') {
    // bare grass — the race ribbon above is the only paving
  } else {
    // crossroad: roads run ±140 so looping traffic recycles deep in the fog
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(14, 280), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.005;
    roadNS.receiveShadow = true;
    scene.add(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(280, 14), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.004;
    roadEW.receiveShadow = true;
    scene.add(roadEW);

    const marks: { x: number; z: number; w: number; l: number; yaw: number }[] = [];
    const addMark = (x: number, z: number, w: number, l: number, yaw: number) => marks.push({ x, z, w, l, yaw });
    for (let z = -136; z <= 136; z += 4.4) if (Math.abs(z) > 8.5) addMark(0, z, 0.22, 2.0, 0);
    for (let x = -136; x <= 136; x += 4.4) if (Math.abs(x) > 8.5) addMark(x, 0, 0.22, 2.0, Math.PI / 2);
    addMark(0, 7.7, 9.4, 0.5, 0);
    addMark(0, -7.7, 9.4, 0.5, 0);
    addMark(7.7, 0, 9.4, 0.5, Math.PI / 2);
    addMark(-7.7, 0, 9.4, 0.5, Math.PI / 2);
    for (let i = -3; i <= 3; i++) {
      addMark(i * 1.25, 9.6, 0.55, 2.4, 0);
      addMark(i * 1.25, -9.6, 0.55, 2.4, 0);
      addMark(9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
      addMark(-9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
    }
    addMarkInstances(scene, marks);
  }

  // level decals: painted lane markings on the aprons — the road-dash
  // instancer with per-decal colors, at 0.014 so they ride above the
  // ribbons but never fight the 0.015 race dashes (z-order contract)
  if (level.decals?.length) addMarkInstances(scene, level.decals, 0.014);

  // corner blocks: sidewalk slabs + buildings (static colliders → pinball walls)
  const winTex = makeWindowTextures();
  for (const { x: cx, z: cz, h, color } of level.buildings) {
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.16, 14),
      new THREE.MeshStandardMaterial({ color: 0x80868e, roughness: 1 }),
    );
    walk.position.set(cx, 0.08, cz);
    walk.receiveShadow = true;
    scene.add(walk);
    const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
    wb.addShape(new CANNON.Box(new CANNON.Vec3(7, 0.08, 7)));
    wb.position.set(cx, 0.08, cz);
    wb.collisionFilterGroup = GROUP_DECOR; // live chassis drive over via springs
    phys.world.addBody(wb);
    phys.noCrashIds.add(wb.id); // curbs scuff, they don't wreck

    const tex = winTex.map.clone();
    tex.needsUpdate = true;
    tex.repeat.set(3, Math.max(2, Math.round(h / 3)));
    const lit = winTex.lit.clone();
    lit.needsUpdate = true;
    lit.repeat.copy(tex.repeat);
    // at night the warm windows glow (daynight.ts sweeps the intensity)
    const bldMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      map: tex,
      emissive: 0xffffff,
      emissiveMap: lit,
      emissiveIntensity: 0,
    });
    bldMat.userData.night = { intensity: 2.6 };
    const bld = new THREE.Mesh(new THREE.BoxGeometry(11, h, 11), bldMat);
    bld.position.set(cx, h / 2 + 0.16, cz);
    bld.castShadow = bld.receiveShadow = true;
    scene.add(bld);
    const bb = new CANNON.Body({ mass: 0, material: phys.matGround });
    bb.addShape(new CANNON.Box(new CANNON.Vec3(5.5, h / 2, 5.5)));
    bb.position.set(cx, h / 2 + 0.16, cz);
    phys.world.addBody(bb);
  }

  // launch ramps: a rotated slab; the suspension rays read the matching
  // height field, the physics box only matters for landings and wrecks
  const chevron = makeChevronTexture();
  for (const r of level.ramps) {
    const theta = Math.atan2(r.height, r.length);
    const slopeLen = Math.hypot(r.length, r.height);
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.9 });
    const topTex = chevron.clone();
    topTex.needsUpdate = true;
    topTex.repeat.set(1, Math.max(1, Math.round(slopeLen / 3)));
    const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.85 });
    const geo = new THREE.BoxGeometry(r.width, 0.3, slopeLen);
    const mesh = new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    mesh.rotation.x = -theta;
    mesh.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: phys.matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(r.width / 2, 0.15, slopeLen / 2)));
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -theta);
    body.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    body.collisionFilterGroup = GROUP_DECOR; // springs ride it; box is for wrecks
    phys.world.addBody(body);
    phys.noCrashIds.add(body.id);
  }
}
