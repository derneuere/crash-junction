# Prop draw-call batching & culling plan (collapse the ~843-singleton tail)

Status: PLAN ONLY (no code changed). Author pass: 2026-06-28.
Scope: presentation-only batching of set-dressing props. Pin-safe by construction
(colliders, sim, RNG, camera, replay hash all untouched — see Pin-safety note).

Cross-references (sibling agents own these; this plan does not redesign them):
- `docs/research/perf-reflections-plan.md` — cube-reflection exclusion via `THREE.Layers`.
- `docs/research/perf-grass-plan.md` — grass-tile draw-call work.
- This plan only touches the **prop** path (`src/game/props.ts`, `src/game/propinstancer.ts`).

---

## 1. Problem (measured)

Frame-exact averages at a FROZEN gantry "dockyard" pose:

| Scenario | Draws | FPS |
|---|---|---|
| Baseline (all on) | **1441** | 31 |
| Props OFF | **574** | 60 |
| **Props cost** | **≈ 870** | — |

Live scene traversal census (1224 visible renderable objects):
- **~843 plain singleton meshes** ("other") — the tail this plan targets.
- 255 grass tiles (sibling: `perf-grass-plan.md`).
- 86 prop instanced batches (the InstancedMeshes `PropInstancer` already emits).
- ~29 other instanced (walks, marks, posts).
- ~92 vehicle sub-meshes.

Every base draw is multiplied **×6** by the player cube reflection on capture frames
(`reflections.ts` re-renders the whole scene into six faces every other frame). So a
draw removed from the main render is removed up to ~7× over a capture frame **today**
— but see §7: the sibling reflections plan removes props from the cube entirely, which
changes this multiplier to ~×1–2 once it lands. The two plans must compose, not
double-count the same savings.

### Where the 843 come from (root cause)

`PropInstancer` (`src/game/propinstancer.ts`) bins props into 40 m spatial TILES and
emits ONE `InstancedMesh` per `(geometry+material, tile)` only when a tile holds
≥ `MIN_INSTANCES` (=2) of that exact geometry+material pair. **Anything that is unique
within its tile stays a plain singleton `Mesh` — one draw call each.** The dockyard is
dressed with many *different-shape* prototypes (cranes `crane-tower-jtoastie`,
`crane-harbor-hancock`; cargo `container-{red,green,shipping,small,structure,
train-cargo}`, `silo`; industrial `building-s/j`, `chimney-large`; builtins
`gantry-crane`, `floodlight-mast`, `bollard`, `lamp`; trees), each with several
sub-meshes. Two cranes 100 m apart fall in different tiles → two singletons. A crane,
a silo and a chimney in the same tile are three different geometries → three singletons.
The 86 instanced batches are the *repeated* containers; the 843 tail is the
*shape-diverse* remainder, which the geometry-identity key can never instance.

The material span is the lever. The census names a small set of material names:
`colormap` (the Kenney shared atlas — likely the dominant share), `stone`, `woodBark`/
`woodBarkDark`/`leafsDark` (trees), `yello_metal` (cranes), `chevronBlack`, and Kenney
sub-materials `mat5/mat8/...`. So ~843 singletons span on the order of **~20–40 distinct
materials**. Different SHAPES, but many SHARE a material — exactly the case
`THREE.BatchedMesh` exists for.

---

## 2. Options & tradeoffs

### Option A — `THREE.BatchedMesh` per material  ← **headline**

`THREE.BatchedMesh` (present in three 0.170: `node_modules/three/src/objects/
BatchedMesh.js`) packs MANY DIFFERENT geometries that share ONE material into a SINGLE
draw call. It keeps per-geometry bounding volumes and does its own per-object frustum
culling (`perObjectFrustumCulled = true` by default) and depth sort
(`sortObjects = true`). Each instance carries its own matrix (`setMatrixAt`) and color
(`setColorAt`) — a perfect fit for the existing per-instance-tint contract.

API confirmed in 0.170:
- `new THREE.BatchedMesh(maxInstanceCount, maxVertexCount, maxIndexCount, material)`
- `addGeometry(geometry) -> geometryId` (packs the geometry into the shared buffer)
- `addInstance(geometryId) -> instanceId`
- `setMatrixAt(instanceId, matrix)` / `setColorAt(instanceId, color)`
- `computeBoundingSphere()` / per-instance `setVisibleAt`.

Mapping to our tail: group the 843 singletons by **material identity** and emit ONE
BatchedMesh per material. Each distinct prototype sub-mesh geometry is `addGeometry`'d
once; each placement is an `addInstance` + `setMatrixAt(worldMatrix)` + `setColorAt(tint
or white)`.

