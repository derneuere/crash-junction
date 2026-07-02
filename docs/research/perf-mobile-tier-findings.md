# Mobile quality tier — iPhone-class 60 fps pass (findings + measurements)

Branch: `perf/iphone-60fps` (base `fix/jump-landing-and-air-control` @ 69ee4b0
+ merge of `feat/mobile-controls`). Goal: Gantry Point demo on an iPhone 11
(A13, Safari, DPR 2) — measured 11 fps before this pass.

## Where the frame actually died (measured)

Baseline probe (`tests/drawcall-poses.mjs`, gantry day, post-prop-batching):

| Pose | MAIN calls / tris | CUBE ×6 calls / tris |
| --- | --- | --- |
| dockyard | 223 / 0.89M | 2064 / 12.8M |
| harbor | 171 / 0.39M | 2132 / 13.3M |
| straight | 273 / 1.35M | 2161 / 14.2M |
| ontrack | 202 / 0.66M | 2116 / 13.4M |

The main pass was already lean (PR #12 batching shipped). The costs a phone
GPU cannot pay were the **multipliers**:

1. **Player cube reflection** — whole-scene ×6 re-render every other frame
   (~2100 draws / ~13M tris per capture).
2. **Film-look composer** (postfx.ts) — always-on 4×MSAA HalfFloat buffer +
   N8AO + bloom chain, at DPR 1.75.
3. **Shadow fill** — 3072² PCFSoft depth raster + wide per-fragment kernel.
4. **Native-DPR fill** on a 828×1792 panel.

## What shipped

### For every tier
- **Cube capture excludes props + grass** via the existing `hide` seam in
  `core.ts` (perf-reflections-plan §2.0 / Option A intent — the PMREM-blurred
  clearcoat can't resolve a crate or a blade). Measured live (idle-orbit pose,
  real render path): capture **1143 → 411 draws, 8.18M → 1.04M tris**.
- **`refreshPlayerEnv` fix**: with `gfx.reflections` off the paint now falls
  back to the static showroom PMREM — previously it kept sampling the live
  cube RT, which is never written when the toggle is off (black paint).

### The phone tier (`TIER_PRESETS.phone`, graphics.ts)
Auto-selected when `IS_MOBILE` (mobile UA, or iPadOS Mac-masquerade with
touch); every field user-overridable in the graphics overlay (new QUALITY
PRESET buttons + FILM POSTFX toggle):

| Knob | Desktop | Phone | Effect |
| --- | --- | --- | --- |
| `reflections` | on | **off** | no ×6 capture at all; showroom paint |
| `postfx` | on | **off** | bare `renderer.render`, renderer-level ACES; no MSAA HDR buffer / N8AO / bloom |
| `ao` | on | **off** | (subsumed by postfx off; kept explicit) |
| `renderScale` | 1 | **0.75** | pixel ratio 1.75 → 1.3125 on DPR-2 phones ⇒ ~44% fewer shaded pixels |
| `shadowSize` | 3072 | **1536** | 4× fewer depth texels; + `PCFShadowMap` (not Soft) on mobile at renderer creation |
| `grassRange` | 1 | **0.6** | grass LOD rings pulled in (`GrassField.setRangeScale`) — FULL 64→38 m, CULL 210→126 m |

Old `cj-gfx` blobs (pre-tier schema) are treated as stale **on mobile only**
(storage.ts) so a phone that saved `reflections:true` under the old defaults
doesn't boot back into the hole.

### Merged for the demo
`feat/mobile-controls` (087851c): touch steering/throttle overlay (gates on
`(pointer: coarse)`), phone-friendly menu.

## Measured after (live game, real render path)

| Config | Draws | Tris | Notes |
| --- | --- | --- | --- |
| Desktop tier, capture frame (idle pose) | ~470 main + 411 cube | ~3.8M | was ~470 + 1143 / ~11M |
| Phone tier, idle orbit | 250 | 0.77M | 60 fps in preview |
| **Phone tier, chase cam in race** | **118–160** | **~1.05M** | 60 fps in preview |

Per-frame GPU load on the phone tier vs the old capture frame: roughly **8×
fewer draws, ~10× fewer triangles**, ~44% fewer shaded pixels, each pixel far
cheaper (no HDR MSAA resolve, no N8AO, 4× fewer shadow texels, cheap PCF).

## Verification
- `tsc --noEmit` clean; `vite build` clean.
- Replay suite: same 8 pass / same 3 pre-existing branch-HEAD failures
  (junction ramp T-bone, race wheels-strip, proving-ground diagonal air) —
  determinism untouched (every change is presentation-only: hide lists,
  pixel ratio, shadow-map size/type, tone-map owner, grass ring radii).
- Visual: phone tier keeps glossy showroom paint, near-field grass, props,
  clouds, real-time shadows; desktop tier unchanged (film look + live cube).

## Round 2 — on-device feedback (14 fps, worst at the dockyard)

The first on-device test came back 14 fps — and crucially, the ORIGINAL 11 fps
test already had reflections + grass off, so the cube win never applied to
that number; postfx/renderScale/shadows alone bought +3. The dockyard being
the worst spot pointed at the drawn dressing itself. Desktop split at the
phone tier measured sim ≈ 3.9 ms / render-submit ≈ 13.8 ms — render-side
still the wall (and at 14 fps the fixed-step catch-up multiplies sim ~3×,
which self-heals as render gets cheaper).

### Fog-line prop culling (all tiers) + `drawDistance` knob

Key observation: anything fully past `fog.far` is rendered fog-coloured —
rasterised but invisible. So:

- `PropInstancer` now keeps a cull list of every emitted draw unit — per-tile
  InstancedMeshes and singletons flip `visible`; **BatchedMesh members flip
  `setVisibleAt` per instance** (the batch stays, its far members stop
  rasterising). World bounding radius rides in the distance test, so a 30 m
  crane survives far longer than a bollard — size-aware for free.
- `Game.frame()` drives it at `fog.far × 1.15` each frame (render tail,
  pin-safe, same contract as the grass tile cull).
- New `drawDistance` graphics field scales the authored fog band (far ×k,
  near ×√k): desktop 1, phone 0.6 → gantry race fog 90/340 → 70/204.

Measured at the frozen dockyard vista pose (main pass):

| Config | Calls | Tris |
| --- | --- | --- |
| Pre-cull baseline (probe, this morning) | 223 | 0.89M |
| Desktop tier + fog-line cull | 298* | **0.25M** |
| Phone tier (fog 204, cull 235 m) | 234* | **0.22M** |

\* call counts not directly comparable (baseline was idle grid; these are
mid-race with rivals in frustum) — the triangle column is the story: the
far side of the loop was in-frustum and fully fogged, now gone. **72%
triangle cut at the worst pose, visually free** (verified: fog silhouettes,
no cut line).

### HUD: SIM / REN ms rows

`perfLive()` now reports smoothed `simMs` (fixed steps + game logic) and
`drawMs` (cube + composer/renderer submit); the stats HUD shows them as SIM /
REN. **On the next device test these two numbers settle CPU-vs-GPU
definitively**: if SIM dominates at low fps, the wall is cannon-es + 26
actors (a sim-side, determinism-review change — cut traffic count or steps);
if REN dominates, keep cutting fill/draws (renderScale 0.6, water off).

## Round 3 — draw-call attribution (15–16 fps on device; "chase view draws more than top-down")

Hooked `renderer.renderBufferDirect` to attribute every draw to its object +
pass (phone tier, manual renders so the shadow pass is included). The user's
hunch was right on both counts:

| Pose | Total | Top sources |
| --- | --- | --- |
| chase (car height) | **546** / 1.14M tris | **cars main 173 + cars shadow 72**, prop-batched 159*, buildings 70, grass tiles 46 |
| dockyard top-down | 255 / 0.25M tris | prop-batched 88, cars shadow 72, prop tiles 38 |

The chase view draws 2× the dockyard because at car height you see the CARS
(and street-level grass/buildings). **One car = ~33 main + ~15 shadow draws**:
multi-material hull ≈ 4 (paint/glass/head/tail), 6 detachable panels (inside
pivot Groups!), 4 wheels, a 2-draw INTERIOR mesh that is only ever visible
through crash wounds, the wing — × 26 actors.

\* `cj-prop-batched` invocation counts are per-geometry fallback draws in the
SwiftShader harness; on iOS 17.4+ Safari `WEBGL_multi_draw` collapses each
batch to ~1 real call — keep the demo iPhone's iOS current.

### What shipped (`carlod.ts`, driven from the render tail like the prop cull)

Per NON-player car (player always full detail):
- **interior drawn only while damaged and < 30 m** — a pristine car fully
  occludes its innards; the whole field is pristine at the start. Measured
  −20 main draws at the grid pack.
- **> 52 m: panels + wheels + small bits hidden → hull-only (~4 draws)**; the
  hull is a complete baked body, so no holes. Hysteresis rings prevent strobe.
- **past the fog horizon: whole car hidden** (was rasterised fog-coloured).
- **shadow casters pruned to the hull, once, all cars incl. player** — the
  sun blob is the hull silhouette; panel/wheel shadows never read. Measured
  car shadow draws **97 → 27** at the grid pose.

Detach safety: parts that leave the car's group (shunt-torn panels →
looseParts debris) drop out of the LOD lists via an ancestor check, so the
LOD never fights the debris system. Everything is visibility/castShadow flags
in the render tail — pin-safe, replay suite untouched.

