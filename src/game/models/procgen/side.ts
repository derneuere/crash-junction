import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import { Soup, prism, type V3 } from './soup';
import { surfaceOf } from './surface';

// ────────────────────────────────────────────────────────────────────────────
// Side furniture: door shutlines, handles, rocker/side mouldings — the
// dressing that makes the flank read as a 5-door instead of a bar of soap.
// Everything anchors to the loft surface via surface.ts (halfW/bodyY) plus a
// local mirror of the loft's fender-bulge falloff, so silhouette changes
// can't strand it. Dark seams are flat quads floating a few mm proud of the
// wall (they read purely by colour); the crease is a shaded 2-quad ridge;
// handles are small prisms rooted inside the wall so they stay attached
// where the shoulder bevel slopes away above the side-wall top.
// ────────────────────────────────────────────────────────────────────────────

interface SideSoups {
  paint: Soup;
  trim: Soup;
}

interface SideColors {
  paint: THREE.Color;
  trim: THREE.Color;
}

// Loft constants we shadow (loft.ts): side wall ends SIDE_TOP_DROP below the
// shoulder line (the bevel spans that last rise, SHOULDER_BEVEL deep), rocker
// knuckle sits KNUCKLE_RISE above the floor.
const SIDE_TOP_DROP = 0.05;
const SHOULDER_BEVEL = 0.06;
const KNUCKLE_RISE = 0.09;

const SEAM_PROUD = 0.012; // dark shutlines float this far off the wall
// (generous: the loft wall is faceted between inserted stations and our
// continuous bulge model only approximates those chords — anything closer
// depth-fights and the seams render dashed)
const SEAM_W = 0.014; // shutline strip width (perpendicular to its run)

/** (z, y) polyline point on the side wall. */
type ZY = [number, number];

