import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
// the windows. We keep the Burnout clearcoat over the top: clearcoat reflects
// WHITE sky/cube glints over any base colour (metalness would tint reflections
// by albedo → near-black glass reflects nothing), so the sky still sweeps
// across the windscreen.
//
// ROUND 2 — richer refraction/transparency drawing on OverShifted/LiquidGlass
// (MIT, _ref/LiquidGlass). That demo is 2-D screen-space, but its glass recipe
// is fully transferable to a 3-D MeshPhysicalMaterial pane:
//   • LiquidGlass tints the *transmitted* sample by a depth falloff f(dist),
//     not a flat surface colour → here `attenuationColor` + `attenuationDistance`
//     (Beer-Lambert: light is filtered by how far it travels through the glass
//     VOLUME), so the tint reads as real depth instead of a painted-on hue.
//     The albedo `color` is now near-white so the tint comes purely from the
//     volume — a clearer, more see-through pane that still carries colour.
//   • LiquidGlass remaps the background sample outward near the rim (a lens) and
//     adds grain noise → here a gentle generated clearcoat-normal map gives the
//     surface a glassy micro-wobble (the same idea three's normalMap drives into
//     the refraction direction), and `dispersion` splits the refraction by
//     wavelength for the faint prismatic edge LiquidGlass fakes with noise.
//   • LiquidGlass's rim `Glow()` term → here `specularColor`/`specularIntensity`
//     + clearcoat keep a bright Fresnel rim where the pane curves away.
// Refs: _ref/LiquidGlass/assets/shaders/BatchRenderer2D.glsl (LiquidGlass()
//   refraction + f(dist) falloff + rim glow), threejs.org MeshPhysicalMaterial
//   (attenuation = transmitted-light tint over distance; dispersion = chromatic
//   refraction; ior/thickness drive the bend).
//
// COMPOSER SAFETY (pmndrs/postprocessing#431): a HalfFloat composer at
// NoToneMapping can "burn" when an HDR sky is refracted through the pane. We
// keep transmission below 1, thickness small, dispersion gentle, and now lean
// on attenuation (which DARKENS toward the tint with depth) so the pane trends
// toward its tint, never toward blown-out white — verified in CINE at 8/16/28/
// 40 m/s. Single-sided shell, so no DoubleSide transmission feedback (three
// #33060). vertexColors stays on: shatterGlass paints the crack web / frost
// per-vertex, and a frosted vert (bright, near-opaque) swamps the clear pane.

/** Live-tweakable glass look (DebugOverlay drives these). Defaults: a clear,
 *  faintly cool windscreen with depth-tint, a prismatic refraction edge and a
 *  bright Fresnel rim — see-through, but unmistakably glass. */
export interface GlassParams {
  tint: number; // depth-tint = colour transmitted light picks up through the glass volume
  transmission: number; // 0 opaque … 1 fully see-through
  roughness: number; // 0 mirror-clear … blurs both transmission and reflection
  thickness: number; // refraction depth (small — big values "burn" under the composer)
  ior: number; // index of refraction (glass ≈ 1.5)
  dispersion: number; // chromatic refraction (prismatic split) — keep gentle for the composer
  attenuation: number; // depth-tint strength: lower = more strongly tinted (Beer-Lambert distance)
  reflection: number; // clearcoat/env reflection strength (envMapIntensity baseline)
  rim: number; // Fresnel rim-glow strength (specularIntensity) — LiquidGlass's Glow()
  warp: number; // surface micro-wobble (clearcoat-normal map scale) — the "liquid" texture
  frost: number; // how white a frosted (cracked) pane goes (shatterGlass reads this)
}

export const glassParams: GlassParams = {
  tint: 0xafc4d4,
  transmission: 0.9,
  roughness: 0.08,
  thickness: 0.34,
  ior: 1.5,
  dispersion: 1.4,
  attenuation: 1.1,
  reflection: 1.0,
  rim: 1.0,
  warp: 0.5,
  frost: 0.82,
};

// A small tileable value-noise normal map → a gentle glassy surface wobble that
// bends the transmission/reflection a touch off-flat, the 3-D analogue of
// LiquidGlass's grain + lens distortion. Built once at module load; driven onto
// the pane as a clearcoatNormalMap (the clear lacquer ripples, the tint stays
// even). Kept low-frequency and low-amplitude so it never reads as dirt.
function makeGlassWarpMap(): THREE.DataTexture {
  const S = 64;
  const h = new Float32Array(S * S);
  // a couple of octaves of hashed value noise, smoothed
  const hash = (x: number, y: number): number => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      let amp = 1;
      let freq = 1;
      for (let o = 0; o < 3; o++) {
        const fx = (x / S) * freq * 6;
        const fy = (y / S) * freq * 6;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = hash(ix, iy);
        const b = hash(ix + 1, iy);
        const c = hash(ix, iy + 1);
        const d = hash(ix + 1, iy + 1);
        v += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        amp *= 0.5;
        freq *= 2;
      }
      h[y * S + x] = v;
    }
  }
  // height → tangent-space normal via central differences
  const data = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  const strength = 2.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * S + x) * 4;
      data[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.needsUpdate = true;
  return tex;
}

const glassWarpMap = makeGlassWarpMap();

