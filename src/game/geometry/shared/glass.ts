import * as THREE from 'three';
import { makeGlassWarpMap } from './glassWarpMap';
import { ENV_INTENSITY, PLAYER_INTENSITY, playerSwap, getEnvScale } from './registry';

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
  glassMat.envMapIntensity = GLASS_ENV_BASE * getEnvScale();
  glassMat.needsUpdate = true;
  const clone = playerSwap.get(glassMat) as THREE.MeshPhysicalMaterial | undefined;
  if (clone) {
    PLAYER_INTENSITY.set(clone, GLASS_PLAYER_BOOST * GLASS_ENV_BASE);
    clone.envMapIntensity = GLASS_PLAYER_BOOST * GLASS_ENV_BASE;
    clone.needsUpdate = true;
  }
}
