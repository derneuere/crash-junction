// ============================================================================
// SEA — Gerstner wave bank + the derived shoreline amplitude budget.
// ============================================================================
// Split out of sea.ts as a cohesive constant block. The wave config + scale
// tunables and the SEA_MAX_AMPLITUDE budget (re-exported by sea.ts as part of
// the public surface) live here; values are unchanged. build.ts packs these
// into the shader uniforms.

/** Wave bank: direction (set per-entry), steepness 0..1, wavelength (m).
 *  Layout mirrors the reference's WAVE_CONFIG [dirX, dirZ, steepness, wavelength]
 *  but the amplitude each wave contributes is steepness/k SCALED DOWN by
 *  AMP_SCALE so the summed crest at the waterline stays within the foam-seam
 *  budget (see SEA_MAX_AMPLITUDE). */
export type WaveDef = readonly [dirX: number, dirZ: number, steepness: number, wavelength: number];

// 12 Gerstner waves: three long primary swells, three cross swells, and six
// chop layers — directions spread so the surface never reads as parallel
// corrugations. Taken from the reference; amplitudes are derived, not stored.
export const WAVE_CONFIG: WaveDef[] = [
  // Primary ocean swells (dominant energy, long period)
  [1.0, 0.15, 0.10, 140.0],
  [0.80, -0.30, 0.09, 95.0],
  [0.55, 0.60, 0.07, 70.0],
  // Cross swells (directional chaos)
  [-0.20, 1.0, 0.11, 48.0],
  [0.70, -0.55, 0.13, 36.0],
  [-0.85, 0.25, 0.12, 28.0],
  // Medium chop
  [0.92, 0.40, 0.16, 24.0],
  [0.35, -0.88, 0.14, 20.0],
  [-0.45, 0.80, 0.12, 18.0],
  // Short-medium chop (mesh-safe wavelengths ≥ 16 m)
  [0.78, 0.20, 0.14, 17.0],
  [0.20, 0.95, 0.11, 16.5],
  [-0.55, -0.70, 0.10, 16.0],
];

export const TWO_PI = Math.PI * 2;

// Each Gerstner wave's intrinsic crest amplitude is steepness/k (k = 2π/λ).
// AMP_SCALE tames the whole bank so the summed shoreline crest lands in the
// modest range the foam seam expects — the long swells (140 m, 95 m) carry the
// most amplitude, so this scale is small. Tuned so Σ amp ≈ 0.24 m and the total
// (with the vertex-noise lift) ≈ 0.29 m — inside the 0.2–0.35 m seam budget.
export const AMP_SCALE = 0.027;

// Vertex turbulence lift, metres (tanh-capped). Tiny — the look is carried by
// the fragment normal, not by tall geometry.
export const SEA_VNOISE_AMP = 0.05;

/** Theoretical peak crest height above seaLevel at the shoreline = Σ amp +
 *  the small vertex-noise lift. Exported so the SAND→WATER sibling sits its
 *  beach foam just above the crest line. Kept modest (≈0.3 m). */
export const SEA_MAX_AMPLITUDE = (() => {
  let sum = 0;
  for (const [, , steep, wavelength] of WAVE_CONFIG) {
    const k = TWO_PI / wavelength;
    sum += (steep / k) * AMP_SCALE;
  }
  return sum + SEA_VNOISE_AMP; // + the tanh-capped vertex noise lift
})();