export const glassMat = new THREE.MeshPhysicalMaterial({
  // near-white albedo: the colour now comes from the transmitted VOLUME tint
  // (attenuationColor), so the pane is clearer and the tint reads as depth
  color: 0xeef3f6,
  vertexColors: true,
  roughness: glassParams.roughness,
  metalness: 0,
  transmission: glassParams.transmission,
  thickness: glassParams.thickness,
  ior: glassParams.ior,
  dispersion: glassParams.dispersion,
  attenuationColor: new THREE.Color(glassParams.tint),
  attenuationDistance: attenuationDistanceFor(glassParams.attenuation),
  specularColor: new THREE.Color(0xffffff),
  specularIntensity: glassParams.rim,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
  clearcoatNormalMap: glassWarpMap,
  clearcoatNormalScale: new THREE.Vector2(glassParams.warp, glassParams.warp),
  // the pane is a thin shell; transmission already gives it depth — keep
  // depthWrite so the interior blocks behind sort correctly, but the
  // transmission sampling handles the see-through, not alpha blending
  transparent: false,
});

/** Map the friendly `attenuation` knob (0…2, higher = clearer) to a
 *  Beer-Lambert distance. Small distance = transmitted light is filtered by the
 *  tint over a short path → strongly tinted; large = barely tinted. Clamped so
 *  the slider's full range stays sane. */
function attenuationDistanceFor(attenuation: number): number {
  // 0.2 → ~0.07 (heavy privacy tint), 1.1 → ~0.55, 2.0 → ~1.4 (almost clear)
  return Math.max(0.04, 0.5 * Math.max(0.05, attenuation) ** 1.6 + 0.05);
}

/** Push glassParams onto the live material(s). Re-applied whenever a tweak
 *  changes in the debug overlay; also seeds the player's cloned glass via
 *  setPlayerEnvMap's intensity baseline. Returns the params for chaining. */
export function applyGlassParams(p: Partial<GlassParams> = {}): GlassParams {
  Object.assign(glassParams, p);
  for (const m of glassMats()) {
    // tint now lives in the transmitted volume, not the albedo, so the pane
    // stays clear while the colour reads as depth (LiquidGlass f(dist) idea)
    m.attenuationColor.setHex(glassParams.tint);
    m.attenuationDistance = attenuationDistanceFor(glassParams.attenuation);
    m.transmission = glassParams.transmission;
    m.roughness = glassParams.roughness;
    m.thickness = glassParams.thickness;
    m.ior = glassParams.ior;
    m.dispersion = glassParams.dispersion;
    m.specularIntensity = glassParams.rim;
    m.clearcoatNormalScale.set(glassParams.warp, glassParams.warp);
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

// White base material: the dark tyre / lighter hub / mid-grey spokes all ride
// in per-vertex colours so the wheel's rotation is legible (a flat-dark cylinder
// reads as static no matter how fast it spins). MeshStandard with vertexColors
// multiplies albedo by the vertex colour, so a white base shows them unaltered.
export const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });

const wheelGeoCache = new Map<number, THREE.BufferGeometry>();

/** Procedural road wheel with a contrasting hub + spokes so the BP wheel-roll
 *  (Wheel::UpdateRotation accumulates a real angle every step) is VISIBLE.
 *  A featureless cylinder hides that spin; the hub disc and radial spokes on
 *  both faces make each revolution unmistakable. Per-vertex coloured + merged
 *  into one cached BufferGeometry per radius (keyed by `r`). */
export function wheelGeometry(r: number): THREE.BufferGeometry {
  let g = wheelGeoCache.get(r);
  if (!g) {
    const width = r * 0.76;
    const parts: THREE.BufferGeometry[] = [];

    // tyre: dark rubber cylinder, axis along X (rotateZ), enough radial segs to
    // read as round once the hub/spokes give it a turning reference
    const tyre = new THREE.CylinderGeometry(r, r, width, 16);
    tyre.rotateZ(Math.PI / 2);
    applyUniformColor(tyre, 0x191b1f);
    parts.push(tyre);

    // hub + spokes on BOTH axial faces (±X) so the turning detail shows from
    // either side. The disc is lighter metallic grey; thin radial spoke boxes
    // bridge hub→rim in mid-grey — the high-contrast pattern that makes roll obvious.
    const hubR = r * 0.5;
    for (const sx of [width / 2 + 0.004, -(width / 2 + 0.004)]) {
      const disc = new THREE.CircleGeometry(hubR, 12);
      // CircleGeometry faces +Z; rotate so it faces ±X and sits on the wheel face
      disc.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
      disc.translate(sx, 0, 0);
      applyUniformColor(disc, 0x6a6e74);
      parts.push(disc);

      // 5 radial spokes — thin boxes from just outside the hub to near the rim
      const spokeLen = r - hubR * 0.6;
      const spokeMid = (hubR * 0.6 + r) / 2;
      for (let s = 0; s < 5; s++) {
        const ang = (s / 5) * Math.PI * 2;
        const spoke = new THREE.BoxGeometry(r * 0.06, spokeLen, r * 0.1, 1, 1, 1);
        spoke.translate(0, spokeMid, 0); // push out along +Y before rotating into place
        spoke.rotateX(ang); // spread the spokes around the wheel face (Y/Z plane)
        // No rotateZ: the box is already flat against the ±X face (its thin r*0.06
        // axis is local x), spanning radially hub→rim in the face plane. A rotateZ
        // here would swing the long radial axis out along the axle into a spike.
        spoke.translate(sx, 0, 0);
        applyUniformColor(spoke, 0x4a4d52);
        parts.push(spoke);
      }
    }

    g = mergeGeometries(parts, false)!;
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
