# ELEVATION — Research & Engine Audit

> **STATUS: implemented 2026-06-12 (Phases 0+1; Phase 2 declined per §recommendation)** — decomposed HeightSampler + north-arc profile + furniture y, see `src/game/environment.ts`, `src/game/suspension.ts`, `src/game/levels/gantryPoint.ts`, `src/game/Game.ts`, `src/game/vehicles.ts`.

**Question in one line:** racing games use height to make tracks *feel* — crests that go
light, dips that compress, hills that hide the road and then reveal the sea — and GANTRY
POINT's flat engine currently fakes all of it; what would real elevation cost, and is it
worth it?

Deliverable of the GDD's known compromise: §9 of `docs/gantry-point-gdd.md` cuts "road
elevation / true overpass" from v1 ("ribbon is flat at y≈0.012; the flyover *fantasy*
ships via the ramp jump instead"), and `docs/concept-art/cliff.png` wants a towering
clifftop road the flat world can't deliver — today's fake is rock mass stacked *above*
grade plus a sea painted 2.2 m *below* it (`src/game/levels/gantry/cliff.ts`,
`CoastDef.seaLevel = -2.2`). This document is the research and the honest costing for
doing it for real.

---

## 1. Elevation as a design tool

What the craft literature and the classic tracks actually use height for:

