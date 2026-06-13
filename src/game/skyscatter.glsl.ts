import { SKY_CLOUDS } from './skyclouds.glsl';

// Atmospheric-scattering sky shader (GLSL, ported to three.js).
//
// TECHNIQUE + ATTRIBUTION
// -----------------------
// The Rayleigh+Mie+ozone raymarch below is adapted from Sebastian Lague's
// "Geographical-Adventures" (MIT, Copyright (c) 2024 Sebastian Lague):
//   Assets/Post Processing/Effects/Atmosphere/Shader Common/AtmosphereCommon.hlsl
//   Assets/Post Processing/Effects/Atmosphere/LUT Compute/SkyRender.compute
//   Assets/Post Processing/Effects/Atmosphere/Shaders/DrawSky.shader
// which itself credits Sébastien Hillaire's EGSR 2020 sky model
// (https://sebh.github.io/publications/egsr2020.pdf) and the shadertoy
// reference https://www.shadertoy.com/view/slSXRW.
//
// Ported HLSL→GLSL and adapted for a single-pass three.js sky dome (no LUTs —
// the dome is cheap to raymarch once per frame and is re-baked into a PMREM
// env only on time-of-day change). The sun-disc-with-bloom, the analytic
// scattering integral, the getScatteringValues density model, the
// getSunTransmittance inner integral, and the raySphere intersection are all
// direct adaptations of Lague's HLSL. Original work here: the night-sky tint /
// star field, the horizon haze lift, the per-time-of-day uniform plumbing, and
// the dome vertex setup. MIT-compatible — see report for attribution.

