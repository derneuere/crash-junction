# GANTRY POINT — Game Design Document

**Fantasy in one line:** a flat-out lap of a rugged port island — thread the container
cranes, jump the flyover, cheat the cliff ledge, and put every rival into something
orange and load-bearing.

Burnout 3 "round course" energy: one coastal ring with a working dockyard at its
heart, four risk-vs-reward shortcuts, and four named takedown theatres. The route is
readable from anywhere on the island — the gantry cranes are the landmark you steer by.

---

## 1. Design pillars

1. **The ring tells you where you are.** Coast on one side, island interior on the
   other, cranes always on the horizon. No tunnel vision, no map needed.
2. **Risk buys seconds.** Every shortcut is strictly optional, never taken by rivals,
   and priced honestly: the more it saves, the more it can cost you (wreck = ~8 s of
   crashtime + SLOW reset, off a ledge = 5 s rescue).
3. **Takedowns everywhere, but four places are special.** Slow pockets and pinches are
   deliberately placed where the scenery sells the slam — crane legs, a cliff rim, a
   barrier chicane, a billboard.
4. **Flat-out rhythm.** Two genuine straights to breathe and boost; technical pockets
   (port streets, chicane, village) where the pack concertinas and the fighting happens.

---

## 2. Course overview

| Property | Value | Why |
| --- | --- | --- |
| Centreline length | ~2 090 m | verified against the Catmull-Rom resampler in `race.ts` |
| Sections | ~220 @ 8 m requested spacing | resampler's effective spacing lands ~9.5 m |
| Main ribbon width | 22 m | four Burnout lanes, same as SILVER LAKE RING — room for combat |
| Lap estimate | 61 s by `sum(8/v)`; **~73–78 s wall clock** | the 8 m nominal vs ~9.5 m effective spacing means real laps run ~1.19× the formula; lands on the ~75 s target |
| Laps | **2** | ~2.5–3 min race; shortcut knowledge pays twice |
| Rivals | **5** | skills 0.97, 0.94, 0.92, 0.90, 0.87 — colors 0x2266dd, 0xeeaa22, 0x22bb55, 0x8844cc, 0xd4408a |
| Speed classes | 18–38 m/s, both extremes present | chicane/port corners bottom out at 18; straights pin 38 |
| World footprint | x ∈ [−253, 262], z ∈ [−242, 250] | ground plane must scale to ≥ 580 × 560 (see §9) |
| Ground | `'field'` (grass island; race ribbon is the only paving) | dressing paints beach/water at the rim |

Direction of travel is **counter-clockwise** (east along the south straight first),
matching SILVER LAKE RING's grid logic: rivals stagger 7 m apart ahead of section 0,
player starts last.

---

## 3. Island map

North (+z) is up, east (+x) is right. `#` main loop, lowercase = shortcuts
(`f` Flyover Link, `h` Harbor Run, `l` Lookout Ledge, `b` Beach Run), uppercase =
takedown zones (`B`illboard Blast, `C`rane Smash, `X` = Cliff Crash, `R`oadblock),
`S` = start/finish. Everything beyond the loop's outer edge is water.

```
             # ### ####llllllll#### ############
         ####           ##  #                   ####
       ##                 ###                       ##
      #                                             X#
    ##            THE LOOKOUT                        #
    #                                               #
   #                                                #
   #                                               #
    ##                                            ##
     ##                                        ###h
     #                                       ##   h
   ##              (island interior)    #####     h
   #                                 ###          h
   #R#                              #  DOCKYARD   h
     #                              #            hh
   ###                              ##           h
  ##                                  #########  hh
  #                                            ###h
  #                                               C
  b####                                           #
  bb   #####                                     f#
   b        ##   VILLAGE                         f##
    bb       #                                  ff  #
     bb     ##                       CANNERY    f    #
      bb  ##                                  ff    #
        b ##                                 ff  ####
         bb ######                   # #####ff####
          bbbbbbbbbb#######S# ##B####
       BEACH    b
```

---

## 4. Main loop — waypoint table (blocking input)