- Expected: ~843 singletons sharing ~20–40 materials → **~20–40 draws** for the tail
  (one BatchedMesh per material), with the built-in per-geometry culling keeping
  off-screen prototypes out of the GPU submission. If `colormap` really dominates, the
  bulk collapses into a *handful* of large BatchedMeshes.
- The 86 already-instanced repeated batches can ALSO fold in (a BatchedMesh handles the
  repeated case too — many instances of the same geometryId), so the *whole* prop set
  could become ~20–40 draws rather than 86 + 20–40. (Phase it — see §5.)

**The load-bearing constraint (and the main risk):** `BatchedMesh._validateGeometry`
(BatchedMesh.js ~L302) requires **every geometry added to a given BatchedMesh to carry
the IDENTICAL attribute set** as the batch's first geometry — same attribute *names*,
`itemSize`, `normalized`, and the same index-or-not. Adding a geometry missing an
attribute the batch already has, or with an extra one, **throws**. This collides head-on
with our AO contract: baked AO (`ao.ts`) adds an `aoVert` float attribute to *some*
prototypes (those the offline bake covers) and not others. Within one material bucket we
may have a mix of `aoVert`-having and `aoVert`-lacking geometries → a throw. **Mitigation
is mandatory (see §3, AO contract).** Trees/leaves may also be `MeshStandardMaterial`
with `alphaTest`; that is a material property, shared across the batch, so it is fine as
long as it is one material per batch.

Tiling vs BatchedMesh's own culling: BatchedMesh already culls per geometry, so a
LEVEL-WIDE BatchedMesh per material does NOT have the "one giant bounding sphere always
on-screen" pathology that a single level-wide `InstancedMesh` has (the reason the current
code tiles). The per-object frustum test drops off-screen prototypes for free. So spatial
tiling becomes **optional / complementary**, not required, for the BatchedMesh path —
simplifying the code. (A coarse tiling can still help GPU-side sort coherence, but it is
no longer load-bearing for culling.)

### Option B — Geometry merge per (material, spatial tile)  ← fallback / complement

`BufferGeometryUtils.mergeGeometries` (already imported by `src/game/chunkbatch.ts`)
bakes each source geometry's world matrix into a clone and merges *different-shape*
geometries that share a material into ONE mesh per tile.

- Expected: collapses the tail to ~(materials × occupied-tiles) meshes. With a 40 m grid
  over a ~210×240 m port that is ~30 tiles; ~20–40 materials but only a few materials per
  tile in practice → on the order of **~60–150 draws** — a real win, but coarser than
  BatchedMesh's ~20–40.
- **Loses per-instance frustum culling** (the merge is one rigid buffer; only tile-level
  culling survives, via the tight per-tile bounding sphere `chunkbatch` already computes).
- **Loses per-instance tint**: merging bakes vertices, so a per-instance color must be
  carried as a baked vertex-color attribute or it fragments the merge by tint (back to
  the problem the per-instance-color refactor in `props.ts` solved). Doable but fiddly.
- `mergeGeometries` has the SAME attribute-consistency requirement as BatchedMesh (it
  refuses to merge mismatched attribute sets — `chunkbatch.ts` already has the
  null-return fallback), so the `aoVert` mix problem appears here too.
- Upside: dead-simple, no new three class, reuses `chunkbatch` machinery; a solid
  fallback if BatchedMesh proves brittle for a particular material family.

### Option C — Material / texture atlasing  ← multiplier on A

The size of the BatchedMesh win scales with how many singletons share a material. Kenney
kits already paint most pieces from one `colormap` atlas, so the share is probably high
already. Atlasing is about *increasing* that share:
- Audit how many distinct `THREE.Material` instances the 843 actually span (not just
  names — `props.ts` `loadPropScene` clamps `metalness` on the *cached template*, so
  same-URL submeshes already share a material instance; cross-URL sharing depends on
  whether the GLBs ship the same atlas texture object after load — they do NOT
  automatically, since each GLB load makes its own `Texture`/`Material`).
- A `perf-mem`-style material/texture dedup pass (merge identical-config materials and
  same-image textures into one instance) would *collapse the bucket count*, turning e.g.
  six near-identical `colormap` materials (one per GLB) into one → one BatchedMesh
  instead of six. **This is the highest-leverage complement to Option A** and likely
  already partly owned by an existing `perf-mem` dedup pass — check before re-doing it.
- True UV re-atlasing (repacking textures + rewriting UVs) is heavy and out of scope;
  the cheap win is *material-instance* dedup so the bucket key collapses.

---

