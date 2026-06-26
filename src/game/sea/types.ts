// ============================================================================
// SEA — public handle + per-time-of-day palette types.
// ============================================================================
// Split out of sea.ts. Both interfaces are part of the module's public export
// surface (re-exported by sea.ts); buildSea returns a Sea and Game feeds it a
// SeaPalette via setTimeOfDay.

import * as THREE from 'three';

/** Handle returned by buildSea: the mesh (already added to the scene) and the
 *  per-frame update hook. update(dtSeconds) advances the wave clock by a
 *  wall-time delta in SECONDS — call it once per RENDERED frame with the
 *  render dt (never the sim dt). Visual only; safe to call during replay. */
export interface Sea {
  mesh: THREE.Mesh;
  /** @param dtSeconds elapsed RENDER time since last frame (seconds) */
  update(dtSeconds: number): void;
  /** Re-tint the reflection/sun to the current time of day. Visual only. */
  setTimeOfDay(p: SeaPalette): void;
}

/** Per-time-of-day look fed from Game. All hex colours. */
export interface SeaPalette {
  /** zenith / sky-dome colour the water mirrors looking up (analytic fallback) */
  sky: number;
  /** horizon / haze colour (Game's fog colour is ideal) */
  horizon: number;
  /** deep water body colour */
  deep: number;
  /** sun/moon disc colour for the glint */
  sun: number;
  /** unit direction toward the sun/moon */
  sunDir: THREE.Vector3;
  /** glint strength (bright by day, dim at night) */
  sunStrength: number;
  /** overall reflection brightness (scene.environmentIntensity is a good feed) */
  envIntensity: number;
  /** light level on the water body: ~1 day, ~0.85 dusk, ~0.35 night */
  ambient: number;
}
