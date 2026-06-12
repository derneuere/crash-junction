import type { CoastDef, LevelDef, ShortcutDef, SignatureZoneDef } from '../types';
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

// The GDD's 40-point table, with two corners re-rounded after the resampler
// audit: the Lookout Ess bottom and the second village 90° both produced a
// centreline radius under the 11 m half-width — the ribbon (and its wall
// chain) would have folded over itself at the apex. Each apex is split into
// two points along the turn; both corners still bottom out at the 18 m/s
// floor, so the slow pockets the GDD wants there survive untouched.
// Tuned lap: 220 sections, 2080 m, sum(8/v) = 61.8 s — the 8 m nominal vs
// ~9.5 m effective spacing means real laps run ~1.19x that, on the ~75 s
// design target.
const WAYPOINTS: [number, number][] = [
  // south straight, heading east — START/FINISH, BILLBOARD BLAST
  [0, -228],
  [148, -220],
  [202, -212],
  // Cannery horseshoe around the lighthouse point (Flyover Link cuts it)
  [242, -194],
  [256, -156],
  [234, -120],
  // Crane Alley — the quay under the gantry cranes; CRANE SMASH
  [226, -95],
  [230, -62], // port gate fork: Harbor Run blasts straight on
  // Port Detour — the dockyard S through the warehouse rows, slowest
  // sustained stretch on the lap; Harbor Run skips all of it
  [196, -46],
  [150, -34],
  [106, -26],
  [88, 4], // warehouse hairpin west
  [104, 34],
  [174, 62],
  [198, 82],
  [228, 100], // quay rejoin (Harbor Run exit)
  // quay north — fast bowed run along the waterfront
  [248, 136],
  [256, 168],
  [262, 196], // headland spike apex — CLIFF CRASH
  [242, 224],
  [204, 240],
  // clifftop straight, then the Lookout Ess around the knoll
  [144, 250],
  [30, 244], // ess entry (Lookout Ledge runs the rim)
  [10, 218], // ess bottom, rounded in two points — single-apex V folded
  [-20, 216], // the 22 m ribbon (R 6.8 < half-width 11)
  [-40, 240], // ess exit (Ledge rejoins)
  [-156, 236],
  // NW sweepers — two linked fast sweeps, classic wall-shoving ground
  [-198, 210],
  [-228, 170],
  [-242, 124],
  // Roadblock Chicane — left-right-left-right barrier flicks; ROADBLOCK
  [-214, 82],
  [-244, 40],
  [-218, 2],
  [-246, -40],
  [-250, -86], // Beach Run forks seaward here
  // Village Snake — inland 90°s past the motel
  [-202, -100],
  [-154, -114],
  [-140, -156],
  [-168, -180], // second 90° rounded in two points — same fold fix as
  [-164, -198], // the ess (single apex read R 10.3)
  [-134, -214], // motel corner
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
 *  clear of the line, so a violation must never reach a race. */
function shortcut(name: string, waypoints: [number, number][], width: number, surface: ShortcutDef['surface']): ShortcutDef {
  const [ex0, ez0] = waypoints[0];
  const [ex1, ez1] = waypoints[waypoints.length - 1];
  const entry = nearestSection(ex0, ez0);
  const exit = nearestSection(ex1, ez1);
  if (!(entry >= 4 && entry < exit && exit <= SECTIONS.length - 4)) {
    throw new Error(`${name}: entry/exit ${entry}->${exit} breaks the shortcut contract (N=${SECTIONS.length})`);
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
  // the ledge runs straight along the cliff rim. 66 m of commitment, the
  // narrowest ribbon on the island, highest risk-per-metre.
  shortcut('LOOKOUT LEDGE', [[28, 243], [-4, 248], [-36, 239]], 10, 'dirt'),
  // The pressure valve: a long open sweep along the waterline that bypasses
  // the village snake where the pack concertinas. Wide, flowing, learnable
  // on lap one — the forgiving cut.
  shortcut('BEACH RUN', [[-250, -90], [-234, -136], [-202, -178], [-172, -224], [-108, -242], [-80, -228]], 12, 'dirt'),
];

// Named takedown theatres — scoring-only circles (no colliders): a takedown
// resolved with the victim inside flashes the zone's name instead of
// TAKEDOWN. Placed on the slow pockets and pinches where the scenery (the
// zone dressing) sells the slam; the red/white wall stays the actual
// wrecking surface.
const SIGNATURES: SignatureZoneDef[] = [
  { name: 'BILLBOARD BLAST', x: 45, z: -227, r: 22 }, // launch-speed scrum after the line
  { name: 'CRANE SMASH', x: 228, z: -80, r: 24 }, // Crane Alley: Harbor forks, Flyover lands
  { name: 'CLIFF CRASH', x: 252, z: 202, r: 26 }, // headland spike: hard slow-in over open water
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
      // the slow pockets concertina — "takedowns everywhere" needs targets
      rivals: [
        { color: 0x2266dd, skill: 0.97 },
        { color: 0xeeaa22, skill: 0.94 },
        { color: 0x22bb55, skill: 0.92 },
        { color: 0x8844cc, skill: 0.9 },
        { color: 0xd4408a, skill: 0.87 },
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
  // Every spot was audited against the fine-sampled spline chains
  // (tools/audit-gantry-dressing.mjs): mouth barrels stand 1–3 m outside
  // their branch ribbon's edge in the fork wedges and flanks, ≥ 12 m off the
  // main centreline — most inside the wall-gap spans, so a wide line clips
  // them from either road. The ROADBLOCK cluster is the exception by
  // necessity: the chicane is walled on both sides, so its run-off is the
  // outer band of the corridor itself; everything there sits 9–10 m off the
  // centreline (≥ 1.3 m inside the wall), ground the slalom line never uses.
  poles: [
    // ROADBLOCK run-off lamps (GDD §6): planted where each middle flick's
    // overshoot ray crosses the outer band, in front of the barricade decor
    // behind the wall — blow the flick and you fell a streetlight before
    // you meet the barrier. Both inside the signature circle.
    { x: -247, z: 23 },
    { x: -209, z: 6 },
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
    // rim rocks — the narrowest cut announces itself loudest
    { x: 16, z: 252 },
    { x: 10, z: 253 },
    // BEACH RUN: fork-wedge pair by the pylon, seaward pair by the pier
    { x: -233, z: -115 },
    { x: -231, z: -125 },
    { x: -251, z: -116 },
    { x: -253.5, z: -107.5 },
    // ROADBLOCK run-off (GDD §6 "2–3 knockable barrels in the run-off"):
    // bunched on the overshoot rays of the two middle flicks, all inside
    // the signature circle — shoving someone wide here reads as smashing
    // them through the roadblock
    { x: -252, z: 32 },
    { x: -250, z: 29 },
    { x: -249, z: 26 },
    { x: -210.5, z: 12.5 },
    { x: -209, z: 8 },
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
