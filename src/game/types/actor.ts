import type * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import type { VehicleModel } from '../models';
import type { VehicleSpec } from './level';

export enum GameState {
  Idle,
  Launch,
  Crash,
  Settle,
  Done,
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
  /** Crash damage scaling of preload+spring (1 = healthy). A battered
   *  corner carries less load, so wrecks settle with a Paradise lean. */
  sag: number;
}

export interface DeformablePart {
  mesh: THREE.Mesh;
  base: Float32Array; // undeformed vertex positions
  baseCol: Float32Array; // unscuffed vertex paint
  /** Vertex index ranges that are window glass (model-based hulls) —
   *  shatterGlass frosts them and spawns shard particles. */
  glass?: [number, number][];
  /** Head/taillight vertex ranges — needed to rebuild the hull's material
   *  groups after index surgery (the lenses wear emissive night materials). */
  head?: [number, number][];
  tail?: [number, number][];
  /** Vertex slot → representative slot at the same base position; built
   *  lazily on first crumple. Flat-shaded models duplicate every corner
   *  (split normals), so the deformer must weld displacement across the
   *  copies or the skin tears into loose triangles. */
  weld?: Uint32Array;
  /** Per-slot glass flag (built with weld) — the crumple deformer skips
   *  glass entirely: glass doesn't bend, it shatters (shatterGlass). */
  glassMask?: Uint8Array;
  /** Pristine triangle index, stashed the first time shatterGlass blows a
   *  pane out of the hull — repairVehicle reglazes from it. */
  baseIndex?: Uint16Array | Uint32Array;
  /** Per glass-vertex damage stage (0 virgin · 1 cracked/spider-web · 2
   *  frosted/spalled · 3 blown out). Lets shatterGlass run its three stages
   *  off explicit state instead of a fragile colour threshold (transmission
   *  glass starts at a bright neutral tone, so "is it broken?" can't be read
   *  from brightness). Built lazily on first hit, reset by repairVehicle. */
  glassStage?: Uint8Array;
  /** Creased-normal smoothing clusters (built from pristine normals) —
   *  computeVertexNormals() always rebuilds flat split normals, so every
   *  recompute is followed by applyNormalSmoothing with this map. */
  smooth?: Uint32Array;
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
  homeQ: THREE.Quaternion; // pivot-local rest orientation (lid tilt)
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
  /** Baked Quaternius model this vehicle was dressed with (null = procedural). */
  model: VehicleModel | null;
  wheels: THREE.Mesh[];
  susp: SuspensionCorner[];
  deformables: DeformablePart[];
  panels: PanelState[];
  /** Real dynamic night lights, parented to the group: a headlight spot
   *  painting the road, a brake point that fires only while braking, a
   *  lamp point on streetlight poles. Game drives them per frame — night
   *  only, wrecks go dark, a toppled pole takes its glow with it. */
  nightLights: { head?: THREE.SpotLight; brake?: THREE.PointLight; lamp?: THREE.PointLight } | null;
  /** Visual brake detection (night brake light): last frame's speed and
   *  the latch that keeps the lamp lit through a braking phase. */
  lastSpeed: number;
  brakeT: number;
  q0: CANNON.Quaternion;
  scripted: { dir: { x: number; z: number }; speed: number; delay: number } | null;
  started: boolean;
  curSpeed: number;
  isPlayer: boolean;
  crashed: boolean;
  /** Shunt mode: seconds of lost control left — the car slides physics-owned
   *  until it recovers, but control RAMPS BACK over the window (steering
   *  authority climbs from ~0 to full as this counts down), Burnout's
   *  recoverable out-of-control slide rather than a hard on/off. A wall touch while
   *  destabilized is a wreck; if the player caused it, that wreck is a TAKEDOWN. */
  destabilized: number;
  /** The value `destabilized` was last (re)set to — the length of the current
   *  shunt window. Keys the control-authority ramp (1 − destabilized/window
   *  = how far recovery has come) so authority returns smoothly regardless of
   *  whether the slide was a 1.2 s nudge or a 2.2 s slam. */
  destabilizeWindow: number;
  /** How close to wrecked, 0..1 (Road Rage style): a continuous fragility a
   *  shunt RAISES and recovery bleeds off. A further hard contact (or a wall)
   *  while this is high tips a sliding car into a WRECK — so stacked shunts
   *  wreck while a single one recovers. Modest by design (see SHUNT_FRAGILITY_*
   *  constants); never set on the rammer, so winning a shunt can't self-wreck. */
  howCloseToWrecked: number;
  destabilizedByPlayer: boolean;
  /** Body id of the car whose ram caused the current destabilization (0 =
   *  none). Stops the same contact pair from echoing: collide events fire on
   *  BOTH bodies, and without this the loser's event would read its fresh
   *  shunt mode as "a sliding car hit me" and knock the winner loose too. */
  destabilizedBy: number;
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
