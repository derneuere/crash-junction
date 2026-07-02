import type { CarRecipe, Station } from './recipe';

// ────────────────────────────────────────────────────────────────────────────
// Loft-surface queries for part builders. Clips, lights, seams and trim
// should anchor to the SURFACE the loft actually skins — piecewise-linear
// interpolation over the recipe's stations — instead of hand-rolling their
// own two-station interpolations (which strand parts the moment the
// silhouette agent moves a station). Same numbers the loft uses; z is
// clamped to the station span.
// ────────────────────────────────────────────────────────────────────────────

export interface LoftSurface {
  /** Fender/hood/belt/deck height at z. */
  bodyY(z: number): number;
  /** Greenhouse top at z (= bodyY where there is no cabin). */
  roofY(z: number): number;
  /** Body half-width at z (before shoulder bevel / fender bulge). */
  halfW(z: number): number;
  nose: Station;
  tail: Station;
}

export function surfaceOf(recipe: CarRecipe): LoftSurface {
  const s = recipe.stations.slice().sort((a, b) => a.z - b.z);
  const interp = (z: number, pick: (st: Station) => number): number => {
    if (z <= s[0].z) return pick(s[0]);
    for (let i = 1; i < s.length; i++) {
      if (z <= s[i].z) {
        const a = s[i - 1], b = s[i];
        const t = (z - a.z) / (b.z - a.z);
        return pick(a) + (pick(b) - pick(a)) * t;
      }
    }
    return pick(s[s.length - 1]);
  };
  return {
    bodyY: (z) => interp(z, (st) => st.bodyY),
    roofY: (z) => interp(z, (st) => st.roofY),
    halfW: (z) => interp(z, (st) => st.halfW),
    nose: s[0],
    tail: s[s.length - 1],
  };
}
