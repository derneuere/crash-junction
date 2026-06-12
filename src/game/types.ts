import type * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import type { VehicleModel } from './models';

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

/** A race waypoint: [x, z] on flat ground, or [x, z, y] where the road
 *  carries an elevation profile (docs/research/elevation.md Phase 1). y is
 *  metres above the flat physics ground plane; the Catmull resampler in
 *  race.ts interpolates it along the chain (arc length stays 2D, so adding
 *  y to a waypoint never moves a section) and clamps the result at 0 —
 *  the spline's tangent overshoot near a flat→climb seam would otherwise
 *  dip the road a few centimetres under the island grass. */
export type RaceWaypoint = [number, number] | [number, number, number];

/** A branch ribbon off the main loop — Burnout's risk-vs-reward cut. An
 *  OPEN polyline the player can run instead of the main sections between
 *  entry and exit; rivals never take it (the AI owns the main line).
 *
 *  CONTRACT: entry < exit, and both lie at least 4 sections from the lap
 *  line (entry >= 4, exit <= N-4), so a shortcut never wraps section 0.
 *  RaceDirector leans on this when it snaps playerTarget past the exit:
 *  the snap can never cross the line, so lap counting stays untouched.
 *  Elevation contract: endpoint y must match the main loop's y at the
 *  entry/exit sections (the mouths share driving surface with the main
 *  road, so a height step there would be a launch edge — the composer's
 *  shortcut() helper asserts it at module load). */
export interface ShortcutDef {
  name: string;
  entry: number; // main-loop section index where the branch forks off
  exit: number; // main-loop section index where it rejoins
  waypoints: RaceWaypoint[]; // open polyline, entry → exit
  width: number; // branch ribbon width (m) — narrower than the main road
  surface: 'dirt' | 'asphalt'; // cosmetic in v1: tint only, no grip change
}

/** A named takedown theatre: scoring-only circle, no colliders. A takedown
 *  resolved with the victim inside flashes the zone's name instead of
 *  TAKEDOWN (Game.ts, takedown resolution). */
export interface SignatureZoneDef {
  name: string;
  x: number;
  z: number;
  r: number;
}

/** GLB set dressing (cranes, containers, rocks) with an optional hand-placed
 *  box collider. The split is the determinism contract: the collider's
 *  half-extents are EXPLICIT plain numbers — physics may never depend on
 *  async-loaded geometry — so the cannon body exists before the first step
 *  while the GLB drapes over it whenever the network delivers (props.ts). */
export interface PropDef {
  /** GLB path, or 'builtin:<name>' for a code-built model (props.ts
   *  BUILTINS registry: gantry-crane, floodlight-mast, bollard, lamp-post).
   *  Builtins behave exactly like GLBs otherwise — collider still comes
   *  from the explicit half-extents below, never from the geometry. */
  url: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** Visual-only lift (m). The collider stays ground-planted at hy. */
  y?: number;
  /** Multiply-tint the visual's opaque materials toward this color — one
   *  Kenney container GLB becomes a whole rainbow stack. Visual only;
   *  transparent and glass-named materials keep their look. */
  tint?: number;
  /** Box half-extents; 'none' or absent = pure decor, no body. A prop WITH
   *  a body judges like a track barrier (wallDirs) — a crane leg is a wall. */
  collider?: { hx: number; hy: number; hz: number } | 'none';
}

/** Section-index range that swaps the default red/white race barrier for a
 *  themed wall. Each style sets BOTH the look and the physics box height —
 *  a 0.45 m kerb is hoppable where the 2.2 m dockyard fence is not.
 *  Segment i runs from section i to i+1; a range covers i where
 *  from <= i <= to (inclusive; from > to wraps the lap seam past 0).
 *  'left'/'right' are relative to race direction; overlapping entries are
 *  resolved last-wins. 'none' opens a gap — no wall, no body. */
export interface WallStyleDef {
  from: number;
  to: number;
  side: 'left' | 'right' | 'both';
  style: 'guardrail' | 'kerb' | 'fence' | 'none';
}