Feed exactly these 40 points, in this order, to `buildLoopSections(WAYPOINTS, 8)`.
First point is the start/finish on the south straight, heading east. Section indices
quoted elsewhere in this document assume N ≈ 220 and are approximate by ±2 — the
implementation must derive real indices from the built sections (nearest section to
the stated coordinate), never hard-code mine.

| # | x | z | Sector / note |
|---|-----|------|---------------|
| 1 | 0 | -228 | **START/FINISH** — south straight, heading +x |
| 2 | 148 | -220 | south straight |
| 3 | 202 | -212 | into the Cannery horseshoe |
| 4 | 242 | -194 | horseshoe outer |
| 5 | 256 | -156 | Cannery Point apex (lighthouse) |
| 6 | 234 | -120 | horseshoe return |
| 7 | 226 | -95 | Crane Alley approach |
| 8 | 230 | -62 | quay south — port gate fork (Harbor Run entry) |
| 9 | 196 | -46 | main turns inland through the gates |
| 10 | 150 | -34 | dock street |
| 11 | 106 | -26 | dock street |
| 12 | 88 | 4 | warehouse hairpin west |
| 13 | 104 | 34 | climbing back east |
| 14 | 174 | 62 | between warehouse rows |
| 15 | 198 | 82 | port exit |
| 16 | 228 | 100 | rejoins the quay (Harbor Run exit) |
| 17 | 248 | 136 | quay north |
| 18 | 256 | 168 | quay north |
| 19 | 262 | 196 | **headland spike apex — CLIFF CRASH** |
| 20 | 242 | 224 | cliff hook |
| 21 | 204 | 240 | onto the clifftop road |
| 22 | 144 | 250 | clifftop straight |
| 23 | 30 | 244 | Lookout Ess entry (Ledge forks right) |
| 24 | -4 | 206 | ess bottom — around the lookout knoll |
| 25 | -40 | 240 | ess exit (Ledge rejoins) |
| 26 | -156 | 236 | clifftop straight west |
| 27 | -198 | 210 | NW sweeper outer |
| 28 | -228 | 170 | NW sweeper apex |
| 29 | -242 | 124 | west coast |
| 30 | -214 | 82 | chicane flick 1 (right) |
| 31 | -244 | 40 | chicane flick 2 (left) — **ROADBLOCK** |
| 32 | -218 | 2 | chicane flick 3 (right) |
| 33 | -246 | -40 | chicane exit (left) |
| 34 | -250 | -86 | west coast — Beach Run forks right |
| 35 | -202 | -100 | main turns inland into the village |
| 36 | -154 | -114 | village street |
| 37 | -140 | -156 | village 90° (south) |
| 38 | -174 | -188 | village 90° (back toward the sea) |
| 39 | -134 | -214 | village exit, motel corner |
| 40 | -78 | -226 | merges onto the south straight |

Verified properties of this exact loop (re-check after any edit):

- no centreline self-intersections; closest non-adjacent approach 41.7 m (Lookout Ess
  neck) — safely above the ~30 m two-ribbons-plus-walls minimum
- AI lap estimate 61.0 s, min section speed 18, max 38
- start grid: 150+ m of straight ahead of section 0 — fits 5 staggered rivals

### Sector character (approximate section indices)

| Sector | Sections | Character |
| --- | --- | --- |
| Billboard Straight | 0–15 | flat-out 38; boost, draft, line up BILLBOARD BLAST |
| Cannery Horseshoe | 16–36 | medium-slow right horseshoe around the lighthouse; Flyover Link cuts it |
| Crane Alley (quay south) | 36–41 | short straight under the gantry cranes; CRANE SMASH |
| Port Detour | 41–78 | the dockyard S: three 90°s through warehouses, slowest sustained stretch; Harbor Run skips it |
| Quay North | 78–88 | fast bowed run along the waterfront |
| Headland Spike | 88–100 | hard slow-in hook over the water; CLIFF CRASH |
| Clifftop Straight + Lookout Ess | 100–132 | fast, then a dip inland around the lookout knoll; Lookout Ledge runs the rim |
| NW Sweepers | 132–152 | two linked fast sweeps, classic Burnout wall-shoving |
| Roadblock Chicane | 152–176 | left-right-left-right barrier flicks, slowest pocket on the lap |
| Village Snake | 176–212 | inland 90°s past the motel; Beach Run bypasses on the sand |
| Merge & Line | 212–0 | accelerate back onto the straight |

