// Cloud-layer GLSL chunk: main raymarch, inline composite + equirect mapping.
//
// Extracted verbatim from skyclouds.glsl.ts (the SKY_CLOUDS chunk). Holds the
// heavy cloudMarchRGBA core (view march + per-step sun light-march, premultiplied
// RGBA output), the applyClouds inline-composite fallback, and the equirectangular
// direction<->uv mapping shared by the bake and the dome lookup. Concatenated back
// into SKY_CLOUDS by ./sky-clouds.ts in the original order.
export const CLOUD_MARCH_GLSL = /* glsl */ `
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
