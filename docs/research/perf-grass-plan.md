# PERF — low-triangle / low-draw-call grass that keeps the lush chase-cam look

**Question in one line:** the gantry dockyard pose draws all the grass at full
fidelity even when the chase cam never sees most of it — what is the cheapest
grass that still reads lush from the car, and how do we build it in this codebase
without touching the sim?

Everything below is **presentation-only**: grass already runs off render time
(`grass.update(dt, camPos)` called from the pixels-only tail of `frame()` in
`src/game/Game/core.ts:2904`), carries no collider, and never enters the
sim/replay/world-hash. The plan keeps that contract intact — see the pin-safety
note at the end. The replay suite must stay green.

Companion to [reflections-plan.md](reflections-plan.md) (sibling agent owns the
player cube reflection; this doc only *cross-references* it — see §2.0).

---

## 1. Problem — the measured numbers

Frame-exact averages at a **frozen gantry "dockyard" camera pose** (idle orbit,
wide frustum), from the PR #11 perf HUD:

| State            | Draw calls | FPS | Triangles |
|------------------|-----------:|----:|----------:|
| Baseline (all on)|       1441 |  31 |     ~3.1M |
| Grass OFF        |       1310 |  37 |     ~1.0M |
| **Grass delta**  |   **~131** | +6  | **~2.1M** |
| Everything-OFF floor |     59 |   — |    ~0.02M |

**Allocation:** 559,186 blades placed (`MAX_BLADES = 600000`, `DENSITY = 3.1`
clumps/m²), partitioned into **523 spatial tiles** (`TILE_SIZE = 22 m`). At the
wide idle-orbit pose, all 523 tiles are within `CULL_RADIUS = 210 m`, so none are
distance-culled; ~131 of them survive three's per-tile frustum cull and draw.

**The shape of the cost (the key reading):**
- Grass is **~131 draw calls but ~2.1M triangles** — it is the dominant
  **triangle** cost and a modest **draw-call** cost. Any plan must attack
  triangles first.
- ~2.1M tris / ~131 drawn tiles ≈ **16K tris/tile**. A 22 m tile at 3.1 clumps/m²
  holds ~1500 clumps; at LOD00 = 66 tris that's ~99K tris *if drawn full*, so the
  count-LOD is already thinning hard. The 16K/tile average is the post-LOD draw —
  but it is still 2.1M because **so many tiles are in the lush near band at once**
  at this wide pose (the idle orbit sits high and far, so a huge apron of verge is
  inside `FULL_RADIUS`/`LOD0_RADIUS` from the orbit centre, not from a car).

### 1.1 The cube-reflection multiplier (cross-reference, §2.0)

`renderer.info` has `autoReset = false` and is reset once per frame
(`perf.ts:125,137`), so the HUD's draw/triangle numbers **accumulate every render
in the frame** — the main pass **plus the 6 cube-reflection faces**. The player
cube (`reflections.ts`) re-renders the whole scene into 6 faces, throttled to
every other frame (`core.ts:2928`, `cubeEvery`), and **grass is NOT in its `hide`
list** (`core.ts:2934` passes only `[p.group, this.sunFlare.group]`). So on a cube
frame, grass is rasterised **7×** (1 main + 6 faces). The ~2.1M "grass" triangles
in the table are therefore inflated by the cube on cube frames. Two consequences:

1. **Excluding grass from the cube is the single highest-leverage, lowest-risk
   win** and is *independent* of every other option here. It costs grass nothing
   visually (a streaky clearcoat reflection does not need individual blades).
2. The *real* main-pass grass cost is lower than 2.1M; the geometry options below
   still matter for the main pass and for the idle-orbit pose (no player ⇒ no cube,
   so the idle measurement is closer to pure main-pass grass).

---

## 2. Options (with tradeoffs)

### 2.0 Exclude grass from the player cube reflection — DO THIS REGARDLESS
- **What:** add the grass meshes (or a single grass group) to the `hide` list
  passed to `reflections.update(...)` at `core.ts:2934`, exactly as the player
  bodywork and sun flare are hidden.
- **Win:** removes grass from 6 cube faces every cube frame. On the dockyard, that
  is the lion's share of grass *triangle* throughput during play (the idle table
  has no player/cube, but in-play the cube dominates).
- **Risk:** near-zero. The clearcoat reflection blurs to mush; the player will not
  notice the verge missing from their own paint. The lawn the camera looks at is
  unchanged.
- **Ownership note:** the cube and its `hide` list belong to the sibling
  reflections concern. This plan *requests* the exclusion and treats it as the
  baseline; if the reflections agent prefers a scene-graph `layers` mask, that
  works equally well. **Cross-reference, do not re-design the cube here.**

