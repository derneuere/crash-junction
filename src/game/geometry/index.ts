export {
  GLASS, hullMat, glassMat, headlightMat, taillightMat, reverseMat, metalMat, cabinMat, wheelMat, wheelGeometry,
  makeColoredBox, applyUniformColor, smoothstep, registerCarMaterial, setCarEnvMap, applyCarEnvScale,
  registerPlayerSwappable, adoptPlayerMaterials, setPlayerEnvMap, playerSwap,
  buildNormalSmoothing, applyNormalSmoothing,
  glassParams, applyGlassParams, type GlassParams,
  buildWheelGeometry, TYRE_HALF_WIDTH, type WheelStyle, type WheelSide, type WheelDetail,
} from './shared';
export { makeSedanGeometry } from './sedan';
export { makeBoxHullGeometry } from './boxHull';
export { makeTankGeometry } from './tank';
