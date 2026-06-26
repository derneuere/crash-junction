import * as THREE from 'three';

// Shared car-material registries + the env-map plumbing that drives them. These
// live in their own module so both the opaque car materials (materials.ts) and
// the glass subsystem (glass.ts) can register into / read from the same
// singletons without a circular import. The registries are seeded by
// materials.ts at module load (it owns the literal material list + order).

// Gloss needs something to reflect. The Game hands every car material the
// same PMREM environment texture once the renderer exists; materials created
// later (clones) join via registerCarMaterial.
export const carMats: THREE.MeshStandardMaterial[] = [];
export const ENV_INTENSITY = new Map<THREE.MeshStandardMaterial, number>();
let carEnv: THREE.Texture | null = null;
let envScale = 1; // night dims the showroom reflections — the sky is dark

/** Current day/night env scale — glass reads this to size its clearcoat env. */
export function getEnvScale(): number {
  return envScale;
}

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

// ---------- player live-reflection materials ----------
// The player's car trades the shared showroom materials for clones wearing
// the live CubeCamera capture (reflections.ts) — the world actually sweeps
// through the paint. Clones live OUTSIDE carMats on purpose: setCarEnvMap
// (the day/night showroom swap) must never claw them back. Rivals and
// traffic keep the showroom; they're never close enough for it to read.

export const playerSwap = new Map<THREE.Material, THREE.MeshStandardMaterial>();
export const PLAYER_INTENSITY = new Map<THREE.MeshStandardMaterial, number>();
let playerEnv: THREE.Texture | null = null;

/** Declare a shared car material swappable on the player (paint, glass,
 *  lenses — modules owning extras, like panels.ts, register theirs too).
 *  Clones are created eagerly so the daynight sweep always sees them. */
export function registerPlayerSwappable(src: THREE.MeshStandardMaterial, intensity: number): void {
  if (playerSwap.has(src)) return;
  const clone = src.clone() as THREE.MeshStandardMaterial;
  playerSwap.set(src, clone);
  PLAYER_INTENSITY.set(clone, intensity);
  if (playerEnv) {
    clone.envMap = playerEnv;
    clone.envMapIntensity = intensity;
    clone.needsUpdate = true;
  }
}

/** Swap every registered shared material on this subtree for its player
 *  clone — run once over the player's group at build time (panels and
 *  cutouts hang inside it, so one traversal covers the whole car). */
export function adoptPlayerMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => playerSwap.get(m) ?? m);
    } else {
      mesh.material = playerSwap.get(mesh.material as THREE.Material) ?? mesh.material;
    }
  });
}

/** Point the player set at a (live or fallback) environment texture. */
export function setPlayerEnvMap(tex: THREE.Texture): void {
  playerEnv = tex;
  for (const m of playerSwap.values()) {
    m.envMap = tex;
    m.envMapIntensity = PLAYER_INTENSITY.get(m) ?? 0.9;
    m.needsUpdate = true;
  }
}
