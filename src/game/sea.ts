import * as THREE from 'three';

// THE SEA on GANTRY POINT — a single huge animated water plane.
//
// PURE VISUAL, PIN-SAFE. The physics ground is the flat y=0 plane and this
// mesh carries no collider (same contract as the old static sea). The waves
// are driven by a RENDER clock (accumulated elapsed wall time fed from the
// frame loop), NEVER sim time, so the surface animates freely during replay
// without ever entering the world hash. update() only writes float/colour/
// texture uniforms — it touches no sim state.
//
// ───────────────────────────────────────────────────────────────────────────
// ocean shader adapted from jsfiddle gz76849v
//   (https://jsfiddle.net/gz76849v/ — "Ocean Surface Simulation, Gerstner
//   Waves 3D"). It is the standard real-time ocean recipe: a sum of Gerstner
//   (trochoidal) waves with tanh crest-softening; a 5-layer domain-warped
//   simplex-noise NORMAL perturbation in the fragment shader (the dense
//   micro-ripple that kills the "plastic plane" look); Schlick fresnel;
//   cubemap sky reflection; subsurface scattering; triple-lobe sun specular;
//   and a multi-layer anisotropic foam system. Refs in the original:
//     Gerstner/normal-tangent     GPU Gems 1 ch.1; catlikecoding "Waves"
//     simplex noise               Ashima Arts (Stefan Gustavson / Ian McEwan)
//     fresnel                     Schlick 1994
// ───────────────────────────────────────────────────────────────────────────
//
// WHAT WE ADAPTED for crash-junction's pipeline (vs the standalone fiddle):
//   • REFLECTION SOURCE. The fiddle bakes its own CubeCamera off three's Sky
//     and feeds a `samplerCube`. We instead consume OUR world IBL —
//     scene.environment, the PMREM 2D texture skyenv.ts bakes from the
//     Preetham dome (a sibling SKY agent enriches it). PMREM is NOT a cube
//     map; it is sampled with three's own `textureCubeUV` decoder, so we
//     pull that ShaderChunk in and inject the CUBEUV_* / ENVMAP_TYPE_CUBE_UV
//     defines the renderer would normally add for a standard material. When
//     no env is bound yet we fall back to an analytic sky gradient built from
//     the same time-of-day palette, so the water is never black on frame 0.
//   • TIME OF DAY. uSunDirection / uSunColor and the deep / shallow / fog /
//     sky colours all come from Game's per-tod palette (setTimeOfDay), so the
//     sea reads day / dusk / night in lockstep with the dome. An ambient term
//     darkens + desaturates the body toward moonlit blue at night.
//   • AMPLITUDE BUDGET. The fiddle's waves crest several metres and add 2.2 m
//     of height noise — fine for an open-ocean orbit, but our calm waterline
//     is seaLevel −2.2 right next to a beach, and the SAND agent's foam seam
//     needs the shoreline crest sum kept MODEST (see SEA_MAX_AMPLITUDE). So
//     the Gerstner amplitudes and the vertex noise are scaled WAY down; the
//     dense look is carried by the fragment normal-perturbation (which is
//     amplitude-independent) instead of by tall geometry.
//   • PERFORMANCE. The fiddle runs a 4000×4000 plane at 512×512 and ~25
//     fragment noise fetches everywhere. We keep the 4000 m extent but at
//     256×256 (analytic + fragment normals make near detail independent of
//     tessellation), and DISTANCE-GATE the expensive fragment work: the fine
//     capillary normal layers and the foam layers fade out past the near
//     field, so far water pays only for the cheap base. One mesh, one draw
//     call, no extra passes (a planar-mirror reflection over a 4 km plane
//     would re-render the scene every frame and tank the FAST tier).
//   • FOG. Merged with three's own Fog (fog_* chunks) so the far plane
//     dissolves into the same world fog the dome and track use, instead of
//     the fiddle's standalone exp fog.

/** Wave bank: direction (set per-entry), steepness 0..1, wavelength (m).
 *  Layout mirrors the reference's WAVE_CONFIG [dirX, dirZ, steepness, wavelength]
 *  but the amplitude each wave contributes is steepness/k SCALED DOWN by
 *  AMP_SCALE so the summed crest at the waterline stays within the foam-seam
 *  budget (see SEA_MAX_AMPLITUDE). */
