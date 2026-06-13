import * as THREE from 'three';

// ============================================================================
// STATIC-PROP DRAW-CALL BATCHER (perf-drawcalls)
// ============================================================================
//
// The dockyard dresses GANTRY POINT with ~300 hand-placed props — shipping
// containers, cranes, warehouses, bollards, lamps, barriers, rocks, trees.
// Each prop is a cloned GLB *group* and every sub-mesh inside it was its own
// draw call: ~388 scene draws at the dockyard pose. That cost then MULTIPLIES
// ×6 through the player's live cube reflection (reflections.ts re-renders the
// whole scene into six cube faces), so the port is the engine's worst case.
//
// This module COLLAPSES the identical, repeated prop geometry into instanced
// draws WITHOUT changing a single pixel of the scene: same props, same
// positions, same materials, same AO, same shadows, same night lights. Only
// the batching changes — geometry that was drawn N times in N calls is drawn
// once with N instance matrices.
//
// ── WHY SPATIAL CHUNKING (the lesson a prior naive pass learned the hard way) ─
//   A single level-spanning InstancedMesh DEFEATS three's frustum culling: its
//   bounding sphere wraps the whole 200 m port, so it is "on screen" from every
//   angle and three draws ALL of its instances every frame — even the ones
//   behind the camera. That is MORE triangles, not fewer. So, exactly like
//   grass.ts, we bin instances into spatial TILES and emit ONE InstancedMesh
//   PER (geometry+material, tile). Each tile gets a tight bounding sphere, so
//   three's own frustum test drops the off-screen tiles and the dockyard only
//   pays for the stacks actually in view (and the cube faces likewise).
//
// ── WHAT'S PRESERVED (fidelity contract) ─────────────────────────────────────
//   * GEOMETRY: clone(true) shares the cached template geometry across every
//     placed instance, so same-URL/same-submesh props already share a geometry
//     UUID. We bake each sub-mesh's LOCAL node transform into the instance
//     matrix (instanceM = propWorldMatrix · submeshLocalMatrix), so a GLB whose
//     mesh sits off its node origin lands exactly where it did unbatched.
//   * MATERIAL: the instance reuses the prop's SHARED base material verbatim —
//     including the AO shader patch (ao.ts patches the material) and the
//     userData.night emissive tag (daynight.ts sweeps materials via a scene
//     traverse, which still reaches an InstancedMesh's shared material). TINT is
//     no longer a material clone: it rides as the instance's per-instance colour
//     (InstancedMesh.instanceColor), which three multiplies into the diffuse
//     exactly as the old clone multiplied the material colour. So every
//     same-geometry prop — EVERY tint — collapses into one instanced draw per
//     region, and the look is byte-identical. Glass/window sub-meshes and
//     untinted props carry a white (identity) instance colour.
//   * AO: the baked self-occlusion lives in the geometry's `aoVert` attribute
//     (set once on the shared template) and is read by the patched material;
//     instancing carries both through untouched.
//   * SHADOWS: each InstancedMesh sets castShadow/receiveShadow exactly as the
//     source meshes did, so the shadow pass batches the same way.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//   PURE PRESENTATION. This only ever runs on the VISUAL meshes — the prop
//   COLLIDER bodies are built synchronously in props.ts and never touched here.
//   Nothing in this file reads sim state, RNG or the camera transform; it adds
//   render objects to the scene after the GLBs stream in. Replay pins can't
//   see it.
// ============================================================================

/** Spatial tile size (m). The dockyard spans ~210 m in x and ~240 m in z; a
 *  40 m tile gives a coarse grid whose per-tile overhead is trivial while each
 *  tile's bounding sphere is still tight enough that frustum culling drops the
 *  off-screen stacks. Sized a touch larger than grass's 32 m because props are
 *  far sparser than blades — a smaller tile would just fragment instance runs. */
const TILE_SIZE = 40;

