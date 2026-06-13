import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from './skyscatter.glsl';

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
  },
  dusk: {
    elevation: 6, azimuth: 59.5, turbidity: 6, rayleigh: 1.35, mieCoefficient: 4.0, mieDirectionalG: 0.86,
    exposure: 18.0, sunDiscSize: 0.9, sunIntensity: 26.0, sunTint: 0xffc070, groundColor: 0x8a7a6a,
    night: 0,
  },
  night: {
    elevation: -8, azimuth: 59.5, turbidity: 4, rayleigh: 1.1, mieCoefficient: 2.0, mieDirectionalG: 0.8,
    exposure: 16.0, sunDiscSize: 0.5, sunIntensity: 0.0, sunTint: 0x9db6e8, groundColor: 0x05080f,
    night: 1, nightTint: 0x0b1734, starStrength: 1.0,
  },
};

const _col = new THREE.Color();
function toVec(c: THREE.ColorRepresentation): THREE.Vector3 {
  _col.set(c);
  return new THREE.Vector3(_col.r, _col.g, _col.b);
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
      },
    });
    // a unit sphere scaled large enough to enclose the camera path; the vertex
    // shader pins it to the far plane regardless, so the scale is only about
    // making sure the camera never exits the dome.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.material);
    this.mesh.scale.setScalar(2000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1; // draw the background first
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

    this.sunDir.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - preset.elevation),
      THREE.MathUtils.degToRad(preset.azimuth),
    );
    (u.uSunDir.value as THREE.Vector3).copy(this.sunDir);
  }

  /** PMREM-capture the configured sky for scene.environment. The dome is
   *  borrowed into a bake scene and handed back — same trick as three's
   *  webgl_shaders_sky example. */
  bake(renderer: THREE.WebGLRenderer): THREE.Texture {
    const parent = this.mesh.parent;
    const wasVisible = this.mesh.visible;
    this.mesh.visible = true; // bake even if the live dome is hidden (night)
    const bakeScene = new THREE.Scene();
    bakeScene.add(this.mesh);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(bakeScene);
    pmrem.dispose();
    if (parent) parent.add(this.mesh); // reclaim from the bake scene
    this.mesh.visible = wasVisible;
    this.rt?.dispose();
    this.rt = rt;
    return rt.texture;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
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