### 2.1 Far more aggressive distance density/LOD falloff (tighten the rings)
- **What:** the current rings (`config.ts`) are tuned for the *idle orbit* reading
  full at a wide pose: `FULL_RADIUS = 64`, `LOD0_RADIUS = 80`, `LOD1_RADIUS = 145`,
  `CULL_RADIUS = 210`, `MIN_LOD_FRAC = 0.05`. The **chase cam** (eye ~2.4 m,
  ~7–9 m behind the car, looking ~8 m ahead, gantry fog 55–150 m) cannot resolve a
  single blade past ~40–50 m. Pull every ring in hard for the chase cam.
- **Win:** linear in the number of tiles that drop out of the full/near bands.
  Halving `FULL_RADIUS`/`LOD0_RADIUS` and pulling `CULL_RADIUS` to ~120 m (still
  inside the 150 m fog wall) removes most of the near-band tiles that drive the
  16K-tri/tile average and converts the rest to LOD01/LOD02 (32/16 tris).
- **Risk:** low–moderate. The *idle orbit* (level-select preview) genuinely shows
  a wide vista, so a single global ring set can't be both tight-for-chase and
  lush-for-orbit. Solution: a **two-profile ring set** keyed on whether a player
  exists / cine pose vs idle (§3, presentation-only — it reads the same render-time
  state the update already reads).
- **Fidelity:** none lost from the chase cam (the blades it culls are sub-pixel);
  the idle-orbit preview keeps the wide profile.

### 2.2 Reduce blades-per-clump and clump count at mid/far range
- **What:** the count-LOD already eases `mesh.count` from `full` to `MIN_LOD_FRAC`
  across `FULL_RADIUS → CULL_RADIUS`. Two free wins: (a) drop `MIN_LOD_FRAC`
  toward ~0.02 and steepen the ease (cube the falloff instead of squaring it), and
  (b) make `FULL_RADIUS` itself small for the chase profile so the thinning starts
  almost immediately. Because placement order within a tile is hash-uniform,
  drawing the first K instances is an even spatial subsample (no clustering) — this
  is already how it works, so steepening it is a one-line tuning change.
- **Win:** triangles scale with drawn instance count; steepening the curve in the
  mid band (where most drawn tiles live) is a direct multiplier on the ~2M.
- **Risk:** low — the thinned blades are far and small; the alpha-mask clump keeps
  each surviving instance reading bushy.

### 2.3 Billboard / impostor LOD for the far ring (the big structural win)
- **What:** beyond a near threshold (~`LOD0_RADIUS`), stop drawing 3D blade clumps
  and draw **camera-facing alpha quads** with a baked grass-clump texture. A quad
  is **2 triangles** vs LOD01's 32 / LOD02's 16 — and one impostor card can stand
  in for a *cluster* of clumps, so the instance count drops too. The bake is a
  single offscreen render of the LOD00 clump (or a small fan of them) to an RGBA
  texture, done once at asset-load time alongside the GLB.
- **Win — the largest triangle lever after §2.0:** the far/mid band is most of the
  drawn tiles at the wide pose. Replacing 16–32-tri clumps with 2-tri cards there
  is a ~8–16× per-instance triangle cut on exactly the tiles that dominate the
  count. Combined with §2.1's tighter near band, the near band (true 3D clumps)
  becomes a thin collar around the car and everything else is cards.
- **Risk — moderate, this is the real engineering:**
  - *Camera-facing rotation must stay pin-safe.* Billboarding orients each card to
    the camera. Do it in the **vertex shader** from the camera/view matrix (the
    grass material already injects vertex code via `onBeforeCompile`,
    `material.ts:117`) so the instance matrices stay constant and nothing is
    rewritten per frame on the CPU — no new per-frame CPU state, no RNG, no sim
    read. This is the clean way and it's a natural extension of the existing
    shader graft.
  - *Look match.* Far grass as flat lit cards can read as a "billboard ring" if the
    transition is abrupt. Mitigate by (a) putting the swap where the clump is
    already only a few pixels tall (it already is at `LOD0_RADIUS = 80`, and the
    chase profile pulls that in), (b) baking the card from the SAME LOD00 clump +
    alpha mask so colour/silhouette match, (c) keeping the base→tip gradient + a
    cheap version of the wind sway on the card (lean the top, not whole-quad
    translate) so the field still moves.
  - *Lighting.* The card should reuse the same `MeshStandard` + `onBeforeCompile`
    path (env-damped, fog, time-of-day re-tint) so it sits in the scene like the
    clumps; a second material is fine but must share the day/night re-tint hooks.

