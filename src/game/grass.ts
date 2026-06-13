import * as THREE from 'three';
import { hash01 } from './textures';
import type { LevelDef, GroundPatchDef } from './types';

// ============================================================================
// INSTANCED 3D-BLADE GRASS — the GRASS VERGES of the whole island (GANTRY POINT).
// ============================================================================
//
// The textured island-grass ground + the alpha-tongue dune fringe (both in
// environment.ts) stay as the BASE; this module AUGMENTS them with a field of
// real 3D blades that sit ON the grass and sway in the wind. Blades are placed
// ONLY where the ground is genuinely grass.
//
// ── WHY THIS WAS REWRITTEN (the bug) ─────────────────────────────────────────
//   The previous pass confined the whole field to a tiny SW-beach rectangle
//   (BAND minX -262..maxX -150, ~the grass-sand art pose) and biased its
//   density toward that one camera. tools/grass-count.mjs proved the result:
//   the SW beach poses saw 6k-17k blades, but EVERY on-track driving pose round
//   the rest of the lap (start straight, dockyard, quay climb, cliff, lookout,
//   NW sweepers, roadblock) saw ZERO. The player drives a full island loop and
//   never passed the band, so they "saw no grass at all". The island ground is
//   `ground:'field'` (bare grass) everywhere; the GRASS VERGES the player drives
//   past are exactly that green ground, minus the non-grass patches and the
//   road. None of it had blades.
//
//   The fix: scatter blades across the WHOLE island outline (the green field),
//   with a hard mask that rejects only genuine non-grass — sand, gravel and
//   concrete patches, the road + shortcut corridors, building plinths, and
//   anything seaward of the coast rim or the dune lip. drygrass (the golden
//   headland/cliff verges) is REAL drying grass, so it keeps its blades.
//
// ── DENSITY: MATCHED TO THE FLUFFYGRASS DEMO (2026-06-13) ────────────────────
//   The reference https://fluffygrass.vercel.app/ scatters 8000 tuft instances
//   over a ~2546 m² terrain → ~3.14 tufts/m² (tools/fluffy-measure.mjs proves
//   this from its source; note island.glb has no vertex colour, so its
//   setWeightAttribute("color") is a no-op and the scatter is UNIFORM). We now
//   match that NEAR-FIELD density: DENSITY = 3.1 tufts/m², each a small 3-blade
//   tuft like the demo's clump, so the lawn reads as a lush mat. The old pass
//   sat at 0.42 (≈0.27 measured) — ~12x too sparse. Because our island is huge
//   (not a ~55 m demo patch), full-island coverage at 3.1/m² is unaffordable to
//   DRAW, so render-time distance LOD (see FULL_RADIUS / MIN_LOD_FRAC) keeps the
//   near field at full demo density and thins the mid/far field hard.
//
// TECHNIQUE — adapted from FluffyGrass by Ebenezer (MIT):
//   https://github.com/thebenezer/FluffyGrass
//   The tuft/clump geometry, the vertex-shader wind sway (a noise-perturbed
//   sine that scales by (1 - uv.y) so the base stays planted while the tip
//   whips), and the base->tip colour gradient are adapted from that project's
//   GrassMaterial.ts + GrassLOD00. We do NOT port its code verbatim: the tuft
//   geometry is built procedurally here (FluffyGrass loads a GLB LOD), placement
//   is a bounded deterministic-hash scatter (FluffyGrass uses MeshSurfaceSampler
//   on a small terrain), and the material is grafted onto MeshStandardMaterial
//   (FluffyGrass uses Lambert) so the blades catch this engine's PMREM sky env +
//   fog + shadows. MIT requires keeping the copyright/attribution — see this
//   comment + the art-grass report. License text: _ref/FluffyGrass/LICENSE.
//
// PIN-SAFE / VISUAL ONLY: blades are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (update(dt)
// only writes a float uniform). Distance culling reads the RENDER-time camera
// position (passed into update) and only flips per-tile mesh visibility — it
// never touches sim state, RNG, or the world hash. Nothing here enters the
// world hash.
//
// ── GRASS-ONLY PLACEMENT (the hard mask) ─────────────────────────────────────
//   We build a HARD mask from the LEVEL'S OWN surface geometry (read-only — we
//   never edit the level) and REJECT every candidate that is not on real grass:
//     * outside the island OUTLINE polygon (inset a touch) -> over sea (reject)
//     * inside any 'sand' / 'gravel' / 'concrete' patch -> not grass (reject)
//     * seaward of the SW 'drygrass' dune lip -> sand (reject; belt-and-braces
//       with the sand polygon, derived from data not a hand-typed polyline)
//     * within (half-width + margin) of the MAIN race ribbon centreline (the
//       road) or of any SHORTCUT ribbon centreline -> on/near road (reject)
//     * within a building plinth's footprint + margin -> under a building
//   drygrass patches are NOT rejected — they are drying-but-real grass (the
//   golden headland and cliff verges the player drifts along). The mask is a
//   hard accept/reject, so ZERO blades sit on sand, gravel, concrete or road.
//
// ── DISTANCE CULLING + LOD (what makes demo near-density affordable) ─────────
//   The island is partitioned into a grid of TILES; each non-empty tile is its
//   own InstancedMesh with its own bounding sphere. update(dt, camPos):
//     * hides a tile whose centre is beyond CULL_RADIUS (far field draws zero);
//     * draws FULL allocated density inside FULL_RADIUS (the lush near field);
//     * between the two, scales mesh.count down (ease-out to MIN_LOD_FRAC) so
//       the mid/far ring thins HARD. Because placement order within a tile is
//       hash-uniform, drawing the first K instances is an even spatial
//       subsample — no clustering artefact from the thinning.
//   three's own frustumCulled (left on per tile) drops off-screen tiles too.
//   This near-full / far-thin split is what lets us match the demo's ~3.1
//   tufts/m² in the near field on a 600 m island without drawing it everywhere.
//
//   * ONE InstancedMesh PER TILE = one draw call per VISIBLE tile (off-screen /
//     far tiles issue none). Wind is entirely in the vertex shader (zero CPU
//     per blade per frame); placement is build-time only.
//
// ── CINE-ONLY ────────────────────────────────────────────────────────────────
//   The game is moving to always-CINE; there is no FAST density tier any more.
//   setTier() is kept on the interface (Game.ts still calls it) but every tier
//   resolves to the single full-density path — no sparse-subset branch.
// ============================================================================

