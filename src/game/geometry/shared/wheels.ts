import * as THREE from 'three';
import { buildWheelGeometry, type WheelSide, type WheelStyle } from './wheelBuilder';

// White base material: the dark tyre / bright rim / hub all ride in per-vertex
// colours so the wheel's rotation is legible (a flat-dark cylinder reads as
// static no matter how fast it spins). MeshStandard with vertexColors
// multiplies albedo by the vertex colour, so a white base shows them unaltered.
// Smooth-shaded: the wheel geometry carries its own normals (round tyre,
// hard rim lip), so flatShading would throw that away.
export const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 });

const wheelGeoCache = new Map<string, THREE.BufferGeometry>();

/** Shared procedural road wheel for anything without a modelled wheel: the
 *  garage's baked roster, the tanker, the no-model fallback. One parametric
 *  build per (style, side, radius), cached for the life of the page — callers
 *  must NOT dispose or track it per car. */
export function wheelGeometry(r: number, style: WheelStyle = 'five-spoke', side: WheelSide = 'L'): THREE.BufferGeometry {
  const key = `${style}/${side}/${r}`;
  let g = wheelGeoCache.get(key);
  if (!g) {
    g = buildWheelGeometry(style, r, side);
    wheelGeoCache.set(key, g);
  }
  return g;
}

export function applyUniformColor(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = (g.attributes.position as THREE.BufferAttribute).count;
  const cols: number[] = [];
  for (let i = 0; i < count; i++) cols.push(c.r, c.g, c.b);
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return g;
}

/** Segmented colored box — enough vertices for the crumple deformer. */
export function makeColoredBox(sx: number, sy: number, sz: number, hex: number): THREE.BufferGeometry {
  return applyUniformColor(new THREE.BoxGeometry(sx, sy, sz, 2, 2, 2), hex);
}
