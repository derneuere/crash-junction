// Cloud-layer GLSL chunk: slab geometry, density, phase + sun light-march.
//
// Extracted verbatim from skyclouds.glsl.ts (the SKY_CLOUDS chunk). Holds the
// horizontal cloud slab, Lague's sampleDensity (height gradient × shape × detail
// erosion + coverage offset), the dual-lobe Henyey–Greenstein phase, and the
// lightmarch (Beer's law toward the sun). Concatenated back into SKY_CLOUDS by
// ./sky-clouds.ts in the original order.
export const CLOUD_DENSITY_GLSL = /* glsl */ `
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
`;
