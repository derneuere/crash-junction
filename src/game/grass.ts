import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hash01 } from './textures';
import type { LevelDef, GroundPatchDef } from './types';

// ============================================================================
// INSTANCED FLUFFY-GRASS — the GRASS VERGES of the whole island (GANTRY POINT).
// ============================================================================
//
// The textured island-grass ground + the alpha-tongue dune fringe (both in
// environment.ts) stay as the BASE; this module AUGMENTS them with a field of
// real 3D blade-clumps that sit ON the grass and sway in the wind. Clumps are
// placed ONLY where the ground is genuinely grass.
//
// ── WHY THIS WAS REWRITTEN AGAIN (2026-06-13, grass-lush) ────────────────────
//   The previous pass matched the FluffyGrass demo's NUMERIC density (~3 tufts/
//   m²) with a procedurally-built 3-blade cross-tuft, ~0.45–1.0 m tall. From the
//   chase cam (driving height ~2.4 m, looking down the verge at a shallow angle)
//   that still read as a THIN GREEN FUZZ, not the demo's rich grass field — the
//   blades were too short and too thin-silhouetted to fill the frame. The demo
//   gets its lush look from three things our procedural tuft lacked:
//     1. a real fanned blade-CLUMP mesh (grassLODs.glb LOD00, ~6 splayed cards),
//     2. an ALPHA TEXTURE (grass.jpeg) of ~10 wispy blades cut out of each card
//        — so every instance reads as a bushy clump of strands, not a few quads,
//     3. a base→tip COLOUR GRADIENT + perlin-noise height/colour variation.
//   This pass adopts the demo's ACTUAL assets + shader and makes the blades a
//   lot TALLER (the main missing lever for a shallow chase-cam angle).
//
// ── WHAT WE TOOK FROM FluffyGrass (assets + technique) ───────────────────────
//   Assets (public/grass/, MIT — see public/grass/manifest.md):
//     * grassLODs.glb     — Grass.LOD00/01/02 fanned blade-clump meshes
//     * grass-alpha.jpeg  — white-on-black alpha mask of ~10 wispy blades
//     * perlinnoise.webp  — tiling noise: G drives wind, R drives variation
//   Shader (ported from FluffyGrass GrassMaterial.ts):
//     * world-UV + perlin wind sway scaled by (1 - uv.y) (planted base, whippy
//       tip) + a perlin height bump that gives the field its fluffy unevenness,
//     * baseColor → tipColor vertical gradient with a per-clump noise hue mix,
//     * the alpha-mask blade silhouette (step over the mask's red channel).
//   ADAPTATIONS (not a verbatim port):
//     * the demo scatters 8000 clumps over a ~55 m island with MeshSurfaceSampler
//       and a single LOD; we scatter over a 600 m island with a deterministic
//       hash (pin-safe) and a HARD grass-only surface mask, partitioned into
//       per-tile InstancedMeshes with a distance LOD (LOD00 near → LOD02 far)
//       + distance cull so the full demo look stays affordable to draw,
//     * the shader is grafted onto MeshLambert-equivalents via onBeforeCompile of
//       MeshStandardMaterial so the blades pick up THIS engine's PMREM sky env +
//       fog + the time-of-day grade (the demo is a fixed-light Lambert),
//     * blades are scaled TALLER than the demo (~1.4–1.9 m vs the demo's ~0.65 m)
//       so the field reads lush at our shallow chase-cam angle, not just top-down.
//   MIT requires keeping the copyright/attribution — see public/grass/manifest.md
//   (full licence) and this header. FluffyGrass © 2023 Ebenezer (thebenezer):
//   https://github.com/thebenezer/FluffyGrass  •  https://fluffygrass.vercel.app/
//
// ── ASYNC ASSET LOAD, SYNC PLACEMENT (the determinism contract) ──────────────
//   buildGrass() stays SYNCHRONOUS: it does the (deterministic-hash) placement
//   and creates the per-tile InstancedMeshes IMMEDIATELY, with a tiny fallback
//   geometry + the textures un-set. The GLB + the two textures load in the
//   background; when they land we SWAP the real LOD geometry onto every tile
//   mesh and set the texture uniforms. Nothing about the load order touches sim
//   state — placement, matrices and the world hash are all decided synchronously
//   at build time; the async swap only changes what's DRAWN. Pin-safe.
//
// PIN-SAFE / VISUAL ONLY: clumps are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (update(dt)
// only writes a float uniform). Distance culling reads the RENDER-time camera
// position (passed into update) and only flips per-tile mesh visibility / count
// / LOD — it never touches sim state, RNG, or the world hash.
//
// ── GRASS-ONLY PLACEMENT (the hard mask) ─────────────────────────────────────
//   We build a HARD mask from the LEVEL'S OWN surface geometry (read-only) and
//   REJECT every candidate that is not on real grass:
//     * outside the island OUTLINE polygon (inset a touch) -> over sea (reject)
//     * inside any 'sand' / 'gravel' / 'concrete' patch -> not grass (reject)
//     * seaward of the SW 'drygrass' dune lip -> sand (reject)
//     * within (half-width + margin) of the MAIN race ribbon or any SHORTCUT
//       ribbon centreline -> on/near road (reject)
//     * within a building plinth's footprint + margin -> under a building
//   drygrass patches are NOT rejected — they are drying-but-real grass (the
//   golden headland and cliff verges the player drifts along).
//
// ── DISTANCE CULL + LOD (what makes the demo look affordable) ────────────────
//   The island is partitioned into a grid of TILES; each non-empty tile is its
//   own InstancedMesh. update(dt, camPos):
//     * hides a tile whose centre is beyond CULL_RADIUS (far field draws zero);
//     * picks the tile's blade GEOMETRY by distance: LOD00 (full clump) inside
//       LOD0_RADIUS, LOD01 in the mid ring, LOD02 in the far ring — fewer tris
//       per clump as the clump shrinks on screen;
//     * draws FULL allocated density inside FULL_RADIUS (the lush near field);
//     * between FULL_RADIUS and CULL_RADIUS, scales mesh.count down (ease-out to
//       MIN_LOD_FRAC) so the mid/far ring thins HARD. Placement order within a
//       tile is hash-uniform, so drawing the first K instances is an even
//       spatial subsample — no clustering artefact.
//   three's own frustumCulled (left on per tile) drops off-screen tiles too.
//   ONE InstancedMesh per VISIBLE tile = one draw call each.
//
// ── CINE-ONLY ────────────────────────────────────────────────────────────────
//   The game is always-CINE; there is no FAST density tier. setTier() is kept on
//   the interface (Game.ts still calls it) but resolves to the single path.
// ============================================================================

