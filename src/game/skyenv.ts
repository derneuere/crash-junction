import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from './skyscatter.glsl';
import { CLOUD_PASS_VERT, CLOUD_PASS_FRAG } from './skyclouds.glsl';

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

// SkyPreset keeps the legacy field shape so existing Game.ts wiring
// (SKY_PRESETS[t] → configure) is untouched, and adds optional richer knobs
// for the scattering model. Legacy turbidity/rayleigh/mie* feed the new
// coefficients when the explicit ones are absent.
export interface SkyPreset {
  /** sun elevation above the horizon, degrees */
  elevation: number;
  /** sun azimuth from +z toward +x, degrees */
  azimuth: number;
  /** legacy haze knob — biases Mie scatter when mieScatter is unset */
  turbidity: number;
  /** legacy Rayleigh strength — scales the per-channel Rayleigh coefficient */
  rayleigh: number;
  /** legacy Mie coefficient — used directly as the Mie scatter strength */
  mieCoefficient: number;
  /** Mie phase asymmetry g (forward-scatter; higher = tighter sun glow) */
  mieDirectionalG: number;
  /** radiance → display scale (the raymarch output is unbounded HDR) */
  exposure: number;
  // ---- optional scattering knobs (default-filled in configure) ----
  /** angular radius of the crisp sun disc, degrees */
  sunDiscSize?: number;
  /** brightness multiplier on the sun disc + its bloom halo */
  sunIntensity?: number;
  /** RGB colour bias of the disc/glow (warm at dusk) */
  sunTint?: THREE.ColorRepresentation;
  /** colour seen looking just below the horizon line */
  groundColor?: THREE.ColorRepresentation;
  /** 0 day .. 1 night — blends in the night tint + star field */
  night?: number;
  /** deep scattered-blue night dome colour */
  nightTint?: THREE.ColorRepresentation;
  /** star-field brightness (only visible while night > 0) */
  starStrength?: number;
  // ---- cloud layer (skyclouds.glsl.ts) ----
  /** 0 clear .. 1 overcast — lowers the density cut so more sky fills with cloud */
  cloudCoverage?: number;
  /** overall opacity multiplier of the cloud layer (0 = no clouds) */
  cloudDensity?: number;
  /** ambient/shadow fill colour for clouds — usually the sky's mid tone, so
   *  shaded cloud reads as lit-by-sky (warm-grey day, blue-grey dusk/night) */
  cloudTint?: THREE.ColorRepresentation;
}

// Per-channel Rayleigh base coefficient ∝ 1/λ⁴ for λ ≈ (680, 550, 440) nm —
// the blue-sky / red-sunset bias. Scaled by preset.rayleigh in configure.
const RAYLEIGH_BASE = new THREE.Vector3(5.8, 13.5, 33.1);
// Ozone Chappuis-band absorption (1e-3 units) — subtly cools the zenith and
// keeps a believable blue in the upper sky at low sun (Bruneton).
const OZONE_BASE = new THREE.Vector3(0.65, 1.88, 0.085);

// Day matches the legacy key light (sprite pinned at (170,220,100) →
// azimuth ≈ 59.5°, elevation ≈ 48°). Dusk is the Riviera money shot: sun
// ~6° over the horizon straight down the same azimuth, forward scattering
// for the warm golden glow wall. Night drops the sun below the horizon for a
// dark scattered-blue dome with stars (Game.ts may still hide the dome and use
// the lamp-glint env, but this preset makes the dome itself believable if shown).
export const SKY_PRESETS: Record<'day' | 'dusk' | 'night', SkyPreset> = {
  day: {
    elevation: 48, azimuth: 59.5, turbidity: 8, rayleigh: 1.0, mieCoefficient: 3.0, mieDirectionalG: 0.76,
    exposure: 16.0, sunDiscSize: 0.6, sunIntensity: 20.0, sunTint: 0xfff4e2, groundColor: 0x8a9bb0,
    night: 0,
    // fair-weather cumulus: scattered, bright-white tops, blue-grey sky fill
    cloudCoverage: 0.42, cloudDensity: 0.9, cloudTint: 0xb9c6d6,
  },
  dusk: {
    elevation: 6, azimuth: 59.5, turbidity: 6, rayleigh: 1.35, mieCoefficient: 4.0, mieDirectionalG: 0.86,
    exposure: 18.0, sunDiscSize: 0.9, sunIntensity: 26.0, sunTint: 0xffc070, groundColor: 0x8a7a6a,
    night: 0,
    // golden-hour: a touch more coverage so the warm sun catches the cloud
    // rims; cooler purple-grey ambient so the lit edges pop against shadow
    cloudCoverage: 0.50, cloudDensity: 0.95, cloudTint: 0x6a6680,
  },
  night: {
    elevation: -8, azimuth: 59.5, turbidity: 4, rayleigh: 1.1, mieCoefficient: 2.0, mieDirectionalG: 0.8,
    exposure: 16.0, sunDiscSize: 0.5, sunIntensity: 0.0, sunTint: 0x9db6e8, groundColor: 0x05080f,
    night: 1, nightTint: 0x0b1734, starStrength: 1.0,
    // dark blue-grey cloud silhouettes against the star band; faint moon fill
    cloudCoverage: 0.40, cloudDensity: 0.85, cloudTint: 0x1a2540,
  },
};