/** A circuit, AISections-style: an ordered loop of sections (centre +
 *  direction + speed class), rivals that navigate them, and reset-pair
 *  respawns. Sections are defined in race.ts (RaceSection). */
export interface RaceDef {
  laps: number;
  width: number; // track ribbon width (m)
  /** y is the road elevation at the section centre (0 on flat tracks) —
   *  carried by the race.ts resamplers from the waypoints' optional third
   *  component. The suspension height field, ribbon, walls and respawns
   *  all read it; speed classes and progress stay 2D by design. */
  sections: { x: number; z: number; y: number; dirX: number; dirZ: number; v: number }[];
  /** skill = corner-speed multiplier <1 (what makes them beatable);
   *  aggression = appetite for shunts and slams, 0 (clean) … 1 (B3 bully). */
  rivals: { color: number; skill: number; aggression: number }[];
  /** Player-only branch ribbons (see ShortcutDef contract). */
  shortcuts?: ShortcutDef[];
  /** Named takedown zones — presentation only, never judged by physics. */
  signatures?: SignatureZoneDef[];
  /** Themed wall overrides; absent = today's red/white chain everywhere. */
  wallStyles?: WallStyleDef[];
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

/** The island silhouette + sea level. The outline is ONE closed CCW polygon;
 *  each vertex's edge type styles the visual skirt for the segment running
 *  from it to the next vertex: 'beach' = a gentle sand slope (~18 m wide),
 *  'wall' = a vertical concrete quay face, 'cliff' = a jagged jittered rock
 *  face, 'bank' = a short plain grass slope (~6 m).
 *
 *  ALL VISUAL — the physics ground stays the flat y=0 plane everywhere, so
 *  a car carried past the edge visibly hovers over the water. Accepted
 *  arcade tradeoff: the 5 s off-track rescue recovers it, same as any other
 *  trip into the weeds. seaLevel ≈ -2.2 reads well: deep enough for a drop
 *  at the cliff, shallow enough that the beach slope stays believable. */
export interface CoastDef {
  seaLevel: number;
  /** y (optional, default 0) raises a vertex's RIM — the skirt's top row —
   *  above grade, for coast arcs that run beside an elevated road
   *  (elevation.md: the cliff arc's raised rim is what finally sells
   *  cliff.png). Visual only, like everything else here: author it to
   *  match the road-base field so the embankment drape meets the skirt. */
  outline: { x: number; z: number; edge: 'beach' | 'wall' | 'cliff' | 'bank'; y?: number }[];
}

/** A textured ground polygon — the dockyard's concrete apron, the beach's
 *  sand, the headland's dry grass. Pure paint: no physics, no grip change.
 *  Default y 0.006 slots UNDER the road ribbons (z-order contract in
 *  environment.ts). poly vertices are [x, z]. */
export interface GroundPatchDef {
  poly: [number, number][];
  kind: 'concrete' | 'sand' | 'drygrass' | 'gravel';
  y?: number;
}

/** A painted rectangle on the ground — lane markings, hatched aprons, bay
 *  stripes. The same instanced quads as the road dashes, generalized with a
 *  color (default the dashes' off-white). w/l in metres, yaw like a car's.
 *  y (optional) is an ABSOLUTE height for paint riding elevated terrain —
 *  include the usual 0.014 decal slot in it; omitted = the flat slot. */
export interface DecalDef {
  x: number;
  z: number;
  w: number;
  l: number;
  yaw: number;
  color?: number;
  y?: number;
}

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
  /** Async GLB scenery; colliders are synchronous plain-number boxes. */
  props?: PropDef[];
  /** Island silhouette + sea — replaces the auto-sized grass square. */
  coast?: CoastDef;
  /** Textured ground polygons under the roads. Visual only. */
  patches?: GroundPatchDef[];
  /** Painted ground rectangles (lane markings on aprons). Visual only. */
  decals?: DecalDef[];
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
  /** Shunt mode: seconds of lost control left — the car is physics-owned
   *  (no steering) until it recovers. A wall touch while destabilized is a
   *  wreck; if the player caused it, that wreck is a TAKEDOWN. */
  destabilized: number;
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