## 3. Recommended approach

**Option A (BatchedMesh per material) as the headline, with Option-C material dedup as
the force multiplier, and Option B kept as a per-material fallback.** Implement inside the
existing `PropInstancer` so `props.ts` and the determinism split are untouched.

### Files / functions

- `src/game/propinstancer.ts` — extend `PropInstancer.flush()`. The `collect()` harvest
  stays almost as-is (it already gathers geometry, base material, world matrix, tint
  color, shadow flags, x/z). Replace the "singleton tail → plain Mesh" branch with a
  **per-material BatchedMesh accumulation**:
  1. After grouping, the items that *currently* fall through to singleton (tile count
     `< MIN_INSTANCES`) instead get routed into a `Map<materialKey, Collected[]>`.
  2. For each material bucket, size a BatchedMesh: `maxInstanceCount = bucket.length`,
     `maxVertexCount`/`maxIndexCount` = sum over the *distinct* geometries in the bucket
     (cache `addGeometry` results in a `Map<BufferGeometry, geometryId>` so each unique
     prototype geometry is packed once and reused across its instances).
  3. Per item: `id = batched.addInstance(geometryId)`; `batched.setMatrixAt(id,
     it.matrix)`; `batched.setColorAt(id, it.color)` (white = identity = untinted/glass,
     exactly as `instanceColor` does today).
  4. `batched.castShadow / receiveShadow` from the bucket (all members share flags in
     practice; if a material bucket mixes flags, split the bucket by flag pair —
     cheap, and shadow correctness matters).
  5. `batched.computeBoundingSphere()`; `this.parent.add(batched)`.
- `src/game/props.ts` — NO change needed. It already feeds positioned, AO-applied,
  metalness-clamped clones into `instancer.collect()` and calls `instancer.flush()` after
  `Promise.all`. The batching change is entirely inside `flush()`.

Keep `MIN_INSTANCES`/tile-`InstancedMesh` path for the *repeated identical* geometry
(it already works and is one draw per tile). Phase 1 only re-routes the singleton tail
into BatchedMeshes; a later phase can fold the repeated batches in too (§5).

### Preserving the fidelity contract

- **AO `aoVert` (THE critical one).** BatchedMesh demands a uniform attribute set per
  batch. Mixing `aoVert`-having and `aoVert`-lacking prototypes in one material bucket
  throws. Fix by **NORMALIZING the attribute set before packing**: when building a
  material bucket, if ANY geometry in it has `aoVert`, ensure ALL do — for the ones that
  lack it, attach a neutral `aoVert` (all `1.0` = "fully open" = the AO shader's no-op,
  per `ao.ts` `FRAG_AO`: `vAoVert = 1` → `aoVertFactor = 1`). Conversely, strip nothing;
  just *add the missing neutral attribute*. This is a per-geometry one-time fixup (cache
  on the geometry like `ao.ts` does for `aoVert`). The patched `MeshStandardMaterial`
  (the AO `onBeforeCompile` injection) is the *shared* material the BatchedMesh wears, so
  the shader patch reaches it exactly as it reaches an `InstancedMesh` material today. Net:
  AO-baked prototypes darken as before; neutral-`aoVert` prototypes render identically to
  un-batched (factor 1).
  - Also normalize `position`/`normal`/`uv` presence and `index` (BatchedMesh requires
    consistent index-or-not). Kenney/Quaternius GLB submeshes are indexed with
    pos/normal/uv; if a stray prototype is non-indexed or lacks `uv`, either call
    `toNonIndexed()`/`mergeVertices` to normalize, or fall back that material bucket to
    Option B (geometry merge) which has the same constraint but a graceful null-return
    fallback already in `chunkbatch.ts`.
- **Per-instance tint.** `setColorAt(id, color)` is the BatchedMesh analog of
  `InstancedMesh.setColorAt`; three multiplies diffuse by it identically. The existing
  rule (glass/window/transparent submeshes → white) is preserved verbatim from
  `collect()`'s `skipTint` computation — `it.color` is already white for those.
- **Shadows.** Set `castShadow`/`receiveShadow` on the BatchedMesh from the bucket; the
  shadow depth pass batches the BatchedMesh the same way (one shadow draw per BatchedMesh
  instead of per singleton — a *bonus* shadow-pass win).
- **Night emissive.** `daynight.ts` `applyTimeOfDay` is a `scene.traverse` keyed on
  `mat.userData.night`. A BatchedMesh's single shared material is reached by that walk
  exactly like an `InstancedMesh`'s — no bookkeeping. (Confirmed: the sweep dedups by
  material instance, and the BatchedMesh wears the shared base material.)
