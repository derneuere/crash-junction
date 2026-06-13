import * as THREE from 'three';
import { hash01 } from './textures';
import type { LevelDef, GroundPatchDef } from './types';

// ============================================================================
// INSTANCED 3D-BLADE GRASS — the beach-approach dune lip (GANTRY POINT).
// ============================================================================
//
// Round-2 upgrade of the round-1 grass: the textured island-grass ground +
// the alpha-tongue dune fringe (both in environment.ts) stay as the BASE; this
// module AUGMENTS them with a field of real 3D blades that sit ON the grass and
// sway in the wind. Blades are placed ONLY where the ground is genuinely grass
// and the far field is distance-culled so it costs ~nothing.
//
// TECHNIQUE — adapted from FluffyGrass by Ebenezer (MIT):
//   https://github.com/thebenezer/FluffyGrass
//   The blade approach, the vertex-shader wind sway (a noise-perturbed sine
//   that scales by (1 - uv.y) so the base stays planted while the tip whips),
//   and the base->tip colour gradient are adapted from that project's
//   GrassMaterial.ts. We do NOT port its code verbatim: the blade geometry is
//   built procedurally here (FluffyGrass loads a GLB LOD), placement is a
//   bounded deterministic-hash scatter (FluffyGrass uses MeshSurfaceSampler),
//   and the material is grafted onto MeshStandardMaterial (FluffyGrass uses
//   Lambert) so the blades catch this engine's PMREM sky env + fog + shadows.
//   MIT requires keeping the copyright/attribution — see this comment + the
//   art-grass report. License text: _ref/FluffyGrass/LICENSE (not committed).
//
// PIN-SAFE / VISUAL ONLY: blades are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (update(dt)
// only writes a float uniform). Distance culling reads the RENDER-time camera
// position (passed into update) and only flips per-tile mesh visibility — it
// never touches sim state, RNG, or the world hash. Nothing here enters the
// world hash.
//
// ── GRASS-ONLY PLACEMENT (the fix) ──────────────────────────────────────────
//   The round-1 band spilled blades onto the dry-SAND apron and across the
//   BEACH RUN dirt ribbon (and a corner of the road). We now build a HARD mask
//   from the LEVEL'S OWN surface geometry (read-only — we never edit the level)
//   and REJECT every candidate that is not on real grass:
//     * inside the 'sand' patch polygon  -> the dry apron (reject)
//     * inside the 'gravel' patch polygon -> the motel lot (reject)
//     * seaward of the 'drygrass' band's seaward edge -> sand (reject); the
//       drygrass band itself is drying-but-real grass, so blades may live up
//       to its seaward lip but never past it (this IS the dune lip, derived
//       from data instead of a hand-typed polyline)
//     * within (half-width + margin) of the MAIN race ribbon centreline (the
//       road) or of any SHORTCUT ribbon centreline (the BEACH RUN dirt cut
//       slices straight through the band) -> on/near road (reject)
//   The mask is a hard accept/reject, not a probability ramp, so ZERO blades
//   sit on sand, gravel, or road.
//
// ── DISTANCE CULLING (the other fix) ────────────────────────────────────────
//   The band is partitioned into a grid of TILES; each non-empty tile is its
//   own InstancedMesh with its own bounding sphere. update(dt, camPos) hides a
//   whole tile when its centre is beyond CULL_RADIUS from the camera, so the
//   far field draws nothing. three's own frustumCulled (left on per tile) drops
//   off-screen tiles too. The far field costs ~one cheap distance check / tile.
//
//   * ONE InstancedMesh PER TILE = one draw call per VISIBLE tile (off-screen /
//     far tiles issue none). Wind is entirely in the vertex shader (zero CPU
//     per blade per frame); placement is build-time only.
//   * TIER GATE: CINE gets the full per-tile blade budget; FAST gets a sparse
//     subset (each tile's count scaled by BUDGET.fast/BUDGET.cine) so the cheap
//     tier leans on the textured-ground fallback. setTier() just flips each
//     tile's InstancedMesh.count — no re-alloc, no re-place.
// ============================================================================

/** Bounded grass band on the SW dune approach (world metres). Sized to the
 *  locked grass-sand pose: foreground green lawn on the LEFT thinning through
 *  the drygrass dune band into the dry-sand apron. We only scatter blades that
 *  land in this rectangle AND pass the grass-only mask below. */
