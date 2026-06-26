// Barrel for the sky / image-based-lighting subsystem. The implementation lives
// in ./skyenv/* (presets + scattering port + the SkyRig dome and the SunFlare
// sprites); this file re-exports the original public surface so importers of
// "./skyenv" are unchanged. See ./skyenv/skyrig.ts for the full subsystem notes.

export type { SkyPreset } from './skyenv/presets';
export { SKY_PRESETS } from './skyenv/presets';
export { SkyRig } from './skyenv/skyrig';
export { SunFlare } from './skyenv/sunflare';