export const SKY_VERT = /* glsl */ `
// World-space ray from the camera through this dome vertex. The dome is a big
// inverted sphere centred on the camera path; we only need the *direction*.
varying vec3 vWorldDir;
void main() {
  // local position of the unit dome, scaled — direction is position-relative
  // to the dome centre, which we treat as the camera (background dome).
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldDir = normalize( world.xyz - cameraPosition );
  // pin to the far plane: w == z so perspective divide leaves z/w == 1
  vec4 clip = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position = clip.xyww;
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;
varying vec3 vWorldDir;

uniform vec3 uSunDir;        // unit, toward the sun
uniform vec3 uRayleighCoeff; // per-channel Rayleigh scattering coefficient
uniform float uMieCoeff;     // Mie scattering coefficient
uniform float uMieG;         // Mie phase asymmetry (forward scatter)
uniform vec3 uOzoneCoeff;    // ozone absorption (Chappuis band, warms sunsets)
uniform float uExposure;     // radiance → display scale
uniform float uSunDiscSize;  // angular radius of the disc, degrees
uniform float uSunIntensity; // brightness of the disc + bloom
uniform vec3 uSunTint;       // disc/glow colour bias (warm at dusk)
uniform vec3 uGroundColor;   // colour seen looking below the horizon
uniform float uNight;        // 0 day .. 1 night — blends in stars + night tint
uniform vec3 uNightTint;     // deep scattered-blue night sky colour
uniform float uStarStrength; // star field brightness (night only)

// HALF-RES CLOUD BUFFER (skyenv.ts): premultiplied cloud RGBA, filled by the
// cloud pass each frame. When uUseCloudBuffer > 0.5 the dome SAMPLES this (cheap
// bilinear upscale) instead of running the per-pixel raymarch inline. The bake
// path (and any buffer-less render) leaves it 0 and falls back to applyClouds().
uniform sampler2D uCloudBuffer;
uniform float uUseCloudBuffer; // 1 = sample the half-res buffer, 0 = inline march
uniform vec2 uResolution;      // full-res target size, for the screen-space lookup

const float PI = 3.14159265359;

// --- planet geometry (kilometres, Hillaire/Lague scale) ---
const float groundRadius = 6360.0;
const float atmoRadius    = 6460.0;
const float atmoThickness = 100.0;
// density falloff heights (km) for Rayleigh / Mie exponential atmospheres
const float rayleighScaleH = 8.0;
const float mieScaleH       = 1.2;
// ozone tent layer, centred ~25 km up, ~15 km half-width (Bruneton)
const float ozoneCentre  = 25.0;
const float ozoneWidth   = 15.0;

// ray–sphere: returns (distToNear, distThrough); miss => through == 0
vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, 0.0);
  float s = sqrt(d);
  float near = max(0.0, -b - s);
  float far  = -b + s;
  if (far < 0.0) return vec2(1e9, 0.0);
  return vec2(near, far - near);
}

// densities + extinction at a point (height above ground), Lague's
// getScatteringValues adapted to physical scale-height atmospheres.
void getScattering(vec3 p, out vec3 rayleighS, out float mieS, out vec3 extinction) {
  float h = length(p) - groundRadius;
  float rDensity = exp(-h / rayleighScaleH);
  float mDensity = exp(-h / mieScaleH);
  // ozone: triangular tent, zero outside the band
  float oDensity = max(0.0, 1.0 - abs(h - ozoneCentre) / ozoneWidth);

  rayleighS = uRayleighCoeff * rDensity;
  mieS = uMieCoeff * mDensity;
  // Mie also absorbs (~10% of scatter); ozone is pure absorption.
  float mieAbsorption = uMieCoeff * 0.1 * mDensity;
  extinction = rayleighS + mieS + mieAbsorption + uOzoneCoeff * oDensity;
}

float rayleighPhase(float c) {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Cornette–Shanks / HG Mie phase, g = forward asymmetry (Lague getMiePhase)
float miePhase(float c, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + c * c);
  float denom = (2.0 + g2) * pow(max(0.0001, 1.0 + g2 - 2.0 * g * c), 1.5);
  return 3.0 / (8.0 * PI) * num / denom;
}

// inner integral: how much sunlight survives to a sample point (Lague
// getSunTransmittance), short march toward the sun.
vec3 sunTransmittance(vec3 p) {
  vec2 hit = raySphere(p, uSunDir, atmoRadius);
  float len = hit.y;
  const int STEPS = 8;
  float ds = len / float(STEPS);
  vec3 optical = vec3(0.0);
  vec3 pos = p + uSunDir * ds * 0.5;
  for (int i = 0; i < STEPS; i++) {
    vec3 rs; float ms; vec3 ext;
    getScattering(pos, rs, ms, ext);
    optical += ext * ds;
    pos += uSunDir * ds;
  }
  return exp(-optical);
}

// primary raymarch through the atmosphere along the view ray (Lague raymarch,
// analytic per-step scattering integral that converges at low step counts).
vec3 raymarchSky(vec3 ro, vec3 rd) {
  vec2 atmoHit = raySphere(ro, rd, atmoRadius);
  if (atmoHit.y <= 0.0) return vec3(0.0);
  // if the view ray hits the ground, stop the march there
  vec2 groundHit = raySphere(ro, rd, groundRadius);
  float marchLen = atmoHit.y;
  if (groundHit.y > 0.0 && groundHit.x > 0.0) marchLen = min(marchLen, groundHit.x);

  const int STEPS = 24;
  float ds = marchLen / float(STEPS);

  float cosT = dot(rd, uSunDir);
  float phR = rayleighPhase(cosT);
  float phM = miePhase(cosT, uMieG);

  vec3 luminance = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  vec3 pos = ro + rd * (atmoHit.x + ds * 0.5);

  for (int i = 0; i < STEPS; i++) {
    vec3 rayleighS; float mieS; vec3 extinction;
    getScattering(pos, rayleighS, mieS, extinction);

    vec3 sampleT = exp(-extinction * ds);
    vec3 sunT = sunTransmittance(pos);

    vec3 inScatter = (rayleighS * phR + mieS * phM) * sunT;
    // analytic integral of in-scatter over the step (Lague: converges faster
    // than the naive inScatter*transmittance*ds at low step counts)
    vec3 integral = (inScatter - inScatter * sampleT) / max(vec3(0.0001), extinction);
    luminance += integral * transmittance;
    transmittance *= sampleT;

    pos += rd * ds;
  }
  return luminance;
}

// crisp sun disc + gaussian/inverse bloom halo (Lague sunDiscWithBloom)
float sunDisc(vec3 rd) {
  float solidAngle = uSunDiscSize * PI / 180.0;
  float minCos = cos(solidAngle);
  float c = dot(rd, uSunDir);
  if (c >= minCos) return 1.0;
  float offset = minCos - c;
  float gauss = exp(-offset * 4000.0) * 0.5;
  float inv = 1.0 / (0.02 + offset * 300.0) * 0.012;
  return gauss + inv;
}

${SKY_CLOUDS}

// cheap hash-based star field — only meaningful at night, gated by uStarStrength.
// Deterministic in the *view direction* (render-time only, no sim state).
float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
vec3 hash3(vec3 p) {
  return vec3(hash(p), hash(p + 11.3), hash(p + 27.7));
}
// Soft round star points: quantise the sky direction into cells, place one
// candidate star at a random sub-cell position, and shade it with a smooth
// radial falloff (not a hard quantised pixel). Sparse + size/brightness varied.
float stars(vec3 rd) {
  const float DENSITY = 110.0; // cells per unit direction (bigger = denser grid)
  vec3 scaled = rd * DENSITY;
  vec3 cell = floor(scaled);
  vec3 f = fract(scaled);
  float occupied = hash(cell);
  if (occupied < 0.97) return 0.0; // ~3% of cells host a star
  vec3 rnd = hash3(cell + 5.1);
  // star centre jittered within the cell; distance gives a soft round point
  vec2 centre = rnd.xy * 0.6 + 0.2;
  float d = length(f.xy - centre);
  float radius = 0.09 + rnd.z * 0.06; // slight size variation (kept >1px to
                                      // avoid composer chromatic fringing)
  float point = smoothstep(radius, 0.0, d);
  float bright = 0.5 + 0.5 * hash(cell + 9.4); // twinkle/brightness variation
  return point * bright;
}

void main() {
  vec3 rd = normalize(vWorldDir);
  // camera sits just above the ground surface, looking out
  vec3 ro = vec3(0.0, groundRadius + 0.2, 0.0);

  vec3 sky = raymarchSky(ro, rd) * uExposure;

  // sun disc + its transmittance-tinted glow, scaled by the day/night sun power
  vec3 sunTrans = sunTransmittance(ro + rd * 0.0);
  float disc = sunDisc(rd);
  sky += disc * sunTrans * uSunTint * uSunIntensity;

  // CLOUD LAYER: composite drifting cumulus over the sky+sun, lit by the same
  // sun colour/transmittance and an ambient sky fill. Clouds catch warm dusk
  // light, go dark at night, and never bloom (capped). See skyclouds.glsl.ts.
  // Applied AFTER the sun disc so a cloud passing the sun dims its glow, and
  // BEFORE the horizon/night tint so the night blend darkens clouds too.
  //
  // PERF: the heavy raymarch runs in a HALF-RES pass (skyenv.ts); here the dome
  // just samples that premultiplied RGBA buffer (bilinear upscale — invisible on
  // low-frequency clouds) and composites sky*(1-a)+rgb. The inline applyClouds()
  // fallback runs only when no buffer is bound (the PMREM bake, which zeroes
  // cloud density anyway).
  if (uUseCloudBuffer > 0.5) {
    vec4 c = texture2D(uCloudBuffer, gl_FragCoord.xy / uResolution);
    sky = sky * (1.0 - c.a) + c.rgb;
  } else {
    sky = applyClouds(rd, sky, sunTrans);
  }

  // Looking below the horizon line: the ocean covers this in-game, but the
  // dome can peek through at the seam, so keep the bright horizon haze right
  // at the line and only ease toward a muted ground tone well below it. A
  // gentle, narrow fade (not a hard band) so no brown stripe sits above the
  // sea — the haze reads as continuous atmosphere down to the waterline.
  float belowHorizon = smoothstep(0.0, -0.08, rd.y);
  sky = mix(sky, uGroundColor, belowHorizon * 0.85);

  // NIGHT: lift toward a deep scattered-blue tint and sprinkle stars high up.
  // The raymarch already goes near-black when the sun is below the horizon;
  // uNightTint gives the night dome believable colour instead of dead black.
  if (uNight > 0.001) {
    vec3 night = uNightTint;
    // stars only above the haze band, faded near the horizon
    float starMask = stars(rd) * uStarStrength * smoothstep(0.04, 0.25, rd.y);
    night += vec3(starMask);
    sky = mix(sky, max(sky, night), uNight);
  }

  // Output raw linear radiance (no tone map / no sRGB encode here): the
  // visible dome is tone-mapped downstream by the renderer's ACES (fast tier)
  // or the composer (cine tier), and the PMREM bake wants exactly this linear
  // HDR signal for scene.environment. Same contract as three's Sky example,
  // which the previous SkyRig relied on.
  gl_FragColor = vec4(max(vec3(0.0), sky), 1.0);
}
`;
