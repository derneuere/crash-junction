# SENSE OF SPEED — research + audit + ranked proposals

> **STATUS: implemented 2026-06-12 (FREE A-list: A1-A5, A7)** — see `src/game/camera.ts`, `src/game/effects/streaks.ts`, `src/game/audio/synths.ts`, `src/game/audio/index.ts`, `src/game/levels/raceway.ts`; B-items deferred (need the batched pin re-record).

**Question in one line:** racing games manufacture "fast" out of optics, audio and
set dressing — which of those tricks do we already run, and which should we add?

**The constraint that shapes everything here:** this game has a deterministic replay
system and **the camera is sim state**. Aftertouch pushes the wreck along
camera-relative axes (`Game.ts` ~1170 `camera.getWorldDirection`), and the
`CameraDirector` runs inside the recorded-frame `advance()` (`Game.ts` ~1564, comment:
"the camera is part of the deterministic domain"). Any change to camera **position or
orientation** behavior — height, distance, lag, shake — changes body trajectories and
re-records the two determinism pins (`tests/replays/`, `"checksums": "require"`, see
README §"Replay fixtures as regression tests"). **FOV, postprocessing, particles, HUD
and audio are presentation-only and free**: `worldHash` (`replay.ts:183`) hashes
dynamic bodies only, and `camera.fov` never feeds `getWorldDirection`. Every proposal
below is bucketed accordingly.

---

## 1. What the research says

### 1.1 Camera — FOV is the big lever

- **Burnout 3 shipped a deliberately wide-angle chase cam** that "increases the sense
  of movement in peripheral vision while making things in the centre of the view
  appear smaller and rush towards you faster. When you boost, the view gets even
  wider." Criterion artist Chris Walley: *"Boosting doesn't add that much speed, only
  10% or something, but it doesn't feel like it, it feels like you're going another
  50 per cent faster."* ([PlayStation Blog — Classic Levels Deconstructed: Burnout 3's
  Alpine track](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/))