/** Per-area clump density (blade-clumps per m² of accepted grass).
 *
 *  The FluffyGrass demo scatters 8000 clumps over its ~2546 m² terrain →
 *  ~3.14 clumps/m². Each demo clump is a fanned ~6-card cluster textured with a
 *  ~10-blade alpha mask, so the ground reads as a continuous lush mat. We match
 *  that near-field density. Because each clump now renders as a FULL bushy
 *  cluster (alpha-mask silhouette, not a couple of strips) we can hold the lush
 *  read at this density without the old "solid green wall" failure. */
const DENSITY = 3.1;

/** Hard ceiling on allocated clumps across the whole island. Render-time LOD
 *  makes only a fraction DRAW at once, so this bounds the one-time build cost
 *  (placement + instance buffers) not the per-frame draw. */
const MAX_BLADES = 600000;

/** Distance-cull radius (m): a tile whose centre is farther than this from the
 *  live camera draws nothing. Sized to read out toward the scene fog (gantry
 *  fog is 90..340 m linear). Between FULL_RADIUS and here the per-tile LOD
 *  thins the draw and shrinks the geometry, so the far edge stays cheap. */
const CULL_RADIUS = 210;

/** Inside this radius (m) a tile draws its FULL allocated density — the demo's
 *  ~3.1 clumps/m². This is the lush near field the chase cam sees in detail;
 *  it must read exactly as full as the demo. Beyond it the per-tile count LOD
 *  ramps the drawn fraction down to MIN_LOD_FRAC at CULL_RADIUS. */
const FULL_RADIUS = 64;

/** Floor on the per-tile drawn fraction at the cull edge. A distant-but-visible
 *  tile draws this fraction of its clumps (uniformly thinned). */
const MIN_LOD_FRAC = 0.05;

/** Geometry-LOD ring radii (m). A tile inside LOD0_RADIUS draws the full LOD00
 *  clump; between LOD0 and LOD1 it draws LOD01; beyond LOD1 (out to CULL_RADIUS)
 *  it draws LOD02. Sized so the swap happens where the clump is already small on
 *  screen, so the tri-count drop is invisible. */
const LOD0_RADIUS = 80;
const LOD1_RADIUS = 145;

/** Spatial tile size (m) for the culling + LOD grid. A 22 m tile over the
 *  ~600 m island gives a fine grid for smooth distance LOD + tight frustum. */
