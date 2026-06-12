# CLUTCH LOOK GAP — what's between our frame and theirs

**Question in one line:** the Clutch pre-release footage (Maverick Games, June 2026)
reads as photoreal cinema — which parts of that read are post-processing and lighting
we can adopt cheaply, and which parts are asset fidelity we can't?

**The reference:** [Clutch](https://en.wikipedia.org/wiki/Clutch_(video_game)) was
revealed 2026-06-02 by Maverick Games — studio head Mike Brown and the core
leadership of Playground Games / Forza Horizon, on a customised Unreal Engine 5,
set on the French Riviera, shipping spring 2027
([OverTake](https://www.overtake.gg/news/maverick-games-reveals-open-world-racing-game-clutch-set-for-spring-2027-release.4540/),
[VGC](https://www.videogameschronicle.com/news/ex-forza-devs-reveal-clutch-their-own-open-world-racing-game/)).
The analysed frame: M3 GTR-style hero car chasing into a low sun through a Riviera
hill town — heavy bloom + lens flare, strong peripheral motion blur, long warm
shadows, dense mid-rise facades with trees, yellow speed readout ("271"),
white track-outline minimap bottom-left, circular gauge bottom-right.

**The constraint that shapes everything here** (same as
[sense-of-speed.md](sense-of-speed.md)): the camera **position/orientation** is sim
state; FOV, post-processing, particles, HUD, lighting, sky and materials are
presentation-only and free. Every proposal below is presentation-only — nothing
re-records the replay pins. The real budget is **GPU frame time**, not determinism
(pixelRatio is already capped at 1.75, `Game.ts:252`).

---

## 1. Deconstructing their frame

What actually makes the shot read "AAA", in rough order of contribution:

1. **The sun is an event.** Low elevation (~5–10°), directly in frame, with
   full-screen bloom, anamorphic-ish flare ghosts, and god-ray glow over the
   buildings. Everything is graded warm against cool blue shadow.
2. **Camera-velocity motion blur.** Road and walls smear hard at the periphery;
   the car (moving with the camera) stays sharp. This is a velocity-buffer blur,
   not a radial cheat.
3. **The world is lit by the sky, not by three lights.** UE5 Lumen GI: facades
   bounce warm light, shadowed sides pick up sky blue, the car reflects the
   *actual street*, not a showroom.
4. **Asset density.** Riviera apartment blocks with balconies and shutters, trees
   overhanging stone walls, guardrails, parked cars, oncoming traffic, worn road
   decals. Thousands of artist-hours of licensed-quality content.
5. **Hero car fidelity.** UV-textured livery, decals, French plate, detailed
   wheels with spin blur, clearcoat paint picking up scene reflections, soft AO
   under the sills.
6. **Filmic image pipeline.** TAA, subtle DoF in the far field, vignette, grain —
   the "shot on a camera" wrapper.
7. **Minimal confident HUD.** One yellow speed number, a white track outline with
   position dots, one circular dial. No chrome, no boxes.

Items 1, 2, 6, 7 are **code**. Item 3 is **half code** (IBL + tuning), half
out of reach (real GI). Items 4–5 are **content** — the unbounded part.

## 2. What we already run (closer than it looks)

| Theirs | Ours today | Where |
|---|---|---|
| ACES filmic tonemap | ✅ `ACESFilmicToneMapping`, exposure 1.05 | `Game.ts:250` |
| Clearcoat car paint | ✅ `MeshPhysicalMaterial`, clearcoat 1.0 | `geometry/shared.ts:16` |
| Soft shadows | ✅ PCFSoft, 2048², but only ±34 m bounds | `daynight.ts:289` |
| Paint reflections | ⚠ static PMREM "showroom", cars only | `Game.ts:73-104` |
| Sky | ⚠ flat colour + sun/moon glow sprites | `daynight.ts:303` |
| Motion blur | ⚠ 96 peripheral streak lines (cheap stand-in) | `effects/streaks.ts` |
| Speed FOV | ✅ 55°→74° curve + boost kick | `camera.ts` |
| Bloom / flare / AO / grain | ❌ no EffectComposer at all | `Game.ts:246-258` |
| Minimap / speedo | ❌ none (score, boost bar, flash text only) | `ui/Hud.tsx` |

The intentional house style is Burnout-3-stylized, vertex-coloured, deterministic.
The goal below is **not** photorealism — it's stealing the *cinematic read*
(items 1, 2, 6, 7, half of 3) while keeping the stylization.

## 3. Ranked proposals

### Tier A — the post stack (one PR, biggest single jump)

The frame's "wow" is mostly full-screen passes we don't run. Adopt the pmndrs
[`postprocessing`](https://github.com/pmndrs/postprocessing) composer (faster than
three's stock EffectComposer, merges effects into single passes):

- **A1. Bloom** on the sun sprite, emissives (tail-lights at night!), explosion
  sprites and specular hits. Half-res, luminance-thresholded. This alone
  transforms the explosion/crashbreaker shots.
- **A2. Lens flare.** Baseline: three's stock
  [`Lensflare`](https://threejs.org/docs/#examples/en/objects/Lensflare) textured
  ghosts parented to the sun, occlusion-faded. Sells "camera", costs nothing.
- **A3. Real camera motion blur** via
  [`realism-effects`](https://github.com/0beqz/realism-effects)
  (`VelocityDepthNormalPass` + `MotionBlur`) — per-pixel velocity, so the car
  stays sharp and the world smears, exactly like the footage. Keep streaks for
  the >40 m/s top end; gate the pass off below ~15 m/s. Presentation-only by
  construction.
- **A4. AO**: [`n8ao`](https://github.com/N8python/n8ao) — grounds cars and props
  (we currently have zero contact darkening; airborne wrecks visibly float).
- **A5. Grade wrapper**: Vignette + film grain + ~0.4px chromatic aberration from
  `postprocessing` built-ins. Five lines, big "footage" feel.
- **A6. AA**: composer disables MSAA → use SMAA effect (or the WebGL2
  multisampled buffer option in `postprocessing`).

Perf note: budget ~3–5 ms at 1080p×1.75 for A1+A4+A5+A6; A3 is the expensive one
(~2–4 ms) — make it a quality toggle next to the existing day/night toggle.

### Tier B — light the world like a place, not a showroom

- **B1. `scene.environment` from a real sky.** Render three's
  [Sky shader](https://threejs.org/examples/#webgl_shaders_sky) (Preetham) into the
  existing PMREM generator per time-of-day and assign to `scene.environment` +
  `scene.background`. Gradient sky replaces the flat `0xb6cde6`, and **the prop
  metalness downgrade dies** — `props.ts:35-42` only forces dielectric because
  there's no scene env to reflect.
- **B2. Golden-hour preset.** The footage is shot at ~8° sun elevation. Add a
  third time-of-day ("dusk"): sun colour ~0xffc88a, intensity ~2.6, near-horizon
  position, hemisphere cooled toward blue. Long shadows need bigger coverage →
  either a camera-following 4096² frustum or three's
  [CSM example](https://threejs.org/examples/#webgl_shadowmap_csm) with 2–3
  cascades.
- **B3. Live paint reflections.** One 128px `CubeCamera` updated every other
  frame, feeding only the **player** hull/glass env — buildings actually sweep
  through the paint like the footage. Rivals keep the static showroom PMREM.
- **B4. Aerial perspective.** Push fog toward a blue-grey haze (`FogExp2`
  ~0.006) so distant blocks sit back in atmosphere; optionally
  `postprocessing` GodRays from the sun sprite for the over-the-rooftops glow.

### Tier C — content density (the honest long pole)

This is where Clutch is a 100-person UE5 team and we're procedural canvas
textures at 64–512px (`textures.ts`). Achievable middle ground, in order:

- **C1. Road material.** Tiling asphalt albedo+normal+roughness from
  [ambientCG](https://ambientcg.com) (CC0) on the ribbon UVs; keep the painted
  line InstancedMesh but add worn-alpha variation. Roads fill half of every frame.
- **C2. Wheel spin blur.** Swap to a blurred-spoke wheel variant (or alpha disc)
  above ~20 rad/s. Tiny, hugely sells speed next to motion blur.
- **C3. Facade depth.** Balcony ledge extrusions + awning quads on the window-grid
  buildings; one CC0 facade normal map. Silhouette stays low-poly.
- **C4. Route dressing density.** Tree/parked-car/lamp instancing along race
  ribbons (the async props pipeline already supports it) — the footage's density
  read is mostly *stuff at the road edge*, not building quality.
- **C5. Hero-car livery pass.** UV-decal bake (stripes, plate, sponsor blocks) on
  top of vertex colour for the player skins. **Caution:** the damage/panel system
  bakes vertex colours at load (`models.ts`) — decals must ride the same bake or
  they'll detach from panels.

### Tier D — HUD (cheapest, do any time)

- **D1. Speed readout.** Big yellow mph number, top-centre, Impact-skewed like the
  existing chips. The sim already has body velocity; pure presentation.
- **D2. Track-outline minimap.** Render the section centreline polyline once to an
  offscreen canvas (white, rounded joins), bottom-left, with dots per racer from
  the existing race-position data. Static north-up, exactly like the footage.
- **D3. Circular boost dial.** Re-skin the boost bar as a bottom-right radial
  gauge (SVG arc), needle = boost, ring flash = crashbreaker ready.

## 4. What we should *not* chase

- **Lumen-class GI, Nanite-class geometry, licensed car models** — engine and
  content budgets, not techniques. B1+B3 fake the lighting read; C-tier fakes the
  density read at our art style.
- **Per-object DoF** — subtle in the footage, expensive, and fights gameplay
  readability at our camera distance. Skip until everything else lands.
- **Replacing the camera rig** to match their lower/longer framing — camera
  position is sim state; any change re-records both determinism pins. FOV and
  post are where we buy "speed cinema" for free (see sense-of-speed.md).

## 5. Suggested slicing

1. **PR "film look"**: Tier A complete + D1 (speedo). One toggle for the whole
   stack. This is ~70% of the perceived gap.
2. **PR "golden hour"**: B1 + B2 + B4 (sky env, dusk preset, haze) — also
   un-breaks prop metalness.
3. **PR "street presence"**: B3 + C1 + C2 + C4 (live reflections, road PBR,
   wheel blur, dressing density).
4. **PR "race HUD"**: D2 + D3.
5. Backlog: C3, C5, god rays, DoF.

Verified 2026-06-12 against `src/game/Game.ts`, `daynight.ts`,
`geometry/shared.ts`, `textures.ts`, `effects/streaks.ts`, `camera.ts`,
`ui/Hud.tsx` (renderer state confirmed live on the dev preview, port 5174).