### 2.4 Tighter cull radius for the chase cam vs the idle orbit
- A sub-case of §2.1, called out because it's the cheapest framerate lever in
  *play*: at the chase pose `CULL_RADIUS = 210` is wasteful (fog hides everything
  past ~150 m at gantry). A chase-profile `CULL_RADIUS ≈ 120` drops whole far tiles
  to zero draw. Idle keeps 210 for the preview vista.

### 2.5 three.js 0.170 — `BatchedMesh` (cross-reference only)
- 0.170 ships `THREE.BatchedMesh` (multi-draw / merged geometry with per-instance
  visibility + per-geometry LOD), which could collapse the per-tile InstancedMesh
  draw calls. **The sibling batching/culling agent owns this.** Grass's draw-call
  count (~131) is the *secondary* cost here; the triangle options above are the
  priority. If batching lands, the impostor cards (§2.3) are an ideal BatchedMesh
  payload (uniform 2-tri geometry, per-instance cull). **Cross-reference, don't
  design batching here.**

---

## 3. Recommended approach

Three layers, in priority order. Layers A and B are small, decisive, and
independent; layer C is the structural triangle win.

### Layer A — exclude grass from the cube reflection (§2.0)  *[request to reflections agent]*
- **Change:** at `src/game/Game/core.ts:2934`, add the grass group/meshes to the
  `hide` array, or tag grass meshes onto a `layers` channel the cube camera masks
  out. Grass meshes are already enumerable via `this.grass.meshes`
  (`GrassField.meshes`, `types.ts:11`).
- **Expected savings:** removes 6× grass rasterisation on cube frames — the largest
  in-play grass triangle/draw reduction, at **zero** fidelity cost.
- **Owner:** reflections sibling. This plan assumes it lands.

### Layer B — chase-vs-idle ring profiles (§2.1, §2.2, §2.4)  *[grass module]*
Promote the ring constants from fixed values to a small **profile object** that
`update()` selects per frame from render-time state already in hand.

- **Files/functions:**
  - `src/game/grass/config.ts` — keep the existing values as the **`IDLE` profile**
    (preview vista unchanged) and add a **`CHASE` profile**:
    ```
    CHASE:  FULL_RADIUS 28, LOD0_RADIUS 44, LOD1_RADIUS 80,
            CULL_RADIUS 120, MIN_LOD_FRAC 0.02
    IDLE:   (today's) 64 / 80 / 145 / 210 / 0.05
    ```
  - `src/game/grass/types.ts` — `GrassField.update(dt, camPos, profile?)` gains an
    optional profile flag (or reuse the existing `setTier` seam — it already exists
    for exactly this kind of presentation switch and is a no-op today).
  - `src/game/grass/build.ts` — the `update()` closure reads the active profile's
    radii instead of the module constants; recompute the squared radii when the
    profile changes (cheap, once per switch).
  - `src/game/Game/core.ts:2904` — pass the profile: **`CHASE` when a player exists
    and is driving** (`this.player` set, state `Launch`), **`IDLE` otherwise**
    (level-select orbit, replay-cam-far). This is the same render-time state the
    pixels-only tail already reads; no new sim coupling.
  - Steepen the count-LOD ease in `update()`: change `inv * inv` to `inv * inv *
    inv` (cubic) so the mid band thins faster.
- **Expected savings (chase pose, main pass):** the near/full band collapses from a
  64–80 m apron to a ~28–44 m collar; far tiles past 120 m drop to zero. On a chase
  frame the drawn-grass triangle count should fall by roughly **3–5×** vs today's
  near-band-heavy draw, with **no visible change** (the culled blades are
  sub-pixel behind the fog). Idle-orbit preview byte-identical (uses `IDLE`).
- **Fidelity risk:** low. The only watch-item is the *transition* as the player
  slows/parks (CHASE↔IDLE swap) — gate the swap on driving-state with a small
  hysteresis so it doesn't pop while maneuvering near a verge.

### Layer C — billboard impostor far ring (§2.3)  *[grass module, larger]*
Replace the LOD01/LOD02 3D clumps in the far band with camera-facing alpha cards.

- **Files/functions:**
  - `src/game/grass/assets.ts` — after the GLB lands, **bake a clump impostor**:
    render the conditioned LOD00 geometry (with the alpha mask + base→tip gradient)
    to a small RGBA `WebGLRenderTarget` (e.g. 64×96, base-at-bottom) once, and build
    a unit **quad geometry** (`lodCard`) that samples it. Add `lodCard` to the
    `GrassLODs` interface (`assets.ts:24`).
  - `src/game/grass/material.ts` — add a **billboard branch** (or a sibling
    material sharing the same uniforms/day-night hooks): in the vertex shader,
    offset the quad corners along the camera right/up vectors (from the view
    matrix) so the card faces the camera; keep a reduced tip-lean wind so it sways;
    sample the baked impostor texture for colour+alpha in the fragment shader.
    Reuse `uTime`, `uAmbient`, `uBaseColor`, the day/night re-tint, and fog.
  - `src/game/grass/build.ts` — in `update()`, the geometry-LOD pick gains a 4th
    tier: inside `LOD0_RADIUS` → `lod0` (3D), `LOD0..LOD1` → `lod1`, **beyond
    `LOD1_RADIUS` → `lodCard`** (the impostor) instead of `lod2`. The card material
    swap rides the same `t.lod` guard already there (`build.ts:225-231`).
