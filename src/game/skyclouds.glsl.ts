// Volumetric raymarched cloud layer for the atmospheric sky dome (GLSL chunk).
//
// TECHNIQUE + ATTRIBUTION
// -----------------------
// A faithful technique port of Sebastian Lague's "Clouds" project
// (MIT, Copyright (c) 2019 Sebastian Lague — https://github.com/SebLague/Clouds,
// the companion repo to his "Coding Adventure: Clouds" video):
//   Assets/Scripts/Clouds/Shaders/Clouds.shader
//   Assets/Scripts/Clouds/Shaders/CloudSky.shader
//   Assets/Scripts/Clouds/Noise/Compute/NoiseGenCompute.compute (the Worley field)
// which itself credits Andrew Schneider / Guerrilla's "Nubis" Horizon-Zero-Dawn
// cloud talk (GPU Pro 7 / SIGGRAPH 2015) for the Perlin–Worley density + the
// powder/Beer lighting model.
//
// NOTE ON THE TASK REFERENCE: the prompt named SebLague/Geographical-Adventures,
// but that project ships only the atmospheric-scattering model (already ported in
// skyscatter.glsl.ts) — it has NO volumetric cloud raymarcher. The canonical
// volumetric-cloud technique (3D Worley/Perlin density, sun light-march,
// Beer–Lambert, dual-lobe Henyey–Greenstein, powder/silver-lining) lives in
// SebLague/Clouds, also MIT / Sebastian Lague, and is the source ported here.
//
// PORTED + ADAPTED (HLSL → GLSL):
// Lague's shader is a screen-space post pass that raymarches a finite world-space
// box of cloud and, at every density sample, runs a SECOND short march toward the
// sun (lightmarch) for self-shadowing, compositing col = bg·T + lightEnergy·sunCol.
// We keep that whole structure but adapt it to a background SKY DOME:
//
//   * Container : instead of a finite box at the camera, the clouds live in an
//                 infinite horizontal SLAB between two altitudes (cloudBottom..
//                 cloudTop). The view ray (from a virtual eye just under the slab)
//                 is intersected with the two horizontal planes → entry/exit dist.
//                 Flat-earth slab, so clouds naturally bunch toward the horizon
//                 and open up overhead like real cumulus. Direct port of the
//                 rayBoxDst → entry/exit + while(dst<limit) march, minus depth.
//   * Density   : sampleDensity() ported verbatim in spirit — a base SHAPE fbm
//                 (an inverted-Worley/Perlin-Worley analog, since we have no
//                 precomputed 3D NoiseTex), gated by Lague's height gradient
//                 (gMin/gMax remaps → flat-bottomed, rounded-top cumulus) and
//                 eroded at the edges by a DETAIL Worley fbm weighted by
//                 (1-shape)^3 (his detailErodeWeight → cauliflower billows).
//   * Lighting  : lightmarch() ported — numStepsLight samples toward the sun,
//                 accumulate density, Beer's law exp(-d·lightAbsorptionTowardSun),
//                 floored at darknessThreshold so shadowed cloud never goes black.
//   * Phase     : phase() ported verbatim — dual-lobe HG (forward lobe = the
//                 silver lining toward the sun, back lobe = soft fill) with
//                 Lague's phaseParams bias+scale.
//   * Powder    : Schneider's powder term (1 - exp(-2·density)) multiplies the
//                 in-scatter so the cloud's lit edges get the dark-rim "powder"
//                 sugar look — the cue that sells fluffy cumulus.
//   * Drift     : Lague scrolls the noise sample positions by _Time. Because we
//                 BAKE the field once per tod (see PERFORMANCE below), the bake
//                 itself is static; the sense of motion is instead a slow scroll
//                 of the dome's equirect LOOKUP (uCloudDrift, RENDER clock) —
//                 cheaper than re-marching and still never touches sim state.
//
// COLOUR / TIME-OF-DAY: clouds are lit by the SAME uSunTint·uSunIntensity the
// dome's sun disc uses (warm gold at dusk, zero at night) and filled by an
// ambient sky tint (uCloudTint) toward the zenith, so they inherit the per-tod
// palette for free: bright-white sunlit tops by day, warm rims at dusk, dark
// blue-grey moonlit silhouettes at night. No new palette contract.
//
// BLOOM SAFETY: the composer's bloom trues HDR hotspots near luminance 1.4
// (postfx.ts). lightEnergy·sunCol is capped (CLOUD_LIGHT_MAX) so a sunlit cloud
// reads bright but never blooms into a white blob; only the thin sun-struck
// silver lining is allowed to approach the cap.
//
// PERFORMANCE — PRERENDERED CLOUD BAKE (this is the win):
// The raymarch is HEAVY by nature (view march × per-step sun light-march ×
// procedural 3D noise) AND the clouds are distant sky-dome geometry that barely
// changes frame-to-frame. So instead of marching every frame, we BAKE the whole
// cloud layer ONCE per time-of-day into a high-res EQUIRECTANGULAR texture
// (skyenv.ts cloudBake()): the march runs over a 2048×1024 lat/long panorama,
// many steps, NO jitter → a clean, full-res, correctly-lit cloud field. The live
// sky dome then just SAMPLES that texture by view direction (dirToEquirectUv +
// one texture2D) and composites premultiplied-over — a texture fetch, not a
// raymarch. The bake is camera-independent (clouds are at infinity), so the same
// panorama serves every frame and every camera angle; it is re-baked only when
// the time of day changes (3 states), exactly where skyRig already re-bakes the
// PMREM env. Result: full-res quality (no half-res shimmer, no jitter grain) at
// near-zero per-frame cost.
//
// DRIFT: a static bake would freeze the clouds, so the dome scrolls the equirect
// lookup by a slow azimuth offset (uCloudDrift, RENDER-clock driven) — a free
// sense of motion without re-marching or re-baking. Subtle, like distant cumulus.
//
// The bake march (cloudMarchRGBA) takes its step count as a uniform (uViewSteps/
// uLightSteps) so the same code serves a HIGH-quality bake and any cheap inline
// fallback; the bake path sets uCloudBake=1 to drop the dither jitter entirely.
//
// DETERMINISM: visual-only. uCloudDrift is driven off RENDER time (Game's af.dt),
// never sim time — same pin-safe contract as the sea/grass animation. The bake
// runs on tod change (also render-time), never inside the sim/replay loop.

