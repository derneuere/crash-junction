# CRASH JUNCTION

A Burnout-style crash mode: launch your car into a junction, wreck as much
traffic as possible, steer the wreck with aftertouch, detonate the
Crashbreaker. React + TypeScript + three.js + cannon-es.

## Run it

Needs Node 18+ (use `fnm use 22` if the system Node is older).

```
npm install
npm run dev      # vite dev server
npm run build    # typecheck + production build into dist/
npm test         # replay regression suite (needs installed Chrome or Edge)
```

## Asset pipeline / baking

Some assets are **baked offline** so the build and the runtime never have to:
the vehicle models are converted from FBX to GLB, and the static environment's
ambient occlusion is precomputed to a JSON the runtime folds into ambient light.
These are the only offline asset-generation steps — everything else under
`tools/` and `tests/` is a diagnostic or a test (see below). One driver runs
them in dependency order:

```
npm run bake           # run the whole pipeline (skips steps already up to date)
npm run bake:list      # list the steps and what each produces
npm run bake:models    # just FBX → GLB
npm run bake:ao        # just the AO bake
node tools/bake-all.mjs ao --force   # force one step; --force alone forces all
```

The steps, in order (later steps depend on earlier ones):

1. **models** (`tools/convert-models.mjs`) — converts the Quaternius vehicle and
   transport FBX packs in `public/models/{cars,transport}/FBX/` to the `.glb`
   the runtime loads, into the sibling `glb/` folders. Re-run **after adding or
   changing a source FBX**.
2. **ao** (`tools/bake-ao.mjs`) — bakes per-vertex self + ground ambient
   occlusion for the static built environment (warehouses, containers, the
   lattice cranes, floodlight masts) and writes **`public/baked-ao.json`**.
   `src/game/ao.ts` folds it into the indirect/ambient term only, so the one
   geometric bake reads correctly at day, dusk and night. Runs *after* `models`
   because it bakes against the prototype GLBs. Re-run **after changing prop
   geometry or the procedural dockyard furniture in `src/game/builtins.ts`**.
   The bake is **deterministic** — fixed Fibonacci hemisphere sampling, no RNG —
   so a re-bake reproduces the same `baked-ao.json` byte-for-byte (~2 min).

`npm run bake` is **idempotent**: it skips a step whose outputs are already
newer than its inputs and prints why; pass `--force` to rebake regardless.
Adding a future bake (e.g. a grass-asset step) is a one-line entry in the
`STEPS` array in `tools/bake-all.mjs` — give it a name, script, inputs and
outputs and it slots into the order with the same up-to-date check.

Not part of this offline pipeline: the **cloud** bake is a *runtime* bake
(per-time-of-day, in `src/game/skyenv.ts`), so it has no offline step.

### Diagnostics & dev tools

These read assets or drive a headless game; they generate no shipped artifacts:

- `tools/inspect-models.mjs [substr]` — dump GLB node/mesh/material/bounds.
- `tools/refshot.mjs <zone> --port N` — capture the canonical fixed-pose GANTRY
  POINT screenshots (`dockyard`/`harbor`/`cliff`/`beach`).
- `tools/grass-count.mjs --port N` — count grass blades drawn in the frustum per
  camera pose (the metric the grass-density work is judged on).
- `tools/fluffy-measure.mjs` — measure the FluffyGrass reference demo's density.
- `tests/scene-census.mjs [--port N]` — mesh/draw-call census of the dockyard,
  grouped by source, for targeting the instancing pass.
- `tests/{lag,harbor,cloud-perf}-probe.mjs` — headless perf probes (frame-time
  median, draw calls, shader-compile spikes). Software-GL inflates absolute ms,
  so read the deltas, not the absolutes; these are diagnostics, not gates.
- `tests/drive-probe.mjs` — headless driving-model probe: flattens the height
  field, teleports the player to open ground and runs scripted manoeuvres
  (launch, full stop, gripped corners, held drifts left/right, a lifted-throttle
  slide, a mid-drift countersteer) through the real fixed step, reporting speed,
  body slip, yaw rate, drift state and front-wheel angle every quarter second.
  Run it before and after a handling change and diff the two reports.
- `tests/rival-stall-probe.mjs [simSeconds]` — deterministic rival-AI stall
  probe: pumps SILVER LAKE RING through the fixed step with a wall-blind
  throttle-only player, force-wrecks each rival once to exercise the respawn
  path, and dumps the full state (body, suspension loads, solver state, racer
  state, solver contacts) of any rival that sits clean under 1 m/s for 2 s.
  Unlike `ai-probe.mjs` it does not sample on the wall clock, so a stall
  reproduces step-for-step. `REPLAY_ONLY=<fixture-substring>` on
  `run-replay-tests.mjs` runs a single fixture and prints all its stats.

