// ============================================================================
// SEA — water fragment shader (GLSL source string).
// ============================================================================
// Split out of sea.ts verbatim as the ShaderMaterial.fragmentShader source.
// Domain-warped multi-scale normal perturbation + Schlick fresnel + PMREM sky
// reflection (textureCubeUV) or analytic fallback + subsurface scattering +
// triple-lobe sun specular + multi-layer anisotropic foam, distance-gated for
// the FAST tier. Unchanged from the original inline string. See sea/build.ts
// for the ENVMAP_TYPE_CUBE_UV / CUBEUV_* / SEA_MAX_AMP defines this references.

export const SEA_FRAGMENT_SHADER = /* glsl */ `
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
    `;
