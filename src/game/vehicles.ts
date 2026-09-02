// Barrel for the vehicle subsystem. The implementation lives in ./vehicles/*;
// this file keeps the original "src/game/vehicles" import path stable and
// re-exports the same public surface (values AND types) it always had.
export { SPECS } from './vehicles/specs';
export {
  exhaustAnchors, HEADLIGHT_INTENSITY, BRAKE_GLOW, BRAKE_INTENSITY, LAMP_RAMP, REVERSE_GLOW, type CollideHandler,
} from './vehicles/factory';
export { createVehicle, createPole, createBarrel } from './vehicles/create';
export { deformActor, repairVehicle, charActor } from './vehicles/deform';
export { shatterGlass } from './vehicles/glass';
export { popWheel, type LoosePart } from './vehicles/looseParts';
