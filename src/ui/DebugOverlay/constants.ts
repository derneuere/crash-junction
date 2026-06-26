import type { DebugGame, GlassParams } from './types';

// Tint presets: a clear-ish day windscreen vs a dark "privacy" limo look, plus
// classic automotive tints. Hex feeds glassMat.color, the transmission filter.
export const GLASS_TINTS: { label: string; hex: number }[] = [
  { label: 'CLEAR', hex: 0xc6d6e2 },
  { label: 'COOL', hex: 0xafc4d4 },
  { label: 'BRONZE', hex: 0xc9b48c },
  { label: 'PRIVACY', hex: 0x3a4654 },
];

// Slider lanes for the live glass material: [param key, label, min, max, step].
// Each drives one glassMat.<key> through setGlassParam.
export const GLASS_SLIDERS: readonly (readonly [keyof GlassParams, string, number, number, number])[] = [
  ['transmission', 'SEE-THRU', 0, 1, 0.01],
  ['roughness', 'ROUGH', 0, 0.6, 0.01],
  ['thickness', 'REFRACT', 0, 0.8, 0.01],
  ['ior', 'IOR', 1, 2.0, 0.01],
  ['dispersion', 'PRISM', 0, 4, 0.05],
  ['attenuation', 'DEPTH-TINT', 0.2, 2, 0.02],
  ['warp', 'WARP', 0, 1.5, 0.02],
  ['reflection', 'REFLECT', 0, 2.0, 0.05],
  ['rim', 'RIM', 0, 2.0, 0.05],
  ['frost', 'FROST', 0.5, 1, 0.01],
] as const;

export const getGame = (): DebugGame | null =>
  (window as unknown as { __game?: DebugGame }).__game ?? null;

/** MIRROR of tools/refshot.mjs POSES (the frozen contract). The harness is a
 *  plain .mjs the UI can't import without dragging tools/ into the bundle —
 *  if a pose ever moves there (it shouldn't: they're frozen), move it here
 *  too. All GANTRY POINT world coordinates. */
export const REFSHOT_POSES: Record<string, { cam: [number, number, number]; look: [number, number, number] }> = {
  dockyard: { cam: [110, 38, -35], look: [190, 0, 35] },
  harbor: { cam: [205, 32, 95], look: [290, 0, 150] },
  cliff: { cam: [212, 26, 150], look: [275, 2, 212] },
  beach: { cam: [-158, 30, -108], look: [-235, 0, -185] },
  'seam-1': { cam: [243, 14, 178], look: [288, 6, 214] },
  'seam-2': { cam: [-218, 22, 40], look: [-285, 0, -10] },
};
