// ────────────────────────────────────────────────────────────────────────────
// Procedural car recipes — the "genome" a generated car is built from.
// A recipe is PURE DATA and the generator is a pure function of it: no RNG,
// no clocks, built once at load. That keeps generated cars exactly as
// deterministic as the baked GLBs (docs/research/procedural-cars-plan.md).
//
// Space conventions match the bake: group origin rides at COM height
// (spec.rideHeight above ground), the nose faces -z, ground = -rideHeight.
// Dims are free WITHIN the variant's crash box — like the GLB roster, where
// the wedge is visually lower than the compact over the same physics box.
// ────────────────────────────────────────────────────────────────────────────

/** One station of the side silhouette, nose → tail (z ascending).
 *  `bodyY` is the fender/hood/belt/deck surface at that z; `roofY` is the
 *  greenhouse top and equals bodyY wherever there is no cabin. The loft
 *  skins between consecutive stations, so silhouette character (fastback,
 *  two-box, long hood) is just station placement. */
export interface Station {
  z: number;
  bodyY: number;
  roofY: number;
  /** Half-width of the body at this station (plan-view taper). */
  halfW: number;
}

export type WheelStyle = 'seven-spoke' | 'steelie' | 'five-spoke' | 'turbine' | 'deep-dish';
export type GrilleStyle = 'bar' | 'closed' | 'chrome';
export type LightStyle = 'pods' | 'strip' | 'quad-round';

export interface CarRecipe {
  /** Overall bounds the stations live in (sanity/asserts only — the
   *  stations are the actual shape). */
  dims: { length: number; width: number };
  /** Bottom of the rocker panel, group space (ground = -rideHeight). */
  floorY: number;
  /** Wheel placement → model.arch → suspension anchors (per-car identity). */
  wheels: { zFront: number; zRear: number; archX: number; style: WheelStyle };
  /** Wheel-well opening radius around each wheel centre. The loft traces
   *  this circle as a polygonal arc down to knuckle (rocker-top) height. */
  archR: number;
  /** Optional subtle fender bulge: extra half-width at the wheel centres,
   *  fading quadratically to zero just beyond each arch opening. */
  archBulge?: number;
  /** The silhouette, nose → tail. Must include stations exactly at the
   *  arch-opening edges (zFront±archR, zRear±archR) so well holes land on
   *  band boundaries. buildRecipeStations() below handles that. */
  stations: Station[];
  /** Where side glass lives: z span, belt line (glass bottom), pillar z
   *  positions (each listed pillar band renders as dark trim — B-pillar
   *  style). `cPillar` kicks the greenhouse wall outboard over [z0, z1] so
   *  the C-pillar reads as its own surface against the quarter-window edge. */
  cabin: {
    z0: number; z1: number; beltY: number; pillars: number[];
    cPillar?: { z0: number; z1: number; kick: number };
  };
  /** Greenhouse inset: glass base sits this far inboard of the shoulder. */
  tumblehome: number;
  parts: {
    grille: GrilleStyle;
    headlights: LightStyle;
    taillights: LightStyle;
    /** Bumper slabs: body-coloured or dark plastic. */
    bumpers: 'painted' | 'plastic';
    exhaust: 0 | 1 | 2;
  };
  /** Fixed trim colour (bumper plastic, wells, grille). */
  trimColor: number;
  /** Roof antenna stub position (z, on the roof centreline); omit for none. */
  antennaZ?: number;
}

/** Insert interpolated stations at the given z values so loft bands break
 *  exactly there (wheel-well edges, cabin ends, pillars). Keeps recipes
 *  writable as a handful of landmark stations. */
export function withStationsAt(stations: Station[], zs: number[]): Station[] {
  const out = stations.slice().sort((a, b) => a.z - b.z);
  for (const z of zs) {
    if (out.some((s) => Math.abs(s.z - z) < 1e-4)) continue;
    const i = out.findIndex((s) => s.z > z);
    if (i <= 0) continue; // outside the silhouette — nothing to split
    const a = out[i - 1];
    const b = out[i];
    const t = (z - a.z) / (b.z - a.z);
    out.splice(i, 0, {
      z,
      bodyY: a.bodyY + (b.bodyY - a.bodyY) * t,
      roofY: a.roofY + (b.roofY - a.roofY) * t,
      halfW: a.halfW + (b.halfW - a.halfW) * t,
    });
  }
  return out;
}
