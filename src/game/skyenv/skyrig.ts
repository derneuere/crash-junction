import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from '../skyscatter.glsl';
import { CLOUD_BAKE_VERT, CLOUD_BAKE_FRAG } from '../skyclouds.glsl';
import type { SkyPreset } from './presets';
import { RAYLEIGH_BASE, OZONE_BASE } from './presets';
import { toVec, computeSunTransmittance } from './scattering';

// The world's image-based lighting. A custom atmospheric-scattering dome
// (Rayleigh + Mie + ozone single-pass raymarch, ported from Sebastian Lague's
// MIT "Geographical-Adventures" atmosphere — see skyscatter.glsl.ts for the
// full attribution) is both the visible background dome and — captured through
// PMREM — scene.environment, so every standard material picks up sky ambience
// and props may keep their glTF metalness. Cars layer their own envMap on top
// (material.envMap beats scene.environment in three), so the tuned showroom
// gloss and the live player cube are unaffected. The OCEAN samples this same
// scene.environment plus the per-tod palette + sunDir that Game.ts derives
// from SKY_PRESETS and SkyRig.sunDir.
//
// Presentation only: lighting textures, never sim state. The raymarch is a
// pure function of view direction + sun direction — no animation, no time.

export class SkyRig {
  /** the background dome — lives in the main scene (vertex shader pins it
   *  to the far plane, so scale only needs to enclose the camera path).
   *  Kept as a Mesh (was three's Sky) — same role, richer shader. */
  readonly mesh: THREE.Mesh;
  /** unit vector toward the sun for the current preset */
  readonly sunDir = new THREE.Vector3(0, 1, 0);

  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly material: THREE.ShaderMaterial;

