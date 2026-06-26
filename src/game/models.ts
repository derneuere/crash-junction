// Quaternius CC0 vehicle models (public/models/*/glb), converted from FBX by
// tools/convert-models.mjs. The game's whole damage pipeline — crumple,
// scuff, char, glass — runs on per-vertex paint, so each model is baked once
// at load into a single vertex-colored BufferGeometry: one primitive per
// source material, colors from the material (cars pack) or a name palette
// (the transport FBX lost its colors — only the .blend has them).
//
// Wheels are cut out of the model (they're separate nodes in both packs) and
// rescaled so their radius equals the spec's physics wheelRadius; the wheel
// ARCH positions drive wheel-mesh placement, and buildSuspension derives its
// corner anchors from those meshes — so each model's stance is also its
// suspension geometry. Everything here happens before the first take and is
// deterministic, which the replay system depends on.
//
// This module is a thin barrel: the implementation lives under ./models/*,
// split along the bake pipeline's natural seams (roster/load, bake, panel
// metrics, hull cutting, interior, low-level mesh helpers).

export type {
  VehicleModel,
  PanelCut,
} from './models/types';
export type {
  PanelFace,
  LidFit,
  DoorFit,
  PanelMetrics,
} from './models/metrics-types';
export type {
  PlayerCarId,
  PlayerCarDef,
} from './models/roster';
export {
  PLAYER_CARS,
  DEFAULT_CAR,
  setPlayerCar,
  resetModelPicker,
  getVehicleModel,
  loadVehicleModels,
} from './models/roster';
export { applyHullGroups } from './models/bake';
