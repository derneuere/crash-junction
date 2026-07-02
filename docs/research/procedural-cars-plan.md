# Procedural Car System — Plan

Five new roster cars generated from parameters, no GLBs: a crossover SUV, a
winged supercar, a muscle car, an economy hatchback, and a full-size school
bus. Generation is **by car part**: a small recipe (the "genome") drives a
library of pure part builders whose output assembles into the exact
`VehicleModel` contract the GLB bake produces today.

## 1. Core architectural claim

`bakeModel` (src/game/models/bake.ts) is just one *producer* of
`VehicleModel` (src/game/models/types.ts): a vertex-colored body
BufferGeometry with `paintRanges`/`glassRanges`/`headRanges`/`tailRanges`,
wheel templates, `arch` + `wheelY`, `panelMetrics`, `panelCuts`, `interior`.
Every consumer — hull dressing (vehicles/create.ts), detachable panels
(panels/defs.ts + build.ts), hull carving (models/cutting.ts), crumple +
position-weld, glass shatter, the interior blocks, the garage, replay — sees
only that contract.

**The generator is a second producer of `VehicleModel`.** The shared tail of
the bake pipeline is reused verbatim, in the same order as bake.ts:

```
assemble parts → merged body + ranges
  → panelMetrics (filled DIRECTLY from the recipe — no raycast probing;
     measurePanelMetrics exists only because GLBs are opaque)
  → buildInterior(metrics, arch, spec, hull)        (reused)
  → panelDefs(spec, model) → cutPanelTemplates(...)  (reused)
  → applyHullGroups(...)                             (reused)
  → applyNormalSmoothing(...)                        (reused)
```

Two upgrades over the GLB path fall out: metrics are exact by construction,
and tessellation is ours — door/bonnet/boot cut regions get dedicated
triangle bands so cutouts are always clean (cutPanelTemplates assigns
triangles by centroid; ≥2 tris per region or it falls back to the box).

## 2. The recipe

Pure data, ~40 numbers + part selections. No RNG anywhere (deterministic
builds at load; if greeble jitter is ever wanted, an explicit LCG seeded from
a recipe constant — never Math.random, never simRand).

```ts
interface CarRecipe {
  id: PlayerCarId;
  variant: 'sedan' | 'bus';               // physics/crash-box family
  dims: { length: number; width: number; height: number; groundY: number };
  wheels: { zFront: number; zRear: number; archX: number;
            style: 'turbine' | 'five-spoke' | 'steelie' | 'deep-dish' };
  profile: SideProfile;   // silhouette stations: nose tip → hood → cowl →
                          // windshield rake → roof crown → backlight rake →
                          // deck → tail. Fastback/notchback/two-box/SUV are
                          // just different station heights.
  plan: PlanProfile;      // top-down half-width curve + shoulder bevel +
                          // tumblehome (side lean-in above the waist)
  cabin: { z0: number; z1: number; waistY: number; roofInset: number;
           pillars: number[] };            // z positions of B/C pillars
  parts: {
    grille: 'bar' | 'mesh' | 'closed' | 'chrome';
    headlights: 'strip' | 'pods' | 'quad-round';
    taillights: 'strip' | 'bar' | 'triple';
    bumpers: 'painted' | 'plastic' | 'chrome-blade';
    arches: { flare: number; liner: boolean };
    aero: 'none' | 'lip' | 'ducktail' | 'gt-wing';
    mirrors: 'door' | 'stalk';
    exhaust: 0 | 1 | 2 | 4;
    extras: ('hood-scoop' | 'side-intake' | 'roof-rails'
           | 'bus-sign' | 'stop-arm' | 'light-cluster' | 'window-row')[];
  };
  trim: { color: number; accents?: [Role, number][] };
}
```

Dims are free *within* the variant's crash box — same rule as the GLB roster
(the wedge is visually lower than the compact; physics box is spec-sized
either way). `wheels.zFront/zRear/archX` become `model.arch`, which becomes
the suspension anchors — per-car sim identity, exactly like the bakes.

## 3. Part builders

