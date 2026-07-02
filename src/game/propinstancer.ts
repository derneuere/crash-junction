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
//   grass.ts, we bin REPEATED-geometry instances into spatial TILES and emit ONE
//   InstancedMesh PER (geometry+material, tile). Each tile gets a tight bounding
//   sphere, so three's own frustum test drops the off-screen tiles and the
//   dockyard only pays for the stacks actually in view (and the cube faces
//   likewise).
//
// ── THE SINGLETON TAIL → ONE THREE.BatchedMesh PER MATERIAL (perf-batching) ───
//   The InstancedMesh path only collapses geometry that REPEATS within a tile.
//   The dockyard is dressed with hundreds of DIFFERENT-shape prototypes (cranes,
//   silos, chimneys, warehouses, …) that are each unique within their tile, so
//   they fell through to plain singleton Meshes — ~828 of them, one draw call
//   each. THREE.BatchedMesh (three r166+/0.170) packs MANY different geometries
//   that SHARE ONE material into a SINGLE draw, keeping a per-geometry bounding
//   volume and doing its OWN per-object frustum cull + depth sort. So we group
//   that tail by MATERIAL identity and emit one BatchedMesh per material —
//   ~828 singletons sharing ~20–40 materials → ~20–40 draws — with no tiling
//   needed (BatchedMesh culls per geometry, so a level-wide per-material batch
//   does NOT have the "one giant always-on-screen sphere" pathology a level-wide
//   InstancedMesh has). Per-instance tint rides as setColorAt; per-instance
//   matrix as setMatrixAt; the shared base material (AO patch + night tag) is
//   worn verbatim, so daynight's material sweep and the AO shader reach it
//   exactly as they reach an InstancedMesh.
//
// ── THE LOAD-BEARING NORMALIZATION (BatchedMesh's hard constraint) ────────────
//   BatchedMesh refuses to mix geometries with different attribute SETS or a
//   different index-or-not (it throws). Our prototypes are NOT uniform: ao.ts
//   adds an `aoVert` attribute to SOME prototypes and not others, and a stray
//   prototype may lack `uv` or be (non-)indexed differently. So before packing a
//   material bucket we NORMALIZE every distinct geometry to a common shape —
//   a neutral `aoVert` of all 1.0 (the AO shader's no-op) where missing, a
//   neutral zero `uv` where missing, and a consistent index mode — on a CLONE
//   (never mutating the shared template the InstancedMesh path also draws,
//   except for the idempotent neutral-aoVert add which is itself a no-op). And
//   the whole per-bucket pack is wrapped in try/catch: ANY throw falls the bucket
//   back to today's singleton plain-Mesh path, so the change is strictly
//   NON-REGRESSING — a bucket BatchedMesh can't swallow renders exactly as before.
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

/** Cache of normalized (packable) geometry clones, keyed by (source geometry,
 *  normalization signature). One clone per distinct prototype sub-mesh per
 *  bucket shape — NOT per instance — so packing 828 singletons still only clones
 *  the few dozen distinct prototype geometries. Module-scoped so a re-flush
 *  (rebuild) reuses prior clones for the same template geometries. */
const normCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>();

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

/** One distance-cullable draw unit produced by flush(): either a whole scene
 *  object (per-tile InstancedMesh / plain singleton) or ONE instance inside a
 *  per-material BatchedMesh (culled via setVisibleAt — the batch itself stays,
 *  its far members stop rasterising). x/z/r is the world bounding sphere. */
interface CullRecord {
  obj?: THREE.Object3D;
  batched?: THREE.BatchedMesh;
  id?: number;
  x: number;
  z: number;
  r: number;
  visible: boolean;
}

const _cullSphere = new THREE.Sphere();

export class PropInstancer {
  private items: Collected[] = [];
  private plains: PlainMesh[] = [];
  private cullList: CullRecord[] = [];

  // the parent the batched draws are added to. Usually a dedicated 'cj-props'
  // Group (props.ts) rather than the scene directly, so a single group.visible
  // flip toggles the whole prop set — and any props that stream in AFTER the
  // toggle inherit it (a parent's visible=false hides all descendants in
  // three's render walk). Identity transform, so the baked world matrices land
  // exactly where adding to the scene would.
  constructor(private parent: THREE.Object3D) {}

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
      this.parent.add(mesh);
      this.recordCullable(mesh, p.geometry, p.matrix);
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

