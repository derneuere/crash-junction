import type { RaceWaypoint, ShortcutDef, SignatureZoneDef } from '../../types';
import { SECTIONS } from './waypoints';

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
export const SHORTCUTS: ShortcutDef[] = [
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
export const SIGNATURES: SignatureZoneDef[] = [
  { name: 'BILLBOARD BLAST', x: 45, z: -227, r: 22 }, // launch-speed scrum after the line
  { name: 'CRANE SMASH', x: 228, z: -80, r: 24 }, // Crane Alley: Harbor forks, Flyover lands
  { name: 'CLIFF CRASH', x: 256, z: 204, r: 26 }, // headland spike: committed drift over open water (re-centred to hug the eased apex)
  { name: 'ROADBLOCK', x: -230, z: 20, r: 26 }, // the chicane's middle flicks
];
