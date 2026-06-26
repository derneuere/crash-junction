// Barrel for the procedural canvas-texture factories. The implementation lives
// in ./textures/* sibling modules, grouped by surface family; this file only
// re-exports so every importer keeps using './textures' unchanged.
export { hash01 } from './textures/shared';
export { makeWindowTextures, makeGlowTexture, makeSmokeTexture, makeFireTexture } from './textures/sprites';
export { makeChevronTexture, makeChainLinkTexture, makeBarrelTexture } from './textures/track';
export { makePatchTexture, type PatchKind } from './textures/ground';
export { makeSeaTexture, makeQuayTexture, makeFoamTexture } from './textures/sea';
export { makeWetSandTexture, makeSandNormalTexture, makeSandGlitterTexture } from './textures/sand';
export { makeGrassTexture, makeDuneBlendTexture } from './textures/grass';
