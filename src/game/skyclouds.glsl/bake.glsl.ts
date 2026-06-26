import { SKY_CLOUDS } from './sky-clouds';

// ============================================================================
// EQUIRECTANGULAR CLOUD BAKE PASS (the perf win)
// ----------------------------------------------------------------------------
// A standalone fullscreen pass that runs the cloud raymarch (cloudMarchRGBA) over
// a full LAT/LONG PANORAMA and writes premultiplied cloud RGBA into a high-res
// HDR target. Each texel maps (via equirectUvToDir) back to a view direction;
// the march fills that direction's cloud colour+alpha ONCE. The live sky dome
// then samples this panorama by view direction (texture2D at dirToEquirectUv) —
// a fetch, not a march. The bake is camera-independent (clouds are at infinity),
// so the same panorama serves every camera angle and every frame; it is re-run
// only when the time of day changes (skyenv.ts cloudBake()).
//
// This pass marches HIGH step counts (uViewSteps/uLightSteps) with uCloudBake=1
// (no jitter) → a clean, full-res, well-shadowed field, the whole point of the
// bake: full quality up front so per-frame cost is just a texture sample.
//
// sunTrans (the sun's atmospheric transmittance at the eye, constant over the
// dome) is the ONE value the march needs from the scattering model; it is
// passed in as uSunTrans (computed once per time-of-day in skyenv.ts), so this
// pass needs no atmosphere code.

export const CLOUD_BAKE_VERT = /* glsl */ `
// Fullscreen quad covering the equirect target; vUv spans 0..1 = the panorama.
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const CLOUD_BAKE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;

// uniforms the cloud march needs from the sky/sun model (mirrors SKY_FRAG)
uniform vec3  uSunDir;
uniform vec3  uSunTint;
uniform float uSunIntensity;
uniform float uNight;
uniform vec3  uSunTrans;        // precomputed sun transmittance at the eye

${SKY_CLOUDS}

void main() {
  // this texel IS a view direction (equirect lat/long) — march it once
  vec3 rd = normalize(equirectUvToDir(vUv));
  // premultiplied cloud RGBA — the dome compositor does sky*(1-a)+rgb
  gl_FragColor = cloudMarchRGBA(rd, uSunTrans);
}
`;
