// ============================================================================
// SEA — Gerstner-wave vertex shader (GLSL source string).
// ============================================================================
// Split out of sea.ts verbatim as the ShaderMaterial.vertexShader source.
// Displaces the plane by the summed Gerstner bank + a tanh-capped vertex-noise
// lift and writes the analytic surface normal + crest factor for the fragment
// stage. Unchanged from the original inline string. See sea/build.ts for the
// WAVE_COUNT / SEA_MAX_AMP defines this references.

export const SEA_VERTEX_SHADER = /* glsl */ `
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
    `;
