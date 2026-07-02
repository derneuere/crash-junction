// Barrel for the procedural car generator. The implementation lives in
// ./procgen/* — recipe schema, geometry soup, body loft, clip/wheel parts,
// and the assembler that hands off to the SAME bake tail the GLB models run
// (docs/research/procedural-cars-plan.md).
export type { CarRecipe, Station, WheelStyle } from './procgen/recipe';
export { buildProceduralModel } from './procgen/assemble';
export { METRO } from './procgen/recipes';
