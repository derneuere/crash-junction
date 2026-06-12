import * as THREE from 'three';

export const GLASS = 0x16202c;

export const smoothstep = (a: number, b: number, x: number): number => {
  x = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/** One shared material for every painted/deformable surface — color comes
 *  from per-vertex attributes so crumple scuffing can darken paint.
 *  Burnout-3 gloss = clearcoat (a white specular layer over the color, so
 *  even dark paint shines; metalness would tint reflections by albedo) +
 *  SMOOTH shading: the baked hulls carry creased-smooth normals, so the
 *  env streaks sweep across curved panels instead of stamping per facet. */
export const hullMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.32,
  metalness: 0.05,
  clearcoat: 1,
  clearcoatRoughness: 0.07,
});

/** Window panes (the glass index groups of a baked hull): a full mirror
 *  clearcoat over the dark tint — bright sky reflections on near-black
 *  glass, and the frost recolor still reads underneath. */
export const glassMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  roughness: 0.3,
  metalness: 0,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
});

/** Headlights (and the bus light strip): clearcoated lenses that switch
 *  on at night via the daynight emissive sweep. */
export const headlightMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  emissive: 0xffe9bb,
  emissiveIntensity: 0,
});
headlightMat.userData.night = { intensity: 2.6 };

export const taillightMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  emissive: 0xff2014,
  emissiveIntensity: 0,
});
taillightMat.userData.night = { intensity: 1.9 };

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
const carMats: THREE.MeshStandardMaterial[] = [hullMat, glassMat, headlightMat, taillightMat, metalMat, cabinMat];
const ENV_INTENSITY = new Map<THREE.MeshStandardMaterial, number>([
  [hullMat, 0.75],
  [glassMat, 1.0],
  [headlightMat, 0.9],
  [taillightMat, 0.9],
  [metalMat, 0.8],
  [cabinMat, 0.25],
]);
let carEnv: THREE.Texture | null = null;
let envScale = 1; // night dims the showroom reflections — the sky is dark

export function registerCarMaterial(mat: THREE.MeshStandardMaterial, intensity: number): void {
  carMats.push(mat);
  ENV_INTENSITY.set(mat, intensity);
  if (carEnv) {
    mat.envMap = carEnv;
    mat.envMapIntensity = intensity * envScale;
    mat.needsUpdate = true;
  }
}

export function setCarEnvMap(tex: THREE.Texture): void {
  carEnv = tex;
  for (const m of carMats) {
    m.envMap = tex;
    m.envMapIntensity = (ENV_INTENSITY.get(m) ?? 0.5) * envScale;
    m.needsUpdate = true;
  }
}

export function applyCarEnvScale(scale: number): void {
  envScale = scale;
  for (const m of carMats) m.envMapIntensity = (ENV_INTENSITY.get(m) ?? 0.5) * scale;
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

// ---------- creased normal smoothing ----------
// The PS2-era car look: low-poly geometry, SMOOTH vertex normals — that's
// what lets an env-map streak sweep across a hood instead of stamping one
// tint per facet. The baked hulls arrive with hard-edge split normals, so
// we weld them back together wherever neighboring faces are flatter than
// the crease angle; true edges (panel lines, window frames) stay sharp.

const CREASE_COS = 0.55; // ≈57° — facet pairs flatter than this smooth together

/** Cluster position-welded vertex copies whose normals agree within the
 *  crease angle: slot → cluster representative. Built from pristine
 *  normals; reusable after deformation (membership is fixed). */
export function buildNormalSmoothing(pos: THREE.BufferAttribute, norm: THREE.BufferAttribute): Uint32Array {
  const n = pos.count;
  const map = new Uint32Array(n);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1000)}|${Math.round(pos.getY(i) * 1000)}|${Math.round(pos.getZ(i) * 1000)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }
  for (const g of groups.values()) {
    // greedy: each unclaimed copy seeds a cluster and absorbs the rest
    // whose normals lie within the crease angle of the seed
    const claimed = new Array<boolean>(g.length).fill(false);
    for (let a = 0; a < g.length; a++) {
      if (claimed[a]) continue;
      const i = g[a];
      map[i] = i;
      claimed[a] = true;
      for (let b = a + 1; b < g.length; b++) {
        if (claimed[b]) continue;
        const j = g[b];
        const dot = norm.getX(i) * norm.getX(j) + norm.getY(i) * norm.getY(j) + norm.getZ(i) * norm.getZ(j);
        if (dot > CREASE_COS) {
          map[j] = i;
          claimed[b] = true;
        }
      }
    }
  }
  return map;
}

/** Average normals inside each smoothing cluster, in place. Run after any
 *  computeVertexNormals() — which always rebuilds flat split normals. */
export function applyNormalSmoothing(norm: THREE.BufferAttribute, map: Uint32Array): void {
  for (let i = 0; i < map.length; i++) {
    const rep = map[i];
    if (rep === i) continue;
    norm.setXYZ(rep, norm.getX(rep) + norm.getX(i), norm.getY(rep) + norm.getY(i), norm.getZ(rep) + norm.getZ(i));
  }
  for (let i = 0; i < map.length; i++) {
    if (map[i] !== i) continue;
    const x = norm.getX(i);
    const y = norm.getY(i);
    const z = norm.getZ(i);
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l > 1e-6) norm.setXYZ(i, x / l, y / l, z / l);
    else norm.setXYZ(i, 0, 1, 0);
  }
  for (let i = 0; i < map.length; i++) {
    const rep = map[i];
    if (rep !== i) norm.setXYZ(i, norm.getX(rep), norm.getY(rep), norm.getZ(rep));
  }
  norm.needsUpdate = true;
}
