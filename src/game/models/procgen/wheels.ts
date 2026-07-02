import * as THREE from 'three';
import type { WheelStyle } from './recipe';
import { Soup, type V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Parametric wheels for the generated cars — the same contract as the baked
// wheel templates (centred at origin, axle along X, radius exactly the
// spec's wheelRadius, vertex-colored, display-only/never deformed).
//
// The face is a proper low-poly alloy: a bright outer ring annulus, chunky
// crowned wedge spokes (two facets each so the flat shading picks up light),
// dark recessed windows between them with closing side walls, and a proud
// dark hub. Both axial faces carry the full detail (the pair is shared L/R
// via a 180° Y rotation) and everything stays inside the tire width so the
// face can't poke through the arch or z-fight the dark well liner behind it.
// ────────────────────────────────────────────────────────────────────────────

const TIRE = new THREE.Color(0x17191d);
const ALLOY = new THREE.Color(0xd8dde3);
const ALLOY_DK = new THREE.Color(0x878d96);
const WINDOW = new THREE.Color(0x101216);
const HUB = new THREE.Color(0x3c4046);
const SEGS = 16;

interface StyleParams {
  rimR: number; // alloy face radius as a fraction of the tire radius
  spokes: number;
  fill: number; // fraction of each sector the spoke fills at the ring
  hubR: number; // hub radius as a fraction of the tire radius
  dish: number; // how far the face plane is recessed into the tire (m)
}

const STYLES: Record<WheelStyle, StyleParams> = {
  'seven-spoke': { rimR: 0.72, spokes: 7, fill: 0.6, hubR: 0.13, dish: 0.02 }, // Astra-H alloy
  steelie: { rimR: 0.74, spokes: 6, fill: 0.88, hubR: 0.2, dish: 0.015 }, // near-solid pressed disc
  'five-spoke': { rimR: 0.7, spokes: 5, fill: 0.52, hubR: 0.14, dish: 0.02 },
  turbine: { rimR: 0.7, spokes: 9, fill: 0.45, hubR: 0.13, dish: 0.015 },
  'deep-dish': { rimR: 0.68, spokes: 6, fill: 0.5, hubR: 0.15, dish: 0.055 },
};

const REC = 0.03; // window recess behind the face plane (m)
const RIDGE = 0.012; // spoke crown height above the face plane (m)

/** Left + right wheel template pair for a style. */
export function buildWheelPair(style: WheelStyle, r: number): { wheelL: THREE.BufferGeometry; wheelR: THREE.BufferGeometry } {
  const p = STYLES[style];
  const halfW = r * 0.38;
  const soup = new Soup();
  const rimR = r * p.rimR;

  // tire: outer tread wall + both sidewalls down to the alloy face radius
  for (let k = 0; k < SEGS; k++) {
    const a0 = (k / SEGS) * Math.PI * 2;
    const a1 = ((k + 1) / SEGS) * Math.PI * 2;
    const y0 = Math.cos(a0) * r, z0 = Math.sin(a0) * r;
    const y1 = Math.cos(a1) * r, z1 = Math.sin(a1) * r;
    soup.quad([-halfW, y0, z0], [halfW, y0, z0], [halfW, y1, z1], [-halfW, y1, z1], TIRE, [0, 0, 0]);
    for (const s of [1, -1]) {
      const face = s * (halfW - p.dish);
      const inn: V3 = [-s * r * 2, 0, 0]; // interior ref → normals point OUT of this face
      soup.quad(
        [s * halfW, y0, z0], [s * halfW, y1, z1],
        [face, Math.cos(a1) * rimR, Math.sin(a1) * rimR], [face, Math.cos(a0) * rimR, Math.sin(a0) * rimR],
        TIRE, inn,
      );
    }
  }

  // alloy face on both sides
  for (const s of [1, -1]) buildFace(soup, p, r, s, halfW, rimR);

  const geo = soupToGeometry(soup);
  const wheelR = geo.clone();
  wheelR.rotateY(Math.PI);
  return { wheelL: geo, wheelR };
}

/** One alloy face: ring annulus, crowned spokes, recessed windows, hub. */
function buildFace(soup: Soup, p: StyleParams, r: number, s: number, halfW: number, rimR: number): void {
  const xf = s * (halfW - p.dish); // face plane
  const xw = s * (halfW - p.dish - REC); // recessed window plane
  const xc = s * (halfW - p.dish + RIDGE); // spoke crown / hub plane
  // Winding reference: soup normals point AWAY from the ref, so face detail
  // uses a point deep INSIDE the wheel on the opposite side of this face.
  const out: V3 = [-s * r * 2, 0, 0];
  const ringR = rimR * 0.86; // inner edge of the bright outer ring
  const bossR = rimR * 0.38; // solid metal centre boss the spokes grow from
  const hubR = r * p.hubR;
  const N = p.spokes;
  const sector = (Math.PI * 2) / N;
  const ho = (p.fill * sector) / 2; // spoke half-angle at the ring
  const hi = ho * 0.85; // near-parallel sides, slight taper toward the boss
  const yz = (a: number, rad: number): [number, number] => [Math.cos(a) * rad, Math.sin(a) * rad];

  // bright outer ring annulus (face plane, full circle)
  for (let k = 0; k < SEGS; k++) {
    const a0 = (k / SEGS) * Math.PI * 2;
    const a1 = ((k + 1) / SEGS) * Math.PI * 2;
    const [oy0, oz0] = yz(a0, rimR), [oy1, oz1] = yz(a1, rimR);
    const [iy0, iz0] = yz(a0, ringR), [iy1, iz1] = yz(a1, ringR);
    soup.quad([xf, oy0, oz0], [xf, oy1, oz1], [xf, iy1, iz1], [xf, iy0, iz0], ALLOY, out);
  }

  for (let i = 0; i < N; i++) {
    const am = i * sector + Math.PI / 2; // spoke centreline
    const an = am + sector; // next spoke centreline
    const [cy, cz] = yz(am, (bossR + ringR) / 2);

    // spoke: two facets meeting at a raised crown centreline, boss → ring
    const [ryL, rzL] = yz(am - ho, ringR), [ryR, rzR] = yz(am + ho, ringR);
    const [byL, bzL] = yz(am - hi, bossR), [byR, bzR] = yz(am + hi, bossR);
    const [ryC, rzC] = yz(am, ringR), [byC, bzC] = yz(am, bossR);
    soup.quad([xf, byL, bzL], [xf, ryL, rzL], [xc, ryC, rzC], [xc, byC, bzC], ALLOY, out);
    soup.quad([xf, byR, bzR], [xf, ryR, rzR], [xc, ryC, rzC], [xc, byC, bzC], ALLOY, out);

    // spoke side walls down to the window plane (normal pushed off the spoke)
    for (const e of [-1, 1]) {
      const [ry, rz] = yz(am + e * ho, ringR), [by, bz] = yz(am + e * hi, bossR);
      soup.quad([xf, by, bz], [xf, ry, rz], [xw, ry, rz], [xw, by, bz], ALLOY_DK, [xf, cy, cz]);
    }

    // window slot between this spoke and the next, on the recessed plane
    const [wy0, wz0] = yz(am + hi, bossR), [wy1, wz1] = yz(am + ho, ringR);
    const [wy2, wz2] = yz(an - ho, ringR), [wy3, wz3] = yz(an - hi, bossR);
    soup.quad([xw, wy0, wz0], [xw, wy1, wz1], [xw, wy2, wz2], [xw, wy3, wz3], WINDOW, out);

    // window closing walls: under the ring (facing the axle) + around the boss
    const aw = (am + an) / 2;
    const [fy, fz] = yz(aw, ringR * 2);
    soup.quad([xf, wy1, wz1], [xf, wy2, wz2], [xw, wy2, wz2], [xw, wy1, wz1], WINDOW, [xw, fy, fz]);
    soup.quad([xf, wy0, wz0], [xf, wy3, wz3], [xw, wy3, wz3], [xw, wy0, wz0], ALLOY_DK, [xw, 0, 0]);

    // solid metal boss wedge between spoke roots (face plane, centre → bossR)
    soup.tri([xf, 0, 0], [xf, wy0, wz0], [xf, wy3, wz3], ALLOY, out);
    soup.tri([xf, 0, 0], [xf, byL, bzL], [xf, byR, bzR], ALLOY, out);
  }

  // dark centre cap, slightly proud of the boss
  const HUBSEG = 12;
  for (let k = 0; k < HUBSEG; k++) {
    const a0 = (k / HUBSEG) * Math.PI * 2;
    const a1 = ((k + 1) / HUBSEG) * Math.PI * 2;
    const [y0, z0] = yz(a0, hubR), [y1, z1] = yz(a1, hubR);
    soup.tri([xc, 0, 0], [xc, y0, z0], [xc, y1, z1], HUB, out);
    soup.quad([xc, y0, z0], [xc, y1, z1], [xf, y1, z1], [xf, y0, z0], HUB, [xf, 0, 0]);
  }
}

function soupToGeometry(soup: Soup): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  soup.appendTo(pos, nrm, col);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}
