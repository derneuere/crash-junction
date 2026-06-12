# REFLECTIONS PLAN — getting the Clutch paint sweep, concretely

**Question in one line:** the Clutch footage's car paint reflects the *actual street*
sweeping past — what is that effect made of, and what's the cheapest faithful
three.js construction of it in this codebase?

Companion to [clutch-look-gap.md](clutch-look-gap.md) (Tiers A+B planned out here).
Everything below is presentation-only — no camera position changes, no sim writes —
so both determinism pins are expected byte-exact (same contract as
[sense-of-speed.md](sense-of-speed.md)).

---

## 1. What "their reflections" actually are

Three separable layers, in order of visual contribution:

1. **IBL base** — the sky+sun lighting the clearcoat. Paint always has *something*
   in it: bright sky above the beltline, dark ground below. We already have this
   layer, but it reflects a **fake static showroom** (`Game.ts:260-277`,
   `makeCarEnvScene`) — a box with a hot strip — not the world the car drives in.
2. **Local capture** — buildings/cranes/walls visibly *sweeping through* the bonnet
   as the car moves. UE5 does this with Lumen reflections. The web equivalent is a
   **CubeCamera**: re-render the scene into a cube texture centred on the player
   every frame and feed it to the paint as `envMap`. This is the layer we're
   missing entirely, and it's the one that reads as "expensive".
3. **Highlight pop** — the sun glint on the clearcoat exceeding 1.0 and blooming
   out, plus the broad sun streak on the asphalt. Needs an HDR post chain (bloom
   before tonemap). We have no composer at all (`Game.ts:250-258`).

Layer 2 is the centrepiece. Layers 1 and 3 are what make layer 2 look *right*:
a cube capture of a flat-colour sky over an unlit world reflects nothing
interesting, and without bloom the sun glint is a grey dot.

**Why not SSR?** Screen-space reflections can only reflect what's on screen — the
buildings the paint reflects are mostly *behind the camera*. SSR is the road-mirror
tool (wet asphalt), not the paint tool. Skip it; revisit for wet-road looks later.

## 2. The plumbing we build on (verified in source)

- All cars share six singleton materials — `hullMat` (clearcoat 1.0, rough 0.32),
  `glassMat`, lights, metal, cabin (`geometry/shared.ts:16-74`), with an env
  registry: `setCarEnvMap()` / `registerCarMaterial()` / `applyCarEnvScale()`
  (`shared.ts:79-113`). Cars join the env via materials, **not**
  `scene.environment`.
- Baked hulls render `[hullMat, glassMat, headlightMat, taillightMat]` by index
  groups (`vehicles.ts:60`, `models.ts:417-425 applyHullGroups`).
- **All cars' detachable panels share one `panelMat = hullMat.clone()`**
  (`panels.ts:160-162`).
- Props clamp `metalness` to 0 because there is no `scene.environment` to reflect
  (`props.ts` loadPropScene — the Kenney metallicFactor=1 black-faces lesson).
- Render is one call at `Game.ts:1639`; resize `Game.ts:703`; dispose must keep the
  `forceContextLoss()` discipline (`Game.ts:557-558`).
- Day/night already swaps car env PMREMs (`Game.ts:265-277` envTex day/night,
  `daynight.ts applyTimeOfDay` sweep, `applyCarEnvScale` night dim).

## 3. Phased plan

### Phase 1 — world IBL: give reflections a world worth reflecting (Tier B1)

*New file `src/game/skyenv.ts`, edits in `Game.ts` ctor + `daynight.ts`.*

1. Build a `THREE.Sky` (examples/jsm/objects/Sky.js, Preetham model) in a tiny
   off-scene; aim its sun uniform along the existing key-light direction
   (`daynight.ts` sun positions, sprite at `Game.ts:304`).
2. `pmremGenerator.fromScene(skyScene)` → **`scene.environment`** (day). At night,
   assign the existing `makeNightEnvScene` PMREM (`Game.ts:267`) as
   `scene.environment` instead. Swap inside the existing time-of-day path
   (`Game.ts:386`).
