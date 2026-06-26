// GANTRY POINT — composer barrel. The implementation lives in the sibling
// ./gantryPoint/ folder, split by cohesive seam so each module stays small:
//
//   ./gantryPoint/waypoints.ts  the design doc + the WAYPOINTS table → SECTIONS
//   ./gantryPoint/shortcuts.ts  the shortcut/signature derivation + contracts
//   ./gantryPoint/coast.ts      zone assembly (ZONES) + the stitched island outline
//   ./gantryPoint/level.ts      the LevelDef composer that wires it all together
//
// This file re-exports the public surface so importers keep using
// './gantryPoint' unchanged.
export { gantryPoint } from './gantryPoint/level';