Each part is a pure function `(recipe) → TaggedGeo[]` where
`TaggedGeo = { geo: BufferGeometry (position/normal/color), role }`,
`role ∈ paint | glass | trim | head | tail`. The assembler merges in role
batches and records `[start, end)` vertex ranges per role.

| Builder | Output | Notes |
|---|---|---|
| `loft` | The body-in-white shell | THE real geometry piece: sample profile × plan width at ~20 z-stations, skin with beveled shoulders + tumblehome; split normals at feature lines (shoulder, sills) so smoothing keeps creases. Wheel-arch openings cut in the loft grid; **fallback if stitching fights us**: solid skirt + dark well-liner disc + flare (reads fine at this poly style). Target 2.5–4k tris body. |
| `greenhouse` | Glass panes + pillar trim | Inset panes over cabin span: windshield, backlight, side glass split at `cabin.pillars`. Glass = separate vertex ranges (never welded to body, never cut — matches shatter/cutting rules). Bus: `window-row` extra generates the repeated pane strip. |
| `frontClip` | Bumper mass, grille variant, headlight lenses | `head` role → emissive headlight material group. |
| `rearClip` | Bumper, taillight variant, exhaust tips | `tail` role → emissive tail group. |
| `arches` | Fender flare rings + liners | Muscle hips / SUV cladding via `flare`. |
| `aero` | Lip / ducktail / GT wing on pylons | Wing = trim (carbon dark). |
| `accessories` | Mirrors, scoop, intakes, rails; bus sign, stop arm, roof light cluster | Stop arm is decoration (welded to hull), not a panel. |
| `wheelSet` | `wheelL`/`wheelR` templates | Parametric wheel per style (tire cylinder + hub + spokes, like geometry/shared/wheels.ts but style-varied: turbine for the SUV, five-spoke for the muscle car, steelies for the bus). Display-only, never deformed — same contract as baked wheels. |

## 4. The five cars

| id | Archetype (reference) | Recipe highlights | Flavor | Lineup paint |
|---|---|---|---|---|
| `crossway` | Tesla Model Y | Tall arc roof, closed grille, light strip front+rear, cladding arches, turbine wheels | stock | grey |
| `apex` | McLaren Senna | Cab-forward, very low nose, side intakes, GT wing, quad exhaust | v10 | hazard orange |
| `mach` | '69 Mustang Mach 1 | Long hood, fastback, chrome-blade bumpers, quad-round lights, ducktail, hood scoop | v8 | gunmetal |
| `metro` | Opel Astra | Short two-box hatch, bar grille, plain trim | stock | pearl white |
| `bigbird` | Blue Bird school bus | **variant 'bus'**, 8.8 m hood-nosed box, window row, SCHOOL BUS sign, stop arm, roof light cluster, steelies | v8 | school-bus yellow |

Engine flavors reuse the existing stock/v10/v8 synth set (no audio work; a
'diesel' flavor is a possible later slice).

## 5. Full-size bus plumbing (the one variant seam)

Physics already supports it: `SPECS.bus` + `HANDLING.bus` (physics-overhaul
per-variant handling) exist because the traffic bus drives. What's new:

1. **Roster**: `VARIANT_FOR_CAR: Record<PlayerCarId, Variant>` in
   models/roster.ts (everything 'sedan' except `bigbird`).
   `getVehicleModel('bus', isPlayer=true)` returns the procedural school bus
   when the pinned player car is a bus id; traffic keeps `library.bus`.
2. **Player spawn**: levels declare `player: { variant: 'sedan', ... }` —
   at player-actor creation the Game overrides `spawn.variant` (and keeps
   the chosen color) with `VARIANT_FOR_CAR[playerCar]`. Deterministic — it
   derives from the pinned car, which is already sim state. Rival/traffic
   spawns untouched (modes/race.ts hardcodes 'sedan' — fine, bus vs sedans).
3. **Panels/interior**: `panelDefs` already has the fitted bus branch
   (curbside door + 2 bumpers); `buildInterior` already handled the GLB bus.
   The recipe fills bus metrics (door band nose→front arch).