export function buildSide(recipe: CarRecipe, soups: SideSoups, colors: SideColors): void {
  const surf = surfaceOf(recipe);
  const seam = new THREE.Color(0x0d0f12); // near-black shutline
  const sill = new THREE.Color(recipe.trimColor);
  const creaseCol = colors.paint.clone().multiplyScalar(0.88);

  // ── wall x at z: loft half-width + our mirror of the fender bulge ──
  const bulge = recipe.archBulge ?? 0;
  const archZs = [recipe.wheels.zFront, recipe.wheels.zRear];
  const reach = recipe.archR + 0.2; // ≈ loft's zHalf + 0.2, erring proud
  const bulgeAt = (z: number): number => {
    let f = 0;
    for (const zc of archZs) {
      const t = Math.abs(z - zc) / reach;
      if (t < 1) f = Math.max(f, 1 - t * t);
    }
    return bulge * f;
  };
  const wallX = (z: number): number => surf.halfW(z) + bulgeAt(z);
  const sideTop = (z: number): number => surf.bodyY(z) - SIDE_TOP_DROP;
  /** x on the shoulder-bevel surface at (z, y) for y in [sideTop, bodyY]. */
  const bevelX = (z: number, y: number): number => {
    const t = Math.min(Math.max((y - sideTop(z)) / SIDE_TOP_DROP, 0), 1);
    const shW = surf.halfW(z) - SHOULDER_BEVEL + bulgeAt(z) * 0.6;
    return wallX(z) + (shW - wallX(z)) * t;
  };
  const knuckleY = recipe.floorY + KNUCKLE_RISE;

  // ── helpers (all mirror across x; m = ±1) ──

  /** Flat dark strip along a (z,y) polyline, constant width, SEAM_PROUD off
   *  the wall. Each segment is one quad; corners offset perpendicular to the
   *  segment in the z-y plane. */
  const seamStrip = (pts: ZY[], m: number, color: THREE.Color, proud = SEAM_PROUD): void => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [z0, y0] = pts[i];
      const [z1, y1] = pts[i + 1];
      const len = Math.hypot(z1 - z0, y1 - y0);
      const pz = (-(y1 - y0) / len) * (SEAM_W / 2);
      const py = ((z1 - z0) / len) * (SEAM_W / 2);
      const x = (z: number): number => m * (wallX(z) + proud);
      const away: V3 = [0, (y0 + y1) / 2, (z0 + z1) / 2];
      soups.trim.quad(
        [x(z0 - pz), y0 - py, z0 - pz], [x(z0 + pz), y0 + py, z0 + pz],
        [x(z1 + pz), y1 + py, z1 + pz], [x(z1 - pz), y1 - py, z1 - pz],
        color, away);
    }
  };

  /** Horizontal dark band following yLo(z)..yHi(z) across knot z's. */
  const band = (
    zs: number[], yLo: (z: number) => number, yHi: (z: number) => number,
    m: number, color: THREE.Color,
  ): void => {
    for (let i = 0; i < zs.length - 1; i++) {
      const z0 = zs[i], z1 = zs[i + 1];
      const x0 = m * (wallX(z0) + SEAM_PROUD), x1 = m * (wallX(z1) + SEAM_PROUD);
      const away: V3 = [0, (yLo(z0) + yHi(z1)) / 2, (z0 + z1) / 2];
      soups.trim.quad(
        [x0, yLo(z0), z0], [x1, yLo(z1), z1],
        [x1, yHi(z1), z1], [x0, yHi(z0), z0], color, away);
    }
  };

  /** Body-colour crease ridge at yC: two long quads meeting at a proud apex,
   *  apex fading to the wall at both ends so the moulding dies out cleanly. */
  const crease = (zs: number[], yC: number, hh: number, proud: number, m: number): void => {
    const apex = (i: number): number =>
      i === 0 || i === zs.length - 1 ? 0.001 : proud;
    for (let i = 0; i < zs.length - 1; i++) {
      const z0 = zs[i], z1 = zs[i + 1];
      const w0 = wallX(z0), w1 = wallX(z1);
      const a0 = m * (w0 + apex(i)), a1 = m * (w1 + apex(i + 1));
      const b0 = m * (w0 + 0.001), b1 = m * (w1 + 0.001);
      const away: V3 = [0, yC, (z0 + z1) / 2];
      soups.paint.quad( // lower face (catches down-light as shadow)
        [b0, yC - hh, z0], [b1, yC - hh, z1], [a1, yC, z1], [a0, yC, z0],
        creaseCol, away);
      soups.paint.quad( // upper face (catches sky light)
        [a0, yC, z0], [a1, yC, z1], [b1, yC + hh, z1], [b0, yC + hh, z0],
        creaseCol, away);
    }
  };

  for (const m of [1, -1]) {
    // ── door shutlines (5-door): front leading, B-pillar split, rear trailing ──
    const bp = recipe.cabin.pillars[0] ?? 0.45;
    const frontTopZ = -0.63, rearTopZ = 1.17;
    seamStrip([[-0.84, -0.52], [-0.72, -0.18], [frontTopZ, sideTop(frontTopZ)]], m, seam);
    seamStrip([[bp, -0.52], [bp, sideTop(bp)]], m, seam);
    seamStrip([[0.88, -0.50], [1.00, -0.10], [rearTopZ, sideTop(rearTopZ)]], m, seam);

    // ── belt line: thin dark rubber strip ON the bevel, right under the
    //    glass base, running the door tops out to the quarter panel ──
    const beltZ0 = recipe.cabin.z0;
    for (const [z0, z1] of [[beltZ0, 0], [0, 0.7], [0.7, 1.0], [1.0, 1.3]] as const) {
      const yTop = (z: number): number => surf.bodyY(z) - 0.002;
      const yLo = (z: number): number => surf.bodyY(z) - 0.018;
      const c = (z: number, y: number): V3 => [m * (bevelX(z, y) + SEAM_PROUD), y, z];
      soups.trim.quad(
        c(z0, yLo(z0)), c(z1, yLo(z1)), c(z1, yTop(z1)), c(z0, yTop(z0)),
        seam, [0, surf.bodyY((z0 + z1) / 2) - 0.2, (z0 + z1) / 2]);
    }

    // ── rocker sill strip, low between the arches ──
    band([-0.91, -0.73, 0, 0.71, 0.89],
      () => knuckleY, () => knuckleY + 0.04, m, sill);

    // ── mid-door crease moulding ──
    crease([-0.72, 0.2, 0.71, 0.95, 1.18], -0.25, 0.025, 0.014, m);

    // ── door handles: body-colour bars just under the belt + shadow notch ──
    for (const zH of [0.25, 1.15]) {
      // centre the bar so its top stays under the wall-top corner — anchored
      // to bodyY it pokes through the bevel and breaks the belt line where
      // the belt rises toward the tail
      const yH = sideTop(zH) - 0.025;
      const xIn = m * (wallX(zH) - 0.012);
      const face: [V3, V3, V3, V3] = [
        [xIn, yH - 0.02, zH - 0.085], [xIn, yH - 0.02, zH + 0.085],
        [xIn, yH + 0.02, zH + 0.085], [xIn, yH + 0.02, zH - 0.085],
      ];
      prism(soups.paint, face, [m * 0.03, 0, 0], colors.paint);
      const xN = m * (wallX(zH) + 0.002);
      soups.trim.quad( // thumb-recess shadow behind the bar
        [xN, yH - 0.015, zH + 0.09], [xN, yH - 0.015, zH + 0.14],
        [xN, yH + 0.015, zH + 0.14], [xN, yH + 0.015, zH + 0.09],
        seam, [0, yH, zH + 0.115]);
    }
  }

  // ── fuel-filler square hint, right rear quarter only ──
  const zF = 1.55, yF = 0.0, sF = 0.045, wF = 0.008;
  const xF = wallX(zF) + SEAM_PROUD;
  const edge = (a: ZY, b: ZY, horiz: boolean): void => {
    const dz = horiz ? 0 : wF, dy = horiz ? wF : 0;
    soups.trim.quad(
      [xF, a[1] - dy, a[0] - dz], [xF, b[1] - dy, b[0] - dz],
      [xF, b[1] + dy, b[0] + dz], [xF, a[1] + dy, a[0] + dz],
      seam, [0, yF, zF]);
  };
  edge([zF - sF, yF - sF], [zF + sF, yF - sF], true); // bottom
  edge([zF - sF, yF + sF], [zF + sF, yF + sF], true); // top
  edge([zF - sF, yF - sF], [zF - sF, yF + sF], false); // front
  edge([zF + sF, yF - sF], [zF + sF, yF + sF], false); // rear
}