/** Per-area blade density (blade-tufts per m² of accepted grass).
 *
 *  TARGET = the FluffyGrass demo (https://fluffygrass.vercel.app/). Measured
 *  from its source (tools/fluffy-measure.mjs replicates main.ts exactly):
 *  8000 instances scattered by MeshSurfaceSampler over the island.glb terrain
 *  (scaled 3x), whose grass surface is ~2546 m² of triangle area / ~3180 m² of
 *  footprint → **~3.14 instances/m²** (3.1 over triangle area, 2.5 over the
 *  flat footprint). Each demo instance is a 66-triangle TUFT of ~6 fanned
 *  blades, ~0.70 m tall and ~1.6 m wide after its 5x scale — so the ground
 *  reads as a continuous lush mat, not isolated spikes.
 *
 *  We match that NEAR-FIELD instance density (3.1 tufts/m²) and make our own
 *  blade a small 2-blade cross tuft so each instance reads as full as the
 *  demo's clump. The prior pass sat at 0.42 (≈0.27 measured) — ~12x too sparse.
 *
 *  Allocation = DENSITY × accepted grass area, capped at MAX_BLADES. The island
 *  is huge (~186k m² of grass), so full island coverage at 3.1/m² would need
 *  ~580k tufts; the cap bounds that, and render-time distance LOD (see
 *  FULL_RADIUS/MIN_LOD_FRAC) keeps the DRAWN count affordable — full demo
 *  density in the near field, thinning to a cheap far field. */