const _col = new THREE.Color();
function toVec(c: THREE.ColorRepresentation): THREE.Vector3 {
  _col.set(c);
  return new THREE.Vector3(_col.r, _col.g, _col.b);
}

/** scratch for reading the renderer's current drawing-buffer size */
const _sizeTmp = new THREE.Vector2();

// ---- sun transmittance at the eye (JS port of skyscatter.glsl) ----
// The cloud march needs the sun's atmospheric transmittance at the eye — the
// ONE scattering value it can't compute on its own (it carries no atmosphere
// model). In the inline dome path the frag computes sunTransmittance(ro); the
// half-res cloud pass instead receives it as a uniform. This is a faithful,
// byte-for-byte-intent port of skyscatter.glsl's sunTransmittance/getScattering
// at ro = (0, groundRadius+0.2, 0): it depends only on the sun direction + the
// (per-time-of-day) scattering coefficients, so it is computed ONCE per
// configure() — zero per-frame cost — and matches what the dome computes inline.
const ATMO = {
  groundRadius: 6360.0,
  atmoRadius: 6460.0,
  rayleighScaleH: 8.0,
  mieScaleH: 1.2,
  ozoneCentre: 25.0,
  ozoneWidth: 15.0,
};

/** ray–sphere from skyscatter.glsl: returns through-length (0 on miss). */
function raySphereThrough(ro: THREE.Vector3, rd: THREE.Vector3, radius: number): number {
  const b = ro.dot(rd);
  const c = ro.dot(ro) - radius * radius;
  const d = b * b - c;
  if (d < 0) return 0;
  const s = Math.sqrt(d);
  const near = Math.max(0, -b - s);
  const far = -b + s;
  if (far < 0) return 0;
  return far - near;
}

/** Sun transmittance at the eye — exp(-∫extinction) over an 8-step march toward
 *  the sun, exactly mirroring skyscatter.glsl. rayleighCoeff/mieCoeff/ozoneCoeff
 *  are the SAME values written into the dome uniforms in configure(). */
function computeSunTransmittance(
  sunDir: THREE.Vector3,
  rayleighCoeff: THREE.Vector3,
  mieCoeff: number,
  ozoneCoeff: THREE.Vector3,
): THREE.Vector3 {
  const ro = new THREE.Vector3(0, ATMO.groundRadius + 0.2, 0);
  const len = raySphereThrough(ro, sunDir, ATMO.atmoRadius);
  const STEPS = 8;
  const ds = len / STEPS;
  let opticalR = 0,
    opticalG = 0,
    opticalB = 0;
  const pos = ro.clone().addScaledVector(sunDir, ds * 0.5);
  for (let i = 0; i < STEPS; i++) {
    const h = pos.length() - ATMO.groundRadius;
    const rDensity = Math.exp(-h / ATMO.rayleighScaleH);
    const mDensity = Math.exp(-h / ATMO.mieScaleH);
    const oDensity = Math.max(0, 1 - Math.abs(h - ATMO.ozoneCentre) / ATMO.ozoneWidth);
    const mieS = mieCoeff * mDensity;
    const mieAbs = mieCoeff * 0.1 * mDensity;
    // extinction = rayleighS + mieS + mieAbsorption + ozone*oDensity
    opticalR += (rayleighCoeff.x * rDensity + mieS + mieAbs + ozoneCoeff.x * oDensity) * ds;
    opticalG += (rayleighCoeff.y * rDensity + mieS + mieAbs + ozoneCoeff.y * oDensity) * ds;
    opticalB += (rayleighCoeff.z * rDensity + mieS + mieAbs + ozoneCoeff.z * oDensity) * ds;
    pos.addScaledVector(sunDir, ds);
  }
  return new THREE.Vector3(Math.exp(-opticalR), Math.exp(-opticalG), Math.exp(-opticalB));
}

