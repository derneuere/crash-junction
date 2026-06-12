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
      width: 22, // four generous lanes — Burnout roads, room for combat
      sections: SECTIONS,
      // personalities, B3-style: skill is honest pace, aggression is how
      // often they go for the shunt/slam when somebody's in reach
      rivals: [
        { color: 0x2266dd, skill: 0.97, aggression: 0.55 }, // the pacesetter — quick, scraps when crowded
        { color: 0xeeaa22, skill: 0.93, aggression: 0.8 }, // the headhunter
        { color: 0x22bb55, skill: 0.89, aggression: 0.25 }, // the cruiser — mostly racing clean
        { color: 0x9933cc, skill: 0.91, aggression: 0.95 }, // the bully — lives for the slam
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