const TILE_SIZE = 22;

// ── BLADE SIZING (the chase-cam lushness lever) ─────────────────────────────
//   The demo scales its LOD00 clump x5 → ~0.65 m tall / ~1.6 m wide. From a
//   near-top-down orbit that reads full; from our shallow chase-cam angle
//   (~2.4 m eye, grazing the verge) short blades collapse to a thin fuzz. So we
//   scale the clump TALLER. Per-instance jitter keeps the field from reading as
//   one flat surface. Heights are in metres of the final clump.
const HEIGHT_MIN = 1.35; // m — shortest clump
const HEIGHT_MAX = 1.95; // m — tallest clump
const WIDTH_MIN = 1.0; // m — narrowest clump footprint
const WIDTH_MAX = 1.7; // m — widest clump footprint

// ── ROAD/SURFACE MASK GEOMETRY (read from the level; never mutated) ─────────

/** Even-odd point-in-polygon test (ray cast). poly is a closed ring of
 *  [x, z] vertices (the level's GroundPatchDef.poly format). */
function pointInPoly(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Squared distance from (x,z) to the polyline `pts` (a road/ribbon
 *  centreline). Returns metres² so callers compare against a squared half-width
 *  without a sqrt. */
function distToPolylineSq(x: number, z: number, pts: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) best = d2;
  }
  return best;
}

/** A "road keep-out": a centreline polyline plus a clearance radius (m). */
interface RoadMask {
  pts: [number, number][];
  radiusSq: number;
}

/** A circular keep-out: a centre + squared radius (building plinths). */
interface CircleMask {
  x: number;
  z: number;
  radiusSq: number;
}

/** The grass-only mask, built once from the level's surface geometry. */
interface SurfaceMask {
  outline: [number, number][];
  rejectPolys: GroundPatchDef['poly'][];
  lip: { seaward: [number, number][]; sandInsideSign: number } | null;
  roads: RoadMask[];
  buildings: CircleMask[];
}

/** Pull the SW-beach 'drygrass' band out of the level and split its thin loop
 *  into a seaward and an inland edge at its narrow ends. The seaward edge is the
 *  dune lip: clumps may reach it but not pass it. Mirrors environment.ts
 *  addDuneFringe's split so the blade lip and the painted fringe agree. */
function findDuneLip(patches: GroundPatchDef[]): SurfaceMask['lip'] {
  const band = patches.find(
    (p) => p.kind === 'drygrass' && p.poly.length >= 6 && p.poly.every(([x, z]) => x <= -78 && z <= -60),
  );
  if (!band) return null;
  const poly = band.poly;
  const M = poly.length;
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < M; i++) {
    if (poly[i][0] < poly[iMin][0]) iMin = i;
    if (poly[i][0] > poly[iMax][0]) iMax = i;
  }
  const walk = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % M) {
      out.push([poly[i][0], poly[i][1]]);
      if (i === to) break;
    }
    return out;
  };
  const edgeA = walk(iMin, iMax);
  const edgeB = walk(iMax, iMin);
  const meanZ = (e: [number, number][]): number => e.reduce((s, p) => s + p[1], 0) / e.length;
  const seaward = meanZ(edgeA) > meanZ(edgeB) ? edgeB : edgeA;
  if (seaward[0][0] > seaward[seaward.length - 1][0]) seaward.reverse();
  return { seaward, sandInsideSign: 0 };
}

/** Build the grass-only mask from the level's own surface geometry (read-only). */
function buildSurfaceMask(level: LevelDef): SurfaceMask {
  const patches = level.patches ?? [];
  const rejectPolys: GroundPatchDef['poly'][] = patches
    .filter((p) => p.kind === 'sand' || p.kind === 'gravel' || p.kind === 'concrete')
    .map((p) => p.poly);

  const outline: [number, number][] = [];
  const o = level.coast?.outline ?? [];
  if (o.length >= 3) {
    let cx = 0;
    let cz = 0;
    for (const v of o) {
      cx += v.x;
      cz += v.z;
    }
    cx /= o.length;
    cz /= o.length;
    const INSET = 2.5; // m pulled inland off the rim
    for (const v of o) {
      const dx = v.x - cx;
      const dz = v.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      outline.push([v.x - (dx / len) * INSET, v.z - (dz / len) * INSET]);
    }
  }

  const lip = findDuneLip(patches);

  const roads: RoadMask[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    const mainPts: [number, number][] = race.sections.map((s) => [s.x, s.z]);
    if (mainPts.length > 1) {
      mainPts.push([mainPts[0][0], mainPts[0][1]]); // close the loop
      const r = race.width / 2 + 2.5;
      roads.push({ pts: mainPts, radiusSq: r * r });
    }
    for (const sc of race.shortcuts ?? []) {
      const pts: [number, number][] = sc.waypoints.map((w) => [w[0], w[1]]);
      if (pts.length > 1) {
        const r = sc.width / 2 + 2.5;
        roads.push({ pts, radiusSq: r * r });
      }
    }
  }

  const buildings: CircleMask[] = (level.buildings ?? []).map((b) => {
    const r = 10.5; // ~half-diagonal of the 14x14 plinth + margin
    return { x: b.x, z: b.z, radiusSq: r * r };
  });

  return { outline, rejectPolys, lip, roads, buildings };
}