---

## 5. Shortcuts (branch ribbons)

All four obey the contract: open polyline, entry index < exit index, both ≥ 4 sections
from index 0, none crosses start/finish, rivals never take them, **no barrier walls**.
Off-road cuts are deliberately tighter, prop-hazarded, and unguarded (off-track rescue
is the price of a bad line); the on-road link is wider and faster but demands a jump.

### 5.1 HARBOR RUN — the marquee gamble

- **Surface / width:** dirt (gravel dock apron), 11 m
- **Attach:** entry ≈ section 41 (the port gate fork at [230,−62]); exit ≈ section 78
  (quay rejoin at [228,100])
- **Polyline:** `[230,-58] → [222,-24] → [226,6] → [226,44] → [226,72] → [228,96]`
- **Saves:** ~3.5–4 s — it skips the entire Port Detour
- **The ride:** where the main road turns left through the port gates, the shortcut
  blasts straight on down a fenced gravel lane between container stacks. Mid-lane, a
  **container ramp** (`RampDef { x: 226, zStart: 14, length: 9, width: 7, height: 2.2 }`
  — segment heads +z, satisfying the ascend-toward-+z constraint) launches ~28–30 m of
  air. Landing corridor z ≈ 45…62 at x ≈ 226 must stay prop-free.
- **Risk:** 11 m wide between stack walls of containers (solid props just outside the
  ribbon), barrels at the mouth, the compulsory jump, and no walls to catch a slide.
  Wreck in here and the SectionResetPair drops you back at SLOW — the detour you tried
  to skip wins.
- **Tuning lever:** if 4 s proves dominant, pinch the exit with a barrel chicane
  before nerfing geometry.

### 5.2 FLYOVER LINK — on-road, contested

- **Surface / width:** asphalt, 12 m
- **Attach:** entry ≈ section 16 ([170,−217], end of the south straight); exit ≈
  section 35 ([224,−108], horseshoe return)
- **Polyline:** `[170,-217] → [200,-180] → [216,-148] → [224,-108]`
- **Saves:** ~1.5 s
- **The ride:** the poster's "highway link" reinterpreted for a flat world: a slip
  road that cuts the Cannery horseshoe and fires you off a **flyover ramp**
  (`RampDef { x: 220, zStart: -142, length: 10, width: 8, height: 2.0 }` — +z heading,
  legal). At ~34 m/s the jump carries ~43 m and lands you on the main quay right
  inside the CRANE SMASH theatre — often beside, or into, traffic you just undercut.
- **Risk:** lowest of the four, but the landing is shared road: arrive crooked and a
  rival shove becomes their takedown. Concrete barrier props line the outside of the
  link (outside the ribbon, never on it).

### 5.3 LOOKOUT LEDGE — short and gutsy

- **Surface / width:** dirt, 10 m (narrowest cut on the island)
- **Attach:** entry ≈ section 115 ([28,243]); exit ≈ section 126 ([−36,239])
- **Polyline:** `[28,243] → [-4,248] → [-36,239]`
- **Saves:** ~1.5 s
- **The ride:** the main road dips inland around the lookout knoll; the ledge runs
  straight along the cliff rim. 66 m of commitment with rock outcrops on the seaward
  lip and nothing else between you and the 5 s off-track rescue.
- **Risk:** tiny margin at full speed — entering above ~30 m/s without a clean line
  puts you over the rim. Highest risk-per-metre on the island.

### 5.4 BEACH RUN — the pressure valve

- **Surface / width:** dirt (hard sand), 12 m
- **Attach:** entry ≈ section 179 ([−250,−90], where main turns inland to the
  village); exit ≈ section 212 ([−80,−228], on the south straight, 8 sections before
  the line — inside the ≥4 contract)
