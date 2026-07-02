// ============================================================================
// GRASS — buildGrass(): deterministic placement + per-tile InstancedMeshes +
// the render-time distance-cull / LOD / count update.
// ============================================================================
//
// PIN-SAFE / VISUAL ONLY: clumps are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (update(dt)
// only writes a float uniform). Distance culling reads the RENDER-time camera
// position (passed into update) and only flips per-tile mesh visibility / count
// / LOD — it never touches sim state, RNG, or the world hash.
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

import * as THREE from 'three';
import { hash01 } from '../textures';
import type { LevelDef } from '../types';
import {
  DENSITY,
  MAX_BLADES,
  CULL_RADIUS,
  FULL_RADIUS,
  MIN_LOD_FRAC,
  LOD0_RADIUS,
  LOD1_RADIUS,
  TILE_SIZE,
  HEIGHT_MIN,
  HEIGHT_MAX,
  WIDTH_MIN,
  WIDTH_MAX,
} from './config';
import { buildSurfaceMask, isGrass, seawardDist } from './surfaceMask';
import { type GrassLODs, loadGrassAssets, makeFallbackGeometry } from './assets';
import { makeGrassMaterial } from './material';
import type { GrassField, GrassTile } from './types';

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
  const matH = makeGrassMaterial();
  const mat = matH.mat;
  const { uTime, uAmbient, uBaseColor, uTip1Color, uTip2Color, uAlphaTex, uNoiseTex, uHasTex } = matH;
  const { BASE_COL, TIP1_COL, TIP2_COL } = matH;

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

  // LOD ring radii, scalable by the quality tier (gfx.grassRange): the phone
  // tier pulls the lush band and the cull-off much closer for the same look
  // from the low chase cam. Presentation-only, recomputed on the rare change.
  let cullR2 = CULL_RADIUS * CULL_RADIUS;
  let fullR2 = FULL_RADIUS * FULL_RADIUS;
  let lod0R2 = LOD0_RADIUS * LOD0_RADIUS;
  let lod1R2 = LOD1_RADIUS * LOD1_RADIUS;
  let fullRadius = FULL_RADIUS;
  let lodSpan = Math.max(1, CULL_RADIUS - FULL_RADIUS);
  let rangeScale = 1;
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
            const td = (d - fullRadius) / lodSpan; // 0..1
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
    setRangeScale(s) {
      const k = Math.min(1, Math.max(0.2, s));
      if (k === rangeScale) return;
      rangeScale = k;
      fullRadius = FULL_RADIUS * k;
      cullR2 = CULL_RADIUS * k * (CULL_RADIUS * k);
      fullR2 = fullRadius * fullRadius;
      lod0R2 = LOD0_RADIUS * k * (LOD0_RADIUS * k);
      lod1R2 = LOD1_RADIUS * k * (LOD1_RADIUS * k);
      lodSpan = Math.max(1, CULL_RADIUS * k - fullRadius);
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