- **Multi-material submeshes.** `collect()` already shunts `mats.length !== 1` meshes to
  the `plains[]` path (kept whole). Leave that path unchanged — these are a handful
  (ramps, the rare kit piece) and don't dominate the count.

### Expected draw-call reductions (main render, props only)

| Stage | Prop draws (main render) |
|---|---|
| Today | ~843 singletons + 86 instanced ≈ **929** |
| Phase 1 (tail → BatchedMesh/material) | ~20–40 batched + 86 instanced ≈ **~110–130** |
| Phase 2 (fold repeated into BatchedMesh too) | ~20–40 total ≈ **~20–40** |

So prop draws drop from ~929 to **~20–40** (Phase 2), ~110–130 after Phase 1. Against the
measured ~870 prop draw-call cost, that is roughly a **20–40× reduction of the prop tail**.
The shadow pass gets the same collapse (props that cast shadows now batch), and — *before*
the reflections plan lands — the cube multiplies the saved draws up to ×7. After the
reflections plan removes props from the cube, the multiplier is ×1–2 (main + shadow) —
still the dominant prop-side win, just not double-counted with the cube savings (§7).

### Risk

- **Attribute-set mismatch throws (HIGH if unhandled, LOW with the normalization above).**
  Mitigated by the neutral-`aoVert` fill + index/uv normalization, with a per-bucket
  Option-B fallback. Wrap `addGeometry`/`addInstance` per bucket in a try/catch that, on
  throw, falls the *whole bucket* back to the current singleton-Mesh path (never silently
  drop a prop). This makes the change strictly non-regressing: worst case a bucket renders
  as it does today.
- **Buffer sizing.** BatchedMesh pre-reserves `maxVertexCount`/`maxIndexCount`; under-size
  throws ("Reserved space request exceeds the maximum buffer size"). Size from the exact
  sum of the bucket's distinct geometries (we know them at flush time). No growth needed —
  props are static and fully known at flush.
- **Over-batching defeats culling? No.** `perObjectFrustumCulled` keeps per-geometry
  culling, so a level-wide per-material BatchedMesh does NOT regress like a level-wide
  InstancedMesh would. (This is the key reason BatchedMesh > the old tiling for diverse
  shapes.) Verify the dockyard frozen-pose draw count actually drops via the existing
  perf HUD (`perf.ts` `live().calls`) and the props toggle — no new instrumentation needed.
- **`sortObjects = true`** adds a per-instance depth sort each frame on the CPU. For ~843
  static instances this is cheap, but if it shows up in `perf.ts` `postMs`, set
  `sortObjects = false` on opaque prop batches (props are opaque; sort matters only for
  transparency, which the glass/window submeshes don't go through here — they keep white
  tint but are still their own material bucket; if a transparent bucket exists, leave its
  sort on).
- **three 0.170 BatchedMesh maturity.** It is the r166+ API and stable, but it is newer
  than InstancedMesh. The try/catch fallback de-risks any prototype it chokes on.

---

## 4. Culling improvements (composable, optional)

- **Distance-cull tiny props.** Far small props (bollards, lamps) contribute draws (via
  the cube today) for sub-pixel coverage. With BatchedMesh, per-object frustum culling is
  free, but a *distance* cull (hide instances beyond a radius via `setVisibleAt`) can be
  driven from the render-time camera position exactly like `grass.ts` does — pin-safe
  (reads render camera, flips visibility only). Optional; the BatchedMesh frustum cull
  already removes off-screen props, so distance-cull is a secondary fill-rate lever, not a
  draw-count lever. Defer unless profiling asks for it.
- **Tile sizing now optional.** Because BatchedMesh culls per geometry, the 40 m tiling
  that `PropInstancer`/`chunkbatch` need for InstancedMesh culling is no longer required
  for the batched path. Dropping per-tile fragmentation actually *helps* (bigger buckets =
  fewer draws). Keep tiling only if a future profile shows the BatchedMesh sort cost wants
  spatial coherence.

---

## 5. Incremental rollout

1. **Phase 0 — material-span audit (no behavior change).** Add a one-shot dev log in
   `flush()` (behind a debug flag) that counts distinct `THREE.Material` instances and
   distinct geometries across the singleton tail, and how many lack `aoVert`. This
   confirms the ~20–40 bucket estimate and surfaces the attribute-mix reality before
   writing the batcher. Cheap, reversible, informs sizing. (Cross-check whether a
   `perf-mem` material-dedup pass already shrinks the bucket count — Option C.)
