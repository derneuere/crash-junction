// Race authoring for the editor: the waypoint loop is the source of truth
// the user drags; sections are DERIVED via the game's own resampler
// (race/sections.ts buildLoopSections, spacing 8 — the exact call the
// shipped circuits make at module load), so an edited race drives exactly
// like a hand-authored one.

import type { LevelDef, RaceDef, RaceWaypoint } from '../game/types';
import { buildLoopSections } from '../game/race/sections';

export const SECTION_SPACING = 8;

/** Starter loop for a fresh race — a friendly rounded oval. */
export function defaultWaypoints(): RaceWaypoint[] {
  return [
    [-45, -62], [0, -66], [45, -62],
    [68, -34], [74, 0], [68, 34],
    [45, 60], [0, 65], [-45, 60],
    [-68, 34], [-74, 0], [-68, -34],
  ];
}

export function deriveSections(waypoints: RaceWaypoint[]) {
  return buildLoopSections(waypoints, SECTION_SPACING);
}

/** A complete fresh RaceDef + the level tweaks that make it playable:
 *  sections derived, three beatable rivals, player moved onto the grid
 *  (one slot right of the start line, raceway.ts-style), grass ground so
 *  the ribbon is the paving. Returns a new level. */
export function makeRaceLevel(level: LevelDef): LevelDef {
  const waypoints = defaultWaypoints();
  const sections = deriveSections(waypoints);
  const start = sections[0];
  const race: RaceDef = {
    laps: 3,
    width: 12,
    waypoints,
    sections,
    rivals: [
      { color: 0x2266dd, skill: 0.95, aggression: 0.5 },
      { color: 0xeeaa22, skill: 0.91, aggression: 0.75 },
      { color: 0x22bb55, skill: 0.88, aggression: 0.25 },
    ],
  };
  return {
    ...level,
    ground: level.ground ?? 'field',
    mode: { kind: 'race', race },
    player: {
      ...level.player,
      x: start.x - start.dirZ * 2.6,
      z: start.z + start.dirX * 2.6,
      dir: { x: start.dirX, z: start.dirZ },
      speed: 0,
    },
  };
}

/** Where a fresh waypoint goes: after the selected one, at the midpoint to
 *  its loop successor — or, with nothing selected, after the last. */
export function insertWaypointSpot(
  waypoints: RaceWaypoint[],
  selectedIndex: number | null,
): { index: number; wp: RaceWaypoint } {
  const n = waypoints.length;
  const i = selectedIndex != null && selectedIndex >= 0 && selectedIndex < n ? selectedIndex : n - 1;
  const a = waypoints[i];
  const b = waypoints[(i + 1) % n];
  const wp: RaceWaypoint = [
    Math.round(((a[0] + b[0]) / 2) * 10) / 10,
    Math.round(((a[1] + b[1]) / 2) * 10) / 10,
  ];
  const ay = a[2] ?? 0;
  const by = b[2] ?? 0;
  if (ay || by) wp.push(Math.round(((ay + by) / 2) * 10) / 10);
  return { index: i + 1, wp };
}

/** Keep sections in lockstep with a waypoint edit — the editor's one derive
 *  rule (steward's applyDerives, specialized). Call with the post-write
 *  level + the path that changed; returns the level with sections rebuilt
 *  when the change touched the waypoint loop. */
export function applyLevelDerives(level: LevelDef, path: (string | number)[]): LevelDef {
  if (
    path[0] === 'mode' && path[1] === 'race' && path[2] === 'waypoints' &&
    level.mode.kind === 'race' && level.mode.race.waypoints &&
    level.mode.race.waypoints.length >= 3
  ) {
    return {
      ...level,
      mode: {
        ...level.mode,
        race: { ...level.mode.race, sections: deriveSections(level.mode.race.waypoints) },
      },
    };
  }
  return level;
}