export class SkyRig {
  /** the background dome — lives in the main scene (vertex shader pins it
   *  to the far plane, so scale only needs to enclose the camera path).
   *  Kept as a Mesh (was three's Sky) — same role, richer shader. */
  readonly mesh: THREE.Mesh;
  /** unit vector toward the sun for the current preset */
  readonly sunDir = new THREE.Vector3(0, 1, 0);

  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly material: THREE.ShaderMaterial;

  // ---- half-res cloud pass (the perf win) ----
  /** Quarter-area HDR target the cloud march writes premultiplied RGBA into. */
  private cloudRT: THREE.WebGLRenderTarget;
  private readonly cloudMat: THREE.ShaderMaterial;
  private readonly cloudScene = new THREE.Scene();
  private readonly cloudCam = new THREE.Camera();
  private readonly cloudQuad: THREE.Mesh;
  /** divisor on the full render size — 2 = half-res (quarter the pixels). */
  private readonly CLOUD_DOWNSCALE = 2;
  private readonly _invViewProj = new THREE.Matrix4();
  private fullW = 1;
  private fullH = 1;

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
        // cloud layer (skyclouds.glsl.ts) — uCloudTime is driven per render
        // frame off Game's RENDER clock (pin-safe, like the sea/grass drift)
        uCloudTime: { value: 0 },
        uCloudCoverage: { value: 0.42 },
        uCloudDensity: { value: 0.9 },
        // tile scale of the cloud field (bigger value = smaller, more numerous
        // clouds). Tuned so the sky pose shows a handful of readable cumulus.
        uCloudHeight: { value: 1.4 },
        uCloudTint: { value: new THREE.Vector3(0.72, 0.78, 0.84) },
        // HALF-RES CLOUD BUFFER: the dome samples this premultiplied RGBA target
        // (filled by renderClouds() each frame) instead of marching clouds
        // inline. uUseCloudBuffer gates it; the bake path turns it off so the
        // inline fallback runs (with cloud density forced to 0 anyway).
        uCloudBuffer: { value: null as THREE.Texture | null },
        uUseCloudBuffer: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
      },
    });
    // a unit sphere scaled large enough to enclose the camera path; the vertex
    // shader pins it to the far plane regardless, so the scale is only about
    // making sure the camera never exits the dome.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(2000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // draw the background first

    // --- cloud pass setup ---
    // HDR target (HalfFloat) so the cloud march's >1 sunlit radiance + the
    // composer's bloom survive; RGBA so the premultiplied colour + coverage
    // alpha round-trip. Linear filtering gives the free bilinear upscale that
    // makes half-res clouds read as full-res (they're low-frequency).
    this.cloudRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    // the cloud-pass material shares the dome's cloud/sun uniform OBJECTS so a
    // single configure()/setCloudTime() write drives both paths in lockstep —
    // no risk of the buffer and the (fallback) inline march disagreeing.
    const du = this.material.uniforms;
    this.cloudMat = new THREE.ShaderMaterial({
      name: 'CloudHalfResPass',
      vertexShader: CLOUD_PASS_VERT,
      fragmentShader: CLOUD_PASS_FRAG,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        // shared with the dome (same uniform objects — write once, both see it)
        uSunDir: du.uSunDir,
        uSunTint: du.uSunTint,
        uSunIntensity: du.uSunIntensity,
        uNight: du.uNight,
        uCloudTime: du.uCloudTime,
        uCloudCoverage: du.uCloudCoverage,
        uCloudDensity: du.uCloudDensity,
        uCloudHeight: du.uCloudHeight,
        uCloudTint: du.uCloudTint,
        // cloud-pass only: the sun transmittance at the eye (computed per
        // configure) + the camera reconstruction matrices (set per frame)
        uSunTrans: { value: new THREE.Vector3(1, 1, 1) },
        uInvViewProj: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
      },
    });
    // a fullscreen triangle (oversized quad clipped to the viewport); the vertex
    // shader ignores the projection and writes clip space directly.
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.cloudQuad = new THREE.Mesh(quadGeo, this.cloudMat);
    this.cloudQuad.frustumCulled = false;
    this.cloudScene.add(this.cloudQuad);
  }

  /** Render the half-res cloud buffer for THIS frame's camera, then point the
   *  dome at it. Call once per frame from the render path, AFTER setCloudTime()
   *  and BEFORE the main scene render. Presentation-only: it reads the render
   *  camera + render clock and writes an offscreen texture — never sim state, so
   *  it's pin-safe exactly like the sea/grass drift it sits beside. */
  renderClouds(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    // self-sync the full-res size to whatever the renderer is currently drawing
    // at. The dome composites via gl_FragCoord.xy / uResolution, and gl_FragCoord
    // is in DRAWING-BUFFER pixels (CSS size × pixelRatio), which is also the
    // resolution the composer's RenderPass and the raw canvas render at — so
    // uResolution + the cloud buffer must track the drawing-buffer size. This
    // also keeps offscreen captures correct: refshot/probes call
    // renderer.setSize()/setPixelRatio() directly, never onResize/setSize.
    renderer.getDrawingBufferSize(_sizeTmp);
    if (_sizeTmp.x !== this.fullW || _sizeTmp.y !== this.fullH) {
      this.setSize(_sizeTmp.x, _sizeTmp.y);
    }

    // reconstruct the world-space view ray in the pass from inverse(P*V)
    this._invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    (this.cloudMat.uniforms.uInvViewProj.value as THREE.Matrix4).copy(this._invViewProj);
    (this.cloudMat.uniforms.uCameraPos.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.cloudRT);
    renderer.render(this.cloudScene, this.cloudCam);
    renderer.setRenderTarget(prevTarget);

    // point the dome at the fresh buffer + enable the sample path
    this.material.uniforms.uCloudBuffer.value = this.cloudRT.texture;
    this.material.uniforms.uUseCloudBuffer.value = 1;
  }

  /** Size the cloud buffer + the dome's screen-lookup resolution to the full
   *  render size. Half-res buffer = ceil(full / CLOUD_DOWNSCALE). */
  setSize(width: number, height: number): void {
    this.fullW = Math.max(1, width);
    this.fullH = Math.max(1, height);
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(this.fullW, this.fullH);
    const cw = Math.max(1, Math.ceil(this.fullW / this.CLOUD_DOWNSCALE));
    const ch = Math.max(1, Math.ceil(this.fullH / this.CLOUD_DOWNSCALE));
    this.cloudRT.setSize(cw, ch);
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
    // cloud layer per-tod knobs (uCloudTime is set every frame, not here)
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
    // frag). Feeds the half-res cloud march's warm-rim colour at dusk.
    const sunTrans = computeSunTransmittance(
      this.sunDir,
      u.uRayleighCoeff.value as THREE.Vector3,
      u.uMieCoeff.value as number,
      u.uOzoneCoeff.value as THREE.Vector3,
    );
    (this.cloudMat.uniforms.uSunTrans.value as THREE.Vector3).copy(sunTrans);
  }

  /** Advance the cloud drift clock. Driven off Game's RENDER time (the same
   *  pin-safe source the sea/grass use), never sim time — so clouds drift
   *  smoothly but never perturb replay determinism. Visual-only. */
  setCloudTime(t: number): void {
    this.material.uniforms.uCloudTime.value = t;
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
    const useBuffer = this.material.uniforms.uUseCloudBuffer.value as number;
    this.material.uniforms.uCloudDensity.value = 0; // dome-only: no clouds in env
    // bake reads the dome through the PMREM cube faces, NOT this frame's
    // screen-space cloud buffer — force the inline (density-0 → empty) path so
    // the bake never samples a stale/mis-sized buffer at the cube-face UVs.
    this.material.uniforms.uUseCloudBuffer.value = 0;
    this.mesh.visible = true; // bake even if the live dome is hidden (night)
    const bakeScene = new THREE.Scene();
    bakeScene.add(this.mesh);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(bakeScene);
    pmrem.dispose();
    if (parent) parent.add(this.mesh); // reclaim from the bake scene
    this.material.uniforms.uCloudDensity.value = cloudDensity; // restore for the live dome
    this.material.uniforms.uUseCloudBuffer.value = useBuffer; // restore sample path
    this.mesh.visible = wasVisible;
    this.rt?.dispose();
    this.rt = rt;
    return rt.texture;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.cloudRT.dispose();
    this.cloudMat.dispose();
    this.cloudQuad.geometry.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

// ---------- sun lens flare ----------
// Ghost sprites strung along the screen-space sun→centre axis, occlusion-
// faded so the flare dies behind a building and blazes when the sun clears
// the rooftops — the footage beat. Hand-rolled instead of THREE.Lensflare:
// the stock one saves/restores the framebuffer around a depth probe
// (copyFramebufferToTexture), which is illegal from inside the composer's
// multisampled HDR buffer and smears black quads over the sky. Occlusion
// here is a single physics ray from Game instead — the collision boxes are
// exactly the chunky occluders a flare cares about.

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,240,210,0.55)');
  grad.addColorStop(0.6, 'rgba(255,220,160,0.12)');
  grad.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function ghostTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  grad.addColorStop(0.78, 'rgba(255,255,255,0.35)');
  grad.addColorStop(0.92, 'rgba(255,255,255,0.1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface FlareElement {
  sprite: THREE.Sprite;
  /** 0 = on the sun, 1 = screen centre, >1 mirrored past centre */
  dist: number;
  /** screen-relative size (sizeAttenuation off: 1 ≈ viewport height) */
  size: number;
  opacity: number;
}

