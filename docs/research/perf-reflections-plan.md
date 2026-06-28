# Gantry reflection draw-call plan — keep live paint reflection at a fraction of the cost

> Planning document. No code in this slice. Presentation-only / pin-safe throughout
> (the reflection never enters the sim/replay hash; see "Pin-safety" at the end).

## Problem (measured)

Frame-exact draw-call averages at the frozen gantry "dockyard" pose:

| Config | Draw calls | FPS | Triangles |
| --- | --- | --- | --- |
| Baseline (all on) | **1441** (swings 629 ↔ 2252/frame) | 31 | ~3.1M (swings ~0.25M ↔ ~3.1M) |
| Reflections OFF | **629** (rock-steady) | 60 | ~0.25M |
| Reflections + Props OFF | 210 | 60 | — |

The player-cube reflection alone costs **≈ 810 draw calls** and is the single biggest cost.
It is the source of both per-frame swings (the cube only captures on alternate frames).

### Why it is so expensive

`src/game/reflections.ts` (`PlayerReflections`) holds a `THREE.CubeCamera(0.5, 320)` writing a
`WebGLCubeRenderTarget(96, HalfFloat)`. `update()` calls `cam.update(renderer, scene)`, which
**re-renders the ENTIRE scene into 6 cube faces**. So on a capture frame the whole dressed scene
(~388 visible draw objects: instanced prop tiles, grass tiles, buildings, ground, road, cars)
is drawn six more times. ~388 × 6 ≈ 2300 extra draws on top of the ~629 main-view draws → the
2252-draw capture frames; off frames reuse the persisted cube → the 629 floor.

Gate / throttle today (`src/game/Game/core.ts`):
- Capture is gated in `frame()` at `if (p && this.gfx.reflections && this.renderFrame % this.cubeEvery === 0)`
  → `this.reflections.update(this.renderer, this.scene, p.group.position, [p.group, this.sunFlare.group])`.
- `cubeEvery = CUBE_EVERY_DEFAULT = 2` (`src/game/Game/lighting.ts`) → 30 Hz capture on a 60 Hz display.
- The capture freezes the shadow map (`shadowMap.autoUpdate = false`) and reuses this frame's, so the
  six faces add **no** extra shadow passes (already optimized).
- The `hide` list `[player.group, sunFlare.group]` is walked and every mesh/sprite/points under those
  subtrees is set `visible=false` for the capture, then restored. **This is the natural exclusion seam** —
  but it currently hides only the car + flare, not the hundreds of small props.

### How the player paint consumes the cube (the fidelity contract we must preserve)

- `src/game/geometry/shared/registry.ts`: the player car wears **cloned** materials (`playerSwap`)
  outside the shared `carMats` set, pointed at the cube via `setPlayerEnvMap(tex)`.
- `src/game/Game/core.ts` `refreshPlayerEnv()` sets the player env to `this.reflections.texture` in cine.
- The cube's texture has `needsPMREMUpdate = true` set each capture → three lazily re-runs the roughness
  **PMREM prefilter** before the paint samples it. **This blurs the capture heavily.** The clearcoat is a
  streaky curved-paint reflection, not a mirror — high spatial frequencies in the cube are thrown away.
  This is the key fidelity fact: *the cube does not need to contain small or distant detail.*

### What is actually in the scene (so we know what to keep vs drop in the cube)

- **Big / reflectable** (added directly to `scene` in `src/game/environment/build.ts`): ground plane,
  road pads/strips, sidewalk-walk batches, **buildings** (`BoxGeometry` blocks, ~tall), launch ramps,
  plus sky dome (`skyRig.mesh`), sun/moon sprites, the directional/hemisphere light, and the
  **other cars** (rivals/traffic) — these dominate what a curved clearcoat visibly reflects.
- **Small props** (under `propsGroup` "cj-props", `src/game/props.ts` + `src/game/propinstancer.ts`):
  ~300 hand-placed containers, crates, bollards, lamps, rocks, trees, cranes — emitted as **per-tile
  InstancedMesh** + singleton plain meshes. These are the bulk of the ~388 objects and contribute almost
  nothing a blurred clearcoat can resolve. (Cranes/warehouses are arguably "big", but they're inside the
  same group as the crates — see layer-tagging note below.)
- **Grass** (`src/game/grass.ts` → `grass/build.ts`): per-tile `InstancedMesh` added **directly to the
  scene** (not under propsGroup), exposed as `grass.meshes`. Pure noise in a reflection.

Object/draw budget rough split at the dockyard pose: ~388 capturable objects ≈ buildings/ground/road/ramps
(~40–60) + cars (~6–10) + **props (~250–300 tiles+singletons) + grass (~30–50 tiles)**. So props + grass are
**~80–90%** of the per-face cost.

---

## Options (with tradeoffs)

### Option A — Layer-based capture exclusion (THREE.Layers) — **headline win**

Give the CubeCamera a dedicated "reflectable" layer and only render that layer into the cube.