const DENSITY = 3.1;

/** Hard ceiling on allocated blade-tufts across the whole island. Sized so the
 *  near + mid field around the track can be fully demo-dense while the build
 *  cost stays a one-time ~0.3 s / ~40 MB pass (measured). Render-time LOD makes
 *  only a fraction of the allocated tufts DRAW at once. */
const MAX_BLADES = 600000;

/** Distance-cull radius (m): a tile whose centre is farther than this from the
 *  live camera draws nothing. Sized so the verges read out toward the scene fog
 *  (Game's gantry fog is 90..340 m). Between FULL_RADIUS and here the per-tile
 *  LOD thins the draw, so the far edge is cheap. */
const CULL_RADIUS = 200;

/** Inside this radius (m) a tile draws its FULL allocated density — the demo's
 *  ~3.1 tufts/m². This is the "near field" the player sees in detail; it must
 *  read exactly as lush as the demo. The demo's whole patch is only ~55 m, so
 *  50 m of full density already covers everything the eye resolves as
 *  individual tufts. Beyond it the per-tile LOD ramps the drawn fraction down
 *  to MIN_LOD_FRAC at CULL_RADIUS, so the mid/far field is cheap. Keeping this
 *  tight (vs the 200 m cull) is what makes matching the demo's near-density
 *  affordable on our huge island. */
const FULL_RADIUS = 50;

/** Floor on the per-tile drawn fraction at the cull edge. A distant-but-visible
 *  tile draws this fraction of its tufts (uniformly thinned — hash placement is
 *  spatially uniform, so drawing the first K instances is an even subsample).
 *  Low enough that the 120..200 m ring is cheap, high enough that the field
 *  doesn't visibly terrace into a bald ring before the fog hides it. */
const MIN_LOD_FRAC = 0.04;

/** Spatial tile size (m) for the culling + LOD grid. A 24 m tile over the
 *  ~600 m island gives a ~25 x 22 grid — fine enough that the distance LOD
 *  steps smoothly across the field and three's frustum test is tight, coarse
 *  enough that per-tile overhead stays trivial. */
const TILE_SIZE = 24;

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
 *  centreline). Walks each segment and keeps the nearest perpendicular foot,
 *  clamped to the segment. Returns metres² so callers compare against a
 *  squared half-width without a sqrt. */
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

/** A "road keep-out": a centreline polyline plus a clearance radius (m). A
 *  candidate within `radius` of the line is on/near paving and is rejected. */
interface RoadMask {
  pts: [number, number][];
  radiusSq: number;
}

/** A circular keep-out: a centre + squared radius. Building plinths use these
 *  so blades don't sprout up through a warehouse / motel / hamlet footprint. */
interface CircleMask {
  x: number;
  z: number;
  radiusSq: number;
}

/** The grass-only mask, built once from the level's surface geometry. */
interface SurfaceMask {
  /** The island outline polygon (coast rim). Candidates OUTSIDE it are over
   *  the sea — reject. Empty if the level has no coast (then accept all). */
  outline: [number, number][];
  /** Polygons that are NOT grass (sand apron, gravel lot, concrete apron) —
   *  reject if inside. */
  rejectPolys: GroundPatchDef['poly'][];
  /** The SW drygrass band's SEAWARD edge polyline = the real dune lip. Anything
   *  on the seaward side of this is sand; null if the band can't be found. */
  lip: { seaward: [number, number][]; sandInsideSign: number } | null;
  /** Road/ribbon keep-outs (main loop + shortcuts). */
  roads: RoadMask[];
  /** Building plinth keep-outs. */
  buildings: CircleMask[];
}

