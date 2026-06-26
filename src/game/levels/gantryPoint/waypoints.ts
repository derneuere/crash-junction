import type { RaceWaypoint } from '../../types';
import { buildLoopSections } from '../../race';

// GANTRY POINT — a flat-out lap of a rugged port island (docs/gantry-point-gdd.md).
// Burnout 3 "round course" energy: one coastal ring, counter-clockwise, with
// a working dockyard at its heart, four player-only shortcut ribbons and four
// named takedown theatres. Two genuine straights to breathe and boost; the
// port detour, the roadblock chicane and the village snake are the slow
// pockets where the pack concertinas and the shoving happens.
//
// THIS FILE IS THE COMPOSER. Gameplay lives here — waypoints, shortcuts,
// signatures, barrels, poles, ramps — and is never authored in a zone file.
// The set dressing is split across src/game/levels/gantry/ by territory so
// four zone passes can land in parallel:
//
//   dockyard  x in [60, 270] AND z in [-105, 135]   (Crane Alley, canyon, sheds)
//   harbor    (x >= 246 AND z >= 80) OR (x >= 252 AND z <= -110)
//   cliff     z >= 185 (minus the NW sweeper pines — see shared.ts)
//   beach     x <= -78 AND z <= -60 (hamlet + Beach Run rejoin included)
//   shared    everything else (start straight, slip-road, NW pines, roadblock)
//
// Each zone exports one ZoneDressing; this file concatenates their props /
// patches / decals / wallStyles / buildings and stitches their coast arcs
// into the single closed island outline.

