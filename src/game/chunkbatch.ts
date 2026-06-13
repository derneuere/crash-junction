import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ============================================================================
// REGION-CHUNKED STATIC-GEOMETRY BATCHER (perf-geo)
// ============================================================================
//
// The static ENVIRONMENT geometry in environment.ts — ground patches, building
// sidewalks, shortcut ribbons, coast skirts — was drawn as many separate
// meshes, one draw call each. Walls / kerbs / checkpoint posts / road markings
// were already instanced by a prior pass; the props by propinstancer.ts. This
// module collapses the REMAINING per-region static meshes into the minimum
// number of draws WITHOUT changing a pixel.
//
// ── WHY SPATIAL CHUNKING (the regression a prior naive pass hit) ──────────────
//   A single level-spanning batch (one merged mesh / one InstancedMesh for the
//   whole ~600 m island) DEFEATS three's frustum culling: its bounding sphere
//   wraps the entire level, so it counts as "on screen" from every angle and
//   three draws ALL of it every frame — and ×6 again through the player's live
//   cube reflection. That is MORE triangles, not fewer. So, exactly like
//   grass.ts / propinstancer.ts / the checkpoint-post bins, we bin members into
//   spatial TILES and emit ONE batched object PER tile. Each tile gets a tight
//   bounding sphere, so frustum culling drops the off-screen tiles and the
//   scene only pays for what is actually in view.
//
// ── FIDELITY (unchanged look) ────────────────────────────────────────────────
//   * mergeChunked merges geometries that SHARE A MATERIAL, per tile. Each
//     source geometry's own world transform is baked into the merged buffer
//     (applyMatrix4), so vertices land exactly where the unbatched mesh drew
//     them. The shared material instance is reused verbatim, so the daynight.ts
//     emissive sweep + any onBeforeCompile injection still reach it, and baked
//     vertex-colour / UV attributes ride through the merge untouched.
//   * instanceChunked emits one InstancedMesh per (geometry+material, tile) for
//     repeated identical geometry. Same shared geometry + material, same
//     cast/receive-shadow flags.
//   Both leave frustumCulled ON and compute a tight per-tile bounding sphere.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//   PURE PRESENTATION. Build-time only; reads no sim state, RNG or camera.
//   Adds render objects to the scene; the colliders (cannon bodies) are built
//   separately in environment.ts and are NOT touched here. Replay pins can't
//   see it.
// ============================================================================

/** Spatial tile size (m). Matches the prop batcher's 40 m grid: coarse enough
 *  that per-tile overhead is trivial, fine enough that each tile's bounding
 *  sphere is local so frustum culling drops off-screen tiles. Static
 *  environment features (patches, skirts) are sparse, like props. */
export const CHUNK_SIZE = 40;

/** A geometry to be merged, with the WORLD transform to bake into it and the
 *  point used to assign its spatial tile. */
export interface ChunkMergeItem {
  geometry: THREE.BufferGeometry;
  /** world matrix to bake into the geometry (identity if already world-space). */
  matrix?: THREE.Matrix4;
  /** tile-assignment point (world metres) — usually the feature's centroid. */
  x: number;
  z: number;
}

/** Merge a set of one-off geometries that SHARE a material into the fewest
 *  draws: one merged mesh per spatial tile. Each item's matrix is baked into a
 *  CLONE of its geometry (the source geometry is left intact for any other
 *  user). frustumCulled stays on; a tight per-tile bounding sphere is computed
 *  from the merged buffer so off-screen tiles are dropped.
 *
 *  Returns the meshes added to the scene (caller adds them) — or the caller can
 *  pass `scene` to have them added directly.
 *
 *  @param castShadow / receiveShadow applied to every emitted mesh (the source
 *         patches/skirts set receiveShadow=true, castShadow=false by default).
 */