Mechanism (three 0.170): every `Object3D` has an `.layers` mask; a camera renders an object only if
`camera.layers.test(object.layers)`. So:
1. Reserve a layer, e.g. `REFLECT_LAYER = 1` (layer 0 stays the default everything-layer the **main**
   camera and shadows use, untouched).
2. **Enable** layer 1 on the things the cube should see: ground, road, walks, buildings, ramps, sky dome,
   sun/moon sprites, and **all car groups** (`o.layers.enable(1)` — `enable`, not `set`, so they keep
   layer 0 and still render in the main view). The directional + hemisphere lights must also be on the
   cube's layer or the captured faces go unlit — `light.layers.enable(1)` (and keep the visible-light
   **count** identical so no second shader-program signature compiles; the existing `hide`-keeps-lights
   note in `reflections.ts` is the same constraint).
3. **Leave** props (`propsGroup`) and grass (`grass.meshes`) on layer 0 only → the cube skips them
   entirely.
4. In `PlayerReflections`, set `this.cam.layers.set(REFLECT_LAYER)` once in the constructor (or
   `enableAll()` then `disable(0)` — simplest is `set(1)` so the cube renders **only** layer 1).

Expected savings: cube content collapses from ~388 objects to **~50–150** (the explicitly-tagged big
stuff + cars). Per-face cost drops ~60–85%; the ×6 multiply on the dropped ~250–300 prop/grass objects
disappears. Capture-frame draws fall from ~2252 toward **~900–1100**; the dockyard frame average moves
from 1441 toward the ~700–900 range, i.e. most of the gap to the 629 "reflections-off" floor closes
while the reflection stays live. **This is the recommended core change.**

Tradeoffs / fidelity risk: small. A blurred clearcoat can't resolve a crate; losing crates/grass from the
reflection is imperceptible on a moving car. The one judgement call is whether the **cranes/warehouses**
(big silhouettes) should reflect — see rollout step 2 for a cheap per-prop opt-in.

Why Layers over extending the `hide` list: hiding ~300 subtrees means a traverse that flips `visible` on
hundreds of meshes every capture and restores them — O(n) work per capture and brittle (streamed-in props,
restore-on-throw). A layer mask is a single per-object bit set **once at build time** and a single
`cam.layers.set()`; the renderer's existing per-object `layers.test()` does the culling for free. The
existing `hide` param stays for the genuinely per-frame, must-not-self-reflect cases (the player car, the
screen-space flare).

### Option B — Cheaper cube geometry (resolution / faces / cadence)

Independent knobs that compound with A:
- **Face resolution**: already 96px (header notes 96 reads like 128 post-PMREM). Could drop to **64px**
  for more fragment/bandwidth savings — but this is the *fragment* half, **not draw calls**, so it does
  **nothing** for the 31-fps draw-call bottleneck. Defer; A is the draw-call lever.
- **Fewer faces**: the car mostly sees a horizontal band — the **±Y (up/down)** faces buy little on a
  ground vehicle (down = road, up = sky already in the static env). A custom 4-face (or 5-face, keep +Y
  for sky glints) capture would cut the ×6 to ×4–5 (~17–33% off whatever A leaves). Requires replacing
  `CubeCamera.update()` with a hand-rolled per-face loop (render the 4 side faces into the cube RT faces);
  more code, moderate payoff. **Secondary** to A.
- **Cadence (`cubeEvery`)**: bump 2 → **3** (20 Hz capture). Halves-again the *amortized* cube cost and is
  a one-line default change (`CUBE_EVERY_DEFAULT`), already debug-tunable via `setCubeEvery`. On a fast-
  moving car 20 Hz is borderline (the reflection can visibly step); 30 Hz (current) is the safer ship
  value. Reserve `cubeEvery=3` as the low-end-GPU fallback, not the default. Note: cadence lowers the
  **average**, not the **peak** capture-frame cost (the 2252 spike), so it does nothing for the per-frame
  swing / frame-time spikes that hurt smoothness — A and B-faces attack the peak, cadence only the mean.

### Option C — Drop the dynamic cube for a blended/static env

- **Blended static env + tiny dynamic top/side**: the showroom/sky PMREM already exists
  (`envTex.day/dusk/night`, `makeCarEnvScene`/sky bake). Point the player paint back at the static PMREM
  and add only a **1–2 face** low-res dynamic capture for the dominant near-band. Big draw-call win, but
  loses the "world sweeps through the paint" signature the whole feature exists for. Keep as the **lowest
  graphics tier** fallback, not the default.
- **Screen-space reflections (SSR)**: a postfx pass (`postfx.ts` is the seam). Reflects exactly what's on
  screen at near-zero draw-call cost, but cannot reflect anything off-screen (most of the car's own paint
  faces away from the camera-visible set) and is famously noisy on curved surfaces. Poor fit for car paint;
  **not recommended.**
- **Planar ground reflection**: one extra mirrored-camera pass for a flat reflector. Wrong primitive — the
  car paint is curved, not a floor mirror. **Not recommended.**

---

## Recommended approach