- The perceptual basis is measured, not folklore: **perceived speed increases roughly
  linearly with geometric field of view** in driving simulators ([Colombet et al.,
  *Impact of Geometric Field Of View on Speed Perception*, DSC 2010](http://dsc2015.tuebingen.mpg.de/Docs/DSC_Proceedings/2010/DSC10_07_Colombet.pdf)),
  and simulated speed is otherwise chronically **underestimated** at narrow FOV —
  peripheral optic flow carries most of self-motion speed ([Pretto et al., *Changes in
  optic flow and scene contrast affect the driving speed*](https://nacto.org/wp-content/uploads/changes_optic_flow_scene_contrast_affect_the_driving_speed_pretto.pdf)).
  A central FOV of ≥60° is advised when speed must be read from flow alone
  ([ScienceDirect — optic flow and GFOV in driving simulators](https://www.sciencedirect.com/science/article/abs/pii/S0141938207000236)).
- **Low camera = faster pixels.** Lowering the eye toward the road makes the road fill
  more of the frame and raises per-pixel screen velocity; "camera close to the ground
  and high FOV" is the classic recipe ([GameDev.net — Sensation of
  Speed](https://www.gamedev.net/forums/topic/560057-sensation-of-speed/4593834/)).
  Pulling the chase camera back with speed is the standard complement.
- Modern arcade racers (NFS Heat) stack **motion blur + dynamic camera shake +
  per-camera FOV calibration** ([Game Rant — racing games with the best sense of
  speed](https://gamerant.com/racing-games-best-sense-feel-speed/)).

### 1.2 Post effects — blur is optional, streaks are cheap

- Radial/peripheral motion blur was the 2000s staple; the modern trend is **less
  full-frame blur, sharper image, speed sold by other cues** ([Game Rant,
  ibid.](https://gamerant.com/racing-games-best-sense-feel-speed/); [Digital Foundry
  Tech Focus discussion — Motion Blur: Is It Good For Gaming Graphics?](https://www.resetera.com/threads/digital-foundry-tech-focus-motion-blur-is-it-good-for-gaming-graphics.51418/)).
- "Speed lines"/wind-streak **particles** (Mario-Kart-style boost streaks) deliver
  most of radial blur's reading at a fraction of the cost and are a standard engine
  recipe ([Unity speed-particle tutorials](https://www.youtube.com/watch?v=UWjpkhShB28),
  [UE Niagara speed lines](https://www.youtube.com/watch?v=7o8b8o5xN-w)).
- In three.js, real radial blur means `EffectComposer`: every pass renders to an
  off-screen target and full-frame passes multiply fill cost; you also trade away the
  default canvas MSAA unless you allocate a multisampled WebGL2 render target
  ([Three.js Journey — post-processing](https://threejs-journey.com/lessons/post-processing),
  [threejsroadmap.com post-processing guide](https://threejsroadmap.com/blog/the-complete-guide-to-threejs-post-processing-in-2026),
  [ycw/three-radial-blur](https://github.com/ycw/three-radial-blur)). Cost note in §3.

### 1.3 World — near-field furniture is what the flow flows past

- Burnout 3 again: roads lined with "**lampposts, trees, billboards and buildings**"
  flashing past is named as a core speed device; and because the tracks had to be
  "twice as wide as they should be" for the slide model, *"we had to make the cars
  twice as fast"* (Walley) — geometry scale and speed feel were tuned together
  ([PlayStation Blog, ibid.](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/)).
- The perception literature backs the art directors: optic-flow **density and scene
  contrast** change perceived (and chosen) speed — drivers slow down when flow speeds
  up ([Pretto et al., ibid.](https://nacto.org/wp-content/uploads/changes_optic_flow_scene_contrast_affect_the_driving_speed_pretto.pdf)).
  Near-field objects (posts, fences, overhead gantries, walls close to the road) have
  the highest angular velocity, so they dominate the speed read; far scenery
  contributes almost nothing.
- Ground texture matters for the same reason: an untextured road carries **zero**
  optic flow between its painted marks.

### 1.4 Audio — wind is what "fast" sounds like

- Racing audio hangs engine pitch/volume/filter and **wind + tyre layers off a speed
  RTPC**; wind crossfades from light to heavy with speed ([Audiokinetic — building a
  car racing system in Wwise](https://www.audiokinetic.com/en/blog/building-a-car-racing-system-using-wwise/)).
- Doppler on passed sources "makes cars feel a lot faster as they pass" — in practice
  arcade games fake it with pitched whoosh one-shots rather than true doppler
  ([GameDev.net — sounds in a racing sim](https://gamedev.net/forums/topic/397131-sounds-in-a-racing-sim/397131);
  survey of the genre in [Kastbauer, *Racing Games: A Semi-Formal Sound Study*, GDC
  2012](https://gdcvault.com/play/1015351/Racing-Games-A-Semi-Formal) /
  [Lost Chocolate blog](http://blog.lostchocolatelab.com/2012/05/racing-game-sound-study.html)).

### 1.5 Timing — contrast and frame rate

- Burnout 3's 60 fps was a deliberate, expensive speed feature — Alex Ward: only
  Criterion and "Namco's Tekken team" held 60 on PS2, "because it's really technically
  challenging" ([PlayStation Blog, ibid.](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/)).
  High temporal resolution is itself a speed cue (peripheral vision is
  flicker/motion-sensitive — [Pretto et al., ibid.](https://nacto.org/wp-content/uploads/changes_optic_flow_scene_contrast_affect_the_driving_speed_pretto.pdf)).
- Slow-mo crash time is a **contrast** device: 0.13× crash time makes the cut back to
  1.0× read as an acceleration. We already own this trick (below).

---

## 2. Audit — what CRASH JUNCTION does today

| Area | What the code does | Speed-feel verdict |
| --- | --- | --- |
| Chase cam (`camera.ts:98-103`) | 7.0 m back / 2.35 m high; boost pulls back to 9.2 m and rises to 2.8 m; nose-yaw spring 7.5 (3.2 drifting); position lerp `chaseRate = 9` | Good bones — low and close, BP-modeled; but distance/height are two-state (boost or not), never speed-scaled |
| FOV (`camera.ts:57,102,144`) | **Not static, but state-bucketed**: 55 idle, 62 chase, 65 drift, 71 boost; lerps at `min(1, dt·3)` | The single biggest gap: 39 m/s flat-out looks identical to 20 m/s cruise — FOV only knows *boost*, not *speed*. The boost step 62→71 is the right instinct (it's the B3 trick) but there is no kick/overshoot, and no speed curve under it |
| Shake (`camera.ts:136-141`) | Seeded `simRand` — explicitly sim state | Correctly quarantined; leave alone in free work |
| Renderer (`Game.ts:250-257`) | Plain `WebGLRenderer`, antialias, ACES tonemap, shadows; **no EffectComposer, zero postprocessing**; fog 90→340 on race levels | No blur, no vignette, no streak post FX of any kind |
| Effects (`effects/`) | sparks, smoke, debris, scorch, skidmarks, explosion, glass — all crash/drift-driven. Boost visual = 4 exhaust sparks/frame (`Game.ts:1313-1318`) | **Nothing is speed-reactive.** No peripheral streaks, no wind particles; the boost flame is at the car, not in the player's periphery |
| Audio (`audio/synths.ts:868-911`) | `WindLoop`: fades in past 18 m/s, `gain = clamp((v−18)/26) × (boost ? 0.085 : 0.055)`, highpass swept 350→850 Hz. Engine: perceived-gear model (`HEARD_ACCEL 6.5`). Near-miss whoosh ≤4.6 m & ≥9 m/s rel. (`audio/index.ts:55-56,264`). Slow-mo lowpass dive | Best-developed channel. Own comment says it: wind is "most of what 'fast' sounds like between engine notes." But it caps at 44 m/s with a linear curve and peaks at a very quiet 0.085 |
| Slow-mo contrast (`constants.ts:7-8`, `audio/index.ts:219-224`) | `SLOWMO 0.13` held 2.6 s, master lowpass closes, pitch-warp on all live voices | Already shipped, already excellent — the cut back to 1.0 is our free "speed hit" |
| Road surface (`environment.ts:520-532`) | Race ribbon is a flat untextured colour `0x2e3138`; centre dashes every **2nd** section (~19 m apart, 2.2 m long); checkpoint stripe + glowing posts every **6th** section (~57 m) | Sparse optic flow on the one surface that fills the bottom half of the screen |
| GANTRY POINT (`levels/gantry/*`) | Cranes, container canyons, warehouses, billboards, grandstand, poles, barrels, fences, themed walls | Dense near-field furniture — the B3 recipe |
| SILVER LAKE RING (`levels/raceway.ts:64-69`) | `poles: []`, `barrels: []`, `buildings: []`, `ramps: []` — literally zero furniture; an empty field, walls, dashes, gate posts | **Speed objectively reads slower here.** Same 39 m/s, a fraction of the angular flow. This is the cleanest A/B proof the furniture matters |

Net: physics says 39 m/s (~140 km/h, boost ~48), audio whispers it, the camera hints
it only when boosting, the world states it only on GANTRY POINT, and the screen never
says it at all.

---

## 3. Proposals — ranked, with numbers

Impact assumes the B3 finding (perception is dominated by FOV + periphery), weighted
by our gaps. Effort is presentation-code-only unless flagged sim.

### Bucket A — FREE (presentation-only; pins untouched)

| # | Mechanism | Tunables | Impact / effort |
| --- | --- | --- | --- |
| A1 | **Speed-scaled FOV curve under the state targets.** Replace the flat 62 chase target with `fov(v) = 62 + 8 · clamp((v−18)/21, 0, 1)²` → 62 at ≤18 m/s, ~70 at 39, drift keeps `max(curve, 65)`. Speed² shape keeps cruising calm and makes the last 10 m/s visibly count. `camera.fov` is written inside the sim-stepped director but never feeds `getWorldDirection`/bodies — pin-safe; verify once with a replay run | base 62°, +8° span, onset 18 m/s, full 39 m/s, exponent 2 | **High / trivial** (one expression in `camera.ts`) |
| A2 | **Boost FOV kick.** On boost ignite, target 74° with a 2-stage envelope: attack at `dt·8` (overshoot to ~78° for ~0.3 s via a +4° kick value decaying at `dt·4`), settle to 74, release back to the speed curve at the existing `dt·3`. Asymmetric in-fast/out-slow is what makes the Walley "feels 50% faster" moment ([PS Blog](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/)) | steady 74°, kick +4°, attack dt·8, decay dt·4 | **High / low** |
| A3 | **Peripheral wind-streak particles.** A pooled `THREE.Points`/instanced set of N≈96 elongated additive sprites spawned on a cylinder r = 5–9 m around the camera-forward axis, ahead of the camera, streaming past; skip the central ~±15° so the road stays sharp. Spawn rate `0` below 30 m/s, `(v−30)/18 × 80 /s` at 48; streak length `0.08·v` m; life 0.15 s; alpha ~0.25. `Math.random` is fine — effects never write sim. This is the cheap stand-in for radial blur ([Niagara/Unity speed-lines pattern](https://www.youtube.com/watch?v=7o8b8o5xN-w)) | onset 30 m/s, max 80/s, r 5–9 m, len 0.08·v, life 0.15 s | **High / medium** (new `effects/streaks.ts`, camera pos read-only) |
| A4 | **Wind audio reshape.** Current linear `(v−18)/26 × 0.055` is too quiet and tops out early. Propose `gain = 0.09 · clamp((v−14)/34, 0, 1)^1.6` (audible from ~20, still climbing at 48), boost ×1.5, plus a ±15 % gain LFO at 0.5–2 Hz scaled by speed (buffeting), and widen the HP sweep 300→950 Hz. Add a thin boost-only "air-tear" band (BP noise 1.2–2.4 kHz) above 40 m/s ([Wwise speed-RTPC pattern](https://www.audiokinetic.com/en/blog/building-a-car-racing-system-using-wwise/)) | onset 14 m/s, peak 0.09 (×1.5 boost), exp 1.6, flutter 0.5–2 Hz | **Medium-high / low** (`synths.ts` WindLoop only) |
| A5 | **Trackside one-shot whooshes.** When the player passes within 6 m of a checkpoint gate post / pole / crane leg at >30 m/s, fire the existing `whoosh` sample positioned at the object, `rate = 0.8 + v/60`, gain ~0.2, 0.5 s cooldown — the poor man's doppler the genre actually ships ([GameDev.net](https://gamedev.net/forums/topic/397131-sounds-in-a-racing-sim/397131)). Reads positions only | trigger 6 m & 30 m/s, cooldown 0.5 s | **Medium / low** (extend the near-miss scanner in `audio/index.ts`) |
| A6 | **Road optic flow.** (a) Give the race ribbon a subtle tiling asphalt noise map (procedural, like `makeQuayTexture`) instead of flat `0x2e3138`; (b) on straights (sections with speed ≥ 34) paint centre dashes **every** section (~9.5 m cadence) instead of every 2nd; (c) add two continuous 0.15 m edge lines at ±(w/2 − 0.5). Painted marks are visual-only `addMarkInstances` — zero physics | dash cadence 9.5 m on straights, edge lines 0.15 m | **Medium / low** (`environment.ts`) |
| A7 | **Visual-only furniture cadence on SILVER LAKE RING.** B3's "lampposts, trees, billboards" rule, as async GLB visual props (`props.ts` pattern, **no colliders** — knockable poles are sim, see B3 below): a near-field object every 25–35 m alternating sides on the straights (~6–8 per 100 m counting both sides), an overhead gantry/banner every 150–200 m, billboards on sweeper outsides. The GANTRY-vs-SILVER-LAKE A/B already proves this lever in our own build | 1 object / 25–35 m alternating, gantry / 150–200 m | **High on that level / medium** (level dressing only) |
| A8 | **HUD speed framing.** Boost-edge vignette as a DOM/CSS radial-gradient overlay, opacity `clamp((v−30)/18) × 0.35 (+0.2 boosting)` — zero WebGL cost, no composer; optionally a speedo that starts to jitter ±2 km/h above 130. Chromatic aberration is *not* worth a composer on its own | vignette onset 30 m/s, max 0.35 | **Low-medium / trivial** (React HUD) |
| A9 | **Radial blur (deferred — cost note).** Real radial blur needs `EffectComposer`: +1 full-screen pass at ≤1.75 dpr (~2.6 MP × 6–8 taps), plus an explicitly multisampled WebGL2 target or we lose the canvas MSAA we ship today ([Three.js Journey](https://threejs-journey.com/lessons/post-processing); [ycw/three-radial-blur](https://github.com/ycw/three-radial-blur)). The genre is moving away from heavy blur anyway ([Game Rant](https://gamerant.com/racing-games-best-sense-feel-speed/)). Do A1–A3 first; revisit only if boost still feels flat | mask center 25 %, strength 0.12, boost-only | **Medium / high — park it** |

### Bucket B — SIM-TOUCHING (camera position/orientation; re-records both pins)

| # | Mechanism | Tunables | Impact / effort |
| --- | --- | --- | --- |
| B1 | **Speed-scaled boom (distance + height).** `dist = 7.0 + 1.2·clamp((v−18)/21,0,1)` (boost adds its 2.2 on top), `height = 2.35 − 0.2·(same t)` — lower and longer at speed, the GameDev.net "low camera, faster pixels" lever. Changes camera position → aftertouch axes → **pin re-record** | +1.2 m dist span, −0.2 m height span | **Medium-high / low code, plus pin ceremony** |
| B2 | **Boost-ignite shake.** `addShake(0.12)` on the boost rising edge — shake is already seeded `simRand` and replay-safe *as a mechanism*, but new calls change orientation history → sim | 0.12, decay existing 3.2/s | **Low-medium / trivial + pins** |
| B3 | **Knockable furniture on SILVER LAKE** (poles/barrels via `LevelDef.poles/barrels`) — bodies enter the physics world; even untouched static bodies change the world build | per-100 m cadence as A7 | **Medium / medium + pins** |
| B4 | **Speed-dependent camera lag** (`chaseRate` 9 → 7–11 with speed, softer at top speed so the car strains ahead) | chaseRate 9→7 above 35 m/s | **Low / trivial + pins** |

Recommended sequencing: ship A1+A2 (one file, biggest perceptual delta), then A4,
then A3, then A7 on SILVER LAKE; batch B1+B2+B4 into a single deliberate "camera
feel" change so the two pins are re-recorded once, not three times.

---

## 4. What we already do right (don't break)

- **Slow-mo contrast** (SLOWMO 0.13 + lowpass dive + pitch warp) — the timing trick
  is done; the post-crash cut back to 1.0× is a free speed boost after every wreck.
- **Low, close, BP-modeled chase cam** with drift yaw-softening — keep the geometry,
  only modulate it (B1) when a pin re-record is already scheduled.
- **Boost = pull back + rise + FOV step** — the right Criterion instinct; A1/A2 turn
  the step into a curve + kick without touching position.
- **The audio stack** (perceived-gear engine, near-miss whooshes, positional mix) is
  ahead of the visuals; A4/A5 are refinements, not rescues.