/** Signed seaward distance (m) of (x,z) from the dune-lip polyline. Negative =
 *  inland on the grass; positive = out onto the sand. */
function seawardDist(x: number, z: number, lip: SurfaceMask['lip']): number {
  if (!lip) return -100;
  const pts = lip.seaward;
  let best = Infinity;
  let bestSigned = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      const nlen = Math.hypot(dz, dx) || 1;
      const nx = dz / nlen;
      const nz = -dx / nlen;
      bestSigned = (x - px) * nx + (z - pz) * nz;
    }
  }
  return bestSigned;
}

/** True iff (x,z) is on genuine grass. HARD mask. */
function isGrass(x: number, z: number, mask: SurfaceMask): boolean {
  if (mask.outline.length >= 3 && !pointInPoly(x, z, mask.outline)) return false;
  for (const poly of mask.rejectPolys) if (pointInPoly(x, z, poly)) return false;
  if (mask.lip && seawardDist(x, z, mask.lip) > 0) return false;
  for (const road of mask.roads) if (distToPolylineSq(x, z, road.pts) < road.radiusSq) return false;
  for (const b of mask.buildings) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz < b.radiusSq) return false;
  }
  return true;
}

// ── GRASS LOD GEOMETRY (FluffyGrass grassLODs.glb) ──────────────────────────

/** The three blade-clump LODs from grassLODs.glb, pre-conditioned for use:
 *  re-origined so the clump base sits at y=0 (the GLB authored it ~centred),
 *  each scaled to a UNIT clump (~1 m tall) so the per-instance matrix can size
 *  it in metres. Filled asynchronously after the GLB lands. */
interface GrassLODs {
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry;
  lod2: THREE.BufferGeometry;
}

const GRASS_GLB_URL = '/grass/grassLODs.glb';
const GRASS_ALPHA_URL = '/grass/grass-alpha.jpeg';
const GRASS_NOISE_URL = '/grass/perlinnoise.webp';

/** Normalise a raw LOD geometry from the GLB: drop the tiny negative-y root
 *  overhang so the clump base sits at y≈0, then scale so the clump is ~1 m tall
 *  (a UNIT clump the instance matrix sizes in metres). Returns a fresh geometry;
 *  the source is left untouched. */
function conditionLOD(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = src.clone();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const minY = bb.min.y;
  const height = bb.max.y - bb.min.y || 1;
  // lift base to 0, then normalise height to 1
  geo.translate(0, -minY, 0);
  geo.scale(1 / height, 1 / height, 1 / height);
  geo.computeBoundingSphere();
  return geo;
}

/** Promise of the conditioned LODs + textures, shared across every buildGrass
 *  call (one fetch+parse for the whole app). Kicked off lazily on first build. */
let assetsPromise: Promise<{ lods: GrassLODs; alpha: THREE.Texture; noise: THREE.Texture }> | null = null;