**Adopt Option A (Layers exclusion) as the core fix, with `cubeEvery` kept at 2 and a `cubeEvery=3`
low-tier fallback. Defer B-faces and resolution as follow-ups; keep C only as a lowest-tier fallback.**

Concrete touch points:

1. **`src/game/reflections.ts`** — add `export const REFLECT_LAYER = 1;`. In the `PlayerReflections`
   constructor, `this.cam.layers.set(REFLECT_LAYER);` so the cube renders **only** that layer. Keep the
   `hide` param and the shadow-freeze logic exactly as-is (still needed to suppress the player car + flare,
   which we *do* tag onto the reflect layer because they're otherwise reflectable cars/sprites).

2. **Tag the reflectable set onto the layer at build time.** A single helper, e.g.
   `markReflectable(obj: THREE.Object3D)` that does `obj.traverse(o => o.layers.enable(REFLECT_LAYER))`.
   Call it from `core.ts` after the scene is built, on:
   - the big environment meshes — cleanest is to have `buildEnvironment` (`environment/build.ts`) tag
     ground/road/walks/buildings/ramps as it adds them, **or** tag them in bulk from `core.ts` by walking
     `scene.children` and enabling the layer on everything **except** `propsGroup` and `grass.meshes`
     (allow-list-by-exclusion is fewest edits);
   - `skyRig.mesh`, `sunSprite`, `moonSprite`;
   - `this.sun` and `this.hemi` (`light.layers.enable(REFLECT_LAYER)`) — **required** or faces render
     unlit; verify the visible-light count seen by the cube equals the main view's so no parallel shader
     program compiles (matches the existing `reflections.ts` light-count contract);
   - **every car group** as it's built in `buildActors()` (`actor.group.layers.enable(REFLECT_LAYER)`,
     traverse so wheels/glass inherit). Cars are the most valuable reflected content after buildings.

   Explicitly **do not** tag `propsGroup` or `grass.meshes` — they stay layer-0-only and vanish from the
   cube. (Newly streamed-in prop visuals inherit nothing, so they're excluded for free.)

3. **Keep the `hide` call** in `core.ts` (`[p.group, this.sunFlare.group]`) — the player car is on the
   reflect layer (it's a car) so it would otherwise reflect itself; `hide` still suppresses it per-capture.

Expected draw-call savings (dockyard pose): capture-frame ~2252 → **~900–1100**; props (~250–300) and grass
(~30–50) × the cube faces removed. Frame average 1441 → **~750–950**, FPS from 31 toward 55–60 on the
capture cadence. Most of the 1441→629 gap recovered **with the live reflection still on**.

Fidelity risk: **low**. Post-PMREM the paint can't resolve the dropped props/grass; buildings, cars, sky,
ground/road — the things that actually streak through clearcoat — all remain. The only visible change a
careful eye could catch is large near cranes no longer appearing in the paint; address with the per-prop
opt-in in rollout step 2 if it reads.

---

## Incremental rollout

1. **Slice 1 — Layer plumbing + exclude props & grass.** Add `REFLECT_LAYER`, `cam.layers.set`, the
   `markReflectable` helper, tag env + lights + cars, leave props/grass off. Measure the dockyard pose
   against the table above (expect capture frames ~900–1100, average toward ~800). This is the whole win.
2. **Slice 2 — Selectively re-admit big props (optional).** If cranes/warehouses are missed in the paint,
   add a `reflectable?: boolean` flag to those `PropDef`s (or match by URL) and `enable(REFLECT_LAYER)` on
   just those instanced tiles in `props.ts`/`propinstancer.ts`. Adds back only a handful of big silhouettes,
   keeping the ~250 crates/bollards/grass excluded.
3. **Slice 3 — Cadence fallback.** Wire `cubeEvery=3` into the lowest graphics tier (the existing
   `setCubeEvery` debug seam + a graphics setting), default stays 2.
4. **Slice 4 (defer) — Fewer faces / lower res.** Only if a low-end GPU target still needs it: hand-roll a
   4–5 face capture and/or drop the face RT to 64px. More code; revisit after Slices 1–3 land.

Each slice is independently shippable and measurable at the frozen pose.

## Pin-safety note

All of the above is **presentation-only and pin-safe**:
- The reflection subsystem reads the scene and writes a texture the **sim never samples**; the cube
  capture, `cubeEvery` counter, and layer masks all live in the pixels-only tail of `frame()` below the
  sim read-back line (same contract as sea/grass/cloud drift).
- **`Object3D.layers` and `Camera.layers` are render-time visibility masks** — three uses them only inside
  the render walk. They do not touch physics (cannon bodies are separate), RNG, recorded keys, `worldHash`,
  or the camera *position* (which **is** sim state and is **not** changed here — we only change what the
  *cube* camera renders, never the main `this.camera` transform).
- Headless verify (`?verify=1` / `forceFast`) takes the bare-renderer path and never runs the cube at all
  (`cineActive()` is false), so the replay suite is untouched by construction. The existing 3 pre-existing
  replay-fixture failures on origin/main are unrelated.

The replay suite must stay green; nothing in this plan writes sim state, so it will.
