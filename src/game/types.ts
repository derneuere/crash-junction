import type * as THREE from 'three';
import type * as CANNON from 'cannon-es';

export enum GameState {
  Idle,
  Launch,
  Crash,
  Settle,
  Done,
}

export type Variant = 'sedan' | 'bus' | 'tanker';

export interface VehicleSpec {
  variant: Variant;
  mass: number;
  width: number;
  height: number;
  length: number;
  halfY: number; // chassis collision box half-height
  rideHeight: number; // chassis COM above road while driving (m)
  hullY: number; // visual hull offset from COM
  wheelRadius: number;
  wheelX: number;
  wheelZFront: number;
  wheelZRear: number;
  valueMult: number; // damage-cash multiplier
  cashCap: number; // total damage money this vehicle can ever pay out
  explosive?: { power: number; fuseDamage: number };
}

export interface VehicleSpawn {
  variant: Variant;
  color: number;
  x: number;
  z: number;
  dir: { x: number; z: number };
  speed: number;
  delay?: number; // seconds after launch before this car starts moving
}

export interface RampDef {
  x: number;
  zStart: number; // ramp ascends from zStart toward +z
  length: number;
  width: number;
  height: number;
}

export interface BuildingDef {
  x: number;
  z: number;
  h: number;
  color: number;
}

export interface PickupDef {
  x: number;
  y: number;
  z: number;
  mult: number;
}

/** A circuit, AISections-style: an ordered loop of sections (centre +
 *  direction + speed class), rivals that navigate them, and reset-pair
 *  respawns. Sections are defined in race.ts (RaceSection). */
export interface RaceDef {
  laps: number;
  width: number; // track ribbon width (m)
  sections: { x: number; z: number; dirX: number; dirZ: number; v: number }[];
  rivals: { color: number; skill: number }[];
}

/** What kind of run a level is — each arm carries only the data that mode
 *  actually uses. 'crash' scores damage cash against medal thresholds;
 *  'practice' has no stakes (the player can never wreck — crashes scuff and
 *  shed panels but driving continues, no crashtime, no report); 'race' is a
 *  closed circuit against AI rivals, scored by finishing position. */
export type ModeDef =
  | { kind: 'crash'; medals: { bronze: number; silver: number; gold: number } }
  | { kind: 'practice' }
  | { kind: 'race'; race: RaceDef };

export type ModeKind = ModeDef['kind'];

export interface LevelDef {
  name: string;
  /** 'junction' = the crossroad; 'pad' = open practice asphalt;
   *  'field' = bare grass (the race ribbon is drawn from the race def). */
  ground?: 'junction' | 'pad' | 'field';
  mode: ModeDef;
  /** Painted decals for 'pad' ground: skidpad rings + dash lines. */
  padDecals?: {
    rings: { x: number; z: number; r: number }[];
    dashes: { x: number; z: number; yaw: number }[];
  };
  player: VehicleSpawn;
  traffic: VehicleSpawn[];
  poles: { x: number; z: number }[];
  barrels: { x: number; z: number }[];
  ramps: RampDef[];
  buildings: BuildingDef[];
  pickups: PickupDef[];
}

export interface SuspensionCorner {
  ax: number;
  az: number;
  preload: number;
  k: number;
  c: number;
  fmax: number;
  dist: number;
  grounded: boolean;
}

export interface DeformablePart {
  mesh: THREE.Mesh;
  base: Float32Array; // undeformed vertex positions
  baseCol: Float32Array; // unscuffed vertex paint
}

export type PanelKind = 'door' | 'bonnet' | 'boot' | 'bumper';

/** A detachable body panel: accumulates crumple, flaps on its hinge, then
 *  tears off. Modeled after BP's DeformationSpec IK body parts + joints. */
export interface PanelState {
  kind: PanelKind;
  mesh: THREE.Mesh;
  pivot: THREE.Group; // at the hinge; rotating it flaps the panel
  size: { x: number; y: number; z: number };
  hingeAxis: THREE.Vector3; // pivot-local
  flapDir: number;
  maxAngle: number; // loose-flap limit (rad) — BP mfMaxJointAngle
  outward: THREE.Vector3; // group-local outward normal (detach kick direction)
  threshold: number; // accumulated crumple (m) to detach — BP detach thresholds
  home: THREE.Vector3; // pivot-local rest position (for repairs)
  damage: number;
  angle: number;
  detached: boolean;
}

export type ActorKind = 'vehicle' | 'pole' | 'barrel';

export interface Actor {
  kind: ActorKind;
  body: CANNON.Body;
  group: THREE.Group;
  spec: VehicleSpec | null;
  wheels: THREE.Mesh[];
  susp: SuspensionCorner[];
  deformables: DeformablePart[];
  panels: PanelState[];
  q0: CANNON.Quaternion;
  scripted: { dir: { x: number; z: number }; speed: number; delay: number } | null;
  started: boolean;
  curSpeed: number;
  isPlayer: boolean;
  crashed: boolean;
  /** Shunt mode: seconds of lost control left — the car is physics-owned
   *  (no steering) until it recovers. A wall touch while destabilized is a
   *  wreck; if the player caused it, that wreck is a TAKEDOWN. */
  destabilized: number;
  destabilizedByPlayer: boolean;
  popped: number;
  damageLvl: number;
  smokeT: number;
  exploded: boolean;
  fuse: number | null; // seconds until detonation, null = not lit
  valueMult: number;
  cashLeft: number; // remaining damage-money budget — payouts draw it down
}

export interface CollideEvent {
  body: CANNON.Body;
  contact: CANNON.ContactEquation;
}
