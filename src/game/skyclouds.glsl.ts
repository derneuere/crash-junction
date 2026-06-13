// Cheap analytic cloud layer for the atmospheric sky dome (GLSL chunk).
//
// TECHNIQUE + ATTRIBUTION
// -----------------------
// The lighting model here is adapted from Sebastian Lague's "Clouds" project
// (MIT, Copyright (c) Sebastian Lague — https://github.com/SebLague/Clouds,
// the companion repo to his "Coding Adventure: Clouds" video):
//   Assets/Scripts/Clouds/Shaders/Clouds.shader
//     - hg() / phase()  : dual-lobe Henyey–Greenstein with bias+scale, the
//                          forward-scatter "silver lining" toward the sun
//     - beer()          : exp(-density) extinction (Beer–Lambert)
//     - lightmarch()    : density toward the light → transmittance, floored at
//                          darknessThreshold so shadowed cloud never goes black
//     - compositing     : col = background*transmittance + lightEnergy*lightCol
// which itself credits Andrew Schneider / Guerrilla's "Nubis" Horizon-Zero-Dawn
// cloud talk (GPU Pro 7) for the Perlin–Worley density + powder/Beer model.
//
// PORTED + ADAPTED (HLSL → GLSL, 3D volumetric → cheap analytic 2D):
// Lague's shader is a full 3D volumetric raymarch — for every view ray it
// marches the cloud box, and at every step runs a SECOND march toward the sun
// (lightmarch) for self-shadowing. That is far too expensive for our FAST tier
// (a sibling agent is simultaneously cutting dusk/night cost), so this is a
// *technique* port, not a code port:
//
//   * Density   : an fbm of cheap value-noise (a Perlin-Worley analog) on the
//                 view ray's projection onto a flat cloud plane, gated by a
//                 coverage threshold → puffy cumulus silhouettes. ~5 noise taps.
//   * Lighting  : the second sun-march collapses to ONE extra density tap a
//                 short step toward the sun, then Beer's law — the analytic
//                 stand-in for lightmarch()'s self-shadow term. Sun-facing
//                 cloud faces brighten; the away faces stay in shadow but never
//                 below darknessThreshold (Lague's floor, kept verbatim).
//   * Phase     : Lague's dual-lobe HG phase() kept verbatim — the forward lobe
//                 lights cloud edges near the sun (the silver lining), the back
//                 lobe a soft fill. Drives the dusk "warm light caught on the
//                 cloud rims" beat.
//   * Drift     : the noise sample coords scroll by uCloudTime (render clock),
//                 so clouds drift without ever touching sim state.
//
// COLOUR / TIME-OF-DAY: clouds are lit by the SAME uSunTint * uSunIntensity the
// dome's sun disc uses and filled by an ambient tint pulled from the sky toward
// the zenith, so they inherit the per-tod palette for free: warm gold rims at
// dusk, dark blue-grey at night (with an optional faint moon fill via uNight).
// No new palette contract — purely a function of the existing sky uniforms.
//
// BLOOM SAFETY: the composer's bloom thresholds true HDR hotspots at luminance
// 1.4 (postfx.ts). Cloud radiance is deliberately capped well under that
// (CLOUD_LIGHT_MAX) so lit clouds read bright but never bloom into a white
// blob; only the thin sun-struck silver lining is allowed to approach it.
//
// DETERMINISM: visual-only. uCloudTime is driven off RENDER time (Game's
// af.dt), never sim time — same pin-safe contract as the sea/grass animation.

