// Barrel for the environment builder, split out of the old 2055-line module
// into ./environment/* so each part stays under the line budget. The public
// surface is UNCHANGED: importers of './environment' still get the same
// Environment type, makeHeightSampler and buildEnvironment, with identical
// signatures. The implementation now lives in the sibling modules:
//
//   elevation.ts    — the suspension HeightSampler (road-grade base + features)
//   marks.ts        — painted ground marks + the road ribbon strip
//   sand-material.ts— the Alan-Zucconi beach sand material + SKIRT_W table
//   coast.ts        — island silhouette + sea + coastline skirt dispatch
//   coast-skirts.ts — flat + cliff skirt builders (shared CoastCtx)
//   coast-beach.ts  — beach skirt + wet-sand sheen overlay
//   coast-foam.ts   — animated shore-line foam rings
//   embankment.ts   — elevated-span ground drape + dune-lip grass fringe
//   race-build.ts   — race ribbon/dashes/gates/shortcuts/barriers/embankments
//   race-walls.ts   — barrier wall visuals + the wall-style table
//   build.ts        — buildEnvironment orchestrator + the Environment handle

export type { Environment } from './environment/build';
export { buildEnvironment } from './environment/build';
export { makeHeightSampler } from './environment/elevation';