  // ---- equirect cloud bake (the perf win) ----
  /** High-res equirect HDR panorama; the cloud march fills it ONCE per tod with
   *  a clean, full-res, premultiplied-RGBA cloud field. The dome samples it by
   *  view direction every frame (a texture fetch, not a raymarch). */
  private readonly cloudTex: THREE.WebGLRenderTarget;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly cloudScene = new THREE.Scene();
  private readonly cloudCam = new THREE.Camera();
  private readonly cloudQuad: THREE.Mesh;
  /** equirect panorama resolution. 2048×1024 ≈ 5.7 px/° — crisp at the horizon,
   *  no visible texel blur, while a full-res live raymarch is retired. */
  private readonly CLOUD_TEX_W = 2048;
  private readonly CLOUD_TEX_H = 1024;
  /** view/light march steps for the HIGH-quality bake (no jitter, clean). */
  private readonly BAKE_VIEW_STEPS = 48;
  private readonly BAKE_LIGHT_STEPS = 12;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'AtmosphereScatterSky',
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide, // we're inside the dome
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uRayleighCoeff: { value: RAYLEIGH_BASE.clone() },
        uMieCoeff: { value: 0.003 },
        uMieG: { value: 0.8 },
        uOzoneCoeff: { value: OZONE_BASE.clone() },
        uExposure: { value: 9.0 },
        uSunDiscSize: { value: 0.6 },
        uSunIntensity: { value: 16.0 },
        uSunTint: { value: new THREE.Vector3(1, 0.95, 0.88) },
        uGroundColor: { value: new THREE.Vector3(0.08, 0.07, 0.06) },
        uNight: { value: 0 },
        uNightTint: { value: new THREE.Vector3(0.04, 0.08, 0.19) },
        uStarStrength: { value: 0.9 },
        // cloud layer (skyclouds.glsl.ts)
        uCloudCoverage: { value: 0.42 },
        uCloudDensity: { value: 0.9 },
        // tile scale of the cloud field (bigger value = smaller, more numerous
        // clouds). Tuned so the sky pose shows a handful of readable cumulus.
        uCloudHeight: { value: 1.4 },
        uCloudTint: { value: new THREE.Vector3(0.72, 0.78, 0.84) },
        // bake-quality knobs (the inline fallback only runs at env-bake time,
        // where density is forced to 0, so a low count is fine here; the equirect
        // bake material below overrides these with HIGH counts).
        uViewSteps: { value: 24 },
        uLightSteps: { value: 6 },
        uCloudBake: { value: 0 },
        // BAKED CLOUD PANORAMA: the dome samples this high-res equirect texture
        // (premultiplied RGBA, baked once per tod by cloudBake()) by view
        // direction instead of marching inline. uUseCloudTex gates it; the env
        // PMREM bake turns it off so the inline fallback runs (density 0 anyway).
        uCloudTex: { value: null as THREE.Texture | null },
        uUseCloudTex: { value: 0 },
        // azimuth scroll of the cloud lookup — driven per render frame off Game's
        // RENDER clock (pin-safe, like the sea/grass drift) for cheap motion.
        uCloudDrift: { value: 0 },
      },
    });
    // a unit sphere scaled large enough to enclose the camera path; the vertex
    // shader pins it to the far plane regardless, so the scale is only about
    // making sure the camera never exits the dome.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(2000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // draw the background first

    // --- equirect cloud bake setup ---
    // HDR target (HalfFloat) so the cloud march's >1 sunlit radiance + the
    // composer's bloom survive; RGBA so the premultiplied colour + coverage alpha
    // round-trip. Linear filtering gives smooth bilinear sampling on the dome.
    // ClampToEdge on v (poles), wrap on u so the azimuth drift scroll is seamless.
    this.cloudTex = new THREE.WebGLRenderTarget(this.CLOUD_TEX_W, this.CLOUD_TEX_H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
    // the bake material shares the dome's cloud/sun uniform OBJECTS so a single
    // configure() write drives both in lockstep — but overrides the step/jitter
    // knobs with HIGH-quality bake values (its own uniform entries).
    const du = this.material.uniforms;
    this.cloudMat = new THREE.ShaderMaterial({
      name: 'CloudEquirectBake',
      vertexShader: CLOUD_BAKE_VERT,
      fragmentShader: CLOUD_BAKE_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        // shared with the dome (same uniform objects — write once, both see it)
        uSunDir: du.uSunDir,
        uSunTint: du.uSunTint,
        uSunIntensity: du.uSunIntensity,
        uNight: du.uNight,
        uCloudCoverage: du.uCloudCoverage,
        uCloudDensity: du.uCloudDensity,
        uCloudHeight: du.uCloudHeight,
        uCloudTint: du.uCloudTint,
        // bake-only HIGH-quality march: many steps, no jitter → clean field
        uViewSteps: { value: this.BAKE_VIEW_STEPS },
        uLightSteps: { value: this.BAKE_LIGHT_STEPS },
        uCloudBake: { value: 1 },
        // the sun transmittance at the eye (computed per configure)
        uSunTrans: { value: new THREE.Vector3(1, 1, 1) },
      },
    });
    // a fullscreen quad covering the equirect target; the vertex shader ignores
    // the projection and writes clip space directly (uv spans the panorama).
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.cloudQuad = new THREE.Mesh(quadGeo, this.cloudMat);
    this.cloudQuad.frustumCulled = false;
    this.cloudScene.add(this.cloudQuad);
  }

  /** Bake the cloud panorama for the CURRENT preset into the equirect texture,
   *  then point the dome at it. Runs the HIGH-quality march (many steps, no
   *  jitter) over the whole lat/long panorama ONCE — call right AFTER configure()
   *  on a time-of-day change (Game.setTimeOfDay), NOT per frame. The dome then
   *  samples the result by view direction every frame (a texture fetch, not a
   *  raymarch). The render camera is irrelevant (clouds are at infinity →
   *  camera-independent), so this needs no camera. Presentation-only — writes an
   *  offscreen texture, never sim state; tod changes happen off the render path,
   *  so it stays pin-safe. configure() must run first: it writes the shared sun/
   *  cloud uniforms (incl. uSunTrans) the bake material reads. */
  cloudBake(renderer: THREE.WebGLRenderer): void {
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.cloudTex);
    renderer.render(this.cloudScene, this.cloudCam);
    renderer.setRenderTarget(prevTarget);
    // point the dome at the fresh panorama + enable the sample path
    this.material.uniforms.uCloudTex.value = this.cloudTex.texture;
    this.material.uniforms.uUseCloudTex.value = 1;
  }

  /** Back-compat no-op: clouds used to be re-rendered per frame into a half-res
   *  buffer here; they are now PRERENDERED once per tod (cloudBake, called from
   *  Game.setTimeOfDay). Per-frame the dome just samples the baked panorama, so
   *  there is nothing to do each frame. Kept so the refshot/perf harnesses that
   *  call g.skyRig.renderClouds(r, c) before a one-off render still work
   *  unchanged — the panorama is already bound from the last cloudBake(). */
  renderClouds(_renderer: THREE.WebGLRenderer, _camera: THREE.PerspectiveCamera): void {
    /* intentionally empty — see cloudBake() */
  }

  /** No-op kept for the resize wiring (Game.onResize). The cloud panorama is a
   *  fixed-resolution equirect (camera- and viewport-independent), so a window
   *  resize no longer needs to re-size any cloud buffer. */
  setSize(_width: number, _height: number): void {
    /* equirect bake is fixed-res — nothing to resize */
  }

  configure(preset: SkyPreset): void {
    const u = this.material.uniforms;
    // Rayleigh: per-channel base (≈1/λ⁴ for RGB) × legacy strength, scaled to
    // per-km extinction (Hillaire's ~5.8e-6/m ≡ 5.8e-3/km) for the km-scale
    // atmosphere the raymarch integrates over.
    (u.uRayleighCoeff.value as THREE.Vector3).copy(RAYLEIGH_BASE).multiplyScalar(preset.rayleigh * 1e-3);
    // Mie: legacy coefficient (now an absolute scatter strength), nudged by
    // turbidity for hazier low-sun frames.
    u.uMieCoeff.value = preset.mieCoefficient * 1e-3 * (0.6 + preset.turbidity * 0.06);
    u.uMieG.value = preset.mieDirectionalG;
    (u.uOzoneCoeff.value as THREE.Vector3).copy(OZONE_BASE).multiplyScalar(6e-4);
    // preset.exposure is the direct linear-radiance → display multiplier; the
    // raymarch output is small (~0.02 at the horizon), calibrated offline so
    // ~16 lands the zenith at a healthy sky blue and the horizon at pale haze.
    u.uExposure.value = preset.exposure;
    u.uSunDiscSize.value = preset.sunDiscSize ?? 0.6;
    u.uSunIntensity.value = preset.sunIntensity ?? 16;
    (u.uSunTint.value as THREE.Vector3).copy(toVec(preset.sunTint ?? 0xfff4e2));
    (u.uGroundColor.value as THREE.Vector3).copy(toVec(preset.groundColor ?? 0x5b5043));
    u.uNight.value = preset.night ?? 0;
    (u.uNightTint.value as THREE.Vector3).copy(toVec(preset.nightTint ?? 0x0a1430));
    u.uStarStrength.value = preset.starStrength ?? 0.9;
    // cloud layer per-tod knobs (uCloudDrift is scrolled every frame, not here)
    u.uCloudCoverage.value = preset.cloudCoverage ?? 0.42;
    u.uCloudDensity.value = preset.cloudDensity ?? 0.9;
    (u.uCloudTint.value as THREE.Vector3).copy(toVec(preset.cloudTint ?? 0xb9c6d6));

    this.sunDir.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - preset.elevation),
      THREE.MathUtils.degToRad(preset.azimuth),
    );
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);

    // Cloud pass: the sun transmittance at the eye is constant over the dome and
    // depends only on the sun dir + the scattering coefficients just written —
    // compute it ONCE here (the inline dome path computes the same value in the
    // frag). Feeds the equirect cloud bake's warm-rim colour at dusk.
    const sunTrans = computeSunTransmittance(
      this.sunDir,
      u.uRayleighCoeff.value as THREE.Vector3,
      u.uMieCoeff.value as number,
      u.uOzoneCoeff.value as THREE.Vector3,
    );
    (this.cloudMat.uniforms.uSunTrans.value as THREE.Vector3).copy(sunTrans);
  }

  /** Advance the cloud drift clock. The baked panorama is static; the dome adds a
   *  cheap sense of motion by slowly scrolling its azimuth lookup (uCloudDrift).
   *  Driven off Game's RENDER time (the same pin-safe source the sea/grass use),
   *  never sim time — so clouds drift smoothly but never perturb replay
   *  determinism. CLOUD_DRIFT_RATE is in panorama-widths/sec (tiny → distant,
   *  lazy cumulus); fract() in the shader wraps it seamlessly. Visual-only. */
  setCloudTime(t: number): void {
    const CLOUD_DRIFT_RATE = 0.0008; // panorama widths per second (~21 min/lap)
    this.material.uniforms.uCloudDrift.value = t * CLOUD_DRIFT_RATE;
  }

  /** PMREM-capture the configured sky for scene.environment. The dome is
   *  borrowed into a bake scene and handed back — same trick as three's
   *  webgl_shaders_sky example.
   *
   *  CLOUDS ARE DOME-ONLY, NOT BAKED INTO THE ENV. The env is re-baked only on
   *  a time-of-day change, but the visible clouds drift every frame — baking
   *  them would freeze one cloud pattern into every reflection (water/glass/car)
   *  while the sky overhead keeps moving, which reads as broken. The clouds'
   *  soft ambient contributes almost nothing to the integrated IBL irradiance
   *  anyway, so suppressing them for the bake keeps the env/palette/sun
   *  contract byte-for-byte what the ocean and car reflections already consume.
   *  We zero cloud density for the bake and restore it after. */
  bake(renderer: THREE.WebGLRenderer): THREE.Texture {
    const parent = this.mesh.parent;
    const wasVisible = this.mesh.visible;
    const cloudDensity = this.material.uniforms.uCloudDensity.value as number;
    const useTex = this.material.uniforms.uUseCloudTex.value as number;
    this.material.uniforms.uCloudDensity.value = 0; // dome-only: no clouds in env
    // the env reads the dome through the PMREM cube faces — force the inline
    // (density-0 → empty) cloud path so the env never bakes the cloud panorama
    // into the reflections (a frozen cloud pattern in every reflection while the
    // sky drifts reads as broken; clouds stay dome-only). Same contract as before.
    this.material.uniforms.uUseCloudTex.value = 0;
    this.mesh.visible = true; // bake even if the live dome is hidden (night)
    const bakeScene = new THREE.Scene();
    bakeScene.add(this.mesh);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(bakeScene);
    pmrem.dispose();
    if (parent) parent.add(this.mesh); // reclaim from the bake scene
    this.material.uniforms.uCloudDensity.value = cloudDensity; // restore for the live dome
    this.material.uniforms.uUseCloudTex.value = useTex; // restore sample path
    this.mesh.visible = wasVisible;
    this.rt?.dispose();
    this.rt = rt;
    return rt.texture;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.cloudTex.dispose();
    this.cloudMat.dispose();
    this.cloudQuad.geometry.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
