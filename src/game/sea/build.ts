import * as THREE from 'three';

// SEA — buildSea(): assemble the ShaderMaterial + mesh and the per-frame
// uniform-write update hook. Split out of sea.ts; the wave bank lives in
// ./waves, the public handle/palette types in ./types, and the two GLSL source
// strings in ./vertexShader + ./fragmentShader. Behaviour unchanged.
//
// PURE VISUAL, PIN-SAFE. The physics ground is the flat y=0 plane and this
// mesh carries no collider (same contract as the old static sea). The waves
// are driven by a RENDER clock (accumulated elapsed wall time fed from the
// frame loop), NEVER sim time, so the surface animates freely during replay
// without ever entering the world hash. update() only writes float/colour/
// texture uniforms — it touches no sim state.

import { WAVE_CONFIG, TWO_PI, AMP_SCALE, SEA_VNOISE_AMP, SEA_MAX_AMPLITUDE } from './waves';
import type { Sea, SeaPalette } from './types';
import { SEA_VERTEX_SHADER } from './vertexShader';
import { SEA_FRAGMENT_SHADER } from './fragmentShader';

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
    vertexShader: SEA_VERTEX_SHADER,
    fragmentShader: SEA_FRAGMENT_SHADER,
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
