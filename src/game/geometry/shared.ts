import * as THREE from 'three';

export const GLASS = 0x16202c;

export const smoothstep = (a: number, b: number, x: number): number => {
  x = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** One shared material for every painted/deformable surface — color comes
 *  from per-vertex attributes so crumple scuffing can darken paint.
 *  Burnout-3 gloss = clearcoat: a white specular layer over the color, so
 *  even dark paint shines (metalness would tint reflections by albedo). */
export const hullMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  vertexColors: true,
  flatShading: true,
  roughness: 0.42,
  metalness: 0.05,
  clearcoat: 0.65,
  clearcoatRoughness: 0.18,
});

/** Window panes (the glass index groups of a baked hull): a full mirror
 *  clearcoat over the dark tint — bright sky reflections on near-black
 *  glass, and the frost recolor still reads underneath. */
export const glassMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.3,
  metalness: 0,
  clearcoat: 1,
  clearcoatRoughness: 0.06,
});

/** Bare-chassis metal — interior platform, engine bay, trunk. */
export const metalMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.32,
  metalness: 0.85,
});

/** Cabin fittings — dash, seats, steering wheel. Matte. */
export const cabinMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.85,
  metalness: 0.05,
});

// Gloss needs something to reflect. The Game hands every car material the
// same PMREM environment texture once the renderer exists; materials created
// later (clones) join via registerCarMaterial.
const carMats: THREE.MeshStandardMaterial[] = [hullMat, glassMat, metalMat, cabinMat];
const ENV_INTENSITY = new Map<THREE.MeshStandardMaterial, number>([
  [hullMat, 0.45],
  [glassMat, 1.0],
  [metalMat, 0.8],
  [cabinMat, 0.25],
]);
let carEnv: THREE.Texture | null = null;

export function registerCarMaterial(mat: THREE.MeshStandardMaterial, intensity: number): void {
  carMats.push(mat);
  ENV_INTENSITY.set(mat, intensity);
  if (carEnv) {
    mat.envMap = carEnv;
    mat.envMapIntensity = intensity;
    mat.needsUpdate = true;
  }
}

export function setCarEnvMap(tex: THREE.Texture): void {
  carEnv = tex;
  for (const m of carMats) {
    m.envMap = tex;
    m.envMapIntensity = ENV_INTENSITY.get(m) ?? 0.5;
    m.needsUpdate = true;
  }
}

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
