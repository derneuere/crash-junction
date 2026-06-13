import * as THREE from 'three';

// THE SEA on GANTRY POINT — a single huge animated water plane.
//
// PURE VISUAL, PIN-SAFE. The physics ground is the flat y=0 plane and this
// mesh carries no collider (same contract as the old static sea). The waves
// are driven by a RENDER clock (accumulated elapsed wall time fed from the
// frame loop), NEVER sim time, so the surface animates freely during replay
// without ever entering the world hash. update() only writes float/colour
// uniforms — it touches no sim state.
//
// TECHNIQUE — "realistic but fast" stylised ocean, the standard real-time
// recipe (no extra render passes, no normal-map texture fetch):
//   1. A small SUM OF GERSTNER (trochoidal) WAVES displaces the vertices in
//      the vertex shader. Gerstner > plain sines: as a crest approaches, a
//      point also slides horizontally toward the crest, so the wave sharpens
//      into a believable rolling swell instead of a smooth hump. Steepness Q
//      controls crest sharpness (GPU Gems 1, ch.1; catlikecoding "Waves").
//      Refs: https://catlikecoding.com/unity/tutorials/flow/waves/
//            https://gameidea.org/2023/12/01/3d-ocean-shader-using-gerstner-waves/
//   2. The wave NORMAL is computed ANALYTICALLY in the vertex shader from the
//      same Gerstner derivatives (cross of the per-vertex binormal & tangent),
//      so close water stays crisp regardless of how coarsely the giant plane
//      is tessellated — no dependence on segment density, no normal map.
//      Ref (GPU Gems normal/tangent/binormal):
//            https://gist.github.com/yorung/5f72b5bff2082cd15f1722cd2f679dfa
//   3. The fragment shader does a FRESNEL depth-colour gradient: steep view
//      (looking straight down) shows the deep teal body colour; grazing view
//      toward the horizon goes bright and sky-tinted — the optical tell that
//      sells a flat-ish sea as water (Schlick fresnel approximation).
//   4. SKY REFLECTION is an ANALYTIC sky gradient (zenith->horizon) blended
//      toward the sun, with colours fed live from Game's time-of-day palette
//      (sky colour, fog/horizon colour, sun colour). This HARMONIZES with the
//      Preetham sky + PMREM env at day / dusk / night WITHOUT a second
//      reflection camera and without a single texture fetch — the same TOD
//      palette that tints the dome tints the water's mirror. (A planar mirror
//      pass like three's Water object would re-render the whole scene every
//      frame over a 4000 m plane and tank the FAST tier; a PMREM cube fetch
//      works too but the analytic gradient is cheaper and matches the
//      stylised look.)
//   5. Animated SPARKLE + WHITECAPS: a sun-aligned specular glint that
//      twinkles via a moving hash, plus a foam tint crawling along the wave
//      crests (driven by the analytic wave height) — moving life across the
//      whole expanse.
//
// PERFORMANCE: one mesh, one draw call, one ShaderMaterial. No envMap fetch,
// no extra passes. A handful of Gerstner waves on a 256² grid is a light
// vertex load; the fragment cost is a fresnel + a few mixes. Smooth on FAST.

/** Wave bank: direction (unit, set in code), wavelength (m), steepness 0..1,
 *  amplitude (m). Amplitudes are tuned so the SUM at the waterline stays
 *  modest (~0.21 m) — see SEA_MAX_AMPLITUDE / the shoreline seam contract. */
interface WaveDef {
  dir: [number, number];
  wavelength: number;
  steepness: number;
  amplitude: number;
}

// A few crossing swells: two long primary rollers from off the headland plus
// shorter chop layered across them. Directions are deliberately spread so the
// surface never reads as parallel corrugations.
const WAVES: WaveDef[] = [
  { dir: [1.0, 0.35], wavelength: 64, steepness: 0.62, amplitude: 0.085 },
  { dir: [0.65, -1.0], wavelength: 41, steepness: 0.55, amplitude: 0.06 },
  { dir: [-0.4, -0.7], wavelength: 23, steepness: 0.5, amplitude: 0.04 },
  { dir: [0.9, -0.25], wavelength: 13, steepness: 0.45, amplitude: 0.022 },
];

/** Sum of the wave amplitudes — the theoretical peak crest height above
 *  seaLevel at the shoreline. Exported so the SAND→WATER sibling can sit its
 *  beach foam just above the crest line. ~0.207 m. */
export const SEA_MAX_AMPLITUDE = WAVES.reduce((s, w) => s + w.amplitude, 0);

/** Handle returned by buildSea: the mesh (already added to the scene) and the
 *  per-frame update hook. update(elapsedRenderTime) advances the wave clock
 *  by a wall-time delta in SECONDS — call it once per RENDERED frame with the
 *  render dt (never the sim dt). Visual only; safe to call during replay. */
