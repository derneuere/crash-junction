import * as THREE from 'three';
import type { WheelStyle } from './recipe';
import { Soup, type V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Parametric wheels for the generated cars — the same contract as the baked
// wheel templates (centred at origin, axle along X, radius exactly the
// spec's wheelRadius, vertex-colored, display-only/never deformed). One
// builder covers the four styles by varying rim size, spoke count/width and
// dish depth. Both sides get the detail so either wheel reads from outside.
// ────────────────────────────────────────────────────────────────────────────

const TIRE = new THREE.Color(0x17191d);
const RIM = new THREE.Color(0x9aa0a8);
const SPOKE = new THREE.Color(0x565b63);
const SEGS = 14;

interface StyleParams {
  rimR: number; // rim disc radius as a fraction of the tire radius
  spokes: number;
  spokeW: number; // spoke width as a fraction of the tire radius
  dish: number; // how far the rim face is recessed into the tire (m)
}

const STYLES: Record<WheelStyle, StyleParams> = {
  steelie: { rimR: 0.62, spokes: 4, spokeW: 0.13, dish: 0.015 },
  'five-spoke': { rimR: 0.42, spokes: 5, spokeW: 0.2, dish: 0.01 },
  turbine: { rimR: 0.4, spokes: 9, spokeW: 0.09, dish: 0.008 },
  'deep-dish': { rimR: 0.45, spokes: 6, spokeW: 0.16, dish: 0.05 },
};

/** Left + right wheel template pair for a style. */
export function buildWheelPair(style: WheelStyle, r: number): { wheelL: THREE.BufferGeometry; wheelR: THREE.BufferGeometry } {
  const p = STYLES[style];
  const halfW = r * 0.38;
  const soup = new Soup();

  // tire: outer tread wall + both sidewalls down to the rim radius
  const rimR = r * p.rimR;
  for (let k = 0; k < SEGS; k++) {
    const a0 = (k / SEGS) * Math.PI * 2;
    const a1 = ((k + 1) / SEGS) * Math.PI * 2;
    const y0 = Math.cos(a0) * r, z0 = Math.sin(a0) * r;
    const y1 = Math.cos(a1) * r, z1 = Math.sin(a1) * r;
    const ry0 = Math.cos(a0) * rimR, rz0 = Math.sin(a0) * rimR;
    const ry1 = Math.cos(a1) * rimR, rz1 = Math.sin(a1) * rimR;
    // tread
    soup.quad([-halfW, y0, z0], [halfW, y0, z0], [halfW, y1, z1], [-halfW, y1, z1], TIRE, [0, 0, 0]);
    for (const sx of [halfW, -halfW]) {
      const face = sx - Math.sign(sx) * p.dish;
      const out: V3 = [sx * 3, 0, 0];
      // sidewall ring tire→rim, then the recessed rim disc wedge
      soup.quad([sx, y0, z0], [sx, y1, z1], [face, ry1, rz1], [face, ry0, rz0], TIRE, out);
      soup.tri([face, 0, 0], [face, ry0, rz0], [face, ry1, rz1], RIM, out);
    }
  }

  // spokes: thin radial boxes on both faces, spanning hub → rim radius
  for (const sx of [halfW + 0.004, -(halfW + 0.004)]) {
    for (let s = 0; s < p.spokes; s++) {
      const ang = (s / p.spokes) * Math.PI * 2;
      const w = r * p.spokeW;
      const inner = r * 0.12, outer = rimR * 0.96;
      const cy = Math.cos(ang), cz = Math.sin(ang);
      const py = -cz, pz = cy; // perpendicular in the wheel face
      const q = (t: number, side: number): V3 => [
        sx,
        cy * (inner + (outer - inner) * t) + py * w * side * 0.5,
        cz * (inner + (outer - inner) * t) + pz * w * side * 0.5,
      ];
      soup.quad(q(0, -1), q(0, 1), q(1, 1), q(1, -1), SPOKE, [sx * 3, 0, 0]);
    }
  }

  const geo = soupToGeometry(soup);
  const wheelR = geo.clone();
  wheelR.rotateY(Math.PI);
  return { wheelL: geo, wheelR };
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
