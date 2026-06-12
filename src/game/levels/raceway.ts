import type { LevelDef, PropDef } from '../types';
import { buildLoopSections, type RaceSection } from '../race';

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

const WIDTH = 22; // four generous lanes — also feeds mode.race below
const KIT = '/models/props/kenney-racing-kit';

/** Speed furniture (sense-of-speed research §1.3 / A7). SILVER LAKE shipped
 *  as a literally empty field, and the same 39 m/s objectively read slower
 *  here than on GANTRY POINT — near-field objects carry the highest angular
 *  velocity, so they dominate the speed read (the B3 "lampposts, trees,
 *  billboards" rule). Cadence per the doc: posts/flags every ~16 m
 *  alternating sides on the straights (≈6 per 100 m counting both sides),
 *  a hoarding every ~32 m on the sweeper outsides, and an overhead gantry
 *  roughly every 176 m with the start-light gantry over the grid.
 *
 *  EVERY prop is collider:'none' — props.ts only builds a cannon body for a
 *  real collider, so this adds ZERO physics bodies and the level's recorded
 *  race fixtures (and both determinism pins) replay bit-for-bit. Knockable
 *  versions are the doc's B3 item: a deliberate pin re-record, not free. */
function dressCircuit(sections: RaceSection[]): PropDef[] {
  const props: PropDef[] = [];
  const half = WIDTH / 2; // the walls live at the ribbon edge
  // straight posts rotate flag → lamp → flag…, flags cycling their colors
  const flags = [`${KIT}/flagCheckers.glb`, `${KIT}/flagRed.glb`, `${KIT}/flagGreen.glb`];
  let side = 1;
  let flagIdx = 0;
  let postIdx = 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    // outward = the edge-normal pointing away from the infield; the loop
    // circles the origin, so a sign test against the position picks it
    let px = s.dirZ;
    let pz = -s.dirX;
    if (px * s.x + pz * s.z < 0) {
      px = -px;
      pz = -pz;
    }
    // straight vs sweeper from the actual local curvature — the section
    // speed class caps at 38 on these generous sweeps, so it can't tell.
    // The lap's measured split is ~2°/8 m on the straights vs 5–12° on the
    // sweepers, so the cut sits between at 2.5° (cos ≈ 0.999)
    const n = sections[(i + 1) % sections.length];
    const straight = s.dirX * n.dirX + s.dirZ * n.dirZ > 0.999;

    if (i === 0 || i % 22 === 15) {
      // overhead gantries spanning the road: native 1.26 wide → ~24 m at
      // 19×, legs just outside the ±11 m walls; the grid gets the
      // start-light version, the rest of the lap the plain span
      const url = i === 0 ? `${KIT}/overheadLights.glb` : `${KIT}/overhead.glb`;
      props.push({ url, x: s.x, z: s.z, yaw: Math.atan2(s.dirX, s.dirZ), scale: 19, collider: 'none' });
      continue;
    }
    if (straight && i % 2 === 0) {
      // the flag line: tall thin verticals 2.5 m off the wall, the highest
      // angular-velocity flow the player ever sees
      const d = (half + 2.5) * side;
      const x = s.x + px * d;
      const z = s.z + pz * d;
      const faceTrack = Math.atan2(-px * side, -pz * side);
      if (postIdx++ % 2 === 0) {
        props.push({ url: flags[flagIdx++ % flags.length], x, z, yaw: faceTrack, scale: 5, collider: 'none' });
      } else {
        // builtin lamp post (~6 m): the arm reaches local +z — over the road
        props.push({ url: 'builtin:lamp-post', x, z, yaw: faceTrack, scale: 1, collider: 'none' });
      }
      side = -side;
    } else if (!straight && i % 4 === 1) {
      // sweeper outsides get hoardings facing the apex — big lateral-flow
      // surfaces exactly where the drift points the nose, every ~32 m
      const d = half + 5.5;
      const x = s.x + px * d;
      const z = s.z + pz * d;
      const faceTrack = Math.atan2(-px, -pz);
      if (i % 8 === 1) {
        props.push({ url: `${KIT}/billboard.glb`, x, z, yaw: faceTrack, scale: 9, collider: 'none' });
      } else {
        props.push({ url: `${KIT}/bannerTowerRed.glb`, x, z, yaw: faceTrack, scale: 7, collider: 'none' });
      }
    }
  }
  return props;
}

export const raceway: LevelDef = {
  name: 'SILVER LAKE RING',
  ground: 'field',
  mode: {
    kind: 'race',
    race: {
      laps: 3,
      width: WIDTH, // four generous lanes — Burnout roads, room for combat
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
  props: dressCircuit(SECTIONS),
};
