// Barrel: the Game implementation was split into ./Game/* sibling modules to
// keep each file small; this file preserves the original public import surface
// ("./Game") unchanged. The deterministic Game class lives in ./Game/core; the
// render-path type GfxMode lives in ./Game/lighting.
export { Game } from './Game/core';
export { type GfxMode } from './Game/lighting';
