import * as THREE from 'three';
import { smoothstep } from './shared';

/** Sculpted sedan hull: windshield rise, trunk drop, cabin + nose taper. */
export function makeSedanGeometry(
  W: number,
  H: number,
  L: number,
  bodyHex: number,
  glassHex: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(W, H, L, 6, 3, 12);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols: number[] = [];
  const cb = new THREE.Color(bodyHex);
  const cg = new THREE.Color(glassHex);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    const z = pos.getZ(i);
    const zn = z / L; // -0.5 .. 0.5 (hood at -z)
    const top = 0.5 + 0.5 * smoothstep(-0.26, -0.05, zn) - 0.3 * smoothstep(0.16, 0.36, zn);
    const yn = (y + H / 2) / H; // 0..1
    y = -H / 2 + yn * top * H; // squeeze column to profile
    if (yn > 0.62) x *= 1 - 0.2 * smoothstep(0.62, 1.0, yn); // cabin taper
    x *= 1 - 0.1 * smoothstep(0.36, 0.5, Math.abs(zn)); // nose/tail taper
    pos.setXYZ(i, x, y, z);
    const isGlass = yn > 0.68 && zn > -0.16 && zn < 0.28;
    const c = isGlass ? cg : cb;
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}
