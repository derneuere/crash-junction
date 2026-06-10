import type { LevelDef } from '../types';

// LEVEL 1 — CRASH JUNCTION
//
// Traffic is a living system, not a timed script: cars cruise their lanes,
// yield to each other at the junction, and loop back through the fog when
// they leave the map — so the crossing stays busy no matter when (or how
// fast) the player arrives. The ~120 m approach gives time to line up a
// ramp, grab a multiplier ring mid-air and pick a target. Barrel clusters
// at the corners, the median and the landing zone chain off any blast; the
// fuel tanker is the jackpot; the queued grey car catches overshooters.

export const level1: LevelDef = {
  name: 'CRASH JUNCTION',
  mode: { kind: 'crash', medals: { bronze: 100000, silver: 160000, gold: 220000 } },
  player: { variant: 'sedan', color: 0xe8352a, x: 2.3, z: -120, dir: { x: 0, z: 1 }, speed: 0 },
  traffic: [
    { variant: 'sedan', color: 0xf2b01e, x: -21.5, z: -2.3, dir: { x: 1, z: 0 }, speed: 8.8 }, // taxi
    { variant: 'tanker', color: 0xc7372c, x: 38, z: 2.3, dir: { x: -1, z: 0 }, speed: 9.5 }, // fuel tanker — the jackpot
    { variant: 'sedan', color: 0x3f8efc, x: 58, z: 2.3, dir: { x: -1, z: 0 }, speed: 9 },
    { variant: 'sedan', color: 0xd8d8d8, x: -48, z: -2.3, dir: { x: 1, z: 0 }, speed: 8.5 },
    { variant: 'sedan', color: 0x6f6af0, x: -2.3, z: 36, dir: { x: 0, z: -1 }, speed: 7.5 },
    { variant: 'sedan', color: 0x9aa3ad, x: 2.3, z: 14, dir: { x: 0, z: 1 }, speed: 0 }, // queued at the light
    { variant: 'bus', color: 0x2f9e6e, x: -2.3, z: 62, dir: { x: 0, z: -1 }, speed: 9.5 }, // city bus
    { variant: 'sedan', color: 0xc23a8f, x: -70, z: -2.3, dir: { x: 1, z: 0 }, speed: 10.5, delay: 2 },
    { variant: 'sedan', color: 0x4ec3e0, x: 80, z: 2.3, dir: { x: -1, z: 0 }, speed: 10, delay: 2.5 },
  ],
  poles: [
    { x: 8.6, z: 8.6 },
    { x: -8.6, z: 8.6 },
    { x: 8.6, z: -8.6 },
    { x: -8.6, z: -8.6 },
  ],
  barrels: [
    // NE corner stack
    { x: 8.2, z: 4.6 },
    { x: 9.0, z: 5.3 },
    { x: 8.4, z: 6.2 },
    // SW corner pair
    { x: -8.3, z: -4.8 },
    { x: -9.1, z: -5.5 },
    // landing zone, next to the queued car
    { x: 4.2, z: 12.6 },
    { x: 4.8, z: 14.0 },
    // west median
    { x: -11.5, z: 0.0 },
    { x: -13.0, z: 0.4 },
    // in the junction, between the crossing lanes
    { x: 6.6, z: -0.4 },
    { x: -6.8, z: 0.6 },
    // east roadside
    { x: 11.8, z: -0.2 },
  ],
  ramps: [
    { x: 2.3, zStart: -15.4, length: 6.8, width: 3.4, height: 0.5 }, // main line: into the T-bone
    { x: 8.6, zStart: -19.0, length: 7.5, width: 3.6, height: 0.75 }, // stunt line: over the corner barrels
  ],
  buildings: [
    { x: 17, z: 17, h: 10, color: 0x5b6470 },
    { x: -17, z: 17, h: 15, color: 0x6e5a50 },
    { x: 17, z: -17, h: 12, color: 0x4e5862 },
    { x: -17, z: -17, h: 18, color: 0x7a7468 },
  ],
  // multiplier rings hang in the air over the ramp lines — collect mid-jump
  pickups: [
    { x: 2.3, y: 1.55, z: -6.0, mult: 2 }, // just past the main ramp lip
    { x: 0.0, y: 2.2, z: 0.3, mult: 3 }, // high over the junction center
    { x: 8.6, y: 2.1, z: -7.0, mult: 2 }, // stunt-ramp line
  ],
};
