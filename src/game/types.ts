// Barrel: re-exports the simulation type surface so importers of
// './types' keep resolving here. Definitions live in ./types/*.
export type {
  Variant,
  VehicleSpec,
  VehicleSpawn,
  RampDef,
  BuildingDef,
  PickupDef,
  RaceWaypoint,
  ShortcutDef,
  SignatureZoneDef,
  PropDef,
  WallStyleDef,
  RaceDef,
  ModeDef,
  ModeKind,
  CoastDef,
  GroundPatchDef,
  DecalDef,
  LevelDef,
} from './types/level';

export { GameState } from './types/actor';
export type {
  SuspensionCorner,
  DeformablePart,
  PanelKind,
  PanelState,
  ActorKind,
  Actor,
  CollideEvent,
} from './types/actor';