export interface Sea {
  mesh: THREE.Mesh;
  /** @param dtSeconds elapsed RENDER time since last frame (seconds) */
  update(dtSeconds: number): void;
  /** Re-tint the reflection/sun to the current time of day. Visual only. */
  setTimeOfDay(p: SeaPalette): void;
}

/** Per-time-of-day look fed from Game. All linear-ish hex colours. */
export interface SeaPalette {
  /** zenith / sky-dome colour the water mirrors looking up */
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
 * @param scene     the world scene
 * @param seaLevel  world y of the calm waterline (GANTRY POINT: -2.2)
 */
export function buildSea(scene: THREE.Scene, seaLevel: number): Sea {
  // 4000 m plane (unchanged extent) at a moderate tessellation. Analytic
  // normals mean close detail does NOT depend on this — the grid only has to
  // resolve the longest swell's silhouette near the camera; 256² (~15.6 m
  // cells) is plenty and stays a light vertex load.
  const geo = new THREE.PlaneGeometry(4000, 4000, 256, 256);

  // Pack the wave bank into flat uniform arrays the shader iterates. Each
  // wave: vec4(dirX, dirZ, wavelength, steepness) + its amplitude.
  const N = WAVES.length;
  const params: THREE.Vector4[] = [];
  const amps: number[] = [];
  for (const w of WAVES) {
    const dl = Math.hypot(w.dir[0], w.dir[1]) || 1;
    params.push(new THREE.Vector4(w.dir[0] / dl, w.dir[1] / dl, w.wavelength, w.steepness));
    amps.push(w.amplitude);
  }

  const ownUniforms = {
    uTime: { value: 0 },
    uEnvIntensity: { value: scene.environmentIntensity ?? 1 },
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
    uWaveParams: { value: params },
    uWaveAmp: { value: amps },
    uCamPos: { value: new THREE.Vector3() },
  };
  // fog:true on a raw ShaderMaterial does NOT auto-inject fog uniforms — the
  // fog_* shader chunks reference fogColor/fogNear/fogFar, so merge in three's
  // own fog UniformsLib or the renderer throws reading their .value
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, ownUniforms]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { WAVE_COUNT: N }, // compile constant -> the wave loops unroll
    lights: false,
    fog: true, // dissolve the far plane into the same Fog the world uses
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4  uWaveParams[WAVE_COUNT]; // dirX, dirZ, wavelength, steepness
      uniform float uWaveAmp[WAVE_COUNT];

      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vCrest;   // 0 trough .. 1 crest, drives foam
      #include <fog_pars_vertex>

      const float PI = 3.14159265359;

      void main() {
        // the mesh is rotated so local XY -> world XZ; displace in world space
        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec2 p = wp.xz;

        vec3 disp = vec3(0.0);
        // tangent (d/dx) and binormal (d/dz) start as the flat basis; each
        // wave bends them, and their cross is the analytic surface normal
        vec3 tangent  = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);
        float crest = 0.0;
        float ampSum = 1e-4;

        for (int i = 0; i < WAVE_COUNT; i++) {
          vec2  dir = uWaveParams[i].xy;
          float wavelength = uWaveParams[i].z;
          float steep = uWaveParams[i].w;
          float amp = uWaveAmp[i];

          float k = 2.0 * PI / wavelength;           // wavenumber
          float c = sqrt(9.8 / k);                   // deep-water phase speed
          float f = k * (dot(dir, p) - c * uTime);   // phase
          // steepness -> Q, clamped by 1/(k*A*count) so summed crests never
          // pinch into loops (GPU Gems Gerstner constraint)
          float Q = steep / (k * amp * float(WAVE_COUNT));

          float cosf = cos(f);
          float sinf = sin(f);

          disp.x += Q * amp * dir.x * cosf;
          disp.z += Q * amp * dir.y * cosf;
          disp.y += amp * sinf;

          float wa = k * amp;
          tangent  += vec3(-Q * dir.x * dir.x * wa * sinf,
                            dir.x * wa * cosf,
                           -Q * dir.x * dir.y * wa * sinf);
          binormal += vec3(-Q * dir.x * dir.y * wa * sinf,
                            dir.y * wa * cosf,
                           -Q * dir.y * dir.y * wa * sinf);

          crest += amp * (sinf * 0.5 + 0.5);
          ampSum += amp;
        }

        wp += disp;
        vWorldPos = wp;
        vCrest = crest / ampSum;
        vNormalW = normalize(cross(binormal, tangent));

        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uEnvIntensity;
      uniform vec3  uSky;
      uniform vec3  uHorizon;
      uniform vec3  uDeep;
      uniform vec3  uShallow;
      uniform vec3  uFoam;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform float uSunStrength;
      uniform float uAmbient;
      uniform float uTime;
      uniform vec3  uCamPos;

