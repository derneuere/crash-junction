import * as THREE from 'three';

// SkyPreset keeps the legacy field shape so existing Game.ts wiring
// (SKY_PRESETS[t] → configure) is untouched, and adds optional richer knobs
// for the scattering model. Legacy turbidity/rayleigh/mie* feed the new
// coefficients when the explicit ones are absent.
export interface SkyPreset {
  /** sun elevation above the horizon, degrees */
  elevation: number;
  /** sun azimuth from +z toward +x, degrees */
  azimuth: number;
  /** legacy haze knob — biases Mie scatter when mieScatter is unset */
  turbidity: number;
  /** legacy Rayleigh strength — scales the per-channel Rayleigh coefficient */
  rayleigh: number;
  /** legacy Mie coefficient — used directly as the Mie scatter strength */
  mieCoefficient: number;
  /** Mie phase asymmetry g (forward-scatter; higher = tighter sun glow) */
  mieDirectionalG: number;
  /** radiance → display scale (the raymarch output is unbounded HDR) */
  exposure: number;
  // ---- optional scattering knobs (default-filled in configure) ----
  /** angular radius of the crisp sun disc, degrees */
  sunDiscSize?: number;
  /** brightness multiplier on the sun disc + its bloom halo */
  sunIntensity?: number;
  /** RGB colour bias of the disc/glow (warm at dusk) */
  sunTint?: THREE.ColorRepresentation;
  /** colour seen looking just below the horizon line */
  groundColor?: THREE.ColorRepresentation;
  /** 0 day .. 1 night — blends in the night tint + star field */
  night?: number;
  /** deep scattered-blue night dome colour */
  nightTint?: THREE.ColorRepresentation;
  /** star-field brightness (only visible while night > 0) */
  starStrength?: number;
  // ---- cloud layer (skyclouds.glsl.ts) ----
  /** 0 clear .. 1 overcast — lowers the density cut so more sky fills with cloud */
  cloudCoverage?: number;
  /** overall opacity multiplier of the cloud layer (0 = no clouds) */
  cloudDensity?: number;
  /** ambient/shadow fill colour for clouds — usually the sky's mid tone, so
   *  shaded cloud reads as lit-by-sky (warm-grey day, blue-grey dusk/night) */
  cloudTint?: THREE.ColorRepresentation;
}

// Per-channel Rayleigh base coefficient ∝ 1/λ⁴ for λ ≈ (680, 550, 440) nm —
// the blue-sky / red-sunset bias. Scaled by preset.rayleigh in configure.
export const RAYLEIGH_BASE = new THREE.Vector3(5.8, 13.5, 33.1);
// Ozone Chappuis-band absorption (1e-3 units) — subtly cools the zenith and
// keeps a believable blue in the upper sky at low sun (Bruneton).
export const OZONE_BASE = new THREE.Vector3(0.65, 1.88, 0.085);

// Day matches the legacy key light (sprite pinned at (170,220,100) →
// azimuth ≈ 59.5°, elevation ≈ 48°). Dusk is the Riviera money shot: sun
// ~6° over the horizon straight down the same azimuth, forward scattering
// for the warm golden glow wall. Night drops the sun below the horizon for a
// dark scattered-blue dome with stars (Game.ts may still hide the dome and use
// the lamp-glint env, but this preset makes the dome itself believable if shown).
export const SKY_PRESETS: Record<'day' | 'dusk' | 'night', SkyPreset> = {
  day: {
    elevation: 48, azimuth: 59.5, turbidity: 8, rayleigh: 1.0, mieCoefficient: 3.0, mieDirectionalG: 0.76,
    exposure: 16.0, sunDiscSize: 0.6, sunIntensity: 20.0, sunTint: 0xfff4e2, groundColor: 0x8a9bb0,
    night: 0,
    // fair-weather cumulus: scattered, bright-white tops, blue-grey sky fill
    cloudCoverage: 0.42, cloudDensity: 0.9, cloudTint: 0xb9c6d6,
  },
  dusk: {
    elevation: 6, azimuth: 59.5, turbidity: 6, rayleigh: 1.35, mieCoefficient: 4.0, mieDirectionalG: 0.86,
    exposure: 18.0, sunDiscSize: 0.9, sunIntensity: 26.0, sunTint: 0xffc070, groundColor: 0x8a7a6a,
    night: 0,
    // golden-hour: a touch more coverage so the warm sun catches the cloud
    // rims; cooler purple-grey ambient so the lit edges pop against shadow
    cloudCoverage: 0.50, cloudDensity: 0.95, cloudTint: 0x6a6680,
  },
  night: {
    elevation: -8, azimuth: 59.5, turbidity: 4, rayleigh: 1.1, mieCoefficient: 2.0, mieDirectionalG: 0.8,
    exposure: 16.0, sunDiscSize: 0.5, sunIntensity: 0.0, sunTint: 0x9db6e8, groundColor: 0x05080f,
    night: 1, nightTint: 0x0b1734, starStrength: 1.0,
    // dark blue-grey cloud silhouettes against the star band; faint moon fill
    cloudCoverage: 0.40, cloudDensity: 0.85, cloudTint: 0x1a2540,
  },
};