type WaveDef = readonly [dirX: number, dirZ: number, steepness: number, wavelength: number];

// 12 Gerstner waves: three long primary swells, three cross swells, and six
// chop layers — directions spread so the surface never reads as parallel
// corrugations. Taken from the reference; amplitudes are derived, not stored.
const WAVE_CONFIG: WaveDef[] = [
  // Primary ocean swells (dominant energy, long period)
  [1.0, 0.15, 0.10, 140.0],
  [0.80, -0.30, 0.09, 95.0],
  [0.55, 0.60, 0.07, 70.0],
  // Cross swells (directional chaos)
  [-0.20, 1.0, 0.11, 48.0],
  [0.70, -0.55, 0.13, 36.0],
  [-0.85, 0.25, 0.12, 28.0],
  // Medium chop
  [0.92, 0.40, 0.16, 24.0],
  [0.35, -0.88, 0.14, 20.0],
  [-0.45, 0.80, 0.12, 18.0],
  // Short-medium chop (mesh-safe wavelengths ≥ 16 m)
  [0.78, 0.20, 0.14, 17.0],
  [0.20, 0.95, 0.11, 16.5],
  [-0.55, -0.70, 0.10, 16.0],
];

const TWO_PI = Math.PI * 2;

// Each Gerstner wave's intrinsic crest amplitude is steepness/k (k = 2π/λ).
// AMP_SCALE tames the whole bank so the summed shoreline crest lands in the
// modest range the foam seam expects — the long swells (140 m, 95 m) carry the
// most amplitude, so this scale is small. Tuned so Σ amp ≈ 0.24 m and the total
// (with the vertex-noise lift) ≈ 0.29 m — inside the 0.2–0.35 m seam budget.
const AMP_SCALE = 0.027;

// Vertex turbulence lift, metres (tanh-capped). Tiny — the look is carried by
// the fragment normal, not by tall geometry.
const SEA_VNOISE_AMP = 0.05;

/** Theoretical peak crest height above seaLevel at the shoreline = Σ amp +
 *  the small vertex-noise lift. Exported so the SAND→WATER sibling sits its
 *  beach foam just above the crest line. Kept modest (≈0.3 m). */
export const SEA_MAX_AMPLITUDE = (() => {
  let sum = 0;
  for (const [, , steep, wavelength] of WAVE_CONFIG) {
    const k = TWO_PI / wavelength;
    sum += (steep / k) * AMP_SCALE;
  }
  return sum + SEA_VNOISE_AMP; // + the tanh-capped vertex noise lift
})();

/** Handle returned by buildSea: the mesh (already added to the scene) and the
 *  per-frame update hook. update(dtSeconds) advances the wave clock by a
 *  wall-time delta in SECONDS — call it once per RENDERED frame with the
 *  render dt (never the sim dt). Visual only; safe to call during replay. */
export interface Sea {
  mesh: THREE.Mesh;
  /** @param dtSeconds elapsed RENDER time since last frame (seconds) */
  update(dtSeconds: number): void;
  /** Re-tint the reflection/sun to the current time of day. Visual only. */
  setTimeOfDay(p: SeaPalette): void;
}

/** Per-time-of-day look fed from Game. All hex colours. */
export interface SeaPalette {
  /** zenith / sky-dome colour the water mirrors looking up (analytic fallback) */
  sky: number;
  /** horizon / haze colour (Game's fog colour is ideal) */
  horizon: number;
  /** deep water body colour */
  deep: number;
  /** sun/moon disc colour for the glint */
  sun: number;
  /** unit direction toward the sun/moon */
  sunDir: THREE.Vector3;
  /** glint strength (bright by day, dim at night) */
  sunStrength: number;
  /** overall reflection brightness (scene.environmentIntensity is a good feed) */
  envIntensity: number;
  /** light level on the water body: ~1 day, ~0.85 dusk, ~0.35 night */
  ambient: number;
}

/**
 * Build the animated sea plane at `seaLevel` and add it to `scene`.
 *
 * @param scene     the world scene (its .environment / .environmentIntensity
 *                  are read live for the reflection)
 * @param seaLevel  world y of the calm waterline (GANTRY POINT: -2.2)
 */