    // the singleton TAIL: every item that is unique within its tile (would have
    // become a plain Mesh). We don't emit it inline any more — we collect it by
    // MATERIAL and pack one BatchedMesh per material after the instancing loop.
    const tail: Collected[] = [];

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
          // singleton in this tile: NOT instanceable here (only one of this
          // geometry in this tile). Defer to the per-material BatchedMesh pass —
          // it collapses these shape-diverse singletons that SHARE a material
          // into one draw. (Falls back to a plain Mesh per item if a material
          // bucket can't be batched; see emitBatchedTail.)
          for (const it of bucket) tail.push(it);
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
        this.parent.add(inst);
        const s = inst.boundingSphere!;
        this.cullList.push({ obj: inst, x: s.center.x, z: s.center.z, r: s.radius, visible: true });
      }
    }

    this.emitBatchedTail(tail);

    this.items.length = 0;
  }

  /** Collapse the shape-diverse singleton tail into ONE THREE.BatchedMesh per
   *  material (perf-batching). Each item is unique within its tile, so it can't
   *  be instanced — but most share a material (the Kenney colormap atlas, stone,
   *  the metals), and BatchedMesh packs different geometries that share a
   *  material into a single draw with its own per-object frustum cull.
   *
   *  Strictly non-regressing: any material bucket that BatchedMesh rejects (an
   *  attribute set it can't reconcile, a sizing throw, anything) falls back to
   *  the exact plain-Mesh-per-item path the singleton branch used before. */
  private emitBatchedTail(tail: Collected[]): void {
    if (!tail.length) return;

    // group by (material, shadow-flag pair). The flag split keeps shadow
    // correctness — a BatchedMesh has ONE castShadow/receiveShadow, so a bucket
    // mixing flags would draw some props' shadows wrong. In practice props.ts
    // sets cast=receive=true on every prop mesh, so this is one bucket per
    // material; the split is cheap insurance.
    const buckets = new Map<string, Collected[]>();
    const matKey = new Map<THREE.Material, number>();
    for (const it of tail) {
      let mk = matKey.get(it.material);
      if (mk === undefined) matKey.set(it.material, (mk = matKey.size));
      const key = `${mk}|${it.castShadow ? 1 : 0}${it.receiveShadow ? 1 : 0}`;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(it);
    }

    for (const bucket of buckets.values()) {
      // a bucket of one is the same ONE draw whether plain or BatchedMesh, with
      // less machinery as a plain mesh — emit it directly (mirrors MIN_INSTANCES
      // for the instanced path). BatchedMesh only pays off at >= 2 members.
      if (bucket.length < 2 || !this.tryEmitBatch(bucket)) {
        // either a lone-material singleton or a bucket BatchedMesh refused — in
        // BOTH cases render exactly as the legacy singleton branch did: one
        // plain matrix-baked Mesh per item (tint via a one-off material clone,
        // glass skipped). Strictly non-regressing.
        this.emitPlain(bucket);
      }
    }
  }

  /** Emit each item as a plain matrix-baked Mesh — the pre-batching singleton
   *  path. Used for lone-material singletons and as the BatchedMesh fallback. */
  private emitPlain(items: Collected[]): void {
    for (const it of items) {
      const mat = it.color.equals(WHITE) ? it.material : tintClone(it.material, it.color.getHex());
      const mesh = new THREE.Mesh(it.geometry, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(it.matrix);
      mesh.castShadow = it.castShadow;
      mesh.receiveShadow = it.receiveShadow;
      mesh.frustumCulled = true;
      this.parent.add(mesh);
      this.recordCullable(mesh, it.geometry, it.matrix);
    }
  }

  /** Register a whole scene object for distance culling, with its world
   *  bounding sphere derived from the (shared) geometry + baked matrix. */
  private recordCullable(obj: THREE.Object3D, geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    if (!geo.boundingSphere) return; // empty geometry — never cull
    _cullSphere.copy(geo.boundingSphere).applyMatrix4(matrix);
    this.cullList.push({ obj, x: _cullSphere.center.x, z: _cullSphere.center.z, r: _cullSphere.radius, visible: true });
  }

  /** DISTANCE CULL (perf-mobile-tier): hide every prop draw unit whose world
   *  bounds lie entirely beyond maxDist of the camera. The caller passes the
   *  fog-derived horizon, so everything culled was already fully fog-coloured —
   *  visually free, but it stops paying vertices/raster for it. The bounding
   *  RADIUS rides in the test, so a 30 m crane naturally survives far longer
   *  than a bollard. Per-tile/singleton units flip `visible`; BatchedMesh
   *  members flip setVisibleAt. PURE PRESENTATION — render-time visibility
   *  flags only (same contract as the grass tile cull); the sim, and so every
   *  replay pin, never sees it. Pass Infinity to restore everything. */
  cull(camX: number, camZ: number, maxDist: number): void {
    for (const c of this.cullList) {
      const dx = c.x - camX;
      const dz = c.z - camZ;
      const reach = maxDist + c.r;
      const within = maxDist === Infinity || dx * dx + dz * dz <= reach * reach;
      if (within === c.visible) continue;
      c.visible = within;
      if (c.batched) c.batched.setVisibleAt(c.id!, within);
      else if (c.obj) c.obj.visible = within;
    }
  }

  /** Pack ONE material bucket into a BatchedMesh. Returns false (emitting
   *  nothing) if the bucket can't be batched, so the caller falls back. */
  private tryEmitBatch(bucket: Collected[]): boolean {
    const first = bucket[0];
    // The bucket's common attribute shape: position+normal always; uv if ANY
    // member has it; aoVert if ANY member has it (so AO-baked and un-baked
    // prototypes can share a batch — the un-baked ones get a neutral 1.0 fill).
    // The index mode is "indexed" only if EVERY member is indexed.
    let wantUv = false;
    let wantAo = false;
    let allIndexed = true;
    const distinct = new Set<THREE.BufferGeometry>();
    for (const it of bucket) {
      const g = it.geometry;
      distinct.add(g);
      if (g.getAttribute('uv')) wantUv = true;
      if (g.getAttribute('aoVert')) wantAo = true;
      if (!g.getIndex()) allIndexed = false;
    }
    const sig = `${wantUv ? 'u' : ''}${wantAo ? 'a' : ''}${allIndexed ? 'i' : 'n'}`;

    // Normalize each DISTINCT prototype geometry once (cached), and sum the
    // vertex/index counts to size the BatchedMesh exactly (props are static and
    // fully known here — no growth needed).
    const normByGeo = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    let maxVerts = 0;
    let maxIndices = 0;
    try {
      for (const g of distinct) {
        const n = normalizeForBatch(g, wantUv, wantAo, allIndexed, sig);
        normByGeo.set(g, n);
        maxVerts += n.getAttribute('position').count;
        const idx = n.getIndex();
        maxIndices += idx ? idx.count : n.getAttribute('position').count;
      }
      if (maxVerts === 0) return false;

      const batched = new THREE.BatchedMesh(bucket.length, maxVerts, maxIndices, first.material);
      batched.name = 'cj-prop-batched';
      batched.castShadow = first.castShadow;
      batched.receiveShadow = first.receiveShadow;
      batched.frustumCulled = true; // per-object frustum cull culls off-screen protos
      batched.sortObjects = false; // opaque props — no transparency sort needed

      // pack each distinct geometry once, remembering its geometryId
      const geoId = new Map<THREE.BufferGeometry, number>();
      for (const [src, norm] of normByGeo) geoId.set(src, batched.addGeometry(norm));

      // per-instance cull records staged locally — committed only if the whole
      // pack succeeds (a mid-pack throw falls back to plain meshes, which
      // register their own records; stale batch records would double-cull).
      const staged: CullRecord[] = [];
      for (const it of bucket) {
        const id = batched.addInstance(geoId.get(it.geometry)!);
        batched.setMatrixAt(id, it.matrix);
        // per-instance tint, exactly as InstancedMesh.setColorAt — three
        // multiplies diffuse by it. White = untinted/glass = no change.
        batched.setColorAt(id, it.color);
        const norm = normByGeo.get(it.geometry)!;
        if (!norm.boundingSphere) norm.computeBoundingSphere();
        if (norm.boundingSphere) {
          _cullSphere.copy(norm.boundingSphere).applyMatrix4(it.matrix);
          staged.push({ batched, id, x: _cullSphere.center.x, z: _cullSphere.center.z, r: _cullSphere.radius, visible: true });
        }
      }
      batched.computeBoundingSphere();
      this.parent.add(batched);
      this.cullList.push(...staged);
      return true;
    } catch {
      // any throw (attribute mismatch we didn't catch, sizing, an immature
      // prototype) → caller renders the bucket as plain meshes. Never drop a
      // prop. Dispose the normalized clones we made for this failed attempt
      // unless they're the shared cache (cache clones are reused, never disposed
      // here — they live in normCache for the fallback-free buckets).
      return false;
    }
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

/** Produce a BatchedMesh-packable clone of a prototype sub-mesh geometry with a
 *  CANONICAL attribute set so every member of a material bucket matches:
 *
 *    - exactly {position, normal[, uv][, aoVert]} — any other attribute (tangent,
 *      vertex color, a second uv set) is DROPPED so a stray one never breaks the
 *      uniform-attribute requirement. position+normal always (normal computed if
 *      missing); uv/aoVert present iff the bucket needs them (wantUv/wantAo).
 *    - `aoVert` neutral-filled to 1.0 where missing — 1.0 is the AO shader's
 *      no-op (ao.ts FRAG_AO: factor = 1 when vAoVert = 1), so an un-baked
 *      prototype renders identically to its un-batched self.
 *    - `uv` neutral-filled to 0 where missing — only happens if SOME bucket
 *      member has uv and this one doesn't; a colormap material without uv on a
 *      sub-mesh samples a fixed texel, matching its un-batched behaviour (it had
 *      no uv there before either).
 *    - index mode forced to the bucket's (indexed iff every member is indexed,
 *      else non-indexed via toNonIndexed()).
 *
 *  The result is CACHED per (source geometry, signature) — one clone per distinct
 *  prototype per bucket shape, never per instance. The shared template geometry
 *  is never mutated here (we clone), so the InstancedMesh path that also draws it
 *  is untouched. */
function normalizeForBatch(
  src: THREE.BufferGeometry,
  wantUv: boolean,
  wantAo: boolean,
  indexed: boolean,
  sig: string,
): THREE.BufferGeometry {
  let perGeo = normCache.get(src);
  if (!perGeo) normCache.set(src, (perGeo = new Map()));
  const hit = perGeo.get(sig);
  if (hit) return hit;

  // start from the source; force index mode first so vertex counts are final
  let base = src;
  const srcIndexed = !!src.getIndex();
  if (indexed && !srcIndexed) {
    // shouldn't occur (indexed=true means every member was indexed) — guard anyway
    base = src;
  } else if (!indexed && srcIndexed) {
    base = src.toNonIndexed(); // expands to per-vertex; matching attrs come along
  }

  const out = new THREE.BufferGeometry();
  const pos = base.getAttribute('position');
  out.setAttribute('position', cloneAttr(pos));
  const vcount = pos.count;

  // normal: required for shading; compute it on a throwaway if the source lacks
  // one so every batch member carries it (un-normaled prototypes are rare).
  let normal = base.getAttribute('normal');
  if (!normal) {
    const tmp = base.clone();
    tmp.computeVertexNormals();
    normal = tmp.getAttribute('normal');
  }
  out.setAttribute('normal', cloneAttr(normal));

  if (wantUv) {
    const uv = base.getAttribute('uv');
    out.setAttribute('uv', uv ? cloneAttr(uv) : new THREE.Float32BufferAttribute(new Float32Array(vcount * 2), 2));
  }
  if (wantAo) {
    const ao = base.getAttribute('aoVert');
    if (ao) {
      out.setAttribute('aoVert', cloneAttr(ao));
    } else {
      // neutral AO = fully open = shader no-op (factor 1.0)
      const neutral = new Float32Array(vcount);
      neutral.fill(1);
      out.setAttribute('aoVert', new THREE.Float32BufferAttribute(neutral, 1));
    }
  }

  if (indexed) {
    const idx = base.getIndex();
    if (idx) out.setIndex(cloneIndex(idx));
  }

  perGeo.set(sig, out);
  return out;
}

/** Copy a BufferAttribute into a fresh one with the same itemSize/normalized.
 *  (BatchedMesh.addGeometry reads attribute arrays into its packed buffer; a
 *  fresh copy keeps the canonical clone independent of the source.) */
function cloneAttr(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const out = new THREE.BufferAttribute(new Float32Array(a.count * a.itemSize), a.itemSize, a.normalized);
  for (let i = 0; i < a.count; i++) {
    out.setX(i, a.getX(i));
    if (a.itemSize > 1) out.setY(i, a.getY(i));
    if (a.itemSize > 2) out.setZ(i, a.getZ(i));
    if (a.itemSize > 3) out.setW(i, a.getW(i));
  }
  return out;
}

/** Copy an index attribute into a fresh Uint32 one. */
function cloneIndex(idx: THREE.BufferAttribute): THREE.BufferAttribute {
  const arr = new Uint32Array(idx.count);
  for (let i = 0; i < idx.count; i++) arr[i] = idx.getX(i);
  return new THREE.BufferAttribute(arr, 1);
}
