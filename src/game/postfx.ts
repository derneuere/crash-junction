import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { SpeedBlurEffect } from './speedblur';

// The film-look chain — the game's ONLY render path now: HDR scene render →
// ambient occlusion → speed blur → bloom → ACES tonemap → vignette /
// chromatic aberration / grain. In three r152+, renderer-level tone mapping
// only applies when drawing straight to the canvas, so ACES moves into the
// chain here; the renderer's exposure still flows through (three binds the
// toneMappingExposure uniform on any program that declares it).
//
// MOTION BLUR HISTORY: a realism-effects VelocityDepthNormalPass +
// MotionBlurEffect (per-pixel velocity buffer) sat here but produced NOTHING
// at any speed. Root cause: that pass derives each object's "previous" matrix
// from the CURRENT camera within the same render call, so a STATIC world under
// a TRANSLATING chase cam reports zero screen-space velocity everywhere — the
// velocity texture is identically 0 (verified by readback: maxVelUv 0 even at
// 48 m/s), so the blur early-outs to the unchanged frame. It was replaced by a
// self-contained screen-space radial SpeedBlurEffect (speedblur.ts) driven by
// the car's translational speed — center-sharp so the car stays crisp and only
// the periphery/world streaks. See speedblur.ts for the full rationale.
//
// All of it is presentation-only — the sim and the replay hashes never see a
// pixel. The player-facing FAST/CINE tier was removed; the composer is always
// on in real play. The one path that still bypasses it is the headless
// determinism bypass — ?verify=1 replays (and refshot --gfx fast review
// captures) fall back to renderer.render with renderer-level ACES, so
// swiftshader doesn't pay for cine pixels nobody hashes (Game.forceFast).

// Speed → speed-blur strength curve (m/s). Below ONSET the frame is sharp; the
// radial streak ramps in above cruising and saturates near boost top speed.
// BOOST adds an extra kick so nitrous reads as a clear (but not nauseating)
// smear. The value is the [0..1] gain fed to SpeedBlurEffect.setStrength each
// frame from the render tail of Game.frame() — so a parked car shows no blur
// regardless of where the camera points.
const SPEED_ONSET = 16; // m/s — calm below this (cruising stays mostly sharp)
const SPEED_FULL = 38; // m/s — full smear at/above regular-boost top speed
const BOOST_BONUS = 0.18; // extra strength while boosting (clamped to 1 below)

/** Map player speed (m/s) + boost flag to a speed-blur strength gain [0..1].
 *  Exported so the wiring (Game.ts) and the effect stay in lockstep; at 0 the
 *  effect early-outs and the frame is untouched. */
export function speedBlurStrength(speed: number, boosting: boolean): number {
  const t = (speed - SPEED_ONSET) / (SPEED_FULL - SPEED_ONSET);
  const base = Math.min(1, Math.max(0, t));
  // ease-in so cruising stays subtle and the climb to top speed is where the
  // smear really opens up (square the linear ramp)
  return Math.min(1, base * base + (boosting ? BOOST_BONUS : 0));
}

export class Postfx {
  private composer: EffectComposer;
  // the screen-space radial speed blur — strength + focus pushed each frame from
  // Game.ts (setSpeedBlur). Held so the wiring can drive it without reaching
  // into the EffectPass internals.
  private speedBlur: SpeedBlurEffect;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 4, // WebGL2 MSAA on the scene buffer — no SMAA pass needed
    });
    this.composer.addPass(new RenderPass(scene, camera));

    const ao = new N8AOPostPass(scene, camera, width, height);
    ao.configuration.halfRes = true;
    ao.configuration.aoRadius = 2.2;
    ao.configuration.distanceFalloff = 0.7;
    ao.configuration.intensity = 2.6;
    this.composer.addPass(ao);

    // SPEED BLUR: a center-sharp radial streak driven by the car's translational
    // speed (Game.ts feeds setStrength/setFocus). The world rushes outward from
    // the travel vanishing point while the focal region — where the car sits —
    // stays crisp. Lives BEFORE bloom/tonemap so the streaks pick up the HDR
    // bloom too. (Replaced the dead velocity-buffer motion blur — see header.)
    this.speedBlur = new SpeedBlurEffect();
    const bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 0.45,
      radius: 0.72,
      luminanceThreshold: 1.4, // true HDR hotspots only: sun, emissives, glints
      luminanceSmoothing: 0.25,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.composer.addPass(new EffectPass(camera, this.speedBlur, bloom, tone));

    const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.42 });
    const aberration = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0007, 0.0007),
      radialModulation: true,
      modulationOffset: 0.4,
    });
    const grain = new NoiseEffect({ blendFunction: BlendFunction.COLOR_DODGE, premultiply: true });
    grain.blendMode.opacity.value = 0.04;
    this.composer.addPass(new EffectPass(camera, vignette, aberration, grain));
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  /** Drive the radial speed blur for this frame. `strength` is the [0..1] gain
   *  from speedBlurStrength(); `focusU/focusV` is the travel vanishing point in
   *  UV (where the streaks converge / stay sharp). Called from the render tail
   *  of Game.frame() — presentation only, never read back by the sim. */
  setSpeedBlur(strength: number, focusU = 0.5, focusV = 0.55): void {
    this.speedBlur.setStrength(strength);
    this.speedBlur.setFocus(focusU, focusV);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