export function buildSea(scene: THREE.Scene, seaLevel: number): Sea {
  // 4000 m plane (unchanged extent). 256² (~15.6 m cells): analytic Gerstner
  // normals + the fragment normal-perturbation make close detail INDEPENDENT
  // of this grid, so the segment count only has to resolve the longest swell's
  // silhouette near the camera — a light vertex load. The fiddle's 512² is
  // halved here; the realism moved to the fragment normal (see header).
  const geo = new THREE.PlaneGeometry(4000, 4000, 256, 256);

  // Pack the wave bank: vec4(dirX, dirZ, steepness, wavelength) per wave, plus
  // the derived amplitude (steepness/k · AMP_SCALE) so the shader doesn't
  // recompute k twice.
  const N = WAVE_CONFIG.length;
  const waves: THREE.Vector4[] = [];
  const amps: number[] = [];
  for (const [dx, dz, steep, wavelength] of WAVE_CONFIG) {
    waves.push(new THREE.Vector4(dx, dz, steep, wavelength));
    const k = TWO_PI / wavelength;
    amps.push((steep / k) * AMP_SCALE);
  }

  const ownUniforms = {
    uTime: { value: 0 },
    uEnvMap: { value: null as THREE.Texture | null },
    uEnvIntensity: { value: scene.environmentIntensity ?? 1 },
    uHasEnv: { value: 0 },
    // analytic-sky fallback colours (used when no env is bound)
    uSky: { value: new THREE.Color(0xbfd6ff) },
    uHorizon: { value: new THREE.Color(0xb6cde6) },
    uDeep: { value: new THREE.Color(0x06303f) },
    uShallow: { value: new THREE.Color(0x1d8a92) },
    uFoam: { value: new THREE.Color(0xeaf6f6) },
    uSunDir: { value: new THREE.Vector3(0.45, 0.7, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(0xfff3df) },
    uSunStrength: { value: 1.0 },
    // overall light level on the (unlit) water body: ~1 day .. ~0.35 night, so
    // the sea darkens with the world instead of glowing teal under a night sky
    uAmbient: { value: 1.0 },
    uWaves: { value: waves },
    uWaveAmp: { value: amps },
    uCamPos: { value: new THREE.Vector3() },
    uVNoiseAmp: { value: SEA_VNOISE_AMP },
  };
  // fog:true on a raw ShaderMaterial does NOT auto-inject fog uniforms — the
  // fog_* shader chunks reference fogColor/fogNear/fogFar, so merge in three's
  // own fog UniformsLib or the renderer throws reading their .value
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, ownUniforms]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: {
      WAVE_COUNT: N,
      // textureCubeUV needs ENVMAP_TYPE_CUBE_UV + the CUBEUV_* texel/mip sizes
      // the renderer normally injects for a standard material. They depend on
      // the PMREM texture height; filled at first bind via configureEnvDefines
      // and recompiled if the height ever changes (it won't for a 256 PMREM).
      ENVMAP_TYPE_CUBE_UV: '',
      CUBEUV_TEXEL_WIDTH: '0.0013020833333333333',
      CUBEUV_TEXEL_HEIGHT: '0.0009765625',
      CUBEUV_MAX_MIP: '8.0',
    },
    lights: false,
    fog: true, // dissolve the far plane into the same Fog the world uses
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4  uWaves[WAVE_COUNT];   // dirX, dirZ, steepness, wavelength
      uniform float uWaveAmp[WAVE_COUNT]; // derived amplitude (steepness/k·scale)
      uniform float uVNoiseAmp;

      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vCrest;   // 0 trough .. 1 crest, drives foam

      #include <fog_pars_vertex>

      const float PI = 3.14159265359;
      const float GRAVITY = 9.81;

      // One Gerstner wave: displaces p and bends the tangent/binormal so their
      // cross is the analytic surface normal (GPU Gems). Amplitude is passed in
      // (= steepness/k · scale) rather than recomputed, so the geometry stays
      // inside the foam-seam budget. (Reference gerstnerWave, amplitude-tamed.)
      vec3 gerstnerWave(vec4 wave, float amp, vec3 p, inout vec3 tangent, inout vec3 binormal) {
        float wavelength = wave.w;
        float k = 2.0 * PI / wavelength;
        float c = sqrt(GRAVITY / k);          // deep-water phase speed
        vec2 d = normalize(wave.xy);
        float f = k * (dot(d, p.xz) - c * uTime);
        float cosf = cos(f);
        float sinf = sin(f);
        // amp is already (steepness/k)·AMP_SCALE; wa = k·amp is the steepness
        // the tamed wave actually carries (drives the analytic normal).
        float wa = k * amp;

        // analytic tangent (d/dx) and binormal (d/dz) — their cross is N
        tangent += vec3(
          -d.x * d.x * wa * sinf,
           d.x * wa * cosf,
          -d.x * d.y * wa * sinf
        );
        binormal += vec3(
          -d.x * d.y * wa * sinf,
           d.y * wa * cosf,
          -d.y * d.y * wa * sinf
        );

        // trochoid: slide toward the crest horizontally, lift vertically
        return vec3(d.x * amp * cosf, amp * sinf, d.y * amp * cosf);
      }

      // ── Hash value noise for organic vertex chaos (reference vfbm) ──
      float hash31(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float vnoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
              mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
              mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float vfbm(vec3 p) {
        float f = 0.0;
        f += 0.500 * vnoise(p); p *= 2.03;
        f += 0.250 * vnoise(p); p *= 2.01;
        f += 0.125 * vnoise(p); p *= 2.04;
        f += 0.0625 * vnoise(p);
        return f;
      }

      void main() {
        // the mesh is rotated so local XY -> world XZ; displace in world space
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 p = vec3(wp.x, 0.0, wp.z);

        vec3 tangent  = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);
        vec3 disp = vec3(0.0);
        for (int i = 0; i < WAVE_COUNT; i++) {
          disp += gerstnerWave(uWaves[i], uWaveAmp[i], p, tangent, binormal);
        }

        // ── Turbulent vertex noise — breaks the periodic Gerstner uniformity.
        // Scaled to centimetres (uVNoiseAmp) so it stays within the foam seam.
        vec3 nc1 = p * 0.015 + vec3(uTime * 0.35, 0.0, uTime * 0.22);
        float heightNoise = (vfbm(nc1) - 0.5) * 2.0;
        disp.y += heightNoise * uVNoiseAmp;
        // a whisper of horizontal undulation
        vec3 nc2 = p * 0.01 + vec3(-uTime * 0.12, 0.0, uTime * 0.08);
        disp.x += (vfbm(nc2) - 0.5) * uVNoiseAmp * 0.6;
        disp.z += (vfbm(nc2 + vec3(4.7, 1.3, 6.1)) - 0.5) * uVNoiseAmp * 0.6;

        // ── tanh crest-softening: rounds sharp peaks (reference) ──
        float soft = max(SEA_MAX_AMP, 0.05);
        disp.y = tanh(disp.y / soft) * soft;

        wp += disp;
        vWorldPos = wp;
        vNormalW = normalize(cross(binormal, tangent));
        // 0 trough .. 1 crest, drives foam (reference vFoamFactor analog)
        vCrest = clamp(disp.y / max(SEA_MAX_AMP, 1e-3) * 0.5 + 0.5, 0.0, 1.0);

        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform sampler2D uEnvMap;        // PMREM 2D (textureCubeUV), not a cube
      uniform float uEnvIntensity;
      uniform float uHasEnv;            // 1 when a real env is bound
      uniform vec3  uSky;
      uniform vec3  uHorizon;
      uniform vec3  uDeep;
      uniform vec3  uShallow;
      uniform vec3  uFoam;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform float uSunStrength;
      uniform float uAmbient;
      uniform vec3  uCamPos;

      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vCrest;

      #include <common>
      #include <cube_uv_reflection_fragment>  // textureCubeUV (PMREM decode)
      #include <fog_pars_fragment>

      // ─── Simplex Noise (Ashima) — drives the fragment normal + foam ───
      vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
      vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
      float snoise(vec3 v) {
        const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        i = mod289(i);
        vec4 perm = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j = perm - 49.0 * floor(perm * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);
        vec4 x2_ = x_ * ns.x + ns.yyyy;
        vec4 y2_ = y_ * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x2_) - abs(y2_);
        vec4 b0 = vec4(x2_.xy, y2_.xy);
        vec4 b1 = vec4(x2_.zw, y2_.zw);
        vec4 s0 = floor(b0) * 2.0 + 1.0;
        vec4 s1 = floor(b1) * 2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
        m = m * m;
        return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
      }
      float fbm(vec3 p) {
        float f = 0.0;
        f += 0.5000 * snoise(p); p *= 2.01;
        f += 0.2500 * snoise(p); p *= 2.02;
        f += 0.1250 * snoise(p); p *= 2.03;
        f += 0.0625 * snoise(p);
        return f;
      }
      float fresnelSchlick(float cosTheta, float f0) {
        return f0 + (1.0 - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
      }

      // analytic sky fallback (no env bound): zenith->horizon gradient by the
      // reflected ray, warmed toward the sun, from the SAME palette as the dome
      vec3 analyticSky(vec3 dir) {
        float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 base = mix(uHorizon, uSky, pow(up, 0.6));
        float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 8.0);
        base = mix(base, uSunColor, sunAmt * 0.5 * uSunStrength);
        return base;
      }

      void main() {
        vec3 viewDir = normalize(uCamPos - vWorldPos); // surface -> camera
        vec3 N = normalize(vNormalW);
        float dist = length(uCamPos - vWorldPos);

        // distance gate: near pixels get the full 5-layer micro-ripple; far
        // water fades to the cheap base (skips the fine layers entirely). This
        // is the main FAST-tier perf lever (header PERFORMANCE note).
        float nearAmt = 1.0 - smoothstep(60.0, 520.0, dist);

        // ═══ DOMAIN-WARPED MULTI-SCALE NORMAL PERTURBATION (reference) ═══
        // Dense micro-ripple that breaks the plastic look — amplitude-free, so
        // it doesn't touch the foam seam; it only tilts the shading normal.
        float wt = uTime * 0.04;
        vec3 warp = vec3(
          snoise(vWorldPos * 0.02 + vec3(wt, 0.0, wt * 0.7)),
          0.0,
          snoise(vWorldPos * 0.02 + vec3(0.0, wt, -wt * 0.5))
        ) * 3.0;

        float t1 = uTime * 0.22;
        vec3 q1 = vWorldPos * 0.07 + warp * 0.3 + vec3(t1, 0.0, t1 * 0.65);
        float r1x = fbm(q1);
        float r1z = fbm(q1 + vec3(7.3, 1.1, 3.7));

        float t2 = uTime * 0.16;
        vec3 q2 = vWorldPos * 0.18 + warp * 0.2 + vec3(-t2 * 0.5, 0.0, t2);
        float r2x = snoise(q2) * 0.55;
        float r2z = snoise(q2 + vec3(5.2, 0.0, 2.8)) * 0.55;

        // layers 3-5 (fine→capillary→ultra-fine) only where they read: gated
        float fine = nearAmt;
        float r3x = 0.0, r3z = 0.0, r4x = 0.0, r4z = 0.0, r5x = 0.0, r5z = 0.0;
        if (fine > 0.001) {
          float t3 = uTime * 0.35;
          vec3 q3 = vWorldPos * 0.45 + vec3(t3 * 0.4, 0.0, -t3 * 0.25);
          r3x = snoise(q3) * 0.35; r3z = snoise(q3 + vec3(3.1, 2.7, 0.0)) * 0.35;
          float t4 = uTime * 0.5;
          vec3 q4 = vWorldPos * 0.9 + vec3(-t4 * 0.2, 0.0, t4 * 0.15);
          r4x = snoise(q4) * 0.22; r4z = snoise(q4 + vec3(1.9, 0.5, 4.3)) * 0.22;
          float t5 = uTime * 0.7;
          vec3 q5 = vWorldPos * 1.8 + vec3(t5 * 0.15, 0.0, -t5 * 0.1);
          r5x = snoise(q5) * 0.15; r5z = snoise(q5 + vec3(6.4, 3.2, 1.1)) * 0.15;
        }

        float ns = 0.22;
        vec3 noiseOffset = vec3(
          (r1x + r2x + (r3x + r4x + r5x) * fine) * ns,
          1.0,
          (r1z + r2z + (r3z + r4z + r5z) * fine) * ns
        );
        vec3 noiseNormal = normalize(noiseOffset);
        // blend strength tapers with distance so the horizon stays calm/glassy
        N = normalize(mix(N, noiseNormal, 0.45 * mix(0.35, 1.0, nearAmt)));

        float NdotV = max(dot(N, viewDir), 0.001);
        float fresnel = fresnelSchlick(NdotV, 0.02);

        // ── Sky reflection: OUR PMREM env (textureCubeUV) or analytic fallback
        vec3 reflectDir = reflect(-viewDir, N);
        vec3 envColor = analyticSky(reflectDir);
        #ifdef ENVMAP_TYPE_CUBE_UV
        if (uHasEnv > 0.5) {
          // roughness 0.04: a touch of blur hides PMREM seams without going matte
          envColor = textureCubeUV(uEnvMap, reflectDir, 0.04).rgb;
        }
        #endif
        envColor *= uEnvIntensity;

        // ── Water body colour (deep vs shallow by view + distance) ──
        float depthFactor = pow(NdotV, 0.35);
        vec3 waterColor = mix(uDeep, uShallow, depthFactor);
        // deepen toward the horizon where the swell stacks (depth-absorption)
        float far = smoothstep(40.0, 900.0, dist);
        waterColor = mix(waterColor, uDeep, far * 0.6);

        // ── Subsurface scattering (reference): lee-side glow on crests ──
        vec3 sssDir = normalize(uSunDir + N * 0.6);
        float sssDot = pow(max(dot(viewDir, -sssDir), 0.0), 5.0);
        float sssHeight = clamp(vCrest, 0.0, 1.0);
        vec3 sssColor = uShallow * 0.6 * sssDot * sssHeight * 0.7 * uSunStrength;

        // ── Triple-lobe sun specular (tight disc + medium + broad glow) ──
        vec3 halfVec = normalize(uSunDir + viewDir);
        float NdotH = max(dot(N, halfVec), 0.0);
        float specSharp  = pow(NdotH, 512.0) * 4.0;
        float specMedium = pow(NdotH, 128.0) * 0.6;
        float specBroad  = pow(NdotH, 32.0)  * 0.15;
        vec3 specular = uSunColor * (specSharp + specMedium + specBroad) * uSunStrength;

        // ═══ MULTI-LAYER ANISOTROPIC FOAM (reference) ═══ — near field only
        float totalFoam = 0.0;
        vec3 foamColor = uFoam;
        if (nearAmt > 0.001) {
          vec2 worldXZ = vWorldPos.xz;
          vec2 windDir = normalize(vec2(0.85, 0.35));
          vec2 windPerp = vec2(-windDir.y, windDir.x);
          vec2 stretchA = vec2(dot(worldXZ, windDir) * 0.06, dot(worldXZ, windPerp) * 0.22);
          vec2 stretchB = vec2(dot(worldXZ, windDir) * 0.12, dot(worldXZ, windPerp) * 0.35);

          float streak = snoise(vec3(stretchA + uTime * vec2(0.035, 0.015), uTime * 0.04));
          streak = smoothstep(0.30, 0.75, streak);
          vec2 crossDir = normalize(vec2(0.5, 0.85));
          vec2 stretchC = vec2(dot(worldXZ, crossDir) * 0.09, dot(worldXZ, vec2(-crossDir.y, crossDir.x)) * 0.28);
          float streak2 = smoothstep(0.35, 0.8, snoise(vec3(stretchC + uTime * vec2(-0.02, 0.03), uTime * 0.06))) * 0.45;
          float cell1 = abs(snoise(vec3(worldXZ * 0.5, uTime * 0.08)));
          float cell2 = abs(snoise(vec3(worldXZ * 1.0 + 5.3, uTime * 0.12)));
          float cellular = smoothstep(0.03, 0.20, cell1 * cell2);
          float spray = smoothstep(0.60, 0.92, snoise(vec3(stretchB + uTime * vec2(0.05, 0.02), uTime * 0.12))) * 0.3;

          float crest = smoothstep(0.55, 0.95, vCrest); // foam rides crests
          float foamBase = crest * streak * cellular * 0.8;
          foamBase += crest * streak2 * cellular * 0.4;
          foamBase += crest * spray * 0.3;
          float scatterBase = smoothstep(0.65, 0.92, snoise(vec3(worldXZ * 0.06 + uTime * 0.02, 0.5)));
          foamBase += scatterBase * streak * cellular * 0.1;
          totalFoam = clamp(foamBase, 0.0, 1.0) * nearAmt;

          float colorVar = snoise(vec3(worldXZ * 0.6, uTime * 0.04)) * 0.05;
          foamColor = uFoam + vec3(colorVar);
        }

        // ── Combine (reference order) ──
        vec3 color = mix(waterColor + sssColor, envColor, fresnel);
        color += specular;
        float foamEdge = smoothstep(0.0, 0.20, totalFoam);
        color = mix(color, foamColor * mix(0.5, 1.0, uAmbient), foamEdge * 0.45);

        // time of day: darken + desaturate toward the deep tint as light drops
        color = mix(uDeep * 0.6, color, smoothstep(0.0, 1.0, uAmbient));
        color *= mix(0.55, 1.0, uAmbient);

        gl_FragColor = vec4(color, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  // inject the shoreline crest budget as a compile constant both stages share
  material.defines.SEA_MAX_AMP = SEA_MAX_AMPLITUDE.toFixed(5);

  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = seaLevel;
  // displaced crests poke above the calm plane; pad the bound so the frustum
  // culler never pops the sea when the camera tilts down at the near water
  geo.computeBoundingSphere();
  if (geo.boundingSphere) geo.boundingSphere.radius += SEA_MAX_AMPLITUDE + 1;
  mesh.renderOrder = 0; // before the shoreline foam strip (renderOrder 1)
  mesh.receiveShadow = false; // a moving water shader takes no baked shadow
  scene.add(mesh);

  let clock = 0;
  const camPos = uniforms.uCamPos.value as THREE.Vector3;
  let envHeight = -1; // last PMREM height the CUBEUV defines were tuned to

  // Tune the CUBEUV texel/mip defines to the bound PMREM texture's height
  // exactly as three's WebGLProgram does (generateCubeUVSize). Only fires when
  // the height changes (first bind, or a sky-size change), then recompiles.
  function configureEnvDefines(tex: THREE.Texture): void {
    const h = (tex.image?.height ?? (tex as unknown as { source?: { data?: { height?: number } } }).source?.data?.height) ?? 0;
    if (h <= 0 || h === envHeight) return;
    envHeight = h;
    const maxMip = Math.log2(h) - 2;
    const texelHeight = 1.0 / h;
    const texelWidth = 1.0 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16));
    material.defines.CUBEUV_TEXEL_WIDTH = String(texelWidth);
    material.defines.CUBEUV_TEXEL_HEIGHT = String(texelHeight);
    material.defines.CUBEUV_MAX_MIP = maxMip.toFixed(1);
    material.needsUpdate = true; // recompile with the right PMREM dims
  }

  return {
    mesh,
    update(dtSeconds: number): void {
      // accumulate RENDER wall time only — pin-safe, never sim time
      clock += dtSeconds;
      uniforms.uTime.value = clock;
      // consume OUR world IBL live — scene.environment is the PMREM the sky
      // agent bakes; it may be re-baked on a tod change, so re-read each frame
      const env = scene.environment;
      const usable = env && (env as THREE.Texture).isTexture ? (env as THREE.Texture) : null;
      uniforms.uEnvMap.value = usable;
      uniforms.uHasEnv.value = usable ? 1 : 0;
      uniforms.uEnvIntensity.value = scene.environmentIntensity ?? 1;
      if (usable) configureEnvDefines(usable);
      // camera world position for view-dependent fresnel/sparkle
      if (_activeCamera) camPos.setFromMatrixPosition(_activeCamera.matrixWorld);
    },
    setTimeOfDay(p: SeaPalette): void {
      (uniforms.uSky.value as THREE.Color).setHex(p.sky);
      (uniforms.uHorizon.value as THREE.Color).setHex(p.horizon);
      (uniforms.uDeep.value as THREE.Color).setHex(p.deep);
      (uniforms.uSunColor.value as THREE.Color).setHex(p.sun);
      (uniforms.uSunDir.value as THREE.Vector3).copy(p.sunDir).normalize();
      uniforms.uSunStrength.value = p.sunStrength;
      uniforms.uEnvIntensity.value = p.envIntensity;
      uniforms.uAmbient.value = p.ambient;
    },
  };
}

// The sea reads the camera position for view-dependent fresnel/sparkle. Game
// sets the active camera once via setSeaCamera so update() stays a pure
// uniform write with no scene-graph traversal.
let _activeCamera: THREE.Camera | null = null;

/** Tell the sea which camera to read for view-dependent shading. Visual only. */
export function setSeaCamera(cam: THREE.Camera): void {
  _activeCamera = cam;
}