export function mergeChunked(
  scene: THREE.Scene,
  items: ChunkMergeItem[],
  material: THREE.Material,
  opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string; chunkSize?: number } = {},
): void {
  if (!items.length) return;
  const cs = opts.chunkSize ?? CHUNK_SIZE;
  const tiles = new Map<string, ChunkMergeItem[]>();
  for (const it of items) {
    const tk = `${Math.floor(it.x / cs)},${Math.floor(it.z / cs)}`;
    let bucket = tiles.get(tk);
    if (!bucket) tiles.set(tk, (bucket = []));
    bucket.push(it);
  }
  for (const bucket of tiles.values()) {
    const geos: THREE.BufferGeometry[] = [];
    for (const it of bucket) {
      // clone so baking the world matrix never mutates a source geometry that
      // some other mesh might still reference; mergeGeometries needs matching
      // attribute sets, which clones of the same builder trivially satisfy.
      const g = it.geometry.clone();
      if (it.matrix) g.applyMatrix4(it.matrix);
      // a merge requires every geometry to be non-indexed-consistent and carry
      // the same attributes; drop any stray attributes the material ignores so
      // a patch (uv) and a skirt (uv+color) never get mixed in one tile — the
      // caller groups by material, and same-material features share attributes.
      geos.push(g);
    }
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) {
      // mismatched attribute sets within a tile (shouldn't happen — same
      // material implies same builder) — fall back to one mesh per item so we
      // never silently drop geometry.
      for (const g of geos) {
        const m = new THREE.Mesh(g, material);
        m.castShadow = !!opts.castShadow;
        m.receiveShadow = opts.receiveShadow ?? true;
        m.frustumCulled = true;
        if (opts.name) m.name = opts.name;
        scene.add(m);
      }
      continue;
    }
    // free the per-item clones we merged (merge copied their data out)
    if (geos.length > 1) for (const g of geos) g.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = !!opts.castShadow;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    mesh.frustumCulled = true; // tight per-tile sphere -> off-screen tiles culled
    if (opts.name) mesh.name = opts.name;
    scene.add(mesh);
  }
}

/** One repeated-geometry instance: the world matrix it renders at and the point
 *  used to assign its spatial tile. */
export interface ChunkInstanceItem {
  matrix: THREE.Matrix4;
  x: number;
  z: number;
}

/** Emit repeated identical geometry as one InstancedMesh per spatial tile (so
 *  frustum culling still drops off-screen tiles). The geometry + material are
 *  shared verbatim, so the daynight sweep and baked attributes carry through.
 *  A tile with a single member becomes a plain matrix-baked Mesh (an
 *  InstancedMesh of one is the same one draw with extra machinery for nothing).
 */
export function instanceChunked(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  items: ChunkInstanceItem[],
  opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string; chunkSize?: number } = {},
): void {
  if (!items.length) return;
  const cs = opts.chunkSize ?? CHUNK_SIZE;
  const tiles = new Map<string, ChunkInstanceItem[]>();
  for (const it of items) {
    const tk = `${Math.floor(it.x / cs)},${Math.floor(it.z / cs)}`;
    let bucket = tiles.get(tk);
    if (!bucket) tiles.set(tk, (bucket = []));
    bucket.push(it);
  }
  for (const bucket of tiles.values()) {
    if (bucket.length === 1) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(bucket[0].matrix);
      mesh.castShadow = !!opts.castShadow;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      mesh.frustumCulled = true;
      if (opts.name) mesh.name = opts.name;
      scene.add(mesh);
      continue;
    }
    const inst = new THREE.InstancedMesh(geometry, material, bucket.length);
    inst.castShadow = !!opts.castShadow;
    inst.receiveShadow = opts.receiveShadow ?? true;
    inst.frustumCulled = true;
    if (opts.name) inst.name = opts.name;
    for (let i = 0; i < bucket.length; i++) inst.setMatrixAt(i, bucket[i].matrix);
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere(); // tight per-tile sphere -> off-screen tiles culled
    scene.add(inst);
  }
}