function loadGrassAssets(): Promise<{ lods: GrassLODs; alpha: THREE.Texture; noise: THREE.Texture }> {
  if (assetsPromise) return assetsPromise;
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const glbP = loader.loadAsync(GRASS_GLB_URL).then((gltf) => {
    const byNode: Record<string, THREE.BufferGeometry> = {};
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) byNode[mesh.name] = mesh.geometry as THREE.BufferGeometry;
    });
    // node names in the GLB: Grass.LOD00 / LOD01 / LOD02. Fall back to the
    // three meshes in vertex-count order if the names ever change.
    const pick = (frag: string): THREE.BufferGeometry | undefined =>
      Object.entries(byNode).find(([n]) => n.includes(frag))?.[1];
    let g0 = pick('LOD00');
    let g1 = pick('LOD01');
    let g2 = pick('LOD02');
    if (!g0 || !g1 || !g2) {
      const sorted = Object.values(byNode).sort(
        (a, b) => (b.getAttribute('position')?.count ?? 0) - (a.getAttribute('position')?.count ?? 0),
      );
      g0 = g0 ?? sorted[0];
      g1 = g1 ?? sorted[1] ?? sorted[0];
      g2 = g2 ?? sorted[2] ?? sorted[1] ?? sorted[0];
    }
    return {
      lod0: conditionLOD(g0),
      lod1: conditionLOD(g1),
      lod2: conditionLOD(g2),
    } satisfies GrassLODs;
  });
  const alphaP = texLoader.loadAsync(GRASS_ALPHA_URL).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace; // it's a mask, not colour
    return t;
  });
  const noiseP = texLoader.loadAsync(GRASS_NOISE_URL).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  });
  assetsPromise = Promise.all([glbP, alphaP, noiseP]).then(([lods, alpha, noise]) => ({ lods, alpha, noise }));
  return assetsPromise;
}

/** A tiny stand-in clump used for the brief window between buildGrass() (which
 *  must add the meshes synchronously) and the GLB landing. It's a single tapered
 *  cross-strip — visible as a sliver of green so the field is never empty, then
 *  swapped for the real LOD geometry. Unit height, base at y=0. */
function makeFallbackGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const SEG = 3;
  for (let b = 0; b < 2; b++) {
    const ang = (b / 2) * Math.PI;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const v = s / SEG;
      const w = 0.08 * (1 - v);
      pos.push(-sa * w, v, ca * w, sa * w, v, -ca * w);
      uv.push(0, v, 1, v);
      nrm.push(ca, 0.2, sa, ca, 0.2, sa);
    }
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Handle returned by buildGrass. */
export interface GrassField {
  meshes: THREE.InstancedMesh[];
  /** @param dtSeconds elapsed RENDER time since last frame (seconds)
   *  @param camPos live camera world position for distance culling/LOD */
  update(dtSeconds: number, camPos?: THREE.Vector3): void;
  /** CINE-ONLY no-op kept so Game.ts's grass?.setTier(...) type-checks. */
  setTier(gfx: 'cine' | 'fast'): void;
  /** Re-tint the blades' lit response to match the time-of-day sky. */
  setTimeOfDay(p: GrassPalette): void;
  /** Cheap live telemetry for the debug overlay. */
  stats(): { allocated: number; tilesTotal: number; tilesDrawn: number };
}

/** Per-time-of-day look fed from Game (mirrors the Sea palette pattern). */
export interface GrassPalette {
  /** overall light level on the blades: ~1 day, ~0.85 dusk, ~0.4 night */
  ambient: number;
  /** warm/cool ground tint pushed into the base colour (sun/sky colour) */
  tint: number;
}

/** One spatial tile: an InstancedMesh + world-space centre + full instance
 *  count + the geometry-LOD it currently shows (to avoid redundant swaps). */
interface GrassTile {
  mesh: THREE.InstancedMesh;
  cx: number;
  cz: number;
  full: number;
  lod: number; // 0/1/2 currently assigned; -1 = none yet
}

/**
 * Build the instanced fluffy-grass field for the island's GRASS VERGES and add
 * it to `scene`. The caller only invokes this on coast levels.
 *
 * @param scene the world scene (its PMREM environment lights the blades)
 * @param level the level def — READ (never mutated) for its surface geometry so
 *        clumps land only on real grass, off the sand/gravel/concrete/road.
 */
