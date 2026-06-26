// Synthesized continuous layers: the engine note, the drift squeal, the
// boost afterburner and wind-at-speed. Loops want exact pitch control over
// a continuous rpm/slip range, which one-shot recordings can't give — so
// these stay synthesized while the impacts (samples.ts) come from
// recordings. Everything is built lazily on first use and updated once per
// rendered frame with smoothed AudioParam targets.
//
// This module is a barrel: the layers live in ./synths/* (one file per
// sub-system, sharing ./synths/shared). Importers keep using this path.

export { makeNoiseBuffer, makeImpulseResponse } from './synths/shared';
export { EngineSynth } from './synths/engine-synth';
export { EngineSound, type EngineFlavor } from './synths/engine-sound';
export { TrafficHum } from './synths/traffic';
export { SkidLoop } from './synths/skid';
export { BoostLoop } from './synths/boost';
export { WindLoop } from './synths/wind';
