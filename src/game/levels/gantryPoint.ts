import type { CoastDef, LevelDef, RaceWaypoint, ShortcutDef, SignatureZoneDef } from '../types';
import { buildLoopSections } from '../race';
import { beach } from './gantry/beach';
import { cliff } from './gantry/cliff';
import { dockyard } from './gantry/dockyard';
import { harbor } from './gantry/harbor';
import { shared, sharedNorthwestArc, sharedSouthArc } from './gantry/shared';
import type { ZoneDressing } from './gantry/dressing';

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
const WAYPOINTS: RaceWaypoint[] = [
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

const SECTIONS = buildLoopSections(WAYPOINTS, 8);
const START = SECTIONS[0];

/** Index of the built section nearest a map coordinate. Shortcut attachments
 *  are derived from the geometry, never hard-coded: the GDD quotes its
 *  indices as approximate (±2), and any waypoint tweak shifts every index
 *  after it — a stale hand-written number would silently break the wall
 *  gaps and the rejoin gates. The resampler owns the truth. */
function nearestSection(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < SECTIONS.length; i++) {
    const d = Math.hypot(SECTIONS[i].x - x, SECTIONS[i].z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Attach a branch ribbon at the sections nearest its first/last waypoints
 *  (the engine's wall-gap side inference and rejoin gates key off exactly
 *  those endpoints) and fail loud at module load if the ShortcutDef contract
 *  is broken — RaceDirector's lap counting leans on entry < exit with both
 *  clear of the line, so a violation must never reach a race. The same
 *  loudness guards the elevation contract: a branch mouth that doesn't
 *  match the main loop's height is a launch edge on shared driving
 *  surface, exactly the bug class the height field must never grow. */
function shortcut(name: string, waypoints: RaceWaypoint[], width: number, surface: ShortcutDef['surface']): ShortcutDef {
  const [ex0, ez0] = waypoints[0];
  const [ex1, ez1] = waypoints[waypoints.length - 1];
  const entry = nearestSection(ex0, ez0);
  const exit = nearestSection(ex1, ez1);
  if (!(entry >= 4 && entry < exit && exit <= SECTIONS.length - 4)) {
    throw new Error(`${name}: entry/exit ${entry}->${exit} breaks the shortcut contract (N=${SECTIONS.length})`);
  }
  for (const [wp, sec, end] of [
    [waypoints[0], entry, 'entry'],
    [waypoints[waypoints.length - 1], exit, 'exit'],
  ] as const) {
    const dy = Math.abs((wp[2] ?? 0) - SECTIONS[sec].y);
    if (dy > 0.5) {
      throw new Error(`${name}: ${end} y ${wp[2] ?? 0} is ${dy.toFixed(2)} m off the main loop (section ${sec} at y ${SECTIONS[sec].y.toFixed(2)})`);
    }
  }
  return { name, entry, exit, waypoints, width, surface };
}

// Risk buys seconds. Every cut is strictly optional, rivals never take them,
// and the price is honest: no walls to catch a slide, a wreck pays the full
// SectionResetPair price (back on the MAIN loop at the fork, at SLOW), and
// straying seaward runs the 5 s off-track rescue.
const SHORTCUTS: ShortcutDef[] = [
  // The marquee gamble: where the main road turns inland through the port
  // gates, blast straight on down a gravel lane between container stacks —
  // over a compulsory container ramp — and skip the entire Port Detour.
  // Saves ~4 s; wreck in here and the detour wins.
  shortcut('HARBOR RUN', [[230, -58], [222, -24], [226, 6], [226, 44], [226, 72], [228, 96]], 11, 'dirt'),
  // On-road and contested: a slip road cuts the Cannery horseshoe and fires
  // off a flyover ramp (~43 m of air at speed), landing on the quay right
  // inside the CRANE SMASH theatre. Lowest risk, smallest save (~1.5 s) —
  // but arrive crooked on shared road and a rival shove is their takedown.
  shortcut('FLYOVER LINK', [[170, -217], [200, -180], [216, -148], [224, -108]], 12, 'asphalt'),
  // Short and gutsy: the main road dips inland around the lookout knoll;
  // the ledge runs straight along the cliff rim. The flow pass moved the
  // ess fork east and its exit west, so the rim run grew to ~129 m of
  // commitment — still the narrowest ribbon on the island, highest
  // risk-per-metre, and it now skips the whole three-arc drift chain.
  // Elevation made it LITERAL (the Mt. Akina route asymmetry): the main
  // road compresses down to +3.5 in the ess while the ledge holds the +6
  // rim — endpoint heights match the fork/rejoin sections (asserted).
  shortcut('LOOKOUT LEDGE', [[52, 240, 5.9], [-8, 247, 6.2], [-76, 237, 5.9]], 10, 'dirt'),
  // The pressure valve: a long open sweep along the waterline that bypasses
  // the village snake where the pack concertinas. Wide, flowing, learnable
  // on lap one — the forgiving cut. Its mouth moved with the eased fork
  // sweeper; now that the fork itself is flat-out the cut sells flow more
  // than seconds, which is the right price for the forgiving option.
  shortcut('BEACH RUN', [[-240, -76], [-234, -136], [-202, -178], [-172, -224], [-108, -242], [-80, -228]], 12, 'dirt'),
];

// Named takedown theatres — scoring-only circles (no colliders): a takedown
// resolved with the victim inside flashes the zone's name instead of
// TAKEDOWN. Placed on the slow pockets and pinches where the scenery (the
// zone dressing) sells the slam; the red/white wall stays the actual
// wrecking surface.
const SIGNATURES: SignatureZoneDef[] = [
  { name: 'BILLBOARD BLAST', x: 45, z: -227, r: 22 }, // launch-speed scrum after the line
  { name: 'CRANE SMASH', x: 228, z: -80, r: 24 }, // Crane Alley: Harbor forks, Flyover lands
  { name: 'CLIFF CRASH', x: 256, z: 204, r: 26 }, // headland spike: committed drift over open water (re-centred to hug the eased apex)
  { name: 'ROADBLOCK', x: -230, z: 20, r: 26 }, // the chicane's middle flicks
];

// ---------------------------------------------------------------------------
// Zone assembly. Concatenation order is fixed — shared, dockyard, harbor,
// cliff, beach — for BOTH render layering and physics determinism: solid
// props create static cannon bodies in array order, and reshuffling them
// re-deals body ids (replay determinism pins live on the other levels, but
// there is no reason to churn). wallStyles inherit the same order, and the
// engine resolves overlaps last-wins: a zone's local exception beats
// shared's broad range.
// ---------------------------------------------------------------------------

const ZONES: ZoneDressing[] = [shared, dockyard, harbor, cliff, beach];

// The island outline: ONE closed CCW loop stitched from the per-zone arcs in
// a FIXED order (each arc is open; its last vertex's edge styles the seam
// segment into the next arc, and harbor's last vertex closes back into the
// south arc):
//
//   shared south arc (E→W, bank)
//   → beach west/south-west arc (S→N, beach)
//   → shared NW connector (S→N, bank)
//   → cliff north arc (W→E, cliff)
//   → harbor east arc (N→S, wall/cliff/beach)
//   → close
//
// The outline replaces the auto-sized ground square, so it must enclose
// every road, prop and building — the deliberate exceptions are the four
// vessels (freighter, two fishing boats, the yacht), which float OUTSIDE it
// on the -2.2 sea, and the pier platforms that overhang the beach rim.
const COAST: CoastDef = {
  seaLevel: -2.2,
  outline: [...sharedSouthArc, ...(beach.coast ?? []), ...sharedNorthwestArc, ...(cliff.coast ?? []), ...(harbor.coast ?? [])],
};

export const gantryPoint: LevelDef = {
  name: 'GANTRY POINT',
  ground: 'field', // grass island — the race ribbon is the only paving
  coast: COAST,
  mode: {
    kind: 'race',
    race: {
      laps: 2, // ~2.5 min race; shortcut knowledge pays twice
      width: 22, // four Burnout lanes, same as SILVER LAKE RING — room for combat
      sections: SECTIONS,
      // the GDD's full five-car grid (§2): a deeper pack than SILVER LAKE so
      // the slow pockets concertina — "takedowns everywhere" needs targets.
      // Personalities mirror SILVER LAKE's spread (pacesetter / headhunter /
      // cruiser / bully) plus a mid-temper scrapper: the quickest car races
      // mostly clean at the sharp end while the hunters live in the pack,
      // where the dock pockets concertina the field into reach.
      rivals: [
        { color: 0x2266dd, skill: 0.97, aggression: 0.5 }, // the pacesetter — wins on pace, scraps only when crowded
        { color: 0xeeaa22, skill: 0.94, aggression: 0.85 }, // the headhunter — hunts the player through the pockets
        { color: 0x22bb55, skill: 0.92, aggression: 0.3 }, // the cruiser — minds its racing line
        { color: 0x8844cc, skill: 0.9, aggression: 0.95 }, // the bully — lives for the slam
        { color: 0xd4408a, skill: 0.87, aggression: 0.6 }, // the scrapper — slow, but trades paint to hold the spot
      ],
      shortcuts: SHORTCUTS,
      signatures: SIGNATURES,
      wallStyles: ZONES.flatMap((z) => z.wallStyles ?? []),
    },
  },
  player: {
    variant: 'sedan',
    color: 0xc41e16,
    x: START.x - START.dirZ * 2.6, // grid slot right of the line
    z: START.z + START.dirX * 2.6,
    dir: { x: START.dirX, z: START.dirZ },
    speed: 0,
  },
  traffic: [],
  // Knockable furniture (dynamic actors — never ON a ribbon's driving line).
  // Every spot was audited against the fine-sampled spline chains of the
  // flow-pass geometry (same band math as tools/audit-gantry-dressing.mjs):
  // mouth barrels stand 1–3 m outside their branch ribbon's edge in the
  // fork wedges and flanks, ≥ 12 m off the main centreline — most inside
  // the wall-gap spans, so a wide line clips them from either road. The
  // ROADBLOCK cluster is the exception by necessity: the chicane is walled
  // on both sides, so its run-off is the outer band of the corridor itself;
  // everything there sits ~8.3–9.5 m off the centreline (≥ 1.5 m inside the
  // wall), ground the slalom line never uses.
  poles: [
    // ROADBLOCK run-off lamps (GDD §6): planted where each middle flick's
    // overshoot ray crosses the outer band, in front of the barricade decor
    // behind the wall — blow the flick and you fell a streetlight before
    // you meet the barrier. Both inside the signature circle. Re-seated for
    // the flow pass: flick 3's centreline moved ~11 m west, flick 2's verge
    // tightened ~1 m.
    { x: -248, z: 23.5 },
    { x: -220, z: 5 },
  ],
  barrels: [
    // Shortcut-mouth markers (GDD §7: 2–4 barrels at each entry so the cuts
    // read at speed; §5.1 prices Harbor's mouth in barrels). Explosive red —
    // clipping one on the way into a cut is the advertised risk.
    // HARBOR RUN: flanking the gravel lane through the port-gate furniture
    { x: 216, z: -34 },
    { x: 216.5, z: -37 },
    { x: 234, z: -44 },
    { x: 236, z: -48 },
    // FLYOVER LINK: one under the banner tower, a pair in the slip-road
    // crotch where the link peels off the straight
    { x: 169, z: -204 },
    { x: 192, z: -202 },
    { x: 196, z: -197 },
    // LOOKOUT LEDGE: on the seaward lip at the mouth, short of the solid
    // rim rocks — the narrowest cut announces itself loudest (moved with
    // the ess fork ~18 m east).
    // Elevation: this pair seats at +6 m — Game.ts passes the sampler's
    // base() into createBarrel (elevation.md Phase 1 furniture-y item),
    // so they stand ON the embankment instead of buried inside it.
    { x: 39, z: 249 },
    { x: 33, z: 251 },
    // BEACH RUN: fork-wedge pair by the pylon, seaward pair by the pier —
    // the eased fork pulled the ribbon's first reach ~6 m east, so all
    // four re-seated back to the 1–3 m band off the new edge
    { x: -231, z: -116 },
    { x: -229, z: -125 },
    { x: -246, z: -116 },
    { x: -247, z: -107.5 },
    // ROADBLOCK run-off (GDD §6 "2–3 knockable barrels in the run-off"):
    // bunched on the overshoot rays of the two middle flicks, all inside
    // the signature circle — shoving someone wide here reads as smashing
    // them through the roadblock. The flick-2 trio stays (the eased line
    // drifted them < 1.5 m, still in band); the flick-3 pair follows its
    // centreline ~9 m west.
    { x: -252, z: 32 },
    { x: -250, z: 29 },
    { x: -249, z: 26 },
    { x: -220, z: 11 },
    { x: -219.5, z: 7.5 },
  ],
  // Both ramps live on branch corridors (no walls there), ascend toward +z
  // per the RampDef constraint, and sit dead on their chain centrelines
  // (lateral offset audited at 0.3 m / 1.0 m). The main loop never comes
  // within 16 m of either wedge, so the global height sampler can't bump a
  // car running the ordinary racing line.
  ramps: [
    // Harbor Run container ramp — the compulsory jump mid-lane; the landing
    // corridor (z 45–62 at x 226) stays prop-free by GDD decree
    { x: 226, zStart: 14, length: 9, width: 7, height: 2.2 },
    // Flyover Link ramp — the "highway link" fantasy on a flat world
    { x: 220, zStart: -142, length: 10, width: 8, height: 2.0 },
  ],
  buildings: ZONES.flatMap((z) => z.buildings ?? []),
  pickups: [],
  props: ZONES.flatMap((z) => z.props),
  patches: ZONES.flatMap((z) => z.patches ?? []),
  decals: ZONES.flatMap((z) => z.decals ?? []),
};