/** A geometry+material run only becomes an InstancedMesh once it has at least
 *  this many members IN A TILE. A lone mesh stays a plain Mesh (an InstancedMesh
 *  of one is the same one draw, with extra per-instance machinery for nothing).
 *  2 means "the moment a tile repeats a prop sub-mesh, batch it". */
const MIN_INSTANCES = 2;

const WHITE = new THREE.Color(0xffffff);

/** One collected sub-mesh of a loaded prop: its shared geometry + material and
 *  the WORLD matrix it should render at (group transform already folded in),
 *  plus the per-instance tint colour (identity white when the prop is untinted
 *  or the sub-mesh is glass/transparent). */
interface Collected {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
  color: THREE.Color;
  castShadow: boolean;
  receiveShadow: boolean;
  /** placement, for the spatial bin (the instance's world translation) */
  x: number;
  z: number;
}

/**
 * Collects the visual sub-meshes of loaded props and, on flush(), emits the
 * minimum number of draw objects: per-(geometry+material) InstancedMeshes
 * binned into spatial tiles, plus plain Meshes for the singletons. The caller
 * adds nothing to the scene itself — collect() takes a fully positioned prop
 * instance (already `updateMatrixWorld`'d) and flush() adds the batched result.
 */
/** A multi-material mesh we keep whole (instanceColor can't tint per-slot).
 *  Re-emitted as a plain, matrix-baked Mesh — there are only a handful. */
interface PlainMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
}

export class PropInstancer {
  private items: Collected[] = [];
  private plains: PlainMesh[] = [];

  constructor(private scene: THREE.Scene) {}

