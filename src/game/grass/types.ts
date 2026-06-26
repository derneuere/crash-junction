// ============================================================================
// GRASS — public handle + palette types, plus the internal tile record.
// ============================================================================
// Split out of grass.ts. GrassField + GrassPalette are part of the module's
// public export surface (re-exported by grass.ts); GrassTile is internal.

import * as THREE from 'three';

/** Handle returned by buildGrass. */
export interface GrassField {
  meshes: THREE.InstancedMesh[];
  /** @param dtSeconds elapsed RENDER time since last frame (seconds)
   *  @param camPos live camera world position for distance culling/LOD */
  update(dtSeconds: number, camPos?: THREE.Vector3): void;
  /** CINE-ONLY no-op kept so Game.ts's grass?.setTier(...) type-checks. */
  setTier(gfx: 'cine' | 'fast'): void;
  /** Re-tint the blades' lit response to match the time-of-day sky. */
  setTimeOfDay(p: GrassPalette): void;
  /** Cheap live telemetry for the debug overlay. */
  stats(): { allocated: number; tilesTotal: number; tilesDrawn: number };
}

/** Per-time-of-day look fed from Game (mirrors the Sea palette pattern). */
export interface GrassPalette {
  /** overall light level on the blades: ~1 day, ~0.85 dusk, ~0.4 night */
  ambient: number;
  /** warm/cool ground tint pushed into the base colour (sun/sky colour) */
  tint: number;
}

/** One spatial tile: an InstancedMesh + world-space centre + full instance
 *  count + the geometry-LOD it currently shows (to avoid redundant swaps). */
export interface GrassTile {
  mesh: THREE.InstancedMesh;
  cx: number;
  cz: number;
  full: number;
  lod: number; // 0/1/2 currently assigned; -1 = none yet
}