export function buildGrass(scene: THREE.Scene, level: LevelDef): GrassField {
  const mask = buildSurfaceMask(level);

  // ── MATERIAL: FluffyGrass shader grafted onto MeshStandard ─────────────────
  // MeshStandard so the blades pick up the PMREM sky env + fog + shadows like
  // the textured ground; the demo's gradient + alpha-mask + wind are spliced in
  // via onBeforeCompile. Colours match the FluffyGrass palette (dark olive base
  // -> bright sage tip, with a darker variation tip mixed by noise).
  // FluffyGrass palette, lifted a touch: our scene has a BLUE hemisphere fill
  // (hemiSky ~#bfd6ff) the demo lacks, so the demo's near-black base (#313f1b)
  // got swamped by sky fill into a cyan cast on sparse/short blades. A brighter,
  // greener base keeps the green dominant everywhere while preserving the demo's
  // dark-base → bright-sage-tip gradient character.
  const BASE_COL = new THREE.Color('#42551f'); // mid olive-green planted base
  const TIP1_COL = new THREE.Color('#acd982'); // bright sage sunlit tip (demo-ish)
  const TIP2_COL = new THREE.Color('#6f9242'); // mid-green variation tip
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
    transparent: false,
    shadowSide: THREE.DoubleSide,
    // The blades are lit by the PMREM sky env (so they sit in the scene), but at
    // full env intensity the BLUE sky IBL washes the green diffuse toward cyan
    // at our grazing chase-cam angle. Damp the env contribution hard so the
    // green base->tip gradient stays the dominant colour (the demo is flat
    // Lambert with no env at all; this keeps a touch of sky fill without the
    // cyan cast).
    envMapIntensity: 0.22,
  });
  // Force three to declare the generic `uv` attribute + `vUv` varying in BOTH
  // shader stages even though we set no map/alphaMap on the material. Without
  // this, USE_UV is undefined and our onBeforeCompile references to `uv.y`
  // (vertex) and `vUv` (the alpha-mask cutout, fragment) are undeclared and the
  // program fails to compile — three then silently falls back to a broken/blank
  // program. USE_UV makes `vUv = uv` available in the fragment (see three's
  // uv_pars_*/uv_vertex chunks), which is exactly the card UV the demo samples
  // its blade-silhouette alpha mask at.
  mat.defines = { ...(mat.defines ?? {}), USE_UV: '' };

  // shared uniforms — one material drives every tile mesh
  const uTime = { value: 0 };
  const uAmbient = { value: 1 };
  const uBaseColor = { value: BASE_COL.clone() };
  const uTip1Color = { value: TIP1_COL.clone() };
  const uTip2Color = { value: TIP2_COL.clone() };
  const uAlphaTex = { value: null as THREE.Texture | null };
  const uNoiseTex = { value: null as THREE.Texture | null };
  const uHasTex = { value: 0 }; // 0 until the textures land (avoid sampling null)

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uAmbient = uAmbient;
    shader.uniforms.uBaseColor = uBaseColor;
    shader.uniforms.uTip1Color = uTip1Color;
    shader.uniforms.uTip2Color = uTip2Color;
    shader.uniforms.uAlphaTex = uAlphaTex;
    shader.uniforms.uNoiseTex = uNoiseTex;
    shader.uniforms.uHasTex = uHasTex;

    // ── VERTEX: world-UV + perlin wind (ported from FluffyGrass) ───────────
    // The clump's world origin comes from the instance matrix translation. The
    // demo's wind is sin(freq · dot(windDir, globalUV) + noise.g · k + t) scaled
    // by (1 - uv.y) so the base stays planted and the tip whips, plus a perlin
    // height bump for the fluffy unevenness. We compute globalUV from the world
    // position so neighbouring clumps share the field-scale wind wave.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform sampler2D uNoiseTex;
         uniform int uHasTex;
         varying float vBladeY;   // 0 base -> 1 tip (uv.y)
         varying vec2 vGlobalUV;  // field-scale UV for the colour-variation noise`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBladeY = uv.y;
         // instance world origin (translation column of the instance matrix)
         vec3 iPos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
         // field-scale UV: tile the noise every ~64 m of world so the wind wave
         // and colour variation read at clump-to-clump scale, like the demo.
         vGlobalUV = iPos.xz / 64.0;
         float tipFactor = uv.y; // 0 at base, 1 at tip
         if (uHasTex == 1) {
           // wind: a travelling sine across the field, jittered by the noise G
           // channel so it isn't a clean ripple; amplitude grows toward the tip.
           vec4 n = texture2D(uNoiseTex, vGlobalUV * 1.5 + uTime * 0.012);
           float wave = sin(8.0 * (iPos.x * 0.03 + iPos.z * 0.03) + n.g * 6.0 + uTime * 1.4);
           float amp = 0.22 * tipFactor;
           transformed.x += wave * amp;
           transformed.z += wave * amp * 0.7;
           // perlin height bump: makes the field fluffy/uneven (demo trick),
           // strongest at the tip so the base stays planted on the ground.
           float bump = texture2D(uNoiseTex, vGlobalUV * 2.0).r;
           transformed.y += (exp(bump) - 1.0) * 0.12 * tipFactor;
         } else {
           // pre-texture fallback: a cheap planted-base sway so it isn't static
           float wave = sin(uTime * 1.2 + iPos.x * 0.35 + iPos.z * 0.27);
           transformed.x += wave * 0.14 * tipFactor * tipFactor;
           transformed.z += wave * 0.08 * tipFactor * tipFactor;
         }`,
      );

    // ── FRAGMENT: base->tip gradient + noise variation + alpha-mask cutout ──
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uAmbient;
         uniform vec3 uBaseColor;
         uniform vec3 uTip1Color;
         uniform vec3 uTip2Color;
         uniform sampler2D uAlphaTex;
         uniform sampler2D uNoiseTex;
         uniform int uHasTex;
         varying float vBladeY;
         varying vec2 vGlobalUV;`,
      )
      // splice the alpha-mask cutout BEFORE the standard alphatest so a masked
      // texel is discarded (the wispy blade silhouette = the fluffy look). The
      // mask runs across the card's own uv; we read .r and threshold it.
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
         if (uHasTex == 1) {
           float m = texture2D(uAlphaTex, vUv).r;
           if (m < 0.35) discard;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // base->tip vertical gradient; the tip colour itself varies clump-to-
         // clump via the noise R channel (sage <-> mid-green), so the field
         // isn't one flat green. (FluffyGrass GrassMaterial.ts gradient.)
         vec3 tip = uTip1Color;
         if (uHasTex == 1) {
           float var0 = texture2D(uNoiseTex, vGlobalUV).r;
           tip = mix(uTip1Color, uTip2Color, var0);
         }
         float t = vBladeY * vBladeY; // ease so more of the blade reads tip-lit
         vec3 grass = mix(uBaseColor, tip, t);
         diffuseColor.rgb *= grass * uAmbient;`,
      );
  };
  mat.customProgramCacheKey = () => 'cj-grass-fluffy';

  // ── PLACEMENT (build-time, deterministic hash) ─────────────────────────
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of mask.outline) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    minX = -262;
    maxX = -150;
    minZ = -240;
    maxZ = -86;
  }
  const bboxW = maxX - minX;
  const bboxD = maxZ - minZ;
  const bboxArea = bboxW * bboxD;
  const candidates = Math.min(Math.ceil(bboxArea * DENSITY), MAX_BLADES * 6);

  interface Bin {
    data: number[]; // flat 16-float matrices
    sumX: number;
    sumZ: number;
  }
  const bins = new Map<string, Bin>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const pos = new THREE.Vector3();
  let placed = 0;
  const cols = Math.max(1, Math.ceil(bboxW / TILE_SIZE));
  for (let i = 0; i < candidates && placed < MAX_BLADES; i++) {
    const rx = hash01(i * 2.0 + 11.3);
    const rz = hash01(i * 2.0 + 91.7);
    const x = minX + rx * bboxW;
    const z = minZ + rz * bboxD;

    if (!isGrass(x, z, mask)) continue;

    // visual thinning over the last few metres before the SW dune lip
    const sd = seawardDist(x, z, mask.lip);
    if (sd > -6) {
      const lipKeep = (0 - sd) / 6;
      if (hash01(i * 2.0 + 333.1) > lipKeep) continue;
    }

    // size: TALL clumps (the chase-cam lushness lever) with per-instance jitter
    // so the field has height + width variation instead of reading flat. Taper
    // shorter toward the SW sand so the lawn fades into the dune.
    const thin = Math.max(0, Math.min(1, (sd + 6) / 6)); // 0 inland -> 1 at lip
    const baseH = HEIGHT_MIN + hash01(i * 3.0 + 7.1) * (HEIGHT_MAX - HEIGHT_MIN);
    const h = baseH * (1 - thin * 0.4);
    const w = WIDTH_MIN + hash01(i * 3.0 + 51.9) * (WIDTH_MAX - WIDTH_MIN);
    s.set(w, h, w);

    pos.set(x, 0, z);
    const yaw = hash01(i * 3.0 + 13.7) * Math.PI * 2;
    q.setFromAxisAngle(yAxis, yaw);
    m.compose(pos, q, s);

    const tcol = Math.min(cols - 1, Math.floor((x - minX) / TILE_SIZE));
    const trow = Math.floor((z - minZ) / TILE_SIZE);
    const key = `${tcol},${trow}`;
    let bin = bins.get(key);
    if (!bin) {
      bin = { data: [], sumX: 0, sumZ: 0 };
      bins.set(key, bin);
    }
    const e = m.elements;
    for (let k = 0; k < 16; k++) bin.data.push(e[k]);
    bin.sumX += x;
    bin.sumZ += z;
    placed++;
  }

  // ── REALISE TILES (synchronous; fallback geometry until the GLB lands) ────
  const fallbackGeo = makeFallbackGeometry();
  const tiles: GrassTile[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  for (const [, bin] of bins) {
    const n = bin.data.length / 16;
    if (n === 0) continue;
    const arr = new Float32Array(bin.data);
    const mesh = new THREE.InstancedMesh(fallbackGeo, mat, n);
    mesh.instanceMatrix.array.set(arr);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = 'cj-grass-blades';
    mesh.computeBoundingSphere();
    mesh.count = n;
    scene.add(mesh);
    meshes.push(mesh);
    tiles.push({ mesh, cx: bin.sumX / n, cz: bin.sumZ / n, full: n, lod: -1 });
  }

  // ── ASYNC ASSET SWAP ──────────────────────────────────────────────────────
  // When the GLB + textures land, swap the real LOD geometry onto every tile
  // (default LOD0; update() re-picks per distance) and switch the shader's
  // texture path on. Pure presentation — placement/matrices already decided.
  let lods: GrassLODs | null = null;
  loadGrassAssets()
    .then((assets) => {
      lods = assets.lods;
      uAlphaTex.value = assets.alpha;
      uNoiseTex.value = assets.noise;
      uHasTex.value = 1;
      mat.needsUpdate = true; // re-evaluate uHasTex branch in the compiled program
      for (const t of tiles) {
        t.mesh.geometry = lods.lod0;
        t.lod = 0;
        t.mesh.computeBoundingSphere();
      }
    })
    .catch((err) => {
      // keep the fallback strips if the assets fail (e.g. offline) — better a
      // sparse green sliver than a crash. Log once for diagnosis.
      console.warn('[grass] FluffyGrass assets failed to load; keeping fallback geometry', err);
    });

  const cullR2 = CULL_RADIUS * CULL_RADIUS;
  const fullR2 = FULL_RADIUS * FULL_RADIUS;
  const lod0R2 = LOD0_RADIUS * LOD0_RADIUS;
  const lod1R2 = LOD1_RADIUS * LOD1_RADIUS;
  const lodSpan = Math.max(1, CULL_RADIUS - FULL_RADIUS);
  const allocated = placed;
  let tilesDrawn = tiles.length;

  return {
    meshes,
    update(dt, camPos) {
      uTime.value += dt;
      // DISTANCE CULL + GEOMETRY LOD + COUNT LOD per tile. Pure visibility/
      // count/geometry flip — pin-safe, reads only the render-time camera.
      if (camPos) {
        let drawn = 0;
        for (const t of tiles) {
          const dx = t.cx - camPos.x;
          const dz = t.cz - camPos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > cullR2) {
            t.mesh.visible = false;
            continue;
          }
          t.mesh.visible = true;
          drawn++;

          // geometry LOD: full clump near, cheaper clumps far (only once the
          // real LODs have loaded; the fallback strip has no LODs).
          if (lods) {
            const wantLod = d2 <= lod0R2 ? 0 : d2 <= lod1R2 ? 1 : 2;
            if (wantLod !== t.lod) {
              t.mesh.geometry = wantLod === 0 ? lods.lod0 : wantLod === 1 ? lods.lod1 : lods.lod2;
              t.lod = wantLod;
            }
          }

          // count LOD: full density near, thinning to MIN_LOD_FRAC at the cull
          if (d2 <= fullR2) {
            t.mesh.count = t.full;
          } else {
            const d = Math.sqrt(d2);
            const td = (d - FULL_RADIUS) / lodSpan; // 0..1
            const inv = 1 - td;
            const frac = MIN_LOD_FRAC + (1 - MIN_LOD_FRAC) * inv * inv;
            t.mesh.count = Math.max(1, Math.round(t.full * frac));
          }
        }
        tilesDrawn = drawn;
      } else {
        for (const t of tiles) {
          t.mesh.visible = true;
          t.mesh.count = t.full;
        }
        tilesDrawn = tiles.length;
      }
    },
    setTier(_gfx) {
      void _gfx; // CINE-ONLY no-op (always full density)
    },
    setTimeOfDay(p) {
      uAmbient.value = p.ambient;
      // nudge the base + tips toward the sky/sun tint so dusk warms, night cools
      const t = new THREE.Color(p.tint);
      uBaseColor.value.copy(BASE_COL).lerp(t, 0.12);
      uTip1Color.value.copy(TIP1_COL).lerp(t, 0.08);
      uTip2Color.value.copy(TIP2_COL).lerp(t, 0.08);
    },
    stats() {
      return { allocated, tilesTotal: tiles.length, tilesDrawn };
    },
  };
}