  /** Harvest one positioned prop instance (a cloned, transformed GLB/builtin
   *  group). Reads each mesh's world matrix — the caller MUST have set the
   *  group's transform and called updateMatrixWorld(true) first. The source
   *  group is NOT added to the scene; its meshes are re-emitted batched.
   *
   *  @param tint optional multiply-tint (a hex colour). Applied as the
   *         instance's per-instance colour on opaque sub-meshes; glass/window
   *         and transparent sub-meshes keep white (the old applyTint skip-rule).
   */
  collect(root: THREE.Object3D, tint?: number): void {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // a multi-material mesh can't carry a single instanceColor cleanly, so it
      // is kept WHOLE as a plain matrix-baked mesh (not instanced). If tinted,
      // its materials are cloned + multiplied (the old applyTint semantics,
      // glass skipped) so the look is preserved. These are rare (a handful of
      // kit pieces); the common props (containers, rocks, crates, builtins) are
      // single-material and take the instanced path below.
      if (mats.length !== 1) {
        const finalMats =
          tint === undefined ? (mesh.material as THREE.Material | THREE.Material[]) : mats.map((m) => tintClone(m, tint));
        this.plains.push({
          geometry: mesh.geometry,
          material: finalMats,
          matrix: mesh.matrixWorld.clone(),
          castShadow: mesh.castShadow,
          receiveShadow: mesh.receiveShadow,
        });
        return;
      }
      const mat = mats[0];
      // glass/window/transparent sub-meshes keep their look (no tint), exactly
      // as the old applyTint skipped them.
      const skipTint = tint === undefined || mat.transparent || /glass|window/i.test(mat.name);
      this.items.push({
        geometry: mesh.geometry,
        material: mat,
        matrix: mesh.matrixWorld.clone(),
        color: skipTint ? WHITE : new THREE.Color(tint),
        castShadow: mesh.castShadow,
        receiveShadow: mesh.receiveShadow,
        x: mesh.matrixWorld.elements[12],
        z: mesh.matrixWorld.elements[14],
      });
    });
  }

  /** Build the batched scene objects from everything collected so far and add
   *  them to the scene. Call once per level build, after the props resolve. */
  flush(): void {
    // multi-material leftovers: kept whole as plain matrix-baked meshes.
    for (const p of this.plains) {
      const mesh = new THREE.Mesh(p.geometry, p.material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(p.matrix);
      mesh.castShadow = p.castShadow;
      mesh.receiveShadow = p.receiveShadow;
      mesh.frustumCulled = true;
      this.scene.add(mesh);
    }
    this.plains.length = 0;

    if (!this.items.length) return;

    // group by (geometry, BASE material) identity — same template geometry AND
    // same shared material. Tint is NOT part of the key (it rides as the
    // per-instance colour), so every tint of a given container collapses into
    // one run; only genuinely different materials (a different prop, a glass
    // sub-mesh) split.
    const groups = new Map<string, Collected[]>();
    const geoId = new Map<THREE.BufferGeometry, number>();
    const matId = new Map<THREE.Material, number>();
    const idOf = <T>(m: Map<T, number>, k: T): number => {
      let id = m.get(k);
      if (id === undefined) {
        id = m.size;
        m.set(k, id);
      }
      return id;
    };
    for (const it of this.items) {
      const key = `${idOf(geoId, it.geometry)}:${idOf(matId, it.material)}`;
      let arr = groups.get(key);
      if (!arr) groups.set(key, (arr = []));
      arr.push(it);
    }

    const m4 = new THREE.Matrix4();
    for (const members of groups.values()) {
      // bin this geometry+material run into spatial tiles
      const tiles = new Map<string, Collected[]>();
      for (const it of members) {
        const tc = Math.floor(it.x / TILE_SIZE);
        const tr = Math.floor(it.z / TILE_SIZE);
        const tk = `${tc},${tr}`;
        let bucket = tiles.get(tk);
        if (!bucket) tiles.set(tk, (bucket = []));
        bucket.push(it);
      }

      for (const bucket of tiles.values()) {
        if (bucket.length < MIN_INSTANCES) {
          // singleton in this tile: a plain mesh baked to its world matrix is
          // one draw with no instancing overhead. Reuses the SHARED geometry +
          // material (no memory cost); a tint is applied by cloning the one
          // material so the singleton's look matches its instanced siblings.
          for (const it of bucket) {
            const mat = it.color.equals(WHITE) ? it.material : tintClone(it.material, it.color.getHex());
            const mesh = new THREE.Mesh(it.geometry, mat);
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(it.matrix);
            mesh.castShadow = it.castShadow;
            mesh.receiveShadow = it.receiveShadow;
            mesh.frustumCulled = true;
            this.scene.add(mesh);
          }
          continue;
        }
        const first = bucket[0];
        const inst = new THREE.InstancedMesh(first.geometry, first.material, bucket.length);
        inst.castShadow = first.castShadow;
        inst.receiveShadow = first.receiveShadow;
        inst.frustumCulled = true; // tight per-tile sphere -> off-screen tiles culled
        inst.name = 'cj-prop-batch';
        for (let i = 0; i < bucket.length; i++) {
          m4.copy(bucket[i].matrix);
          inst.setMatrixAt(i, m4);
          // per-instance tint: three multiplies diffuse by this exactly as the
          // old per-prop material clone multiplied material.color. White =
          // untinted/glass = no change.
          inst.setColorAt(i, bucket[i].color);
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        // a per-tile bounding sphere from the instance matrices is what makes
        // frustum culling drop the stacks behind the camera (the whole point of
        // the spatial chunking) instead of drawing the level-wide batch always.
        inst.computeBoundingSphere();
        this.scene.add(inst);
      }
    }

    this.items.length = 0;
  }
}

/** Clone a material and multiply its base colour by a hex tint (the old
 *  applyTint semantics). Used only for the rare singleton/multi-material cases;
 *  the instanced common case carries tint as a per-instance colour instead. */
function tintClone(m: THREE.Material, tint: number): THREE.Material {
  if (m.transparent || /glass|window/i.test(m.name)) return m;
  const c = m.clone(); // deep-copies userData, so night tags survive
  (c as THREE.MeshStandardMaterial).color?.multiply(new THREE.Color(tint));
  return c;
}
