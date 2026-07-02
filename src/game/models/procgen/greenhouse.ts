import * as THREE from 'three';
import type { CarRecipe, Station } from './recipe';
import { Soup, prism, type V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Greenhouse top surfaces — the bands between the greenhouse-top edge (ring
// R_GH_TOP) and the roof centreline, split out of loft.ts. Each band is cut
// laterally into an outer EDGE STRIP and an inner CENTRE PANEL:
//   • the strip is ALWAYS painted body — on the steep windshield/backlight
//     bands it becomes the slanted A-/C-pillar bar flanking an INSET glass
//     panel; on the flat roof (and hood/deck, where the ring collapses) it
//     is coplanar with the panel and reads as one surface.
//   • the centre panel is glass only on the steep screen bands.
// The roof centreline is raised by a rise-scaled CROWN so the roof reads
// gently domed instead of dead flat, and a small dark antenna stub sits on
// the roof rear. Point columns are shared per station so bands stay sealed.
// ────────────────────────────────────────────────────────────────────────────

const STRIP = 0.09; // x-width of the painted edge strip (the pillar bar)
const CROWN = 0.018; // extra roof-centre height at full greenhouse rise
const CROWN_RISE = 0.3; // greenhouse rise that earns the full crown
const STEEP_GLASS = 0.35; // roof slope (dy/dz) that reads as a screen surface
const ROOF_LIMIT = 0.55; // crash-box ceiling — nothing may poke above this

/** Ring indices — must match the loft.ts ring layout. */
const R_GH_TOP = 6, R_ROOF_C = 7;

function crownAt(s: Station): number {
  return CROWN * Math.min(Math.max((s.roofY - s.bodyY) / CROWN_RISE, 0), 1);
}

/** Steep rise/drop over the cabin = windshield or backlight surface. */
function isScreen(a: Station, b: Station, recipe: CarRecipe): boolean {
  const midZ = (a.z + b.z) / 2;
  const steep = Math.abs(b.roofY - a.roofY) / Math.max(b.z - a.z, 1e-4) > STEEP_GLASS;
  return steep && midZ > recipe.cabin.z0 - 0.05 && midZ < recipe.cabin.z1 + 0.05;
}

export function buildGreenhouse(
  recipe: CarRecipe,
  stations: Station[],
  rings: V3[][],
  soups: { paint: Soup; glass: Soup; trim: Soup },
  colors: { paint: THREE.Color; glass: THREE.Color; darkTrim: THREE.Color },
): void {
  // per-station point columns (edge → split → crowned centre)
  const edge = stations.map((_, i) => rings[i][R_GH_TOP]);
  const centre = stations.map((s, i): V3 => {
    const c = rings[i][R_ROOF_C];
    return [0, Math.min(c[1] + crownAt(s), ROOF_LIMIT), c[2]];
  });
  const split = stations.map((_, i): V3 => {
    const [xg, yg, z] = edge[i];
    if (xg < 1e-3) return centre[i];
    const xs = Math.max(xg - STRIP, xg * 0.55);
    const yc = centre[i][1];
    return [xs, yc + (yg - yc) * (xs / xg), z];
  });

  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    const glass = isScreen(a, b, recipe);
    const ctr: V3 = [0, (recipe.floorY + Math.max(a.roofY, b.roofY)) / 2, (a.z + b.z) / 2];
    for (const m of [1, -1]) {
      const p = (v: V3): V3 => [v[0] * m, v[1], v[2]];
      soups.paint.quad(p(edge[i]), p(split[i]), p(split[i + 1]), p(edge[i + 1]), colors.paint, ctr);
      const soup = glass ? soups.glass : soups.paint;
      const color = glass ? colors.glass : colors.paint;
      soup.quad(p(split[i]), p(centre[i]), p(centre[i + 1]), p(split[i + 1]), color, ctr);
    }
  }

  // ── drip rails: slim dark channel strips along the flat-roof edges ──
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (isScreen(a, b, recipe)) continue;
    if (a.roofY - a.bodyY < CROWN_RISE || b.roofY - b.bodyY < CROWN_RISE) continue;
    const [xa, ya, za] = edge[i];
    const [xb, yb, zb] = edge[i + 1];
    const h = 0.012;
    for (const m of [1, -1]) {
      prism(soups.trim,
        [[xa * m, ya, za], [xb * m, yb, zb], [xb * m, yb + h, zb], [xa * m, ya + h, za]],
        [-0.022 * m, 0, 0], colors.darkTrim);
    }
  }

  // ── antenna stub: a small raked dark prism on the roof centreline ──
  if (recipe.antennaZ !== undefined) {
    const z = recipe.antennaZ;
    const i = stations.findIndex((s, k) =>
      k < stations.length - 1 && s.z <= z && stations[k + 1].z >= z);
    if (i >= 0) {
      const t = (z - stations[i].z) / Math.max(stations[i + 1].z - stations[i].z, 1e-4);
      const y = centre[i][1] + (centre[i + 1][1] - centre[i][1]) * t - 0.005;
      const h = Math.min(0.05, ROOF_LIMIT - y);
      const r = 0.016;
      prism(soups.trim,
        [[-r, y, z - r], [r, y, z - r], [r, y, z + r], [-r, y, z + r]],
        [0, h, 0.03], colors.darkTrim);
    }
  }
}
