import type { LevelDef } from '../types';
import { buildLoopSections } from '../race';

// SILVER LAKE RING — a closed circuit for racing the AI. The layout is an
// ordered loop of AISections-style quad sections generated from waypoints.
// Four lanes wide, walled in, and every corner is a generous sweeper —
// the whole lap is meant to be driven flat-out (drift the sweeps, never
// brake), with the racing line decided by who shoves whom into the wall.

const WAYPOINTS: [number, number][] = [
  // bottom straight, west → east
  [-50, -78],
  [0, -80],
  [50, -78],
  // SE sweeper up the right side
  [82, -62],
  [97, -32],
  [99, 0],
  [96, 32],
  // NE sweeper into the top straight
  [80, 62],
  [48, 78],
  [0, 81],
  [-48, 78],
  // NW sweeper down the left side
  [-80, 62],
  [-96, 32],
  [-99, 0],
  [-97, -32],
  // SW sweeper back to the line
  [-82, -62],
];

const SECTIONS = buildLoopSections(WAYPOINTS, 8);
const START = SECTIONS[0];

export const raceway: LevelDef = {
  name: 'SILVER LAKE RING',
  ground: 'field',
  mode: {
    kind: 'race',
    race: {
      laps: 3,
      width: 16, // four lanes — room to trade paint
      sections: SECTIONS,
      rivals: [
        { color: 0x2266dd, skill: 0.97 },
        { color: 0xeeaa22, skill: 0.93 },
        { color: 0x22bb55, skill: 0.89 },
      ],
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
  poles: [],
  barrels: [],
  ramps: [],
  buildings: [],
  pickups: [],
};
