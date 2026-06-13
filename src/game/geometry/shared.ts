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

// ---------- car glass ----------
// REAL transmission glass, not the old near-black mirror. MeshPhysicalMaterial
// transmission samples the framebuffer behind the pane (three runs a hidden
// transmission pre-pass during renderer.render — which the composer's
// RenderPass triggers too, so it works in both FAST and CINE tiers), so the
// already-built dark interior (models.ts buildInterior) actually shows through
// the windows, TINTED by the material colour. We keep the Burnout clearcoat
// over the top: clearcoat reflects WHITE sky/cube glints over any base colour
// (metalness would tint reflections by albedo → near-black glass reflects
// nothing), so the sky still sweeps across the windscreen. Refs:
//   pixel-capture.com/tutorials/glass-material-threejs-article (transmission
//     1 / roughness 0 / ior 1.5 / thickness for a glass pane),
//   threejs.org MeshPhysicalMaterial (color = tint filter over transmitted
//     light; ior/thickness drive refraction),
//   pmndrs/postprocessing#431 (HalfFloat composer + transmission can "burn"
//     when HDR sky is refracted — so we keep thickness small, transmission
//     below 1 and a real tint so the pane never samples blown-out HDR; the
//     interior, not the sky, is what shows through). Single-sided shell, so
//     no DoubleSide transmission feedback loop (three #33060).
//
// vertexColors stays on: shatterGlass paints the FROST/crack web per-vertex
// (pale, bright), and the frost recolour reads as the pane going opaque-white
// because frosted verts swamp the dark tint. glassMat.color is the live TINT
// knob (clear-ish default; a darker "privacy" preset is one setter call away).

/** Live-tweakable glass look (DebugOverlay drives these). Defaults: a faintly
 *  cool, mostly-clear windscreen that still reflects the sky. */
export interface GlassParams {
  tint: number; // base colour = transmission tint filter
  transmission: number; // 0 opaque … 1 fully see-through
  roughness: number; // 0 mirror-clear … blurs both transmission and reflection
  thickness: number; // refraction depth (small — big values "burn" under the composer)
  ior: number; // index of refraction (glass ≈ 1.5)
  reflection: number; // clearcoat/env reflection strength (envMapIntensity baseline)
  frost: number; // how white a frosted (cracked) pane goes (shatterGlass reads this)
}

export const glassParams: GlassParams = {
  tint: 0xafc4d4,
  transmission: 0.82,
  roughness: 0.12,
  thickness: 0.18,
  ior: 1.45,
  reflection: 1.0,
  frost: 0.82,
};

export const glassMat = new THREE.MeshPhysicalMaterial({
  color: glassParams.tint,
  vertexColors: true,
  roughness: glassParams.roughness,
  metalness: 0,
  transmission: glassParams.transmission,
  thickness: glassParams.thickness,
  ior: glassParams.ior,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
  // the pane is a thin shell; transmission already gives it depth — keep
  // depthWrite so the interior blocks behind sort correctly, but the
  // transmission sampling handles the see-through, not alpha blending
  transparent: false,
});

/** Push glassParams onto the live material(s). Re-applied whenever a tweak
 *  changes in the debug overlay; also seeds the player's cloned glass via
 *  setPlayerEnvMap's intensity baseline. Returns the params for chaining. */
export function applyGlassParams(p: Partial<GlassParams> = {}): GlassParams {
  Object.assign(glassParams, p);
  for (const m of glassMats()) {
    m.color.setHex(glassParams.tint);
    m.transmission = glassParams.transmission;
    m.roughness = glassParams.roughness;
    m.thickness = glassParams.thickness;
    m.ior = glassParams.ior;
    m.needsUpdate = true;
  }
  // reflection strength rides the env-map intensity baseline for glass, scaled
  // by the day/night env scale already in effect
  GLASS_ENV_BASE = glassParams.reflection;
  refreshGlassEnvIntensity();
  return glassParams;
}

/** Every glass material instance the tweaker should drive: the shared showroom
 *  one (rivals/traffic) plus the player's live-reflection clone, if it exists. */
function glassMats(): THREE.MeshPhysicalMaterial[] {
  const out: THREE.MeshPhysicalMaterial[] = [glassMat];
  const clone = playerSwap.get(glassMat) as THREE.MeshPhysicalMaterial | undefined;
  if (clone) out.push(clone);
  return out;
}

// glass reflection (clearcoat env) strength = base × the live day/night scale.
// The player's live-cube clone runs a notch hotter (the live world is dimmer
// than the showroom strip — same convention as registerPlayerSwappable below).
const GLASS_PLAYER_BOOST = 1.2;
let GLASS_ENV_BASE = glassParams.reflection;
function refreshGlassEnvIntensity(): void {
  // keep the day/night swap (setCarEnvMap / applyCarEnvScale) in sync: those
  // read ENV_INTENSITY, so writing the base here means a later tod swap picks
  // up the tweaked reflection strength too
  ENV_INTENSITY.set(glassMat, GLASS_ENV_BASE);
  glassMat.envMapIntensity = GLASS_ENV_BASE * envScale;
  glassMat.needsUpdate = true;
  const clone = playerSwap.get(glassMat) as THREE.MeshPhysicalMaterial | undefined;
  if (clone) {
    PLAYER_INTENSITY.set(clone, GLASS_PLAYER_BOOST * GLASS_ENV_BASE);
    clone.envMapIntensity = GLASS_PLAYER_BOOST * GLASS_ENV_BASE;
    clone.needsUpdate = true;
  }
}

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

// ---------- player live-reflection materials ----------
// The player's car trades the shared showroom materials for clones wearing
// the live CubeCamera capture (reflections.ts) — the world actually sweeps
// through the paint. Clones live OUTSIDE carMats on purpose: setCarEnvMap
// (the day/night showroom swap) must never claw them back. Rivals and
// traffic keep the showroom; they're never close enough for it to read.

const playerSwap = new Map<THREE.Material, THREE.MeshStandardMaterial>();
const PLAYER_INTENSITY = new Map<THREE.MeshStandardMaterial, number>();
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

// the live world is dimmer than the showroom's hot strip — run the player
// set a notch hotter than the rivals' tuned values
registerPlayerSwappable(hullMat, 0.9);
registerPlayerSwappable(glassMat, 1.2);
registerPlayerSwappable(headlightMat, 1.1);
registerPlayerSwappable(taillightMat, 1.1);

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
