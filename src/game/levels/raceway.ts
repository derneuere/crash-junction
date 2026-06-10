import type { LevelDef } from '../types';
import { buildLoopSections } from '../race';

// SILVER LAKE RING — a closed circuit for racing the AI. The layout is an
// ordered loop of AISections-style quad sections generated from waypoints:
// a long bottom straight into a fast right-hander, an S-chicane up the
// side, a back straight, and a slow hairpin home — corners that want the
// tap-to-drift, straights that want the gears and boost.

const WAYPOINTS: [number, number][] = [
  [-48, -46],
  [-10, -52],
  [30, -50],
  [52, -36],
  [56, -12],
  [44, 2],
  [50, 20],
  [42, 40],
  [16, 50],
  [-16, 48],
  [-44, 50],
  [-60, 32],
  [-56, 8],
  [-42, -4],
  [-56, -20],
  [-58, -36],
];

const SECTIONS = buildLoopSections(WAYPOINTS, 7);
const START = SECTIONS[0];

export const raceway: LevelDef = {
  name: 'SILVER LAKE RING',
  ground: 'field',
  race: {
    laps: 3,
    width: 13,
    sections: SECTIONS,
    rivals: [
      { color: 0x2266dd, skill: 0.97 },
      { color: 0xeeaa22, skill: 0.93 },
      { color: 0x22bb55, skill: 0.89 },
    ],
  },
  medals: { bronze: 0, silver: 0, gold: 0 }, // race medals come from position
  player: {
    variant: 'sedan',
    color: 0xc41e16,
    x: START.x - START.dirZ * 2.6, // grid slot right of the line
    z: START.z + START.dirX * 2.6,
    dir: { x: START.dirX, z: START.dirZ },
    speed: 0,
  },
  traffic: [],
  poles: [],
  barrels: [],
  ramps: [],
  buildings: [],
  pickups: [],
};