/** Pull the SW-beach 'drygrass' band out of the level (the same patch the
 *  dune fringe uses) and split its thin loop into a seaward and an inland edge
 *  at its narrow ends (min/max x). The seaward edge is the dune lip: blades may
 *  reach it but not pass it. Mirrors environment.ts addDuneFringe's split so
 *  the blade lip and the painted fringe agree. */
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
  // inland edge sits at higher (less negative) z on average; seaward hugs sand
  const meanZ = (e: [number, number][]): number => e.reduce((s, p) => s + p[1], 0) / e.length;
  const seaward = meanZ(edgeA) > meanZ(edgeB) ? edgeB : edgeA;
  // orient W->E so it runs the same way regardless of which loop half it is
  if (seaward[0][0] > seaward[seaward.length - 1][0]) seaward.reverse();
  return { seaward, sandInsideSign: 0 };
}

/** Build the grass-only mask from the level's own surface geometry. We read
 *  level data (outline + patches + race ribbon + shortcuts + buildings) but
 *  never mutate it. */
function buildSurfaceMask(level: LevelDef): SurfaceMask {
  const patches = level.patches ?? [];
  // EVERY non-grass patch anywhere on the island = reject. sand / gravel /
  // concrete are all hard surfaces; drygrass is real (drying) grass and keeps
  // its blades (the golden headland + cliff verges the player drifts along).
  const rejectPolys: GroundPatchDef['poly'][] = patches
    .filter((p) => p.kind === 'sand' || p.kind === 'gravel' || p.kind === 'concrete')
    .map((p) => p.poly);

  // Island outline (coast rim), inset slightly so blades never overhang the
  // skirt into open water. Inset by moving each vertex toward the centroid.
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
    // MAIN loop centreline (closed) — half-width + a margin so blades never
    // touch the ribbon edge or its kerb. Masks the whole loop, so the verges
    // stop cleanly at the kerb everywhere the player drives.
    const mainPts: [number, number][] = race.sections.map((s) => [s.x, s.z]);
    if (mainPts.length > 1) {
      mainPts.push([mainPts[0][0], mainPts[0][1]]); // close the loop
      const r = race.width / 2 + 2.5; // 11 + 2.5 m clearance to the verge
      roads.push({ pts: mainPts, radiusSq: r * r });
    }
    // SHORTCUT ribbons (dirt/asphalt cuts slice across the field).
    for (const sc of race.shortcuts ?? []) {
      const pts: [number, number][] = sc.waypoints.map((w) => [w[0], w[1]]);
      if (pts.length > 1) {
        const r = sc.width / 2 + 2.5;
        roads.push({ pts, radiusSq: r * r });
      }
    }
  }

  // Building plinths (14x14 footprint, half-diagonal ~9.9 m) + a small margin
  // so blades don't poke through a warehouse / motel / hamlet base.
  const buildings: CircleMask[] = (level.buildings ?? []).map((b) => {
    const r = 10.5; // ~half-diagonal of the 14x14 plinth + ~0.6 m margin
    return { x: b.x, z: b.z, radiusSq: r * r };
  });

  return { outline, rejectPolys, lip, roads, buildings };
}

/** Signed seaward distance (m) of (x,z) from the dune-lip polyline. Negative =
 *  inland on the grass; positive = out onto the sand. Drives the visual
 *  thinning near the lip (the hard sand-rejection is the sand polygon). */
function seawardDist(x: number, z: number, lip: SurfaceMask['lip']): number {
  if (!lip) return -100; // no lip data -> treat everything as well inland
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
      // seaward normal of this segment: the lip runs W->E and the sand lies
      // down-z (more negative z), so (dz,-dx) points seaward.
      const nlen = Math.hypot(dz, dx) || 1;
      const nx = dz / nlen;
      const nz = -dx / nlen;
      bestSigned = (x - px) * nx + (z - pz) * nz;
    }
  }
  return bestSigned;
}

/** True iff (x,z) is on genuine grass: inside the island, not in a non-grass
 *  polygon, not seaward of the SW dune lip, not on/near a road or shortcut
 *  ribbon, not under a building. HARD mask. */