export const SKY_CLOUDS = /* glsl */ `
// ---- cloud uniforms ----
uniform float uCloudCoverage;  // 0 clear .. 1 overcast (raises density offset)
uniform float uCloudDensity;   // overall density multiplier of the layer
uniform float uCloudHeight;    // tile scale of the noise (bigger = smaller clouds)
uniform vec3  uCloudTint;      // ambient/shadow fill colour (sky-derived)
// Bake-quality knobs: the equirect bake (skyenv.ts) runs HIGH step counts with
// no jitter for a clean field; any inline fallback can run cheaper. uCloudBake=1
// drops the dither jitter (the bake is dense + full-res, so it needs no dither).
uniform float uViewSteps;      // view-march sample count (bake: high)
uniform float uLightSteps;     // sun light-march sample count (bake: high)
uniform float uCloudBake;      // 1 while baking → no jitter, clean march

// ===================== procedural 3D Perlin–Worley noise =====================
// Lague bakes NoiseTex (Perlin-Worley) + DetailNoiseTex (Worley) into 3D
// textures offline (NoiseGenCompute.compute). We have no 3D-texture asset
// pipeline and must add no deps, so we synthesise the equivalent fields in the
// shader: a value-noise fbm for the low-frequency Perlin base, and an inverted
// cellular/Worley fbm for the billowy lumps — the same recipe his compute
// kernel layers (worley A + B·persist + C·persist², inverted).

vec3 cloudHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float cloudHash1(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453123);
}

// gradient-ish value noise (smootherstep interpolation → no grid creases)
float valueNoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = cloudHash1(i + vec3(0.0, 0.0, 0.0));
  float n100 = cloudHash1(i + vec3(1.0, 0.0, 0.0));
  float n010 = cloudHash1(i + vec3(0.0, 1.0, 0.0));
  float n110 = cloudHash1(i + vec3(1.0, 1.0, 0.0));
  float n001 = cloudHash1(i + vec3(0.0, 0.0, 1.0));
  float n101 = cloudHash1(i + vec3(1.0, 0.0, 1.0));
  float n011 = cloudHash1(i + vec3(0.0, 1.0, 1.0));
  float n111 = cloudHash1(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, u.x);
  float nx10 = mix(n010, n110, u.x);
  float nx01 = mix(n001, n101, u.x);
  float nx11 = mix(n011, n111, u.x);
  float nxy0 = mix(nx00, nx10, u.y);
  float nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

// Worley / cellular noise (F1) — distance to the nearest jittered feature point
// in the 3x3x3 neighbourhood. Inverted (1-F1) this gives the puffy lumps that
// are the heart of a believable cumulus, exactly Lague's worley() kernel.
float worley3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float minDist = 1.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        vec3 cell = vec3(float(x), float(y), float(z));
        vec3 point = cell + cloudHash3(i + cell);
        vec3 diff = point - f;
        minDist = min(minDist, dot(diff, diff)); // squared, sqrt once at end
      }
    }
  }
  return sqrt(minDist);
}

// Inverted-Worley fbm — the SHAPE field (puffy, billowy). Layered like Lague's
// noiseSum = A + B·persist + C·persist², normalised, inverted.
float shapeFbm(vec3 p) {
  float persist = 0.6;
  float a = 1.0 - worley3(p);
  float b = 1.0 - worley3(p * 2.03 + 19.7);
  float c = 1.0 - worley3(p * 4.01 + 47.3);
  float sum = a + b * persist + c * persist * persist;
  float norm = 1.0 + persist + persist * persist;
  return sum / norm;
}

// A Perlin (value-noise) fbm — the low-frequency "where clouds are at all"
// envelope, mixed with the Worley shape so blobs aren't uniform across the sky.
float perlinFbm(vec3 p) {
  float v = 0.0, amp = 0.55;
  for (int i = 0; i < 3; i++) {
    v += amp * valueNoise3(p);
    p = p * 2.02 + 11.3;
    amp *= 0.5;
  }
  return v;
}

// Worley fbm for the DETAIL erosion (high-frequency cauliflower edges).
float detailFbm(vec3 p) {
  float persist = 0.55;
  float a = 1.0 - worley3(p);
  float b = 1.0 - worley3(p * 2.07 + 5.2);
  float sum = a + b * persist;
  return sum / (1.0 + persist);
}

// ============================ cloud slab geometry ============================
// The clouds live in a horizontal slab between two altitudes. In the dome's
// flat-earth frame the virtual eye sits at y=0 looking out; rd.y>0 rises into
// the slab. These altitudes are in arbitrary "cloud units" — the slab is thin
// relative to its distance, which is what makes cumulus read as a layer.
const float CLOUD_BOTTOM = 70.0;
const float CLOUD_TOP    = 130.0;

// ===================== Lague sampleDensity (slab-adapted) =====================
// Returns cloud density at a world point inside the slab. Ports his height
// gradient (flat bottom, rounded top), shape × detail erosion, and the coverage
// offset. The xz are the drifting noise coords; y drives the height gradient.
float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / (b - a);
}

float sampleCloudDensity(vec3 pos) {
  // height 0..1 through the slab
  float heightPercent = (pos.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
  // Lague's gMin/gMax height gradient: ramp up off the flat base, taper to a
  // rounded top → the classic cumulus silhouette (low gMin = quick base).
  float gMin = 0.18, gMax = 0.62;
  float heightGradient =
      clamp(remap(heightPercent, 0.0, gMin, 0.0, 1.0), 0.0, 1.0) *
      clamp(remap(heightPercent, 1.0, gMax, 0.0, 1.0), 0.0, 1.0);

  // Static sample positions. The bake is a FROZEN cloud field (clean, full-res);
  // the sense of motion is added cheaply at sample time by the dome scrolling its
  // equirect lookup (uCloudDrift), so the density field itself carries no time
  // term — that also keeps the bake deterministic and re-bakeable on tod change.
  vec3 sp = pos * (0.012 * uCloudHeight);

  // base shape: Worley billows × low-freq Perlin envelope, gated by the height
  float shape = shapeFbm(sp);
  float envelope = smoothstep(0.35, 0.85, perlinFbm(sp * 0.45 + 3.1));
  float shapeFBM = shape * envelope * heightGradient;

  // coverage raises the density offset → more sky fills with cloud (Lague's
  // densityOffset; we drive it from uCloudCoverage so presets stay the knob).
  float densityOffset = mix(-0.42, -0.05, uCloudCoverage);
  float baseShapeDensity = shapeFBM + densityOffset;

  if (baseShapeDensity <= 0.0) return 0.0;

  // detail erosion — high-freq Worley subtracted, weighted (1-shape)^3 so edges
  // erode far more than the dense centre → billowy cauliflower borders.
  vec3 dp = pos * (0.05 * uCloudHeight);
  float detail = detailFbm(dp);
  float oneMinusShape = 1.0 - shape;
  float erodeWeight = oneMinusShape * oneMinusShape * oneMinusShape;
  float density = baseShapeDensity - (1.0 - detail) * erodeWeight * 0.55;

  return max(0.0, density) * uCloudDensity;
}

// ============================ Lague phase() ==================================
// Dual-lobe Henyey–Greenstein: forward lobe (silver lining toward the sun) +
// back lobe (soft fill), biased+scaled so even back-lit cloud keeps a base
// scatter. phaseParams = (forwardG, backG, baseBrightness, lobeScale).
float cloudHG(float a, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(0.0001, 1.0 + g2 - 2.0 * g * a), 1.5));
}
float cloudPhase(float a) {
  // phaseParams ≈ (0.72, 0.30, 0.55, 1.6) — Lague's defaults adapted.
  float blend = 0.5;
  float hgBlend = cloudHG(a, 0.72) * (1.0 - blend) + cloudHG(a, -0.30) * blend;
  return 0.55 + hgBlend * 1.6;
}

// =========================== Lague lightmarch() ==============================
// Proportion of sunlight reaching pos: short march toward the sun, accumulate
// density, Beer's law, floored at darknessThreshold so shadow never goes black.
// The step count is a uniform (uLightSteps) so the bake can run it HIGH for a
// clean, well-shadowed field; MAX_STEPS_LIGHT is the compile-time loop bound.
const int   MAX_STEPS_LIGHT = 16;
const float LIGHT_ABSORPTION_SUN = 1.05;
const float DARKNESS_THRESHOLD = 0.12;

float cloudLightmarch(vec3 pos) {
  // distance from pos to the top of the slab along the sun direction (so the
  // march stays inside the cloud layer; flat-earth, sun above the horizon).
  float dirY = uSunDir.y;
  float dstInside;
  if (dirY > 0.001) {
    dstInside = (CLOUD_TOP - pos.y) / dirY;
  } else {
    dstInside = (pos.y - CLOUD_BOTTOM) / max(0.001, -dirY); // sun below: toward base
  }
  dstInside = min(dstInside, 120.0); // cap the light march length
  int steps = int(uLightSteps);
  float stepSize = dstInside / uLightSteps;
  float totalDensity = 0.0;
  vec3 p = pos + uSunDir * stepSize * 0.5;
  for (int i = 0; i < MAX_STEPS_LIGHT; i++) {
    if (i >= steps) break;
    totalDensity += max(0.0, sampleCloudDensity(p) * stepSize);
    p += uSunDir * stepSize;
  }
  float transmittance = exp(-totalDensity * LIGHT_ABSORPTION_SUN);
  return DARKNESS_THRESHOLD + transmittance * (1.0 - DARKNESS_THRESHOLD);
}

// =========================== main cloud raymarch =============================
// Intersect the view ray with the horizontal slab, march it, and at every
// density sample run the sun light-march + accumulate light energy.
//
// cloudMarchRGBA() is the heavy core: it returns the cloud's PREMULTIPLIED
// colour in .rgb and its coverage alpha in .a, with NO background mixed in —
// so it can be baked once into the equirect panorama (skyenv.ts cloudBake) and
// composited later over the sky. The compositing rule is the standard
// premultiplied-over: out = sky*(1-a) + rgb. sunTrans is the sun's atmospheric
// transmittance at the eye (constant over the dome), passed in so the bake and
// the inline fallback agree on cloud colour.
// The view-march step count is a uniform (uViewSteps); MAX_STEPS_VIEW is the
// compile-time loop bound. The bake runs it HIGH (clean), no jitter needed.
const int   MAX_STEPS_VIEW = 64;
const float LIGHT_ABSORPTION_CLOUD = 0.85;

vec4 cloudMarchRGBA(vec3 rd, vec3 sunTrans) {
  // only march rays that rise into the slab; below the haze line the ocean/dome
  // seam owns the frame and clouds would just smear the horizon.
  if (rd.y < 0.03) return vec4(0.0);

  // virtual eye just below the slab; intersect the two horizontal planes.
  vec3 ro = vec3(0.0, 0.0, 0.0);
  float invDirY = 1.0 / rd.y;
  float dstToBottom = (CLOUD_BOTTOM - ro.y) * invDirY;
  float dstToTop    = (CLOUD_TOP - ro.y) * invDirY;
  float dstToSlab   = min(dstToBottom, dstToTop);
  float dstThrough  = abs(dstToTop - dstToBottom);
  if (dstThrough <= 0.0) return vec4(0.0);

  // fade the band: thin clouds straight overhead (so the zenith stays open) and
  // toward the horizon (atmospheric haze swallows distant cloud). Keeps the
  // march cheap where clouds wouldn't read anyway.
  float bandIn  = smoothstep(0.03, 0.16, rd.y);
  float bandOut = smoothstep(1.0, 0.5, rd.y);
  float band = bandIn * bandOut;
  if (band < 0.001) return vec4(0.0);

  // phase toward the sun (silver lining) — constant along the ray.
  float cosAngle = dot(rd, uSunDir);
  float phaseVal = cloudPhase(cosAngle);

  // march the slab
  int steps = int(uViewSteps);
  float stepSize = dstThrough / uViewSteps;
  // The bake runs a high step count with NO jitter → a clean field (uCloudBake).
  // Any cheap inline fallback dithers the reduced march with a per-direction
  // start jitter (deterministic in view direction — render-time only, no sim).
  float jitter = (uCloudBake > 0.5) ? 0.0 : cloudHash1(rd * 73.1) * stepSize;
  float dstTravelled = jitter;

  float transmittance = 1.0;
  vec3 lightEnergy = vec3(0.0);

  for (int i = 0; i < MAX_STEPS_VIEW; i++) {
    if (i >= steps) break;
    if (dstTravelled >= dstThrough) break;
    vec3 pos = ro + rd * (dstToSlab + dstTravelled);
    float density = sampleCloudDensity(pos);
    if (density > 0.0) {
      float lightTransmittance = cloudLightmarch(pos);
      // Schneider's powder term — dark sugar at the lit edges (fluffy cue).
      float powder = 1.0 - exp(-density * stepSize * 2.0);
      lightEnergy += density * stepSize * transmittance * lightTransmittance * phaseVal * powder;
      transmittance *= exp(-density * stepSize * LIGHT_ABSORPTION_CLOUD);
      if (transmittance < 0.01) break; // Lague's early-out
    }
    dstTravelled += stepSize;
  }

  // fade the cloud's opacity by the band so it eases in/out, not a hard edge.
  float cloudAlpha = (1.0 - transmittance) * band;

  // --- colour ---
  // sun light: warm at dusk via sunTrans, zero at night via uSunIntensity.
  // 0.024 calibrates lightEnergy (small, ~density·steps) to display radiance.
  vec3 sunCol = uSunTint * sunTrans * (uSunIntensity * 0.024);
  vec3 lit = lightEnergy * sunCol;
  // ambient sky fill so shadowed cloud reads as lit-by-sky, not black. Scaled
  // by how lit the layer is overall so shaded undersides stay moody.
  vec3 ambient = uCloudTint * (0.55 + 0.45 * (1.0 - transmittance));
  vec3 cloudCol = lit + ambient * cloudAlpha;

  // NIGHT: no sun, so let clouds read as cool moonlit silhouettes against the
  // star band — a faint cool fill, the rest dark (uNight blends it in).
  cloudCol = mix(cloudCol, uCloudTint * (0.32 + 0.22 * (1.0 - transmittance)) * cloudAlpha, uNight);

  // BLOOM SAFETY — cap cloud radiance below the composer's bloom threshold so a
  // sunlit cloud is bright but never a blooming white blob; only the thin
  // silver lining (phase-boosted) approaches the cap.
  const float CLOUD_LIGHT_MAX = 1.2;
  cloudCol = min(cloudCol, vec3(CLOUD_LIGHT_MAX));

  // premultiplied: cloudCol already carries the layer alpha (it is the light
  // energy that reaches the eye, not a surface colour to be alpha-blended).
  return vec4(cloudCol, cloudAlpha);
}

// Inline full-res fallback: march + composite over skyCol in one call. Kept for
// the PMREM env bake (clouds forced to density 0 there) and any path that
// renders the dome without a baked cloud panorama bound, so the dome shader
// still self-composes correctly in isolation.
vec3 applyClouds(vec3 rd, vec3 skyCol, vec3 sunTrans) {
  vec4 c = cloudMarchRGBA(rd, sunTrans);
  // premultiplied-over: background attenuated by (1-alpha), cloud added.
  return skyCol * (1.0 - c.a) + c.rgb;
}

// ===================== equirectangular direction <-> uv ======================
// The cloud bake stores the panorama as a lat/long (equirectangular) texture:
// u = azimuth around the horizon (0..1 = -π..π), v = elevation (0 = down,
// 1 = up). The dome samples it by view direction; the bake fills it by mapping
// each texel back to a direction and marching that ray. Both sides MUST use this
// one mapping so the lookup lands exactly where the march wrote.
vec2 dirToEquirectUv(vec3 dir) {
  float u = atan(dir.x, dir.z) / (2.0 * 3.14159265) + 0.5;
  float v = asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265 + 0.5;
  return vec2(u, v);
}
vec3 equirectUvToDir(vec2 uv) {
  float az = (uv.x - 0.5) * 2.0 * 3.14159265; // -π..π around the horizon
  float el = (uv.y - 0.5) * 3.14159265;        // -π/2..π/2 elevation
  float ce = cos(el);
  return vec3(sin(az) * ce, sin(el), cos(az) * ce);
}
`;

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