- **Polyline:** `[-250,-90] → [-234,-136] → [-202,-178] → [-172,-224] → [-108,-242] → [-80,-228]`
- **Saves:** ~1 s clean — more in practice, because it bypasses the village snake
  where the pack concertinas and walls bite
- **The ride:** a long open sweep along the waterline past beach huts and boat props,
  rejoining by the motel. The forgiving one: wide, flowing, learnable on lap 1.
- **Risk:** stray seaward and the rescue timer runs; scattered rocks and a beached
  dinghy (props at the edges) punish lazy lines.

---

## 6. Signature takedown zones

Circular scoring zones; any takedown resolved inside one flashes its name instead of
TAKEDOWN (hook at the takedown resolution in `Game.ts`, ~lines 718–760). Scenery
supports the fantasy but **never blocks the racing line** — the red/white wall remains
the actual wrecking surface; props sit outside the wall line (or in `noCrashIds` where
soft). Zones are scoring-only: no colliders.

| Zone | Centre | Radius | Why here / scenery setup |
| --- | --- | --- | --- |
| **BILLBOARD BLAST** | (45, −227) | 22 m | The launch-speed shoving match right after the line. A huge race billboard towers behind the south wall at ~(45, −250); grandstand + flag props sell the start/finish. |
| **CRANE SMASH** | (228, −80) | 24 m | Crane Alley: two orange gantry cranes straddle the quay with legs planted just outside both walls; Flyover Link jumpers land here and Harbor Run forks here, so it's the most contested 40 m of road. |
| **CLIFF CRASH** | (252, 202) | 26 m | The headland spike apex — hard braking from the quay into a hook over open water. Rim rocks and a leaning warning-sign cluster beyond the outer wall; the wall *is* the cliff edge fence. |
| **ROADBLOCK** | (−230, 20) | 26 m | The chicane's middle flicks. Police-barrier / barricade prop clusters dress the verge outside each flick (plus 2–3 knockable barrels in the run-off, `LevelDef.barrels`), so shoving someone wide reads as smashing them through a roadblock. |

---

## 7. Theming & prop wishlist (CC0, Kenney / Quaternius low-poly)

Visual-only GLBs load async per the `models.ts` pattern; anything that must collide is
a synchronous cannon box built from plain numbers (see §9 determinism note).

**Dockyard (east, the heart):**
- gantry cranes ×2–3 (the island landmark — visible from the south straight)
- shipping containers (single + stacked units) lining Harbor Run and the port streets
- warehouse sheds; or use `BuildingDef` boxes (lit windows at night come free)
- cargo ship hull moored off the quay (in the water, pure set dressing)
- forklift, pallet stacks, cable spools, fuel silo, port gate + chain-link fences
- harbor lamp poles (`LevelDef.poles` — knockable, light up at night)

**Cliffs (north & northeast):**
- rock outcrops/boulders along the rim, warning signs at CLIFF CRASH
- lookout/radar tower on the knoll inside the Lookout Ess
- windswept pines/cypress, wooden fences
- buoys + water plane beyond the edge

**Beach & village (southwest):**
- motel block with sign at the village exit corner (~[−120, −200], outside the wall)
- beach huts, palms, parasols, beached dinghy/fishing boats, surf rocks
- small houses (`BuildingDef`, low h) inside the village snake — keep ≥20 m off any centreline; their colliders are solid
- pier sticking into the bay (visual)

**Start straight (south):**
- the big billboard (BILLBOARD BLAST), grandstand, team awnings, flag lines
- tire stacks, start gantry
- lighthouse on Cannery Point (~[268, −160], outside the horseshoe) + cannery shed

**Shortcut mouths:** arrow-sign props + 2–4 barrels (`LevelDef.barrels`) at each entry
so cuts read at speed.

---

## 8. Why each feature is buildable (engine mapping)