2. **Phase 1 — tail → BatchedMesh per material.** Re-route only the `< MIN_INSTANCES`
   singleton branch into per-material BatchedMeshes with the `aoVert`/index/uv
   normalization and the per-bucket try/catch fallback. Leave the repeated-geometry
   InstancedMesh path alone. Expected: prop draws ~929 → ~110–130. **Run the replay suite
   — must stay green** (it will: presentation-only). Eyeball the frozen dockyard pose via
   the props toggle + perf HUD.
3. **Phase 2 — fold the repeated batches in.** Route the `≥ MIN_INSTANCES` runs into the
   same per-material BatchedMeshes (repeated geometry = many `addInstance` of one
   `geometryId`). Removes the InstancedMesh tiling entirely for props. Expected: prop draws
   → ~20–40. Re-verify replay + perf.
4. **Phase 3 (optional) — Option C material dedup** if Phase 0 showed cross-GLB material
   duplication, and **Option B fallback hardening** for any bucket BatchedMesh rejects.

Each phase is independently shippable and strictly non-regressing (fallback path).

---

## 6. Pin-safety note

Unchanged from the existing `PropInstancer` contract:
- All work is in `PropInstancer.flush()`, called from `props.ts` AFTER `Promise.all` of
  the async visuals — colliders are built **synchronously** earlier in `loadLevelProps`
  and are NEVER touched here.
- Nothing read or written reads sim state, RNG, the camera transform, or the replay hash.
  It adds render `Object3D`s to the `cj-props` group after the GLBs stream in.
- The `propsGroup.visible` toggle (`graphics.ts` `props`, applied in `Game/core.ts`
  `applyGraphics`) keeps working: a BatchedMesh under `cj-props` is hidden by the parent
  `visible=false` exactly like an InstancedMesh.
- The AO neutral-`aoVert` fill changes only the *visual* attribute on the shared geometry
  (factor 1 = no-op); it cannot affect physics, which never sees prop meshes.
- Replay suite must stay green; the change is byte-identical in pixels (same geometries,
  same world matrices, same per-instance tints, same shared materials), so the only
  observable difference is `renderer.info.render.calls` — which the sim does not read.

---

## 7. Interaction with the cube-reflection exclusion (DO NOT double-count)

The sibling plan `docs/research/perf-reflections-plan.md` (Option A there) puts props on
`THREE.Layers` layer 0 only and renders the cube from **layer 1 only**, so **props leave
the cube entirely**. Today a prop draw is multiplied up to ~×7 (main + 6 cube faces on a
capture frame); after that plan lands, a prop draw costs ~×1–2 (main render + shadow pass;
the cube no longer renders props at all).

Implications for THIS plan:
- **Order-independent, but credit-shared.** If the reflections plan ships first, the cube
  no longer pays for the 843 prop draws regardless of batching, so the *cube* savings
  belong to that plan. THIS plan's remaining payoff is the **main render + shadow pass**:
  ~929 → ~20–40 prop draws there, ~1–2× — still the dominant prop-side main-render win,
  just not ×7.
- **If batching ships first**, it shrinks the cube's prop cost immediately (~870 → ~110
  then ~30 prop draws × the cube's ×6), and the reflections plan later removes the
  residual cube prop cost entirely. No conflict — they stack, but the headline cube number
  is the reflections plan's to claim.
- **No layer bookkeeping needed here.** BatchedMeshes are added under the `cj-props` group;
  whatever layer policy the reflections plan applies to that group (e.g. "props stay layer
  0 only") is inherited by the BatchedMeshes the same as any child mesh. The two plans
  compose cleanly: this plan reduces *how many draws props are*; the reflections plan
  reduces *how many times each is drawn*.
- **Coordinate the headline number** so the two PRs don't both claim the ~810-draw cube
  reduction. Reflections owns the cube multiplier; batching owns the main+shadow object
  count. Combined endgame for the prop tail: from ~843 main-render singletons (×~7 today)
  to ~20–40 main-render batched draws (×~1–2), i.e. the dockyard's prop draw budget goes
  from the dominant cost to a rounding error.

---

## 8. Summary of recommendation

Replace `PropInstancer`'s singleton-tail (and ultimately its repeated-batch path) with
**one `THREE.BatchedMesh` per material**, normalizing the `aoVert`/index/uv attribute set
so the AO contract survives, carrying tint via `setColorAt`, and falling back per-bucket
to the current path on any attribute throw. ~843 singletons → ~20–40 draws (Phase 1
~110–130). Pair with a material-instance dedup audit (Option C) to maximize bucket merging,
keep geometry-merge (Option B) as the graceful fallback, and compose with — not duplicate
— the cube-reflection layer exclusion.
