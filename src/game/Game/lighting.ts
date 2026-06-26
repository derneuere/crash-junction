import { type TimeOfDay } from '../daynight';

/** Render path selector. The game ALWAYS renders in 'cine' (the film-look
 *  chain in postfx.ts + live player reflections in reflections.ts): the
 *  player-facing FAST/CINE tier choice was removed. 'fast' survives ONLY as
 *  the headless/determinism path — ?verify=1 replays and tools/refshot.mjs
 *  --gfx fast review captures force it so swiftshader doesn't pay for cine
 *  pixels nobody hashes. setGfx() is the seam that drives it (refshot calls
 *  it through window.__game); real play never reaches 'fast'. Pure visuals
 *  either way. */
export type GfxMode = 'cine' | 'fast';

/** Scene-light grading per time of day. The sun's direction feeds the
 *  follow-the-player shadow rig; the sky dome / IBL handles the rest. */
export interface TodPreset {
  fog: number;
  hemiSky: number;
  hemiGround: number;
  hemiInt: number;
  sunColor: number;
  sunInt: number;
  /** scene.environment strength — the IBL share of ambient light */
  envInt: number;
}

export const TOD_PRESETS: Record<TimeOfDay, TodPreset> = {
  // hemisphere runs lower than the pre-IBL 1.45 — the sky environment now
  // carries a share of the ambient
  day: { fog: 0xb6cde6, hemiSky: 0xbfd6ff, hemiGround: 0x4a4036, hemiInt: 0.85, sunColor: 0xfff0dd, sunInt: 2.2, envInt: 0.6 },
  dusk: { fog: 0xcfa98c, hemiSky: 0x8fa0c8, hemiGround: 0x4a4036, hemiInt: 0.55, sunColor: 0xffc88a, sunInt: 3.0, envInt: 0.65 },
  night: { fog: 0x0a0f1d, hemiSky: 0x33415c, hemiGround: 0x12141c, hemiInt: 0.55, sunColor: 0x9db6e8, sunInt: 0.55, envInt: 0.5 },
};

// PERF (perf-harbor): refresh the live player cube reflection every Nth
// rendered frame instead of every frame. 2 = 30 Hz on a 60 Hz display, which
// reads identically on the streaky clearcoat while roughly halving the
// reflection's whole-scene re-render cost — the dockyard's dominant frame cost.
export const CUBE_EVERY_DEFAULT = 2;