- **Expected savings:** far-band per-instance triangles drop from 16–32 to **2**
  (~8–16×) on the tiles that dominate the wide-pose count; with batching (§2.5) the
  card draws can also collapse. Net: the residual far/mid grass triangles after
  Layer B fall by another large factor, and the impostor band reads as a continuous
  lush mat from the chase angle (it's only ever seen edge-on and small).
- **Fidelity risk:** moderate — the impostor seam (§2.3). De-risked by baking the
  card from the same LOD00+alpha, putting the swap where the clump is already a few
  pixels, and keeping the gradient+wind on the card. **Ship Layer C behind Layers
  A+B** so the easy wins land first and Layer C can be A/B-compared.

### Why this combination
- Layer A kills the 6× cube multiplier (biggest in-play win, free).
- Layer B kills the wide-near-band over-draw for the chase cam (biggest main-pass
  win, one tuning pass) while preserving the idle preview vista.
- Layer C structurally caps far-band triangles (best look-per-triangle at distance)
  and is the natural home for any future `BatchedMesh` work.

---

## 4. Incremental rollout

1. **Layer A** (reflections agent): grass out of the cube `hide`. Measure: expect a
   large in-play triangle drop on cube frames; idle table unchanged (no cube
   without a player). *No grass-module change.*
2. **Layer B step 1 — profiles plumbing:** add `CHASE`/`IDLE` profiles to
   `config.ts`, thread a profile flag through `update()` (`types.ts`,`build.ts`),
   select it in `core.ts:2904`. Default both profiles to **today's values** first
   (pure refactor, byte-identical render) — land and verify replay green.
3. **Layer B step 2 — tune `CHASE`:** pull the chase radii in (§3 values), steepen
   the count-LOD ease to cubic. Measure chase-pose draws/tris/FPS; tune until the
   verge still reads lush from the car. Idle profile untouched.
4. **Layer C step 1 — bake + card geometry:** add the impostor bake + `lodCard` to
   `assets.ts`; render the card with a *placeholder* (e.g. reuse LOD02 material) to
   prove the swap path before the billboard shader.
5. **Layer C step 2 — billboard material + far-ring swap:** add the camera-facing
   vertex offset + impostor sampling in `material.ts`, switch the far ring to
   `lodCard` in `build.ts`. A/B against Layer-B-only at the chase pose.
6. **(If/when batching lands)** revisit collapsing the per-tile card draws into a
   `BatchedMesh` — coordinate with the batching sibling.

Each step is independently revertable and independently measurable on the frozen
gantry pose.

---

## 5. Pin-safety note

Every layer is presentation-only and preserves the existing determinism contract:

- **Render-driven, never sim.** Grass is updated only in the pixels-only tail of
  `frame()` (`core.ts:2904`, below the sim read-back line). All proposed changes
  live in `grass/*` and that one call site. Nothing touches the camera transform,
  physics, RNG (`simRand`/`rollSeed`), the recorder, `worldHash`, or any pin.
- **Placement stays build-time + deterministic.** `buildGrass()` placement
  (deterministic `hash01`) and the instance matrices are unchanged — the
  world-state at build time is identical. Layers B/C only change *what is drawn*
  (visibility, `mesh.count`, which geometry/material a tile shows), exactly as the
  existing distance-cull/LOD already does.
- **Profile selection reads render-time state only.** The CHASE/IDLE flag is
  derived from `this.player`/game-state the render tail already reads for audio and
  blur; it is never written back into the sim. (Even a wrong profile choice could
  only change pixels, never a checksum.)
- **Billboarding is GPU-side.** Camera-facing orientation is computed in the vertex
  shader from the view matrix — no per-frame CPU rewrite of instance matrices, no
  new CPU state that could leak into a pin. Same contract as the existing
  `onBeforeCompile` wind sway.
- **Cube exclusion is pure visibility.** Adding grass to the cube `hide` list only
  flips `mesh.visible` during the capture and restores it — the established
  pattern in `reflections.ts:44-62`.
- **`?verify=1` / headless unaffected.** Those runs already take the FAST tier and
  hash pixels nobody sees; the grass tier seam (`setTier`) is preserved. The replay
  suite (`npm test`) reads sim hashes, which none of this touches — expected green.
