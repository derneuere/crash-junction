// Cloud-layer GLSL chunk: declarations + procedural 3D noise.
//
// Extracted verbatim from skyclouds.glsl.ts (the SKY_CLOUDS chunk). Holds the
// cloud uniforms and the synthesised Perlin–Worley noise field (value-noise fbm
// + inverted-cellular/Worley fbm) that stand in for Lague's offline 3D NoiseTex.
// Concatenated back into SKY_CLOUDS by ./sky-clouds.ts in the original order.
export const CLOUD_NOISE_GLSL = /* glsl */ `
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
`;