| Design feature | Engine concept |
| --- | --- |
| Main loop | `RaceDef.sections = buildLoopSections(WAYPOINTS, 8)` — AISections-style loop; ribbon, centre dashes, checkpoint gates every 6th section, and red/white walls with `phys.wallDirs` all come free from `environment.ts` |
| Speed feel | curvature classes `clamp(sqrt(16R), 18, 38)`: chicane/port bottom at 18–24, straights pin 38; brake-zone back-propagation already in `buildLoopSections` |
| Shortcuts | branch ribbons: open polyline + entry/exit section indices; resample with an open-ended variant of the Catmull resampler; **no walls**, narrower width, dirt tint |
| Takedown zones | `{ name, x, z, r }` list; point-in-circle test at takedown resolution swaps the `events.emit('flash', …)` text |
| Ramps | two `RampDef`s, both on +z-heading segments (axis-aligned constraint holds); suspension height-sampler handles the launch, physics box handles bad landings |
| Rivals | 5 `RaceDef.rivals`; RaceDirector grid/respawn (SectionResetPair semantics) unchanged |
| Wrecking | walls stay out of `noCrashIds`; zone scenery sits outside the wall line so contact rules in `collision.ts` need no changes |

**Engine work items this design depends on (build these first):**

1. **Branch progress hand-back.** `RaceDirector.trackPlayer()` scans only
   `playerTarget+0..2`. A player taking Harbor Run skips ~37 sections; without help
   their target never advances again this lap. Required: while the player is within a
   branch ribbon's width of its centreline, mark them "on branch X"; from then until
   rejoin, also test main sections `exitIdx−1 … exitIdx+3` for gate-reach and snap
   `playerTarget` forward on hit. (The Flyover jump can land *past* its exit section —
   hence the +3.) Rivals never branch, so AI paths are untouched.
2. **Off-track rescue must know about branches.** `playerOffTrackDistance()` measures
   against main sections only; the Harbor lane sits 22–30 m off the main centreline —
   beyond the `width/2 + 4` slack — so the 5 s rescue in `modes/race.ts` would fire
   mid-shortcut. Required: the distance is the **min** over main sections and all
   branch sections (or rescue is suspended while "on branch").
3. **Ground plane scale.** `buildEnvironment` hard-codes 320×320; this island needs
   ≥ 580×560 (footprint + margin). Scale from the level's section bounds.
4. **Dirt ribbon rendering** for branches (different colour/roughness; same flat
   y≈0.012 strip). Surface is cosmetic in v1 — no grip change (see out-of-scope).

**Determinism contract:** the loop, branches, ramps, walls, buildings, poles, barrels
and zone circles are all plain numbers in the LevelDef, built synchronously at level
construction. GLB props are visual-only and load async; any prop needing collision
(container stacks beside Harbor Run, crane legs) gets a synchronous cannon box from
hand-placed numbers in the LevelDef, with the GLB draped over it later. Nothing here
touches the seeded RNG stream.

---

## 9. Out of scope for v1

| Cut | Rationale |
| --- | --- |
| Ambient traffic streams (poster's "heavy traffic") | needs a traffic director + lane data on a closed circuit; rivals + walls already supply pressure |
| Boost pads | the earned boost meter is the game's economy; free boost undercuts it |
| Road elevation / true overpass | ribbon is flat at y≈0.012; the flyover *fantasy* ships via the ramp jump instead |
| Oncoming lanes | collision rules and AI sections are one-directional by design |
| Animated cranes / moving ships | moving scenery near the line risks nondeterministic physics contacts; v1 scenery is static |
| Surface-grip differences on dirt | physics parity keeps the replay/bug-report system byte-stable; dirt is art + dust |
| Water physics | the sea is a visual plane; leaving the island is handled by the existing off-track rescue |

---

## 10. Balance levers (post-playtest)

- Harbor Run save (4 s) → barrel chicane at exit, or lengthen the lane's slalom
- Rival pressure → skills up to 0.98 / add a 6th rival (grid fits)
- Race length → laps 2 → 3 once lap times confirm ~75 s
- BILLBOARD BLAST radius up to 26 if lap-1 scrums resolve just outside it