      varying vec3 vWorldPos;
      varying vec3 vNormalW;
      varying float vCrest;

      #include <common>
      #include <fog_pars_fragment>

      // cheap analytic sky the water mirrors: zenith->horizon gradient by the
      // reflected ray's elevation, warmed toward the sun. Matches the dome's
      // TOD palette because Game feeds the same colours in.
      vec3 skyColor(vec3 dir) {
        float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 base = mix(uHorizon, uSky, pow(up, 0.6));
        float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 8.0);
        base = mix(base, uSunColor, sunAmt * 0.5 * uSunStrength);
        return base * uEnvIntensity;
      }

      void main() {
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(uCamPos - vWorldPos); // surface -> camera
        float NdotV = max(dot(N, V), 0.0);

        // Schlick fresnel, but CAPPED: at this grazing open-sea framing a full
        // 0..1 fresnel turns the whole sheet into a pale sky mirror. Capping at
        // ~0.55 keeps the water reading as WATER (always ≥45% body colour)
        // while still brightening convincingly toward the horizon.
        float fres = 0.02 + 0.55 * pow(1.0 - NdotV, 5.0);
        fres = clamp(fres, 0.0, 0.55);

        // BODY colour by distance, not just view angle: near water is the rich
        // shallow teal, and it deepens toward the horizon where the swell
        // stacks — a depth-absorption read that survives the grazing angle.
        float dist = length(uCamPos.xz - vWorldPos.xz);
        float far = smoothstep(40.0, 900.0, dist);
        vec3 body = mix(uShallow, uDeep, far);
        // crest backs scatter a touch lighter (subsurface tint on the lee side)
        body = mix(body, uShallow, smoothstep(0.55, 1.0, vCrest) * 0.25);

        // SLOPE SHADING: with a tiny physical amplitude the swell is otherwise
        // near-invisible at this distance, so let the analytic wave normal
        // darken troughs and lighten faces that tilt toward the sun. This
        // reads the chop WITHOUT raising the amplitude (keeps the foam seam).
        float sunFace = dot(N, uSunDir) * 0.5 + 0.5;          // 0 lee .. 1 toward sun
        body *= mix(0.82, 1.14, sunFace);
        // time of day: as light drops, pull the body toward the dark deep tint
        // (so night water DESATURATES to moonlit blue, not just a dimmer teal)
        // then scale overall brightness down.
        body = mix(uDeep, body, smoothstep(0.0, 1.0, uAmbient));
        body *= mix(0.5, 1.0, uAmbient);

        // analytic sky reflection along the reflected view ray
        vec3 R = reflect(-V, N);
        vec3 sky = skyColor(R);

        vec3 col = mix(body, sky, fres);

        // sun sparkle: tight specular off the wave normals, broken into shards
        // by a moving hash so it twinkles instead of sitting as a mirror blob
        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), 180.0);
        float twinkle = step(0.5, fract(sin(dot(floor(vWorldPos.xz * 2.0), vec2(12.99, 78.23))) * 437.55 + uTime * 0.8));
        col += uSunColor * spec * (0.6 + 0.5 * twinkle) * uSunStrength * 1.6;

        // whitecaps: foam tint on the tops of crests, scrolled so it crawls
        // along the swell rather than flickering in place
        float capNoise = 0.5 + 0.5 * sin(vWorldPos.x * 0.21 + vWorldPos.z * 0.17 + uTime * 0.6);
        float cap = smoothstep(0.74, 0.96, vCrest) * (0.4 + 0.6 * capNoise);
        // foam dims with the world too, but keeps a little moonlit presence
        col = mix(col, uFoam * mix(0.45, 1.0, uAmbient), clamp(cap, 0.0, 0.7) * mix(0.55, 1.0, uAmbient));

        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

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
  const camPos = uniforms.uCamPos.value;

  return {
    mesh,
    update(dtSeconds: number): void {
      // accumulate RENDER wall time only — pin-safe, never sim time
      clock += dtSeconds;
      uniforms.uTime.value = clock;
      uniforms.uEnvIntensity.value = scene.environmentIntensity ?? 1;
      // camera world position for view-dependent fresnel/sparkle
      if (_activeCamera) camPos.setFromMatrixPosition(_activeCamera.matrixWorld);
    },
    setTimeOfDay(p: SeaPalette): void {
      uniforms.uSky.value.setHex(p.sky);
      uniforms.uHorizon.value.setHex(p.horizon);
      uniforms.uDeep.value.setHex(p.deep);
      uniforms.uSunColor.value.setHex(p.sun);
      uniforms.uSunDir.value.copy(p.sunDir).normalize();
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