const _flareNdc = new THREE.Vector3();
const _flarePoint = new THREE.Vector3();

export class SunFlare {
  readonly group = new THREE.Group();
  private elements: FlareElement[] = [];
  private visibility = 0; // occlusion-faded 0..1
  private textures: THREE.Texture[] = [];

  constructor() {
    const glow = glowTexture();
    const ghost = ghostTexture();
    this.textures.push(glow, ghost);
    const make = (tex: THREE.Texture, dist: number, size: number, opacity: number, color: number) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        sizeAttenuation: false,
        fog: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(size, size, 1);
      sprite.renderOrder = 999; // over everything, under the DOM HUD
      this.group.add(sprite);
      this.elements.push({ sprite, dist, size, opacity });
    };
    make(glow, 0, 0.5, 0.85, 0xfff4dc); // halo on the sun itself
    make(ghost, 0.35, 0.09, 0.3, 0xa6c6ff);
    make(ghost, 0.55, 0.16, 0.35, 0xffd9a0);
    make(glow, 0.72, 0.06, 0.3, 0xffb380);
    make(ghost, 0.95, 0.24, 0.25, 0xb3e6ff);
    make(ghost, 1.25, 0.12, 0.2, 0xffc8a0);
    this.group.visible = false;
  }

  /** Re-aim the ghosts along the sun→centre axis and fade by occlusion.
   *  `occluded` is Game's physics ray (camera → sun). */
  update(camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, dt: number, enabled: boolean, occluded: () => boolean): void {
    _flareNdc.copy(sunWorld).project(camera);
    const onScreen = enabled && _flareNdc.z < 1 && Math.abs(_flareNdc.x) < 1.3 && Math.abs(_flareNdc.y) < 1.3;
    const target = onScreen && !occluded() ? 1 : 0;
    this.visibility += (target - this.visibility) * Math.min(1, dt * 9);
    if (this.visibility < 0.01) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    // edge fade: flares die toward the screen border like a real lens
    const edge = Math.max(Math.abs(_flareNdc.x), Math.abs(_flareNdc.y));
    const fade = this.visibility * THREE.MathUtils.clamp(1.4 - edge, 0, 1);
    for (const e of this.elements) {
      // ghosts sit on the sun→centre line: ndc * (1 - dist)
      _flarePoint.set(_flareNdc.x * (1 - e.dist), _flareNdc.y * (1 - e.dist), 0.5).unproject(camera);
      e.sprite.position.copy(_flarePoint);
      (e.sprite.material as THREE.SpriteMaterial).opacity = e.opacity * fade;
    }
  }

  dispose(): void {
    for (const e of this.elements) (e.sprite.material as THREE.SpriteMaterial).dispose();
    for (const t of this.textures) t.dispose();
  }
}