### Known residual: the start-grid pack

Cars within ~44 m keep panels + wheels by design (you're racing them). The
race start therefore still pays ~15 draws/car for the pack ahead; the LOD's
main-view win grows as the field spreads. If the pack itself ever needs to be
cheaper, the next lever is merging the panel meshes into the hull draw for
REMOTE cars only (rivals don't deform per-panel until hit) — bigger surgery,
not taken.

## Round 5 — CPU pass: the O(n²) broadphase degeneration

Benchmarked the sim by manually driving `advance(1/60)` ×300 in-page with
sub-timers monkey-patched onto the cannon-es internals (immune to the
hidden-tab rAF):

| Component | ms/frame (desktop) | share |
| --- | --- | --- |
| whole `advance` | 1.75 | 100% |
| `world.step` (×2 substeps) | 1.66 | 95% |
| **`broadphase.collisionPairs`** | **0.99** | **60%** |
| `narrowphase.getContacts` | 0.045 | 3% |
| `solver.solve` | 0.003 | — |
| game logic (advance − step) | 0.09 | 5% |

Every presentation-tail helper (grass update, prop cull, car LOD, blob
shadows, sea, audio frame) measured < 0.05 ms — noise.

**Root cause:** cannon-es `SAPBroadphase.collisionPairs` tests
`needBroadphaseCollision` BEFORE the sorted-axis bounds `break` and
`continue`s on rejection. A STATIC or SLEEPING body is rejected against
everything, so its sweep never breaks and scans the entire remaining list.
With ~490 static prop/wall/building bodies out of ~515, that's ~265k
rejected-pair calls per frame — a stock-library O(n²) wart, not our code.

**Fix (`StaticAwareSAPBroadphase`, physics.ts):** flag bodies once per sweep
as inert (static-or-sleeping — the exact reject predicate); an inert body
sweeps only the ascending list of non-inert bodies ahead of it. Every skipped
pair is one the stock loop `continue`d over with no side effects, and the
first bounds-fail against a non-inert body breaks exactly where the stock
loop would have — **the emitted pair list is bit-identical (same pairs, same
order), so the solver sees byte-identical inputs.** Proven by the replay
suite passing unchanged.

**Measured after:** broadphase **0.99 → 0.055 ms (18×)**; whole sim frame
**1.75 → 0.32 ms (5.5×)**, same scene (499 bodies, 6 awake). Sim CPU is now
~0.3 ms/frame on desktop — even at a 2–3× A13 penalty it is comfortably
inside the 60 fps budget, which effectively eliminates "physics catch-up
spiral" as a bottleneck candidate on the phone.

## Not done (deliberately, demo-scoped)
- perf-reflections-plan Option A proper (THREE.Layers) — the hide-list seam
  delivers the same exclusion; revisit if the per-capture traverse ever shows.
- perf-shadows-plan decor-caster pruning (~137 desktop draws, not the phone
  bottleneck), grass Layer B/C impostors, physics `maxSteps` tuning (sim-
  visible — determinism review needed before touching).
- Real-device numbers: preview GPU ≠ A13. The stats HUD is on by default —
  read FPS on the phone itself; if a pose still dips, next levers are
  `renderScale 0.75 → 0.6` and `cubeEvery`/`grassRange`.