const BAND = { minX: -262, maxX: -150, minZ: -240, maxZ: -86 } as const;

/** Per-tier instance budgets. CINE is the cinematic look; FAST stays sparse so
 *  the textured ground carries the cheap tier. Total allocated = cine. */
const BUDGET = { cine: 24000, fast: 5000 } as const;

/** Camera anchor of the locked grass-sand pose — placement biases density
 *  toward here so the foreground (what the shot frames) is lush and the far
 *  reaches of the band stay sparse. Visual bias only, not the real camera. */
const POV = new THREE.Vector3(-198, 8, -120);

/** Distance-cull radius (m): a tile whose centre is farther than this from the
 *  live camera is hidden. Sized generously past the framed foreground so the
 *  near field always reads lush, while the far half of the band drops out. */
const CULL_RADIUS = 150;

/** Spatial tile size (m) for the culling grid. The band is ~112 x 154 m, so a
 *  28 m tile yields a 4 x 6 grid — coarse enough that the per-tile overhead is
 *  trivial, fine enough that culling and three's frustum test are meaningful. */
const TILE_SIZE = 28;

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

/** The grass-only mask, built once from the level's surface geometry. */
interface SurfaceMask {
  /** Polygons that are NOT grass (sand apron, gravel lot) — reject if inside. */
  rejectPolys: GroundPatchDef['poly'][];
  /** The drygrass band's SEAWARD edge polyline = the real dune lip. Anything
   *  on the seaward side of this is sand; null if the band can't be found. */
  lip: { seaward: [number, number][]; sandInsideSign: number } | null;
  /** Road/ribbon keep-outs (main loop + shortcuts). */
  roads: RoadMask[];
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
 *  level data (patches + race ribbon + shortcuts) but never mutate it. */
function buildSurfaceMask(level: LevelDef): SurfaceMask {
  const patches = level.patches ?? [];
  // sand apron + gravel motel lot in the SW beach quadrant = NOT grass.
  const rejectPolys: GroundPatchDef['poly'][] = patches
    .filter(
      (p) =>
        (p.kind === 'sand' || p.kind === 'gravel') &&
        p.poly.every(([x, z]) => x <= -60 && z <= -40),
    )
    .map((p) => p.poly);

  const lip = findDuneLip(patches);

  const roads: RoadMask[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    // MAIN loop centreline (closed) — half-width + a margin so blades never
    // touch the ribbon edge or its kerb. Only the SW arc nears the band, but
    // masking the whole loop is cheap and robust to waypoint tweaks.
    const mainPts: [number, number][] = race.sections.map((s) => [s.x, s.z]);
    if (mainPts.length > 1) {
      mainPts.push([mainPts[0][0], mainPts[0][1]]); // close the loop
      const r = race.width / 2 + 3; // 11 + 3 m clearance
      roads.push({ pts: mainPts, radiusSq: r * r });
    }
    // SHORTCUT ribbons (BEACH RUN dirt cut slices through the band).
    for (const sc of race.shortcuts ?? []) {
      const pts: [number, number][] = sc.waypoints.map((w) => [w[0], w[1]]);
      if (pts.length > 1) {
        const r = sc.width / 2 + 2.5; // 6 + 2.5 m clearance for BEACH RUN
        roads.push({ pts, radiusSq: r * r });
      }
    }
  }

  return { rejectPolys, lip, roads };
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

/** True iff (x,z) is on genuine grass: not in a non-grass polygon, not seaward
 *  of the dune lip, not on/near a road or shortcut ribbon. HARD mask. */
function isGrass(x: number, z: number, mask: SurfaceMask): boolean {
  for (const poly of mask.rejectPolys) if (pointInPoly(x, z, poly)) return false;
  // seaward of the dune lip = sand (belt-and-suspenders with the sand polygon)
  if (mask.lip && seawardDist(x, z, mask.lip) > 0) return false;
  for (const road of mask.roads) if (distToPolylineSq(x, z, road.pts) < road.radiusSq) return false;
  return true;
}

/** Build ONE tapered grass blade as a thin vertical strip. uv.y runs 0 at the
 *  base (planted) -> 1 at the tip (where the wind sway is full and the colour
 *  is lightest). A handful of height segments keeps the wind bend smooth. The
 *  blade narrows to a point so the silhouette reads as grass, not a quad. */
function makeBladeGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 4;
  const HEIGHT = 1; // unit blade; per-instance scale sizes it in metres
  const HALF_W = 0.07; // base half-width (m at unit scale) — fuller silhouette
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= SEGMENTS; s++) {
    const v = s / SEGMENTS;
    const y = v * HEIGHT;
    // taper to a point; a gentle curve keeps a little width up high so mid
    // blade isn't a needle, then pinches at the very tip
    const w = HALF_W * (1 - v) * (1 - v * 0.25);
    // left, right
    pos.push(-w, y, 0, w, y, 0);
    uv.push(0, v, 1, v);
    // face the +z hemisphere; the wind/lighting shader will treat both sides
    nrm.push(0, 0, 1, 0, 0, 1);
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
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
 *  culls far tiles; setTier() flips the CINE/FAST blade count; setTimeOfDay()
 *  tunes the lit base colour. */
export interface GrassField {
  /** All per-tile instanced meshes (one draw call each when visible). */
  meshes: THREE.InstancedMesh[];
  /** @param dtSeconds elapsed RENDER time since last frame (seconds)
   *  @param camPos live camera world position for distance culling (optional;
   *         omit to leave every tile drawn) */
  update(dtSeconds: number, camPos?: THREE.Vector3): void;
  /** CINE = full budget, FAST = sparse subset. Visual only. */
  setTier(gfx: 'cine' | 'fast'): void;
  /** Re-tint the blades' lit response to match the time-of-day sky. */
  setTimeOfDay(p: GrassPalette): void;
}

/** Per-time-of-day look fed from Game (mirrors the Sea palette pattern). */
export interface GrassPalette {
  /** overall light level on the blades: ~1 day, ~0.85 dusk, ~0.4 night */
  ambient: number;
  /** warm/cool ground tint pushed into the base colour (sun/sky colour) */
  tint: number;
}

/** One spatial tile of the band: an InstancedMesh + its world-space centre,
 *  for the distance cull. cineCount/fastCount are its per-tier blade counts. */
interface GrassTile {
  mesh: THREE.InstancedMesh;
  cx: number;
  cz: number;
  cineCount: number;
  fastCount: number;
}

/**
 * Build the instanced blade field for the SW dune approach and add it to
 * `scene`. The caller only invokes this on coast levels (the band is
 * GANTRY-specific); inland levels get no grass field.
 *
 * @param scene the world scene (its PMREM environment lights the blades)
 * @param level the level def — READ (never mutated) for its surface geometry
 *        so blades land only on real grass, off the sand/gravel/road.
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
  // Walk the bounded band, scatter candidate blades, keep the ones that land on
  // GENUINE GRASS (the hard surface mask). Each accepted blade is binned into a
  // spatial TILE so we can distance-cull whole tiles cheaply. Density still
  // biases denser toward the POV (foreground lush, background sparse) and the
  // blades shrink approaching the lip so the lawn thins out rather than ending
  // at a hard edge.
  const tileBlades = new Map<string, THREE.Matrix4[]>();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const pos = new THREE.Vector3();
  let placed = 0;
  const cols = Math.max(1, Math.ceil((BAND.maxX - BAND.minX) / TILE_SIZE));
  // oversample the band, accept by probability AND the hard grass mask
  for (let i = 0; placed < BUDGET.cine && i < BUDGET.cine * 6; i++) {
    const rx = hash01(i * 2.0 + 11.3);
    const rz = hash01(i * 2.0 + 91.7);
    const x = BAND.minX + rx * (BAND.maxX - BAND.minX);
    const z = BAND.minZ + rz * (BAND.maxZ - BAND.minZ);

    // HARD grass-only mask: zero blades on sand / gravel / road / past the lip.
    if (!isGrass(x, z, mask)) continue;

    // visual thinning near the lip: probability ramps down over the last few
    // metres of grass before the sand so the lawn fades in density too (this
    // is cosmetic — the hard sand rejection already keeps blades off the sand).
    const sd = seawardDist(x, z, mask.lip);
    const lipKeep = sd < -6 ? 1 : (0 - sd) / 6; // sd in [-6,0] -> 1..0

    // POV falloff: lush within ~60 m of the framed foreground, sparse past
    // ~130 m, so the band's far end barely seeds blades.
    const dPov = Math.hypot(x - POV.x, z - POV.z);
    const povKeep = dPov < 60 ? 1 : dPov > 130 ? 0.12 : 1 - ((dPov - 60) / 70) * 0.88;

    const keep = lipKeep * povKeep;
    if (hash01(i * 2.0 + 333.1) > keep) continue;

    // size: taller/lusher inland, shrinking as it nears the sand so the
    // transition reads as the lawn thinning out, not a hard edge
    const thin = Math.max(0, Math.min(1, (sd + 6) / 6)); // 0 inland -> 1 at lip
    const baseH = 0.55 + hash01(i * 3.0 + 7.1) * 0.7; // 0.55..1.25 m tall
    const h = baseH * (1 - thin * 0.5);
    const w = 0.8 + hash01(i * 3.0 + 51.9) * 0.6; // width jitter
    s.set(w, h, 1);

    pos.set(x, 0, z);
    const yaw = hash01(i * 3.0 + 13.7) * Math.PI * 2;
    q.setFromAxisAngle(yAxis, yaw);
    m.compose(pos, q, s);

    // bin into its spatial tile (for the distance cull)
    const tcol = Math.min(cols - 1, Math.floor((x - BAND.minX) / TILE_SIZE));
    const trow = Math.floor((z - BAND.minZ) / TILE_SIZE);
    const key = `${tcol},${trow}`;
    let bucket = tileBlades.get(key);
    if (!bucket) {
      bucket = [];
      tileBlades.set(key, bucket);
    }
    bucket.push(m.clone());
    placed++;
  }

  // ── REALISE TILES ──────────────────────────────────────────────────────
  // one InstancedMesh per non-empty tile; each carries its own bounding sphere
  // so three's frustumCulled drops off-screen tiles, and we distance-cull whole
  // tiles by their centre each frame. FAST budget is a per-tile prefix of the
  // (hash-interleaved, well-spread) instance list — no separate placement pass.
  const fastFrac = Math.min(1, BUDGET.fast / Math.max(1, placed));
  const tiles: GrassTile[] = [];
  const meshes: THREE.InstancedMesh[] = [];
  for (const [, bucket] of tileBlades) {
    const n = bucket.length;
    if (n === 0) continue;
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.castShadow = false; // self-shadowing thousands of blades is a perf trap
    mesh.receiveShadow = true;
    mesh.frustumCulled = true; // off-screen tiles skipped by three's frustum test
    mesh.name = 'cj-grass-blades';
    let sumX = 0;
    let sumZ = 0;
    for (let k = 0; k < n; k++) {
      mesh.setMatrixAt(k, bucket[k]);
      sumX += bucket[k].elements[12];
      sumZ += bucket[k].elements[14];
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere(); // tight sphere -> accurate frustum cull
    const cineCount = n;
    const fastCount = Math.max(1, Math.round(n * fastFrac));
    mesh.count = cineCount;
    scene.add(mesh);
    meshes.push(mesh);
    tiles.push({ mesh, cx: sumX / n, cz: sumZ / n, cineCount, fastCount });
  }

  let currentTier: 'cine' | 'fast' = 'cine';
  const cullR2 = CULL_RADIUS * CULL_RADIUS;

  return {
    meshes,
    update(dt, camPos) {
      uTime.value += dt;
      // distance-cull whole tiles: hide any tile whose centre is beyond the
      // cull radius from the live camera. Pure visibility flip — pin-safe,
      // reads only the render-time camera position. (Frustum culling of
      // on-screen-but-off-frustum tiles is handled by three via frustumCulled.)
      if (camPos) {
        for (const t of tiles) {
          const dx = t.cx - camPos.x;
          const dz = t.cz - camPos.z;
          t.mesh.visible = dx * dx + dz * dz <= cullR2;
        }
      } else {
        for (const t of tiles) t.mesh.visible = true;
      }
    },
    setTier(gfx) {
      currentTier = gfx;
      for (const t of tiles) t.mesh.count = gfx === 'fast' ? t.fastCount : t.cineCount;
    },
    setTimeOfDay(p) {
      uAmbient.value = p.ambient;
      // nudge the base toward the sky/sun tint so dusk warms and night cools
      const t = new THREE.Color(p.tint);
      uBaseColor.value.copy(BASE_COL).lerp(t, 0.12);
      uTipColor.value.copy(TIP_COL).lerp(t, 0.08);
      void currentTier;
    },
  };
}