3. `scene.background`: keep the Sky mesh itself as a background dome (sun disk
   sprite stays — it's the lens-flare/bloom anchor), or keep the flat colour for
   the first slice. Either way fog colour keys to the horizon tint.
4. **Delete the props metalness clamp** in `props.ts` — cranes, guardrails,
   bollards go properly metallic and pick up the sky. (This was always a
   workaround for the missing scene env.)
5. Rebalance: hemisphere intensity comes DOWN (~1.45 → ~0.9 day) because IBL now
   carries ambient; spot-check building window emissive tiers under ACES
   (the 2.6 intensity was tuned against no-IBL).
6. Cars keep the showroom env for now — rivals stay stylized; the player switches
   in Phase 2.

*Acceptance:* a debug chrome sphere (roughness 0, metalness 1) dropped at the
junction shows sky gradient + sun; Kenney metal props no longer matte; day/night
toggle swaps the world env; suite green, pins byte-exact.

### Phase 2 — live player reflections: the money shot (Tier B3)

*New file `src/game/reflections.ts`, edits in `shared.ts`, `vehicles.ts`,
`panels.ts`, `Game.ts`.*

1. **Capture rig** (`reflections.ts`):
   - `new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType })` +
     `new THREE.CubeCamera(0.5, 300, rt)`.
   - `update(renderer, scene, playerRoot, pos)`: position at player roof
     (+~1.2 m), set `playerRoot.visible = false` (a car must not reflect itself;
     loose detached panels are world objects and *should* stay visible), hide the
     camera-anchored streak lines (`effects/streaks.ts` — they'd smear the cube),
     `cubeCamera.update(renderer, scene)`, restore visibility.
   - After each update set `rt.texture.needsPMREMUpdate = true` — three re-filters
     render-target cube textures for PBR materials on that flag; at 128px the
     re-PMREM is cheap.
   - Renders happen *before* the main render in the frame (`Game.ts:1639`), so the
     shadow map generated for the cube pass is reused by the main pass — no double
     shadow cost.
2. **Player-only material set** (`shared.ts` + `vehicles.ts:60`):
   - Clone `[hullMat, glassMat, headlightMat, taillightMat]` for the player car
     and assign at mesh creation. **Keep clones OUT of `carMats`** — otherwise the
     next `setCarEnvMap()` (day/night swap, `Game.ts:386`) claws them back to the
     showroom. Add a parallel `setPlayerEnvMap(tex)` + small registry, mirroring
     the existing one, including the night `applyCarEnvScale` dim.
   - **Player panels too**: `panels.ts:160` shares one `panelMat` across every
     car — give player-owned panels a cloned panelMat from the player set, or the
     bonnet reflects the showroom while the wing reflects the street.
   - The daynight emissive sweep keys off `mat.userData.night` — copy userData on
     clone so headlights still light up.
3. **Intensities**: start hull 0.9 / glass 1.2 (the live world is dimmer than the
   showroom's hot strip; the showroom values 0.75/1.0 were tuned for that).
4. **Cadence & guards**: every frame at 128px first; if profiling demands, every
   2nd frame (reflections lag half a frame — invisible). Skip updates when
   `document.hidden` (rAF-starved preview windows) and in `?verify=1` fast
   replays. `rt.dispose()` in `Game.dispose()` (context-loss discipline).
5. Rivals/traffic stay on the static showroom — they're never close enough to the
   camera for the difference to read, and it keeps the cube pass cost at exactly
   one capture.

*Acceptance:* drive the gantry shortcut — crane lattice sweeps across the bonnet;
park under a building, windows visible in the roof; takedown cam (closest look at
rivals) shows no regression; suite green, pins byte-exact.

*Cost:* 6 small scene renders + PMREM ≈ 1.5–3 ms at 128px. The single biggest
perf knob in this plan — hence the quality toggle in Phase 4.

### Phase 3 — film-look post stack: make the glints pay off (Tier A)

*New file `src/game/postfx.ts`; deps `postprocessing`, `n8ao`,
`realism-effects`; edits `Game.ts:1639` (render), `:703` (resize), `:250-258`
(tonemap handoff).*

1. `EffectComposer` (pmndrs [postprocessing](https://github.com/pmndrs/postprocessing),
   `frameBufferType: HalfFloatType`, `multisampling: 4` on WebGL2):
   - `RenderPass(scene, camera)`
   - [`N8AOPostPass`](https://github.com/N8python/n8ao) half-res — grounds cars
     and props (we have zero contact darkening today).
   - `EffectPass(camera, MotionBlurEffect, BloomEffect, ToneMappingEffect)` —
     bloom on the HDR buffer **before** tonemap (intensity ~0.5, luminance
     threshold ~1.0 so only sun glints/emissives/explosions bloom);
     ACES moves here, `renderer.toneMapping = NoToneMapping` (double-tonemap is
     the classic integration bug).
   - `EffectPass(camera, VignetteEffect ~0.25, ChromaticAberrationEffect ~0.0015,
     NoiseEffect ~0.04)` — the "shot on a camera" wrapper.
2. **Motion blur** = [`realism-effects`](https://github.com/0beqz/realism-effects)
   `VelocityDepthNormalPass` + `MotionBlurEffect`: per-pixel velocity, so the
   world smears and the car (moving with the camera) stays sharp — exactly the
   footage. It's the second scene pass, so gate it to the 'cinematic' tier.
   Keep `effects/streaks.ts` for the 'fast' tier (they're the cheap stand-in).
3. **Lens flare**: stock `THREE.Lensflare` elements parented at the sun sprite
   position (`Game.ts:304`) — textured ghosts with built-in occlusion fade, a
   scene object, zero composer interaction. Day/dusk only.
4. **Quality toggle**: localStorage `cj-gfx` 'cinematic' | 'fast' next to the
   DAY/NIGHT chips (same App→Game plumbing as `cj-tod`; keep refshot.mjs
   button-text regexes working). 'fast' = today's bare `renderer.render` path,
   and stays the default for headless/suite/`?verify=1` runs.

*Acceptance:* sun blooms over rooftops and flares when it clears a building;
explosions bloom; 40 m/s run shows world-smear with sharp car; junction at night =
tail-light streaks bloom. Suite green in 'fast'; one cinematic real-time replay
eyeballed. Perf target ≥ 50 fps at DPR 1.75 on the dev box.

### Phase 4 — golden hour: light it like the footage (Tier B2)

*Edits `daynight.ts`, `Hud.tsx` (third time-of-day chip), `Game.ts` shadow setup.*

1. Third `TimeOfDay` 'dusk': sun elevation ~8° (Sky shader: turbidity ~6,
   mieCoefficient up for the warm haze), directional `0xffc88a` ~2.6, hemisphere
   cooled toward `0x7e90b8` ~0.9, fog warm-grey and pushed out. Re-bake
   `scene.environment` + a dusk car showroom variant via the existing
   `envTex` pattern.
2. **Long shadows**: the fixed ±34 m ortho box (`Game.ts:293-297`) can't do
   low-sun shadows. Re-centre the shadow camera each frame on a point ~25 m ahead
   of the player along travel, snap to shadow-texel grid (kills swimming), bump
   2048 → 4096. CSM is the stretch goal only — `csm.setupMaterial()` must touch
   every material including the Phase-2 clones; not worth it until the follow-box
   visibly fails.
3. `cj-tod` becomes 3-state (localStorage value 'dusk' added — per-card variant
   chips in the event picker per menu-event-picker.md when that lands).

*Acceptance:* dusk refshots at the four canonical poses vs the Clutch frame;
shadow stability driving the full gantry lap; pins byte-exact (lighting is
presentation).

## 4. Order & sizing

**1 → 2 → 3 → 4.** Phases 1+2 are one PR ("live reflections", ~1.5 days incl.
tuning), Phase 3 one PR ("film look", ~1 day), Phase 4 one PR ("golden hour",
~0.5–1 day). 1+2 ship the user-visible reflections win on their own; 3 makes the
glints bloom like the footage; 4 recreates the actual shot.

## 5. Risk register

| Risk | Where | Mitigation |
|---|---|---|
| `setCarEnvMap` claws player clones back to showroom | `shared.ts:101` on day/night swap | separate player registry, never in `carMats` |
| Shared `panelMat` across all cars | `panels.ts:160` | player panels get player-set clone |
| Double tonemap (renderer ACES + composer ACES) | `Game.ts:256` + postfx | `NoToneMapping` when composer active |
| Cube re-PMREM cost per frame | reflections.ts | 128px; every-2nd-frame fallback; 'fast' tier skips |
| Night sweep misses cloned lights | `daynight.ts` userData walk | copy `userData.night` on clone |
| Hemisphere + IBL double ambient | Phase 1 step 5 | drop hemi to ~0.9, re-tune night |
| HMR / dispose leaks (context cap) | `Game.ts:549-561` | composer.dispose + rt.dispose alongside forceContextLoss |
| Hidden-window rAF starvation corrupts captures | preview harness | skip cube update on `document.hidden` |
| refshot/suite drift | tools/refshot.mjs, tests | 'fast' default headless; keep HUD button text regexes |

Planned 2026-06-12. Source refs verified against main @ 9f8c157 (uncommitted
research docs tree).