4. **Garage**: bays become variable-width — per-bay stall half-width and
   camera radius derived from the car's variant spec (bus ≈ R 11 vs 7), bay
   x-positions from a cumulative sum instead of `i * BAY_SPACING`. Garage
   `buildCar` seating must use the car's own spec (`rideHeight`,
   `wheelRadius`), not hardcoded `SPECS.sedan`. Bus parks in the end bay.
5. **Stats**: CarSelect `CAR_STATS.bigbird` = min top speed, max weight.

## 6. Integration surface (small, mostly tables)

- `PlayerCarId` union + `PLAYER_CARS` grow 4 → 9 (label/flavor/tagline).
- `loadVehicleModels` builds the five recipes synchronously next to the GLB
  bakes → `library.playerCars`.
- `GARAGE_LINEUP_COLORS`, CarSelect `CAR_STATS` entries.
- Garage scales by `PLAYER_CARS.length` already (bays, glide, dots); only
  the variable-width bay work from §5.4 is new.
- `tools/garageshot` is the iteration loop: tweak recipe → screenshot all 9.

## 7. File layout (barrel pattern, <300 lines/module)

```
src/game/models/procgen.ts          — barrel: buildProceduralModel(recipe)
src/game/models/procgen/
  recipe.ts      — CarRecipe types + shared helpers
  loft.ts        — body-in-white loft (+ arch openings)
  parts/
    greenhouse.ts  frontClip.ts  rearClip.ts
    arches.ts      aero.ts       accessories.ts   wheels.ts
  assemble.ts    — merge, ranges, metrics fill, reuse of interior/cutting/
                   groups/smoothing → VehicleModel
  recipes.ts     — the five CarRecipe constants
```

## 8. Slices (tracer bullet)

1. **Slice 1 — one car end-to-end**: recipe.ts + loft.ts + assemble.ts +
   minimal frontClip/rearClip/greenhouse/wheels, producing `metro` only.
   Roster entry, garage bay, drivable, doors/bonnet tear correctly, crumple
   welds, glass shatters, interior shows in wounds. Replay suite byte-
   identical (nothing selects the new car). This proves the contract.
2. **Slice 2 — part breadth**: grille/light/bumper/aero/arch/exhaust/wheel
   variants; `crossway`, `apex`, `mach` recipes tuned via garageshot; stats
   + lineup colors.
3. **Slice 3 — the bus**: variant seam (§5), bus parts (window row, sign,
   stop arm, light cluster), variable-width garage bays, drive test with
   HANDLING.bus.

## 9. Risks / gotchas

- **Arch openings in the loft** are the hardest geometry (grid-cell drop +
  liner stitch). Fallback documented in §3 — decide per-look, not per-plan.
- **Cut regions need triangles**: place loft stations so door band, hood
  line, deck line, bumper strips each own grid bands; verify by tearing
  every panel on every car (cutPanelTemplates falls back to colored boxes
  below 2 tris — acceptable but ugly).
- **Weld/deform**: coincident split-normal verts are handled by the position
  weld (1 mm grid); glass verts must stay in dedicated ranges (weld keys on
  the glass flag). Any per-vertex effect on these models must go through the
  weld map — same rule as the bakes.
- **Determinism**: recipes are constants; generation runs once at load
  (~ms); no Math.random / no simRand. New cars can't move existing pins;
  the 3 pre-existing suite fails must stay byte-identical.
- **Garage hardcodes** `SPECS.sedan` in two spots (seating, wheel radius) —
  §5.4 fixes them alongside variable bays.
- **Memory/perf**: +5 models ≈ +20k tris resident, negligible; garage
  renders 9 cars + mirrors — trivial next to gameplay scenes.

## 10. Verification

Per slice: `tsc` clean; replay suite = same 3 pre-existing fails,
byte-identical; garageshot captures of all roster cars; manual drive of each
new car (`?launch=1&level=...`); panel-tear/crumple/glass pass per car
(sandbox B/E explosions); bus race sanity (rival pathing vs 8.8 m body).
