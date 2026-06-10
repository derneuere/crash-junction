import * as THREE from 'three';
import { smoothstep } from './shared';

/** Slab-sided hull with a glass band — buses and truck cabs. */
export function makeBoxHullGeometry(
  W: number,
  H: number,
  L: number,
  bodyHex: number,
  glassHex: number,
  glassLo = 0.55,
  glassHi = 0.9,
  roofTaper = 0.12,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(W, H, L, 4, 4, 10);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols: number[] = [];
  const cb = new THREE.Color(bodyHex);
  const cg = new THREE.Color(glassHex);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    const yn = (y + H / 2) / H;
    x *= 1 - roofTaper * smoothstep(0.7, 1, yn);
    pos.setX(i, x);
    const c = yn > glassLo && yn < glassHi ? cg : cb;
    cols.push(c.r, c.g, c.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}
