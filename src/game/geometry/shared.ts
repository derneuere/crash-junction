import * as THREE from 'three';

export const GLASS = 0x16202c;

export const smoothstep = (a: number, b: number, x: number): number => {
  x = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** One shared material for every painted/deformable surface — color comes
 *  from per-vertex attributes so crumple scuffing can darken paint. */
export const hullMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  vertexColors: true,
  flatShading: true,
  roughness: 0.5,
  metalness: 0.15,
});

export const wheelMat = new THREE.MeshStandardMaterial({ color: 0x191b1f, roughness: 0.85 });

const wheelGeoCache = new Map<number, THREE.CylinderGeometry>();

export function wheelGeometry(r: number): THREE.CylinderGeometry {
  let g = wheelGeoCache.get(r);
  if (!g) {
    g = new THREE.CylinderGeometry(r, r, r * 0.76, 12);
    g.rotateZ(Math.PI / 2);
    wheelGeoCache.set(r, g);
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