function isGrass(x: number, z: number, mask: SurfaceMask): boolean {
  // off the island (over the sea / skirt) -> reject
  if (mask.outline.length >= 3 && !pointInPoly(x, z, mask.outline)) return false;
  for (const poly of mask.rejectPolys) if (pointInPoly(x, z, poly)) return false;
  // seaward of the SW dune lip = sand (belt-and-suspenders with the sand polygon)
  if (mask.lip && seawardDist(x, z, mask.lip) > 0) return false;
  for (const road of mask.roads) if (distToPolylineSq(x, z, road.pts) < road.radiusSq) return false;
  for (const b of mask.buildings) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz < b.radiusSq) return false;
  }
  return true;
}

/** Build ONE grass TUFT: a small fan of CROSSED tapered blades sharing an
 *  origin, mirroring the FluffyGrass demo's clump geometry (its LOD00 is a
 *  ~6-blade fan, not a single strip) so each placed instance reads as a full
 *  bushy clump and the dense field looks like a lush mat rather than rows of
 *  isolated spikes. We use a 3-blade fan at 3 yaw angles — 3x the silhouette
 *  of a single strip at the same instance count, still only 12 triangles.
 *
 *  uv.y runs 0 at the base (planted) -> 1 at the tip (where the wind sway is
 *  full and the colour is lightest). Each blade narrows to a point so the
 *  silhouette reads as grass. The blades are slightly splayed and offset so the
 *  tuft has volume from any view angle. */
function makeBladeGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 4;
  const HEIGHT = 1; // unit blade; per-instance scale sizes it in metres
  const HALF_W = 0.06; // base half-width (m at unit scale)
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];

  // BLADES_PER_TUFT crossed strips fanned around the tuft's vertical axis, each
  // with a small lateral offset + a forward lean so the clump has body.
  const BLADES_PER_TUFT = 3;
  for (let b = 0; b < BLADES_PER_TUFT; b++) {
    const ang = (b / BLADES_PER_TUFT) * Math.PI; // 0, 60, 120° (strip is 2-sided)
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    // lateral root offset so the three blades don't all sprout from one point
    const ox = ca * 0.03;
    const oz = sa * 0.03;
    // each blade leans outward a touch as it rises (lean grows with height)
    const leanX = ca * 0.12;
    const leanZ = sa * 0.12;
    const base = pos.length / 3;
    for (let s = 0; s <= SEGMENTS; s++) {
      const v = s / SEGMENTS;
      const y = v * HEIGHT;
      const w = HALF_W * (1 - v) * (1 - v * 0.25); // taper to a point
      // strip runs along the blade's own width axis (perpendicular to its lean)
      const wx = -sa * w;
      const wz = ca * w;
      const lx = ox + leanX * v * v;
      const lz = oz + leanZ * v * v;
      pos.push(lx - wx, y, lz - wz, lx + wx, y, lz + wz);
      uv.push(0, v, 1, v);
      // normal faces along the lean direction so lighting reads per blade
      nrm.push(ca, 0.2, sa, ca, 0.2, sa);
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  return geo;
}

/** Handle returned by buildGrass: the instanced meshes (already added) plus the
 *  render-loop hooks. update(dt, camPos) advances the wind clock and distance-
 *  culls far tiles; setTimeOfDay() tunes the lit base colour. setTier() is a
 *  no-op kept for the Game.ts call site — the game is always-CINE now. */
export interface GrassField {
  /** All per-tile instanced meshes (one draw call each when visible). */
  meshes: THREE.InstancedMesh[];
  /** @param dtSeconds elapsed RENDER time since last frame (seconds)
   *  @param camPos live camera world position for distance culling (optional;
   *         omit to leave every tile drawn) */
  update(dtSeconds: number, camPos?: THREE.Vector3): void;
  /** CINE-ONLY: the FAST density tier was removed (always-CINE game). This
   *  remains so Game.ts's `grass?.setTier(...)` call still type-checks; it does
   *  nothing — the field is always full density. Visual only. */
  setTier(gfx: 'cine' | 'fast'): void;
  /** Re-tint the blades' lit response to match the time-of-day sky. */
  setTimeOfDay(p: GrassPalette): void;
  /** Cheap live telemetry for the debug overlay: how many blades are allocated
   *  across the island, how many tiles exist, and how many passed the distance
   *  cull on the LAST update() (i.e. are eligible to draw this frame). Reads
   *  cached counters only — no per-blade work, pin-safe. */
  stats(): { allocated: number; tilesTotal: number; tilesDrawn: number };
}

/** Per-time-of-day look fed from Game (mirrors the Sea palette pattern). */
export interface GrassPalette {
  /** overall light level on the blades: ~1 day, ~0.85 dusk, ~0.4 night */
  ambient: number;
  /** warm/cool ground tint pushed into the base colour (sun/sky colour) */
  tint: number;
}

/** One spatial tile of the island: an InstancedMesh + its world-space centre
 *  (for the distance cull) + its full allocated instance count (for the
 *  distance LOD, which scales mesh.count down for far tiles). */
interface GrassTile {
  mesh: THREE.InstancedMesh;
  cx: number;
  cz: number;
  full: number;
}

/**
 * Build the instanced blade field for the island's GRASS VERGES and add it to
 * `scene`. The caller only invokes this on coast levels; inland levels get no
 * grass field.
 *
 * @param scene the world scene (its PMREM environment lights the blades)
 * @param level the level def — READ (never mutated) for its surface geometry
 *        so blades land only on real grass, off the sand/gravel/concrete/road.
 */
export function buildGrass(scene: THREE.Scene, level: LevelDef): GrassField {
  const geo = makeBladeGeometry();
  const mask = buildSurfaceMask(level);

  // Base material: MeshStandard so the blades pick up the PMREM sky env +
  // scene fog + shadows the same way the textured ground does — that's what
  // makes them sit in the lighting across day/dusk/night instead of glowing.
  // Colours match makeGrassTexture's palette so blades and ground agree.
  const BASE_COL = new THREE.Color(0x5e6d3e); // shaded planted base (matches lawn)
  const TIP_COL = new THREE.Color(0xa9bd78); // light sunlit tip
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
    transparent: false,
    shadowSide: THREE.DoubleSide,
  });

  // wind clock + per-tod tint, shared into the patched shader (one material
  // shared by every tile mesh, so one uniform write tints/sways them all)
  const uTime = { value: 0 };
  const uAmbient = { value: 1 };
  const uBaseColor = { value: BASE_COL.clone() };
  const uTipColor = { value: TIP_COL.clone() };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uAmbient = uAmbient;
    shader.uniforms.uBaseColor = uBaseColor;
    shader.uniforms.uTipColor = uTipColor;

    // ── VERTEX: wind sway (adapted from FluffyGrass GrassMaterial.ts) ──────
    // A noise-free, cheap two-frequency sine of world position + time, scaled
    // by (1 - uv.y)^? so the base is planted and the tip whips. The per-blade
    // phase comes from the instance's world x+z (decoded from instanceMatrix),
    // so neighbours sway out of step and the field shimmers like a breeze.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         varying float vHeight;
         varying float vPhase;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vHeight = uv.y;
         // instance world origin from the instance matrix translation column
         vec3 iPos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
         float phase = iPos.x * 0.35 + iPos.z * 0.27;
         vPhase = phase;
         // two crossing breezes + a faster flutter; bend scales with height so
         // the planted base stays put. (1.-uv.y) inverted -> tip moves most.
         float sway =
             sin(uTime * 1.1 + phase) * 0.85
           + sin(uTime * 2.3 + phase * 1.7) * 0.35
           + sin(uTime * 5.0 + iPos.x * 0.9) * 0.12;
         float bend = uv.y * uv.y; // 0 at base -> 1 at tip
         transformed.x += sway * 0.13 * bend;
         transformed.z += sway * 0.08 * bend;
         // a touch of vertical droop as the blade leans, so tall blades don't
         // stretch unnaturally when they whip
         transformed.y -= abs(sway) * 0.03 * bend;`,
      );

    // ── FRAGMENT: base->tip colour gradient + tod tint ────────────────────
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uAmbient;
         uniform vec3 uBaseColor;
         uniform vec3 uTipColor;
         varying float vHeight;
         varying float vPhase;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // dark planted base -> light sunlit tip, with a per-blade hue jitter
         // (from the instance phase) so the field isn't one flat green
         float jitter = sin(vPhase * 3.7) * 0.5 + 0.5;
         vec3 tip = mix(uTipColor, uTipColor * 0.78, jitter);
         vec3 grass = mix(uBaseColor, tip, vHeight * vHeight);
         diffuseColor.rgb *= grass * uAmbient;`,
      );
  };
  // a stable cache key so three doesn't think every blade mesh is a new program
  mat.customProgramCacheKey = () => 'cj-grass-blade';

  // ── PLACEMENT (build-time, deterministic hash) ─────────────────────────
  // Scatter candidate blades UNIFORMLY across the island bounding box and keep
  // the ones that land on GENUINE GRASS (the hard surface mask). Uniform-over-
  // bbox sampling at DENSITY candidates/m² lands DENSITY blades/m² on whatever
  // subregion the mask accepts — so the verges read at an even density all the
  // way round the lap, with no camera bias (the old POV ramp left every pose
  // off the SW beach empty). Each accepted blade is binned into a spatial TILE
  // so we can distance-cull whole tiles cheaply.
  //
  // The island bbox comes from the (inset) outline; fall back to the prior SW
  // band only if a level somehow has no coast (defensive — buildGrass is
  // coast-only in practice).
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
  // candidates so that accepted ≈ area-on-grass × DENSITY; cap so a giant
  // island can't blow MAX_BLADES (the loop stops once it places MAX_BLADES).
  const candidates = Math.min(Math.ceil(bboxArea * DENSITY), MAX_BLADES * 6);

  // Accept candidates and compose each into a 16-float matrix, BINNED by tile.
  // We accumulate into per-tile growable Float32 chunks (no per-blade Matrix4
  // clone — at demo density that would be hundreds of thousands of throwaway
  // objects). The candidate index `i` is hash-scattered uniformly across the
  // bbox, so within any tile the instances arrive in spatially-random order —
  // which is exactly what the render-time LOD relies on: drawing the FIRST K
  // instances of a tile is then an even, uniform subsample of that tile.
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

    // HARD grass-only mask: zero blades off the island / on sand / gravel /
    // concrete / road / under a building / seaward of the SW dune lip.
    if (!isGrass(x, z, mask)) continue;

    // visual thinning near the SW dune lip: probability ramps down over the
    // last few metres of grass before the sand so the lawn fades in density too
    // (cosmetic — the hard sand rejection already keeps blades off the sand).
    // seawardDist returns -100 away from the lip, so this only bites near it.
    const sd = seawardDist(x, z, mask.lip);
    if (sd > -6) {
      const lipKeep = (0 - sd) / 6; // sd in [-6,0] -> 1..0
      if (hash01(i * 2.0 + 333.1) > lipKeep) continue;
    }

    // size: at demo density the field reads as a mat, so blades are SHORTER +
    // more varied than the old sparse pass (a dense field of tall blades turns
    // into a solid green wall). The demo tuft is ~0.7 m; ours jitter 0.45..1.0 m
    // and taper toward the SW sand. Width jitter keeps each tuft's silhouette
    // varied so the dense field shimmers instead of reading as one surface.
    const thin = Math.max(0, Math.min(1, (sd + 6) / 6)); // 0 inland -> 1 at lip
    const baseH = 0.45 + hash01(i * 3.0 + 7.1) * 0.55; // 0.45..1.0 m tall
    const h = baseH * (1 - thin * 0.45);
    const w = 0.75 + hash01(i * 3.0 + 51.9) * 0.6; // 0.75..1.35 width jitter
    s.set(w, h, 1);

    pos.set(x, 0, z);
    const yaw = hash01(i * 3.0 + 13.7) * Math.PI * 2;
    q.setFromAxisAngle(yAxis, yaw);
    m.compose(pos, q, s);

    // bin into its spatial tile (for the distance cull + LOD)
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

  // ── REALISE TILES ──────────────────────────────────────────────────────
  // one InstancedMesh per non-empty tile; each carries its own bounding sphere
  // so three's frustumCulled drops off-screen tiles, and we distance-cull +
  // distance-LOD whole tiles by their centre each frame. `full` caches the
  // tile's allocated instance count so the LOD can scale mesh.count off it.
  const tiles: GrassTile[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  for (const [, bin] of bins) {
    const n = bin.data.length / 16;
    if (n === 0) continue;
    const arr = new Float32Array(bin.data); // contiguous instance-matrix buffer
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.array.set(arr);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false; // self-shadowing thousands of blades is a perf trap
    mesh.receiveShadow = true;
    mesh.frustumCulled = true; // off-screen tiles skipped by three's frustum test
    mesh.name = 'cj-grass-blades';
    mesh.computeBoundingSphere(); // tight sphere -> accurate frustum cull
    mesh.count = n; // starts full; the render-time LOD scales this each frame
    scene.add(mesh);
    meshes.push(mesh);
    tiles.push({ mesh, cx: bin.sumX / n, cz: bin.sumZ / n, full: n });
  }

  const cullR2 = CULL_RADIUS * CULL_RADIUS;
  const fullR2 = FULL_RADIUS * FULL_RADIUS;
  // LOD ramps the drawn fraction from 1 at FULL_RADIUS down to MIN_LOD_FRAC at
  // CULL_RADIUS. Precompute the span so update() is a couple of mults per tile.
  const lodSpan = Math.max(1, CULL_RADIUS - FULL_RADIUS);
  const allocated = placed;
  let tilesDrawn = tiles.length; // tiles inside the cull radius last update

  return {
    meshes,
    update(dt, camPos) {
      uTime.value += dt;
      // DISTANCE CULL + LOD per tile. Pure visibility/count flip — pin-safe,
      // reads only the render-time camera position. (Frustum culling of
      // on-screen-but-off-frustum tiles is handled by three via frustumCulled.)
      //   * beyond CULL_RADIUS -> hidden (draws nothing).
      //   * within FULL_RADIUS -> full allocated density (the demo's ~3.1/m²,
      //     the lush near field the player sees in detail).
      //   * between the two -> mesh.count scaled by a fraction ramping 1 ->
      //     MIN_LOD_FRAC, so the mid/far field thins out smoothly and stays
      //     cheap. Drawing the FIRST K instances is an even subsample because
      //     placement order is hash-uniform within each tile.
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
          if (d2 <= fullR2) {
            t.mesh.count = t.full; // full demo density in the near field
          } else {
            const d = Math.sqrt(d2);
            // EASE-OUT falloff: frac = MIN + (1-MIN)*(1-td)². At td=0 (just past
            // FULL_RADIUS) frac=1; it drops FAST through the near-mid ring
            // (td=0.5 -> ~0.27) then flattens toward MIN_LOD_FRAC at the cull
            // edge. The fast early drop is what keeps the DRAWN instance budget
            // bounded while the near field stays at full demo density.
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
      // CINE-ONLY: the FAST density tier was removed (always-CINE game). The
      // field is always full density; this is a no-op kept so Game.ts's
      // grass?.setTier(...) call still type-checks.
      void _gfx;
    },
    setTimeOfDay(p) {
      uAmbient.value = p.ambient;
      // nudge the base toward the sky/sun tint so dusk warms and night cools
      const t = new THREE.Color(p.tint);
      uBaseColor.value.copy(BASE_COL).lerp(t, 0.12);
      uTipColor.value.copy(TIP_COL).lerp(t, 0.08);
    },
    stats() {
      return { allocated, tilesTotal: tiles.length, tilesDrawn };
    },
  };
}