| Tool | What it does | Canonical example |
| --- | --- | --- |
| **Crest / jump** | Road falls away faster than gravity pulls — the car goes light or airborne; commits the player blind | Finnish rally crests: "brake on every crest because you can't see the road behind it, or go flat-out and jump" — [Benoit Gomes, Kylotonn](https://www.gamedeveloper.com/design/racing-level-design-the-rally-case) |
| **Dip / compression** | Suspension loads up at the bottom; grip spikes then vanishes on the following rise | Eau Rouge–Raidillon: ~40 m of elevation at up to 17–18% grade, tyres compressed at the bottom while 3 g of lateral load builds — [Scuderia Fans](https://scuderiafans.com/eau-rouge-raidillon-the-history-of-the-most-iconic-corner-in-motorsport-2025-f1-belgian-gp/), [Mercedes-AMG F1](https://www.mercedesamgf1.com/news/the-impact-of-track-elevation-in-f1) |
| **Sightline control** | Uphill shortens what you can see (anxiety); the crest and the downhill open it up (relief, planning) | "Limited line of sight will result in the player being anxious… height variations should always be used to create emotional diversity. Rapid changes in height should be avoided though" — [Luke McMillan, *A Rational Approach to Racing Game Track Design*](https://www.gamedeveloper.com/design/a-rational-approach-to-racing-game-track-design) |
| **Rhythm** | Climb–crest–descend is a sentence structure for a lap; it breaks the "straight, corner, straight" monotone | Gomes explicitly designs to "break the pattern of straight line, corner, straight line" — [the rally case](https://www.gamedeveloper.com/design/racing-level-design-the-rally-case) |
| **Drama / vista** | The reveal at the top is the postcard; cliff roads price mistakes in geography, not walls | "As they crest the hill, the desired vista crawls into view" — [Game Design Skills, racing design](https://gamedesignskills.com/game-design/racing/) |
| **Vehicle/route balance** | Downhill favours momentum, uphill punishes it; a high line and a low line become different bets | Mt. Akina in Initial D starts at the highest point and runs downhill, advantaging the light AE86 — [McMillan](https://www.gamedeveloper.com/design/a-rational-approach-to-racing-game-track-design) |

Two craft rules worth pinning, because they translate directly into our constants:

- **Gentle is enough.** Gomes: a 1% camber with a 3-inch dip is "invisible to 95% of
  players but creates instability" — felt elevation starts *far* below what reads in a
  screenshot. McMillan's matching warning: avoid *rapid* height changes. A few metres
  over a sector is a feature; a wall of height is a bug generator.
- **Crest geometry is speed-dependent.** A car leaves the ground when the road's
  vertical curvature exceeds g/v². At our `GRAVITY = -11.5` and the 38 m/s straights
  class, that's a vertical radius under ~125 m (≈200 m at the 48 m/s boost top). So the
  *same* crest is planted at cruise and airborne on boost — which is exactly the
  risk-reward knob Burnout wants.

---

## 2. How Burnout specifically used vertical moments

- **Burnout 3's Alpine track is an ascent-then-descent narrative**: up the autobahn
  through the crags to the peak, then down under a viaduct into the city — with the
  signature roads "twice as wide as they should be" so the slide stays playable
  ([PlayStation Blog, *Classic Levels Deconstructed*](https://blog.playstation.com/archive/2017/08/31/classic-levels-deconstructed-burnout-3-takedowns-blistering-alpine-track/)).
  GANTRY POINT already borrowed the width rule (22 m, four lanes); the climb/descend
  sentence is the part we left behind.
- **B3 put its set pieces at the vertical landmarks** — the split mountain bridge and
  the toll booths are Signature Takedown theatres
  ([Burnout Wiki, B3 locations](https://burnout.fandom.com/wiki/Locations_(Burnout_3))) —
  exactly the GDD §6 pattern, minus the height.
- **Paradise made vertical moments collectibles and routes**: 50 Super Jumps (10 per
  district), split ramps, broken bridges; the jump cuts to a fixed slow-mo camera, so
  air is a *celebrated* state, not an accident
  ([Burnout Wiki, Super Jump](https://burnout.fandom.com/wiki/Super_Jump)). Downtown
  stacks split-level roads under skyscrapers
  ([gamepressure, Downtown Paradise](https://guides.gamepressure.com/burnoutparadisetheultimatebox/guide.asp?ID=6637)).
- **Downhill = boost economy.** East Crawford Drive's descent earns boost by "drifting
  around the downhill bends as well as getting Air Time from the makeshift ramps"
  ([Burnout Wiki, Save Ferris](https://burnout.fandom.com/wiki/Save_Ferris)). Our boost
  refill already pays for drift (`REFILL_DRIFT`) and airtime (`REFILL_AIR`,
  `control.ts`) — a downhill sweeper section with a crest would plug into the existing
  economy with **zero** new code.
- **Vertical Takedowns** (landing on a rival off a small jump) exist from Dominator on
  ([Burnout Wiki, Takedown](https://burnout.fandom.com/wiki/Takedown)) — a free idea the
  moment two cars can be at different heights on the same road.

---

## 3. Faking it vs. modelling it

The genre has three tiers, and crash-junction currently sits *between* the first two:

1. **Pure fake (pseudo-3D era).** OutRun-style engines drew a flat 2D world and faked
   hills by stretching/compressing the road raster and sliding the horizon — cheap,
   "tweaking-intensive, geometrically inaccurate"
   ([Lou's Pseudo 3D Page](https://www.extentofthejam.com/pseudo/)). The modern
   equivalent of this tier is **visual-only terrain**: berms and skylines the physics
   never touches. Our coast skirts (sea at −2.2 with the physics plane staying flat,
   `environment.ts buildCoast`) are exactly this tier.
2. **Road-following height (2.5D).** The world is 3D but only the *road* carries a
   height profile — a spline with y, projected segments, physics that follows the
   ribbon. Lou's page calls this the point where hills stop being empirical hacks and
   become "mathematically consistent." Our ramp wedges + suspension ground-follow are a
   degenerate version of this tier: a height profile that exists only in two 9-metre
   patches.
3. **Full heightfield terrain.** Everything samples terrain; AI, camera, respawns,
   rendering all live in 3D. Sims and open-world racers (Paradise included) pay this
   cost because driving *off* road matters to them.

The cheap-but-honest sweet spot for a walled circuit racer is tier 2: the player can
never legally be anywhere but the road corridor, so road-following height buys ~all of
the feel for a fraction of tier 3's surface area. That observation drives the phasing
in §6.

---

## 4. Engine audit — where elevation lives today

This is the half of the document the web can't supply. File-by-file, with the
constraints stated precisely.

### 4.1 The ground is a flat infinite plane — but the *suspension* never touches it

`physics.ts createPhysics()` adds one static `CANNON.Plane` at y = 0; gravity is
`(0, -11.5, 0)`. That plane is what wrecks tumble on and what the contact solver knows.

Driving, however, happens against a *separate, analytic* surface: the
`HeightSampler` (`environment.ts makeHeightSampler`), a pure `(x, z) → h` function over
plain numbers:

- **ramp wedges** — axis-aligned, ascending +z only (`RampDef` contract), with a 1 m
  lateral skirt fade so clipping a ramp side "rides up like a steep kerb instead of the
  height field teleporting a wheel a metre into the air";
- **building plinths** — 0.16 m sidewalk slabs with a 0.35 m edge blend.

`suspension.ts applySuspension` fires four spring/damper wheel rays against this field,
plus a **kinematic ground-follow**: a driven car below
`ground + max(ride − SUSP_MAX_COMP, halfY + 0.01)` is held at that floor and handed the
field's rise rate as upward velocity — clamped per surface to `√(4·g·h_ahead)` and
absolutely to `RAMP_LAUNCH_VY_MAX = 12`. The lip of a ramp then "releases it
ballistically, which is what makes ramp jumps reach the rings."

The constants around this carry scar tissue that any elevation work must inherit
(`constants.ts`, read the comments in full):

- the chassis floor must clear the *physical* plane (`halfY + 0.01`) or the solver gets
  "a sustained lever and hard landings slowly pole-vault the car into a flip";
- `DOWNFORCE_CAP` was retuned because squat past the box clearance scraped the plane
  and "pole-vaults the car off its own corner (the boost-jump bug)";
- `LIVE_VY_GAIN_PER_STEP = 1.0` and `LIVE_CAR_CONTACT_VY = 1.5` exist because solver
  contacts catapulted live cars (a 48 m/s rammer once climbed a rival, its wreck, then
  the wall top — "6 m over the barrier");
- the `√(4·g·h)` per-surface cap exists because "kerbs and ramp side-skirts … read as
  20+ m/s rises when crossed at speed."

**Lesson to carry forward: every discontinuity in the height field is a launch bug
waiting to happen.** The field history of this engine is one long fight against edges.
Elevation work must add *no new edges* — only smooth grades — and must keep every
feature-relative cap measuring height *relative to the local road*, not absolute
(see the Phase 1 risk list: the `√(4·g·h_ahead)` cap currently reads **absolute** field
height, which is correct on a flat world and silently wrong on an elevated one).

### 4.2 The key insight: raised roads are already mechanically possible

Live chassis are collision-filtered OFF the ramp boxes and plinths
(`GROUP_DECOR`, `physics.ts` / `environment.ts`): "the suspension height field is what
drives over these … the box never hard-clips a ramp kink." The box only matters for
wrecks and landings. **A car driving up a rising height field is exactly how ramps work
today** — wheels-on-field is the whole mechanism. Nothing in the physics core forbids a
road at +6 m; the sampler just has nothing to say up there. What's missing is
*everything around* the mechanism:

### 4.3 Everything else is built flat

| System | File / site | Flat assumption |
| --- | --- | --- |
| Race ribbon | `environment.ts addRibbon` | every vertex at y = 0.012 (shortcuts 0.010); strip rows carry no height |
| Barrier walls | `environment.ts` wall chain | visual boxes and physics boxes at `h/2` above y = 0; `wallDirs` judging is 2D and fine, but box *placement* assumes grade 0 |
| Checkpoint posts / stripes | `environment.ts` | posts at fixed y = 1.3; all painted marks via `addMarkInstances(…, y = 0.015)` — one shared flat y per batch |
| Ground paint | `GroundPatchDef` / `DecalDef` | flat `ShapeGeometry`/quads at y 0.006/0.014 under a z-order contract that *only works because everything is coplanar* |
| Island + coast | `buildCoast` | island polygon at y = 0; every skirt's rim row pinned to y = 0; sea at −2.2; "a car carried past the rim hovers over the water" (accepted jank, `CoastDef` doc) |
| Race AI | `race.ts` | sections are `{x, z, dirX, dirZ, v}` — 2D centres, 2D curvature speed classes, 2D gate-reach, 2D progress; rivals write horizontal velocity and hard-pin their quaternion world-flat every step |
| Respawns | `race.ts placeAt` | `y = rideHeight + 0.05` — assumes ground 0; reset pairs and the takedown handback both go through it |
| Off-track rescue | `race.ts playerOffTrackDistance` + `modes/race.ts` | 2D nearest-centre distance; correct on hills as long as roads never stack vertically |
| Player control | `control.ts` | slope sampled fore/aft ±1.6 m; below 0.02 m of differential (≈0.6% grade) the chassis is hard-pinned world-flat. Any real grade exceeds this constantly → the car would *never* re-pin, drifting on the "ramps and air" branch |
| Traffic AI | `traffic.ts` | same slope-pin pattern, same threshold |
| Furniture | `Game.ts` 570–571, `props.ts` | poles/barrels spawn from `(x, z)` at grade 0; prop colliders are deliberately "ground-planted at hy" regardless of visual y lift |
| Camera | `camera.ts` | follows the car in 3D already (boom at `p.y + height`) — the one system that mostly just works; but it never tests terrain, so a dip entry can put the boom inside the upslope behind the car. Caution: the camera **feeds the sim** during aftertouch ("aftertouch forces are camera-relative … must replay"), so even a camera ground-clamp is a sim change in crash phases |
| Replay stats | `Game.ts updateReplayStats` | `maxAltitude` is measured **relative to the sampler** — fixture envelopes survive elevation as long as the sampler is the road truth |

### 4.4 The determinism bill

The height sampler feeds physics. **Any elevation change is a sim change.** Per repo
convention (`tests/run-replay-tests.mjs`, README §replays):

- the two **determinism pins** (`junction-main-ramp-jump`, `pad-jump-line`,
  `"checksums": "require"`) pin the exact sim that recorded them and must be
  re-recorded after any physics-affecting change — even if the flat levels' float math
  is theoretically bit-identical, the convention is to re-record, not to argue;
- the nine **behavioral fixtures** (`"checksums": "ignore"`) keep valid input tapes,
  but trajectories shift wherever the field actually changed. Seven run on `race`
  (SILVER LAKE) and one on `track` — untouched by a gantry-only profile *if*
  zero-elevation code paths stay numerically identical. The one gantry tape
  (`gantry-grid-uturn`) starts on the south straight; keep the straight at exact
  0 elevation and it should replay — but it must be re-verified, and re-recorded if it
  drifts (`tests/record-race-fixtures.mjs` exists for exactly this).

The quiet cost nobody budgets: **every profile-tuning iteration after the first repeats
the verification pass.** Elevation numbers are gameplay numbers; expect to touch them
five times, not once.

---

## 5. What elevation buys GANTRY POINT specifically

The concept art (`docs/concept-art/cliff.png`) is a guardrailed road cresting a
headland with the sea a *long* way down — golden grass, granite, surf at the base.
The shipped fake (`gantry/cliff.ts` header comment) is candid about the gap: "the coast
skirt's drop is only |seaLevel| = 2.2 m, so the concept's tall-cliff drama has to come
from rock mass stacked ABOVE grade." It reads as a rocky shoulder, not a cliff.

A modest road profile — **+6 m over the north arc, flat everywhere else** — converts
four existing set pieces from painted to felt:

| Sector (GDD §4) | Today | With profile | Design tool used (§1) |
| --- | --- | --- | --- |
| Quay North 78–88 | flat fast bow | last ~4 sections begin a 5% climb | rhythm: the lap gains an "up" |
| Headland Spike 88–100 | flat hook, rocks beside it | climb to **+6 at CLIFF CRASH**; the hook happens at the top with the sea 8 m below the rim | drama; the slow-in corner now has geographic stakes |
| Clifftop Straight 100–115 | flat straight | held +6 — *the cliff.png postcard*, with a gentle crest at entry hiding the Lookout Ess | sightline control: the ess arrives as a reveal |
| Lookout Ess + Ledge 115–132 | flat dip-around-a-knoll | road dips to ~+3.5 (a real compression at the ess bottom); **LOOKOUT LEDGE stays at +6 along the rim** — the shortcut becomes the literal high line | compression; route/risk asymmetry à la Mt. Akina |
| NW Sweepers 132–152 | flat sweeps | 3% descent back to 0 — a downhill boost-and-drift run into the chicane | downhill economy (East Crawford), free via existing `REFILL_DRIFT`/`REFILL_AIR` |

Everything south and east — start grid, Billboard Straight, dockyard, Harbor Run,
Flyover Link, village, Beach Run — stays at exact 0. That is deliberate: the dockyard
*is* quay level (fiction agrees with physics), three of the four shortcuts and both
ramps live in the flat zone (zero migration risk), and the grid/billboard scrum keeps
its tuned behavior (and its `gantry-grid-uturn` fixture).

Free synergies already in the engine: airtime boost refill at the crest, the existing
`OFF_TRACK_RESCUE_SECS = 5` pricing for going over the rim, and the
`√(4·g·h)`-style landing rules — designed jumps and hard landings are already a solved
class of problem *on the road itself*.

---

## 6. The phased path

### Phase 0 — visual-only terrain beyond the walls (free)

Berms, hill masses and raised skylines *outside* the playable corridor; rock mass
between the clifftop road and the rim; a taller painted coast. The pseudo-3D lesson
(§3): most of "elevation" is what the eye gets, and the eye never checks the physics
off-road.

| Change | File | Notes |
| --- | --- | --- |
| Berm/hill meshes (tinted low-poly wedge strips or stacked kit rocks) outside the wall line on the north arc | `gantry/cliff.ts`, `gantry/shared.ts` | pure `decor()` props or one new mesh builder; **no colliders, no new bodies** |
| Raise the *visual* rim: taller cliff skirt (more rows, bigger jitter) on the cliff arc | `environment.ts addCliffSkirt` | keep rim row pinned at y 0 (the road stays at 0 in this phase); jitter key discipline already documented |
| Optional: a "plateau band" mesh sloping from grade up to a fake skyline behind the rim rocks | `gantry/cliff.ts` | sells height from the road's eye level without touching ground truth |

**Determinism cost: zero** — provided no body is added (decor-only props create no
cannon bodies; `props.ts` only builds bodies for explicit colliders). Pins untouched.

**Risks:** only visual — sightline pillar #1 ("cranes always on the horizon") must
survive the new masses; check the refshot poses. Draw-call growth is bounded
(instanced kit rocks).

**Buys:** maybe 40% of cliff.png. The road itself still drives dead flat, and the rim
fiction still collapses the moment a car is shoved through the guardrail.

### Phase 1 — road elevation profile (the big-value phase)

A per-track elevation function along the section chain: waypoints (main loop and
shortcut polylines) gain an optional third component `y`; the Catmull resampler carries
it; `RaceSection` gains `y`; the height sampler adds a **road elevation field**:
nearest-chain-point elevation across the full corridor width plus a shoulder, fading to
0 over a generous embankment band (≥ 15 m at ≤ ~25% slope — gentler than any feature
skirt today). On top of that base, ramps/plinths stack as before.

The one structural code change that matters: **decompose the sampler into
`base(x,z)` (road grade — follow it, never fling off it) + `feature(x,z)` (ramps,
kerbs, plinths — launchable, capped by feature height).** Today's per-surface launch
cap `√(4·g·h_ahead)` uses *absolute* height; at +6 m base elevation, a 0.16 m plinth
edge — which today correctly blips at √(4·11.5·0.16) ≈ 2.7 m/s — would read as a 6.16 m
surface and fling at the full 12 m/s roof. Same bug class as the entire §4.1 scar list,
new trigger. The fix is mechanical once the sampler returns both components.

Grade-following itself is comfortably inside the existing caps: a 6% grade at 38 m/s
asks for 2.3 m/s of rise — the ground-follow hands it over without drama. Crests
(negative rise) need *no* code: the follow simply stops writing vy and the car goes
ballistic, landing on the floor clamp like every ramp landing today. Keep designed
crest radii ≥ ~150 m where you want planted-at-cruise/airborne-on-boost (§1 math).

File-by-file:

| File | Change | Size |
| --- | --- | --- |
| `types.ts` | waypoints `[x, z, y?]`; `RaceDef.sections` and `ShortcutDef.waypoints` carry y; (optional) `CoastDef.outline` per-vertex rim y for the cliff arc | S |
| `race.ts` | `catmullFine`/`resampleEvery`/`finishSections` carry y (arc length stays 2D so spacing and speed classes are untouched on flat ground); `RaceSection.y`; `placeAt`/`respawnPlayer` use `s.y`; *optional* crest-aware speed class (cap `v` where the vertical drop over the next 2 sections exceeds what `g` can follow at that v) | M |
| `environment.ts` | sampler: road elevation field from the section chains + embankment fade, returning base + feature; `addRibbon` per-row y; wall segments take y (and ideally pitch — or accept ±0.25 m stepped seams per 9.5 m segment at 5%, hidden by the 0.5 m overlap); posts, mark instances (per-mark y), shortcut chains | L — the bulk of the work |
| `suspension.ts` | launch cap measures `feature` height, not absolute; floor uses total | S, high care |
| `control.ts` / `traffic.ts` | replace the flat hard-pin with a road-plane pin (orientation from heading + local fore/aft & lateral height differential) above the 0.02 threshold; otherwise on any grade the chassis never re-pins and orientation drifts after every knock | M, high care |
| `Game.ts` / `props.ts` | `createPole`/`createBarrel` take y; prop colliders planted at `elev(x,z) + hy` | S |
| `levels/gantryPoint.ts` | the profile numbers (north-arc waypoints get y; ledge shortcut endpoints must match main-loop y at entry/exit — add the assertion next to the existing shortcut-contract throw) | S |
| `gantry/cliff.ts` + coast | prop y lifts on the plateau; cliff-arc rim raised (per-vertex rim y) + plateau band between road edge and rim — this is what finally delivers cliff.png | M, visual |
| `tests/` | re-record both pins; re-verify all nine behavioral fixtures; re-record `gantry-grid-uturn` if it drifts; add **two new fixtures**: a crest-launch envelope pin on the north arc, and an embankment-edge tape (drive off and back up the fade at speed — the pole-vault regression test) | M |

Honest analysis of the listed soft spots:

- **Shortcut ribbons.** Three of four live at exact 0 — untouched. LOOKOUT LEDGE is the
  only branch in the elevated zone; its open chain gets the same per-waypoint y, its
  ribbon the same per-row y, and the `shortcut()` helper should assert endpoint-y
  continuity with the main loop the way it already asserts the index contract. The
  branch *corridor logic* (`updatePlayerShortcut`, `chainDistance`) is 2D and stays
  correct — heights never stack here.
- **Reset-pair respawns.** One-line fix (`placeAt` y) covers rivals, the player crash
  respawn, the takedown handback and the off-track rescue, because they all funnel
  through it. Respawning *into* the climb at `RESET_SPEED = 10` is fine — the
  ground-follow picks the car up on the first step.
- **Off-track rescue distances.** `playerOffTrackDistance` is 2D nearest-centre — on a
  single-level track this remains exactly correct (a car at the foot of the embankment
  is genuinely off the road). The 5 s price for going over the rim is unchanged. The
  only way 2D breaks is stacked roads — which is why "true overpass" stays out of
  scope even in this phase (the 2D gate-reach in `reachedGate` would let an underpass
  car trip a gate directly above it).
- **The coast seaLevel illusion.** Physics ground stays the y = 0 plane everywhere, so
  a car over the cliff rim now falls 6 m and then hovers on the invisible plane 2.2 m
  above the painted sea — the *same* accepted jank as today, just one beat longer and
  honestly more visible. Acceptable (rescue collects it), but say it in the GDD. The
  alternative — sloping the physics plane down — is Phase 2 territory.
- **Ground paint.** The z-order contract (coplanar paint at 0.006–0.015) only works
  flat. Patches/decals under the elevated north arc must either drape (subdivide +
  displace by the sampler — straightforward but new code) or be replaced by tinted
  band meshes in that zone. Budget it; it's the most tedious line item.

**Determinism cost, plainly:** both pins re-recorded (convention), all behavioral
fixtures re-verified, `gantry-grid-uturn` likely re-recorded, two new fixtures
recorded — and that verification pass repeats on every profile retune. This is the real
price of Phase 1 and it is paid in playtest-iteration friction, not in lines of code.

**Risk list (carrying §4.1's lessons):**

1. **Edge launches return.** The absolute-vs-relative launch cap (fix described above),
   embankment fades read as 20+ m/s rises if too steep, stepped wall-box seams on
   grades. Mitigations: decomposed sampler, ≤ 25% fades, the two new fixtures.
2. **Orientation-pin regressions.** The `control.ts`/`traffic.ts` flat-pin is
   load-bearing (it's what keeps heading and chassis synced after contact); replacing
   it with a road-plane pin touches every level, including the flat ones — the highest
   blast-radius change in the phase. Mitigation: pin to the *sampled local plane*,
   which on flat ground is numerically the identity of today's behavior.
3. **AI at altitude.** Rivals' speed classes are 2D; a crest into a corner can put a
   38 m/s rival airborne and off-line (their 3 s rescue catches it, but visibly).
   Mitigation: keep crests on straights by design; optionally the crest-aware class.
4. **Scope creep through the dressing.** Paint draping, prop y, coast rim, plateau
   band — each small, collectively the long tail. Mitigation: confine elevation to the
   north arc and let the audit table above be the checklist.

**Buys:** the other 60% of cliff.png — the climb, the crest reveal, the compression,
the high-line shortcut, the downhill boost run — i.e. every §1 tool, on the sector of
the island whose entire identity (CLIFF CRASH, THE LOOKOUT, the ledge) was designed
around height the engine couldn't express.

### Phase 2 — full heightfield terrain (probably overkill)

Replace the analytic sampler with sampled terrain everywhere (and/or a
`CANNON.Heightfield` for wrecks), slope the island toward the sea for real, 3D-ify the
AI distances and gates, ground-test the camera. What it adds over Phase 1 on *this*
game: honest off-road tumbles down the embankment, a real beach-to-sea slope, stacked
roads/true overpasses (with the full 2D-progress rework that drags in), and wreck
physics on slopes (the static plane stops matching the driven surface the moment
grades exist — Phase 1 lives with wrecks settling onto flat ground *under* the road
field, visible mainly at the cliff; Phase 2 is what actually fixes that).

For a walled circuit where the player is corridor-bound by design and off-track is a
5-second rescue, that is a lot of surface area for jank-polish. Every system in §4.3
gets touched, every fixture re-records, and the AI's 2D assumptions (progress, gates,
off-track) need genuine redesign rather than y-plumbing. **Not recommended** unless a
future level *needs* stacked routes — at which point revisit with that level's GDD in
hand.

---

## 7. Recommendation

Do **Phase 0 now** (a zone-dressing pass, zero sim risk, immediate concept-art payoff)
and **Phase 1 scoped to the north arc** as its own slice, in this order: sampler
decomposition + fixtures first (the safety net), then race/ribbon/wall y-plumbing, then
the gantry profile numbers, then the coast/plateau visual pass. Skip Phase 2.

The three risks to respect most: the **absolute-height launch cap** (silent until the
first kerb at altitude), the **orientation-pin replacement** (touches every level, not
just gantry), and **fixture-churn friction** (every elevation retune re-runs the
determinism bill — tune the profile in as few, well-playtested passes as possible).
