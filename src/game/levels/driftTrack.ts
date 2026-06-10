import type { LevelDef } from '../types';

// PROVING GROUND — practice pad for drifting and driving.
// No traffic, no walls, no wreck state: scuff the car all you like and
// keep driving. Zones:
//   - skidpad circle (west): painted ring with multiplier rings hovering
//     at door height around it — hold a drift on the line to chase them
//   - pole slalom (east of center): a painted dash line with knockdown
//     traffic poles every 10 m
//   - jump line (far east): two ramps with boost rings over the gaps
//   - barrel corner (south-west): a stack of red barrels to detonate
// Press R to reset, or pick CRASH JUNCTION from the level select.

const SKID = { x: -28, z: 8, r: 16 };

const dashes: { x: number; z: number; yaw: number }[] = [];
for (let z = -44; z <= 28; z += 4.4) dashes.push({ x: 20, z, yaw: 0 }); // slalom line
for (let x = -12; x <= 12; x += 4.4) dashes.push({ x, z: -52, yaw: Math.PI / 2 }); // start line

const poles: { x: number; z: number }[] = [{ x: SKID.x, z: SKID.z }]; // skidpad apex marker
for (let z = -40; z <= 20; z += 10) poles.push({ x: 20, z }); // slalom gates

const ringAt = (angle: number, y: number, mult: number) => ({
  x: SKID.x + Math.cos(angle) * SKID.r,
  y,
  z: SKID.z + Math.sin(angle) * SKID.r,
  mult,
});

export const driftTrack: LevelDef = {
  name: 'PROVING GROUND',
  ground: 'pad',
  practice: true,
  padDecals: { rings: [SKID], dashes },
  medals: { bronze: 0, silver: 0, gold: 0 }, // practice — nothing to win
  player: { variant: 'sedan', color: 0xe8352a, x: 0, z: -60, dir: { x: 0, z: 1 }, speed: 0 },
  traffic: [],
  poles,
  barrels: [
    { x: -52, z: -38 },
    { x: -50.8, z: -37.2 },
    { x: -51.5, z: -36.2 },
    { x: -49.8, z: -38.6 },
    { x: -50.4, z: -35.4 },
  ],
  ramps: [
    { x: 48, zStart: -14, length: 8, width: 4.2, height: 0.9 },
    { x: 48, zStart: 18, length: 8, width: 4.2, height: 1.2 },
  ],
  buildings: [],
  // rings at door height around the skidpad — collect them mid-drift —
  // plus one over each jump
  pickups: [
    ringAt(0, 1.1, 2),
    ringAt((Math.PI * 2) / 3, 1.1, 3),
    ringAt((Math.PI * 4) / 3, 1.1, 2),
    { x: 48, y: 2.3, z: -2, mult: 2 },
    { x: 48, y: 2.7, z: 30, mult: 3 },
  ],
};
