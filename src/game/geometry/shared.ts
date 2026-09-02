// Barrel for the shared geometry/material module. The implementation lives in
// sibling modules under ./shared/ — this file re-exports the full public surface
// so every existing `import … from './shared'` resolves unchanged.

export { GLASS, smoothstep } from './shared/math';

export { hullMat, headlightMat, taillightMat, metalMat, cabinMat } from './shared/materials';

export { glassMat, glassParams, applyGlassParams } from './shared/glass';
export type { GlassParams } from './shared/glass';

export {
  registerCarMaterial,
  setCarEnvMap,
  applyCarEnvScale,
  registerPlayerSwappable,
  adoptPlayerMaterials,
  setPlayerEnvMap,
} from './shared/registry';

export { wheelMat, wheelGeometry, applyUniformColor, makeColoredBox } from './shared/wheels';
export { buildWheelGeometry, TYRE_HALF_WIDTH } from './shared/wheelBuilder';
export type { WheelStyle, WheelSide } from './shared/wheelBuilder';

export { buildNormalSmoothing, applyNormalSmoothing } from './shared/normals';