export const SKY_CLOUDS = /* glsl */ `
// ---- cloud uniforms ----
uniform float uCloudTime;      // render-clock seconds — scrolls the cloud noise
uniform float uCloudCoverage;  // 0 clear .. 1 overcast (threshold on density)
uniform float uCloudDensity;   // overall opacity multiplier of the layer
uniform float uCloudHeight;    // dome elevation (sin of view.y) where clouds sit
uniform vec3  uCloudTint;      // ambient/shadow fill colour (sky-derived)

// 2D value noise + fbm — a cheap Perlin-Worley analog for the density field.
// Hash is the same family as the star field's; deterministic in sample coords.
float cloudHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // smootherstep weights → no grid creases
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = cloudHash(i + vec2(0.0, 0.0));
  float b = cloudHash(i + vec2(1.0, 0.0));
  float c = cloudHash(i + vec2(0.0, 1.0));
  float d = cloudHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 4-octave fbm — the bulk of the cloud cost (the only real noise work).
float cloudFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  // gentle per-octave rotation breaks up axis-aligned streaking
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += amp * valueNoise(p);
    p = rot * p * 2.02;
    amp *= 0.5;
  }
  return v;
}

// Sample the cloud density field at a sky direction. Returns 0..1 coverage,
// already coverage-thresholded and edge-softened (the cumulus silhouette).
float cloudDensity(vec2 uv) {
  // two scrolling layers at different speeds give parallax-ish motion without
  // a second full fbm: a slow base + a faster detail warp of the sample point.
  vec2 drift = vec2(uCloudTime * 0.006, uCloudTime * 0.0025);
  float base = cloudFbm(uv * 1.6 + drift);
  // domain-warp the detail lookup by the base field → billowy, non-uniform edges
  float detail = cloudFbm(uv * 4.0 - drift * 2.0 + base * 0.5);
  float d = base * 0.72 + detail * 0.28;
  // coverage threshold: higher coverage lowers the cut so more sky fills in.
  // remap so the cut edge is soft (smoothstep) → wispy cumulus borders.
  float cut = mix(0.62, 0.30, uCloudCoverage);
  return smoothstep(cut, cut + 0.22, d);
}

// Dual-lobe Henyey–Greenstein — Lague's phase() verbatim (forward + back lobe,
// biased so even back-lit cloud keeps a base scatter). g>0 = forward.
float cloudHG(float a, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.0001, 1.0 + g2 - 2.0 * g * a), 1.5));
}
float cloudPhase(float a) {
  // forward lobe (silver lining), back lobe (soft fill), blended 50/50, then
  // biased+scaled so the darkest cloud still scatters a little (Lague params).
  float forward = cloudHG(a, 0.72);
  float back = cloudHG(a, -0.30);
  float hgBlend = forward * 0.5 + back * 0.5;
  return 0.55 + hgBlend * 1.6; // phaseParams.z (bias) + .w (scale)
}

// Composite a cloud layer over the already-computed sky radiance.
//   rd        : view direction (unit)
//   skyCol    : sky radiance behind the clouds (modified in place)
//   sunTrans  : sun transmittance at the eye (the dome already computed this) —
//               tints the cloud light warm at low sun for free.
// Caps the brightest cloud at CLOUD_LIGHT_MAX so bloom never sees a white blob.
vec3 applyClouds(vec3 rd, vec3 skyCol, vec3 sunTrans) {
  // clouds only live in a band of the upper sky; fade them out toward the
  // horizon (no cloud below the dome's haze line) and toward straight up.
  float elev = rd.y;
  if (elev < 0.02) return skyCol; // below the haze band — ocean/dome seam
  // project the view ray onto a flat cloud plane at a fixed apparent height:
  // dividing xz by y is the standard "infinite plane" cloud-dome mapping, so
  // clouds bunch toward the horizon and spread overhead like real cumulus.
  float planeY = max(elev, 0.06);
  vec2 uv = rd.xz / planeY;
  uv *= uCloudHeight; // tile scale (smaller = bigger clouds)

  float cover = cloudDensity(uv) * uCloudDensity;
  if (cover < 0.002) return skyCol;

  // fade the band: in near the horizon haze, out toward the zenith so the
  // overhead sky stays open (clouds thin directly above the camera).
  float bandIn = smoothstep(0.02, 0.14, elev);
  float bandOut = smoothstep(0.95, 0.55, elev);
  cover *= bandIn * bandOut;
  if (cover < 0.002) return skyCol;

  // --- lighting: the analytic stand-in for Lague's lightmarch() ---
  // one density tap a short step toward the sun → how shadowed this bit is.
  // (full lightmarch sums many taps; one tap + Beer is the cheap analog.)
  float cosT = dot(rd, uSunDir);
  vec2 sunStep = uSunDir.xz * 0.6; // step the sample toward the sun in plane-uv
  float toSun = cloudDensity(uv + sunStep) * uCloudDensity;
  // Beer's law on the toward-sun density, floored at darknessThreshold so the
  // self-shadowed side never goes pure black (Lague's darknessThreshold).
  float darknessThreshold = 0.18;
  float lightTransmit = darknessThreshold + (1.0 - darknessThreshold) * exp(-toSun * 2.4);
  // forward-scatter silver lining: phase peaks looking toward the sun through
  // thin edges, so rims facing the sun blaze (the dusk money beat).
  float phase = cloudPhase(cosT);

  // cloud light = sun colour (warm at dusk via sunTrans) × shadow × phase,
  // plus an ambient sky fill (uCloudTint) so shaded cloud reads as lit-by-sky,
  // not black. uSunIntensity carries the day/dusk/night sun power (0 at night).
  vec3 sunLight = uSunTint * sunTrans * (uSunIntensity * 0.012) * lightTransmit * phase;
  vec3 ambient = uCloudTint * (0.5 + 0.5 * lightTransmit);
  vec3 cloudCol = sunLight + ambient;

  // NIGHT: no sun, so give the clouds a faint cool moon/skyglow fill and let
  // them read as dark silhouettes against the star band (uNight blends it in).
  cloudCol = mix(cloudCol, uCloudTint * (0.35 + 0.25 * lightTransmit), uNight);

  // BLOOM SAFETY — cap cloud radiance below the composer's 1.4 bloom threshold
  // so a sun-lit cloud is bright but never a blooming white blob. Only the thin
  // silver lining (phase-boosted edges) is allowed to approach the cap.
  const float CLOUD_LIGHT_MAX = 1.25;
  cloudCol = min(cloudCol, vec3(CLOUD_LIGHT_MAX));

  // composite: Lague's col = background*transmittance + cloudCol, where the
  // cloud's own opacity (cover) is the transmittance of the layer.
  return mix(skyCol, cloudCol, cover);
}
`;