All of these read render-time state only — they never record a fixture or touch
sim/physics/RNG, so running them can't perturb a replay pin. The replay
regression suite and the fixture recorders are documented under
[Replay fixtures as regression tests](#replay-fixtures-as-regression-tests).

## Controls

| Input | Action |
| --- | --- |
| Click / Space | Launch |
| ↑ / W | Accelerate |
| ← → / A D | Steer |
| Space / Shift | **Boost** — earned, not free. The engine alone cruises; boost unlocks the top-speed band. Fill the bar by **dangerous driving** (drifting, airtime, near-missing traffic); a full bar tips into a sustained **Burnout** (faster still). **Takedowns extend the bar one segment (1×→4×, B3-style) and instantly refill it** — chain them. Crashing collapses it back to 1×. |
| ↓ / S | Brake — **tap while steering to drift**; the slide holds while you steer |
| Arrow keys (after crashing) | Aftertouch — steer the wreck mid-flight |
| **E** | **Crashbreaker** — detonate your wreck (1 charge) |
| B | Sandbox test explosion near the junction center |
| M | Mute / unmute |
| Enter | Restart |
| **R** | **Save a physics bug report** (deterministic replay JSON — see below) |
| Esc | Exit a running replay |
| ` (Backquote) | Debug overlay — telemetry, replay save/load/verify, lighting + engine overrides, refshot camera poses (also the DEV button on the idle screen) |

Driving is grounded in Burnout Paradise's AttribSys vehicle-handling data
(steering lock curves, drift slip/countersteer behavior, boost
acceleration + kick — see `game/control.ts` for the attribute-by-attribute
mapping). Detachable panels (doors/bonnet/boot/bumpers, two-stage
loose-then-detach) mirror the DeformationSpec IK-part + joint model — see
`game/panels.ts`.

## Architecture

React renders the HUD only. The engine is plain TypeScript that owns the
canvas, the physics world and the game loop; the two sides talk through one
typed event emitter (`game/emitter.ts`), so neither imports the other's
internals.

```
src/
  main.tsx, App.tsx        React shell: mounts Game, subscribes to events
  ui/Hud.tsx               presentational HUD (damage, flash, report, cash floats)
  styles.css
  game/
    Game.ts                orchestrator: state machine, loop, collisions,
                           scoring, fuses, explosions (physics side)
    constants.ts           global tunables (speeds, slow-mo, explosion kick…)
    types.ts               shared types: Actor, LevelDef, PanelState, events
    emitter.ts             typed pub/sub bridge to React
    physics.ts             cannon-es world + materials
    suspension.ts          4-ray spring/damper model + downforce + wreck grip
    control.ts             player driving: steering, tap-to-drift, boost
                           (grounded in BP AttribSys handling attributes)
    traffic.ts             traffic AI: lane-keeping, junction yield, looping
                           streams; never wrecks itself — only you do
    vehicles.ts            SPECS (sedan/bus/tanker), vehicle assembly, crumple
                           deformation, wheel popping, charring
    panels.ts              detachable doors/bonnet/boot/bumpers (grounded in
                           BP DeformationSpec joints + thresholds)
    geometry/              hull/panel/wheel geometry builders + materials
    pickups.ts             floating score-multiplier rings
    environment.ts         roads, markings, buildings, ramps, height sampler
    camera.ts              idle orbit / chase cam / crash orbit + shake
    audio/                 recorded CC0 one-shots (public/sounds/ — crashes,
                           glass, explosions, horns…) + synthesized loops
                           (engine, drift squeal, boost, wind) over a 3D
                           positional mix; crashtime warps pitch + lowpass
    effects/               pooled VFX: sparks, smoke, debris, scorch,
                           explosion (fireball/shockwave/light), index.ts
    levels/                data-driven levels + the LEVELS registry:
                           level1 (crash junction), driftTrack (practice pad),
                           raceway + gantryPoint (race circuits)
```

Four levels ship, browsable on the idle screen's event picker — a B3-style
card strip: each card carries the event's stakes, DAY/NIGHT variant chips
(applied live, remembered per event), your best-medal discs and a LAUNCH
row; below it sits a four-car roster (COMPACT / WEDGE / VECTOR / PROWLER —
a car is a body plus the engine voice it implies, and picking one remounts
the game with the model pinned, because wheel arches become suspension
anchors and the car choice is therefore sim state):

- **CRASH JUNCTION** — the crash-mode event: ramps, traffic, the tanker,
  medals.
- **PROVING GROUND** — open practice pad for testing driving and drifting:
  a painted skidpad circle with multiplier rings to chase mid-drift, a
  pole slalom, a two-ramp jump line and a barrel corner. `practice: true`
  means you can never wreck — blasts and crashes scuff the car and rip
  panels, but you keep driving (tipped cars right themselves after a
  beat). R resets.
- **SILVER LAKE RING** — the race mode: three laps against AI rivals on a
  walled circuit of flat-out sweepers, the racing line decided by who
  shoves whom into the wall (a shoved rival wrecking on it is a TAKEDOWN).
- **GANTRY POINT** — a two-lap coastal ring around a working port island:
  four risk-vs-reward **shortcuts** rivals never take (blast a container
  canyon past the port detour, jump the flyover, run the cliff ledge,
  sweep the beach) and four named **signature takedown** theatres — put a
  rival into the crane legs and the wreck flashes CRANE SMASH instead of
  TAKEDOWN. Design notes: [the GANTRY POINT GDD](docs/gantry-point-gdd.md).

Adding a level = adding a `LevelDef` (no engine changes): traffic spawns
with direction/speed/`delay`, barrel and pole positions, ramps, buildings,
medal thresholds.

## Driving physics

The most important thing to know about this engine: **every car — player, rivals
and traffic — is a force-accumulate / integrate-late rigid body**, the same shape
as Burnout's race-car physics. Nothing scripts velocity or heading. Each frame
the controller *banks* engine, tire, drift, boost and contact **forces** onto the
cannon-es body, and the integrator commits them all in one `world.step`. Grip,
yaw, drift and spin-out **emerge** from per-wheel tire forces — a weight-loaded
friction ellipse, applied at the contact patches — instead of canned animation;
`heading`/`speed` are *derived* from the body each frame, never authored.

The keystone that makes a force vehicle stable is that the **grounded chassis is
yaw-only**: while a car is on the ground, cannon's `body.angularFactor` locks out
roll and pitch, so steering, drift and spin stay fully emergent but the car can't
roll itself over under hard cornering. Roll and pitch return in the air (jumps
tumble and auto-level via corrective torques), and slope-following is a small
post-step tilt. The whole model rides cannon-es's **public API**
(`applyForce` / `applyImpulse` / `applyTorque` / `angularFactor` / `world.step`),
so no fork of the physics engine is needed.

**The feel is data.** One solver, and a per-variant vault of tuning constants
(`src/game/handling.ts`: steering lock and ramp, tire friction limits and grip
curves, drift angle / side force / yaw torque, downforce and drag, engine tables,
contact response). The sedan, the bus and the tanker all run the same code.

**Drifting** is Burnout's, not a sim's. A brake tap while steering above the
drift speed latches a slide whose direction is the steering sign at entry. While
sliding: the rear runs a flatter grip curve at reduced grip so the tail steps
out; the **front wheels track the velocity vector** (that is the countersteer you
see on a drifting car, and it keeps the fronts near their grip peak so they pivot
the car instead of scrubbing) with the stick modulating around it; a yaw
controller holds the nose at a target slip angle set by how hard you steer into
the slide, damping the slip *rate* rather than the yaw rate so a steady arc is
not fought; and a speed-scaled **side force** toward the inside of the corner
makes the slide carve — a drift turns tighter than a gripped corner, which is
what it is for. Straighten the wheel and the slide winds down and hooks up in
under a second; hold countersteer through centre and the tail swaps sides (drift
chaining). A slide with the throttle lifted scrubs speed physically through the
tires (no scripted bleed) and, once it drops out, a natural straightening torque
brings the nose back — the tire model has no self-aligning moment past ~60°, so
without it a dropped slide kept spinning until the speed died.

## Physics bug reports & deterministic replay

Saw the physics do something wrong? Press **R** (any time — recording is
always on from the last restart). A `crash-report-<level>-<timestamp>.json`
downloads instantly that reproduces the entire take **exactly**, from the
moment the level loaded to the moment you pressed R. The report is also
copied to the clipboard and kept on `window.__lastReport`, in case your
browser shell blocks programmatic downloads; to attach a note, call
`__game.captureReport('what looked wrong')` from the console instead.

To replay a report:

- **drag the JSON onto the game page**, or
- open `?replay=<url-to-json>` (drop the file in `public/` for a quick URL),
  adding `&verify=1` to fast-forward instead of watching in real time.

While replaying, the tape drives the car; Esc exits. The file carries
world-state checksums every 30 physics steps, so the replay verifies itself:
`REPLAY VERIFIED` / `REPLAY DIVERGED` flashes at the end and the full verdict
lands in `window.__replayResult` (and `document.title` in verify mode, for
scripts). Programmatic hooks: `__game.captureReport(note?)` and
`__game.startReplay(parsedJson, fast?)`.

How it stays deterministic (`game/replay.ts`, `game/rng.ts`): the sim is a
fixed-step accumulator whose only inputs are per-frame wall `dt`, the sampled
key bitmask, the discrete commands (launch / crashbreaker / B-explosion with
its rolled position), and a seeded RNG stream for every random roll that
touches physics or scoring (explosion impulses, fuse jitter, wheel pops,
panel-detach kicks, barrel spawn yaw, damage payouts). The recorder captures
exactly that tuple per frame; replaying it reproduces every step bit-for-bit.
Purely visual randomness (particles, camera shake, crumple jitter) stays on
`Math.random` and never desyncs anything. One caveat: transcendental
functions (`Math.sin` etc.) are implementation-defined, so byte-exact
replay is guaranteed on the same JS engine family (any V8 browser ↔ any V8
browser); a Chrome-recorded report verified in Firefox may diverge.

The report also embeds a full world snapshot at the moment R was pressed
(every body's position/quaternion/velocities, damage, control state), so a
bug can often be diagnosed straight from the JSON without running anything.

### Replay fixtures as regression tests

`npm test` (tests/run-replay-tests.mjs) drives a headless Chrome/Edge through
every fixture in `tests/replays/` and asserts the physics-sanity envelope
(`ReplayStats`: max altitude / upward speed / tilt) from `manifest.json`.
Promote a bug report to a test by dropping its JSON in `tests/replays/` and
adding a manifest entry. Two assertion styles:

- **bug fixtures** (`"checksums": "ignore"`): the input tape stays valid
  forever; assert behavior bounds. A physics fix is *supposed* to diverge
  these from their recorded checksums.
- **determinism pins** (`"checksums": "require"`): recorded on the current
  sim; any divergence fails. Re-record them after deliberate physics changes
  (`tests/record-jump-fixture.mjs`, `tests/record-padjump-fixture.mjs`).

## Explosions

`Game.explode(position, power)` is the one entry point (power ≈ 1 barrel,
1.9 Crashbreaker, 2.4 tanker). It spawns the visuals (`effects/explosion.ts`:
white-hot core flash → rolling fireball that cools white→orange→deep red →
ground shockwave ring → dust donut → black smoke column → point-light flash),
plays the boom, then applies a radial impulse with upward bias to every body
in range — cars crumple, wheels pop, poles fly. Barrels in the radius get a
distance-staggered fuse, so clusters ripple instead of popping at once.

In-game triggers:
- red barrels detonate on hard impact or nearby blasts
- the fuel tanker cooks off after enough accumulated damage (or one huge hit)
- **E** fires the player's Crashbreaker once crashed

## Asset credits

Vehicles are Quaternius CC0 packs (`public/models/`); sounds are recorded
CC0 one-shots (`public/sounds/`); GANTRY POINT's set dressing lives in
`public/models/props/` — per-pack sources, licenses and model notes in each
folder's `manifest.md`. Kenney kits (racing, nature, pirate, city-industrial,
factory) and the Quaternius cargo set are CC0, as is the self-made
`cliff-roadside` pack (chevron boards generated in-repo). A handful of
models are **CC-BY and require this attribution**:

- Crane by J-Toastie [CC-BY] via Poly Pizza (https://poly.pizza/m/gCcpjaxFdv)
- Crane by Max Hancock [CC-BY] via Poly Pizza (https://poly.pizza/m/aZFdGwasy60)
- Forklift by KolosStudios [CC-BY] via Poly Pizza (https://poly.pizza/m/DTQBuenKJY)
- Container Ship by Alex Safayan [CC-BY] via Poly Pizza (https://poly.pizza/m/3AmDGcCu6Ll)
- "Lighthouse", "Boat" (×2 liveries), "Sailboat", "Beach umbrella",
  "Life preserver" and "Hostel" (the motel) by Poly by Google, CC-BY 3.0
  (https://creativecommons.org/licenses/by/3.0/), via poly.pizza

## Level 1 vs the old prototype

- ~120 m driveable approach: steer, drift, boost, pick your line
- two launch ramps: the main line into the T-bone and a stunt line over the
  corner barrels
- ×2/×3 multiplier rings floating over the ramp lines — collect mid-air,
  they scale all damage cash
- traffic is a living system: cars cruise, yield at the junction and loop
  back through the fog — and they never crash on their own; only you (and
  the chaos you cause) wreck them
- fuel tanker jackpot, city bus, explosive barrel clusters
- medal targets (bronze/silver/gold) on the wreckage report
- one queued car downrange catches overshooting players
