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

## Not done (deliberately, demo-scoped)
- perf-reflections-plan Option A proper (THREE.Layers) — the hide-list seam
  delivers the same exclusion; revisit if the per-capture traverse ever shows.
- perf-shadows-plan decor-caster pruning (~137 desktop draws, not the phone
  bottleneck), grass Layer B/C impostors, physics `maxSteps` tuning (sim-
  visible — determinism review needed before touching).
- Real-device numbers: preview GPU ≠ A13. The stats HUD is on by default —
  read FPS on the phone itself; if a pose still dips, next levers are
  `renderScale 0.75 → 0.6` and `cubeEvery`/`grassRange`.