// The GDD's table, reprofiled by the flow pass (docs/research/
// gantry-flow-pass.md): in Burnout the default corner is a sweeper you
// DRIFT, not a bend you brake for, and our drift bottoms out at a ~27 m
// centreline radius — so every corner that accidentally fell under that
// bar is eased back over it, while the three PAID slow pockets keep their
// geometry on purpose: the CRANE SMASH port-gate fork (the lap's one true
// brake pinch), the ROADBLOCK middle flicks (kept class 18, but unfolded
// to R 20-22 so a tap-spam drift survives the theatre) and the village
// south leg (deliberately marginal R~24 so Beach Run keeps its price).
// The concertina survives the easing for free: rivals run a 16 m/s²
// lateral budget, a committed drift holds 33-42 — a corner reprofiled to
// R 27-36 still classes at 21-24 for the pack while the player carries
// 30-40 through the same arc.
// Tuned lap: 215 sections, 1996 m, sum(8/v) = 58.7 s — the 8 m nominal vs
// ~9.5 m effective spacing means real laps run ~1.15x that, on a ~70 s
// wall clock, inside the GDD's 60-90 s window.
//
// ELEVATION PROFILE (docs/research/elevation.md, Phases 0+1): the optional
// third component is road height in metres. The lap's climb-crest-descend
// sentence lives ONLY on the north arc — quay climb (~5.6% avg over 107 m)
// → CLIFF CRASH at +6 with the sea 8 m below the rim → clifftop straight
// held high with a gentle crest hiding the ess → Lookout Ess compression
// down to +3.5 (LOOKOUT LEDGE holds ~+6 along the rim: the literal high
// line) → a ~2-3% downhill boost-and-drift run through the NW sweepers,
// feathered to 0 before flick 1. Everything south and east stays at exact
// 0 BY DESIGN: the grid scrum keeps its tuned behavior, the dockyard IS
// quay level, both ramps and three of four shortcuts live in the flat
// zone. Heights ride existing waypoints only — arc length is 2D, so the
// profile cannot move a section or change a speed class; designed crest
// radii here are well over the ~150 m planted/airborne threshold, so the
// lap stays grounded at any speed (air stays the ramps' job).
//
// Phase 2 (full heightfield terrain — sloped island, stacked roads, wreck
// physics on grades) is deliberately NOT built, per the research doc's own
// recommendation: a walled circuit racer gets ~all of the feel from
// road-following height at a fraction of the surface area. Revisit only
// if a future level needs true overpasses.
export const WAYPOINTS: RaceWaypoint[] = [
  // south straight, heading east — START/FINISH, BILLBOARD BLAST
  [0, -228],
  [148, -220],
  [202, -212],
  // Cannery horseshoe around the lighthouse point (Flyover Link cuts it) —
  // pushed out and re-rounded so the apex holds a flat-out drift (R 27→35)
  [246, -192],
  [258, -154],
  [236, -118],
  // Crane Alley — the quay under the gantry cranes; CRANE SMASH
  [227, -94], // +1/+1 smooths the dogleg the horseshoe easing would kink
  [230, -62], // port gate fork: Harbor Run blasts straight on — the lap's
  // one KEPT brake pinch (R 15): grip-corner it, or take the cut
  // Port Detour — the dockyard S through the warehouse rows, slowest
  // sustained stretch on the lap; Harbor Run skips all of it (kept slow:
  // already a committed-drift corridor at R 29, GDD decree)
  [196, -46],
  [150, -34],
  [106, -26],
  [88, 4], // warehouse hairpin west
  [104, 34],
  [174, 62],
  [198, 82],
  [228, 100], // quay rejoin (Harbor Run exit) — flat: the cut must land at 0
  // quay north — fast bowed run along the waterfront, now the lap's CLIMB:
  // the Catmull clamp keeps the rejoin flat, then the road rises with the
  // gold grass (the section-87 kerb→guardrail handover is also the felt
  // start of the hill)
  [248, 136, 1.4],
  [257, 170, 3.6],
  [264, 200, 6], // headland spike apex — CLIFF CRASH at full height, eased
  [247, 226, 6], // R 22→30: shed speed with a lift and an early slide,
  [204, 240, 6], // never the brake — now with the sea 8 m below the rim
  // clifftop straight, then the Lookout Ess around the knoll — the old
  // 110 m brake trap with a 12 m fold is now three chained R~30 arcs the
  // drift can string together; the dip cuts ~9 m deeper inland to buy
  // each arc its radius (fork moved ~18 m east, exit ~30 m west). The
  // straight crests at +6.5 — just enough to hide the dipping ess until
  // the road falls away (sightline reveal, McMillan's anxiety→relief)
  [144, 250, 6.5],
  [48, 239, 5.9], // ess entry (Lookout Ledge holds the +6 rim — high line)
  [20, 217, 4.5],
  [-8, 205, 3.5], // ess bottom — a real compression at ~0.3 g extra load
  [-36, 213, 4.5],
  [-72, 236, 5.9], // ess exit (Ledge rejoins at matching height)
  [-156, 236, 4.1],
  // NW sweepers — two linked fast sweeps, classic wall-shoving ground;
  // now a ~2-3% DOWNHILL run (East Crawford economy: the drift-and-air
  // boost refill pays double on the way down), feathered to 0 by flick 1
  [-198, 210, 2.5],
  [-228, 170, 1.1],
  [-242, 124, 0.25],
  // Roadblock Chicane — barrier flicks; ROADBLOCK. Flick 1 eased to a
  // marginal drift flick (amplitude −12, R 14→24); the MIDDLE flicks keep
  // class 18 — still the slowest walled pocket, still the takedown
  // theatre — but unfolded to R 20-22 ("hairpin-lite", not a dead stop)
  [-226, 82], // flick 1
  [-244, 40], // flick 2 — same coordinate; unfolds via its neighbours
  [-229, 6], // flick 3, amplitude −11
  [-246, -40],
  // Beach fork — the old turn-in trap (R 16) rounded into a flat-out
  // sweeper (R 42); Beach Run forks seaward off the arc
  [-245, -60],
  [-230, -86],
  [-206, -99],
  // Village Snake — inland past the motel; the street and motel corner
  // ease to committed drifts, the south leg stays DELIBERATELY marginal
  // (R~24) so the village keeps its concertina and Beach Run its price
  [-152, -114], // village street
  [-130, -156], // village right sweep (R 19→32)
  [-133, -185], // village south leg — marginal by design
  [-122, -207], // motel sweep
  [-96, -220], // launches the drift onto the straight
  [-78, -226], // merges onto the south straight
];

export const SECTIONS = buildLoopSections(WAYPOINTS, 8);
export const START = SECTIONS[0];
