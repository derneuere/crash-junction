// ============================================================================
// GRASS — async asset load (grassLODs.glb + alpha/noise textures) + fallback.
// ============================================================================
//
// ── ASYNC ASSET LOAD, SYNC PLACEMENT (the determinism contract) ──────────────
//   buildGrass() stays SYNCHRONOUS: it does the (deterministic-hash) placement
//   and creates the per-tile InstancedMeshes IMMEDIATELY, with a tiny fallback
//   geometry + the textures un-set. The GLB + the two textures load in the
//   background; when they land we SWAP the real LOD geometry onto every tile
//   mesh and set the texture uniforms. Nothing about the load order touches sim
//   state — placement, matrices and the world hash are all decided synchronously
//   at build time; the async swap only changes what's DRAWN. Pin-safe.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ── GRASS LOD GEOMETRY (FluffyGrass grassLODs.glb) ──────────────────────────

/** The three blade-clump LODs from grassLODs.glb, pre-conditioned for use:
 *  re-origined so the clump base sits at y=0 (the GLB authored it ~centred),
 *  each scaled to a UNIT clump (~1 m tall) so the per-instance matrix can size
 *  it in metres. Filled asynchronously after the GLB lands. */
export interface GrassLODs {
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry;
  lod2: THREE.BufferGeometry;
}

const GRASS_GLB_URL = '/grass/grassLODs.glb';
const GRASS_ALPHA_URL = '/grass/grass-alpha.jpeg';
const GRASS_NOISE_URL = '/grass/perlinnoise.webp';

/** Normalise a raw LOD geometry from the GLB: drop the tiny negative-y root
 *  overhang so the clump base sits at y≈0, then scale so the clump is ~1 m tall
 *  (a UNIT clump the instance matrix sizes in metres). Returns a fresh geometry;
 *  the source is left untouched. */
function conditionLOD(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = src.clone();
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const minY = bb.min.y;
  const height = bb.max.y - bb.min.y || 1;
  // lift base to 0, then normalise height to 1
  geo.translate(0, -minY, 0);
  geo.scale(1 / height, 1 / height, 1 / height);
  geo.computeBoundingSphere();
  return geo;
}

/** Promise of the conditioned LODs + textures, shared across every buildGrass
 *  call (one fetch+parse for the whole app). Kicked off lazily on first build. */
let assetsPromise: Promise<{ lods: GrassLODs; alpha: THREE.Texture; noise: THREE.Texture }> | null = null;

export function loadGrassAssets(): Promise<{ lods: GrassLODs; alpha: THREE.Texture; noise: THREE.Texture }> {
  if (assetsPromise) return assetsPromise;
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const glbP = loader.loadAsync(GRASS_GLB_URL).then((gltf) => {
    const byNode: Record<string, THREE.BufferGeometry> = {};
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) byNode[mesh.name] = mesh.geometry as THREE.BufferGeometry;
    });
    // node names in the GLB: Grass.LOD00 / LOD01 / LOD02. Fall back to the
    // three meshes in vertex-count order if the names ever change.
    const pick = (frag: string): THREE.BufferGeometry | undefined =>
      Object.entries(byNode).find(([n]) => n.includes(frag))?.[1];
    let g0 = pick('LOD00');
    let g1 = pick('LOD01');
    let g2 = pick('LOD02');
    if (!g0 || !g1 || !g2) {
      const sorted = Object.values(byNode).sort(
        (a, b) => (b.getAttribute('position')?.count ?? 0) - (a.getAttribute('position')?.count ?? 0),
      );
      g0 = g0 ?? sorted[0];
      g1 = g1 ?? sorted[1] ?? sorted[0];
      g2 = g2 ?? sorted[2] ?? sorted[1] ?? sorted[0];
    }
    return {
      lod0: conditionLOD(g0),
      lod1: conditionLOD(g1),
      lod2: conditionLOD(g2),
    } satisfies GrassLODs;
  });
  const alphaP = texLoader.loadAsync(GRASS_ALPHA_URL).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace; // it's a mask, not colour
    return t;
  });
  const noiseP = texLoader.loadAsync(GRASS_NOISE_URL).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  });
  assetsPromise = Promise.all([glbP, alphaP, noiseP]).then(([lods, alpha, noise]) => ({ lods, alpha, noise }));
  return assetsPromise;
}

/** A tiny stand-in clump used for the brief window between buildGrass() (which
 *  must add the meshes synchronously) and the GLB landing. It's a single tapered
 *  cross-strip — visible as a sliver of green so the field is never empty, then
 *  swapped for the real LOD geometry. Unit height, base at y=0. */
export function makeFallbackGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const SEG = 3;
  for (let b = 0; b < 2; b++) {
    const ang = (b / 2) * Math.PI;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const v = s / SEG;
      const w = 0.08 * (1 - v);
      pos.push(-sa * w, v, ca * w, sa * w, v, -ca * w);
      uv.push(0, v, 1, v);
      nrm.push(ca, 0.2, sa, ca, 0.2, sa);
    }
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
