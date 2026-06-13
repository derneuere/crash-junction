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
import { MotionBlurEffect, VelocityDepthNormalPass } from 'realism-effects';
import { RadialBlurEffect } from './effects/radialBlur';

// The film-look chain — the game's ONLY render path now: HDR scene render →
// ambient occlusion → per-pixel motion blur → bloom → ACES tonemap → vignette
// / chromatic aberration / grain. In three r152+, renderer-level tone mapping
// only applies when drawing straight to the canvas, so ACES moves into the
// chain here; the renderer's exposure still flows through (three binds the
// toneMappingExposure uniform on any program that declares it).
//
// All of it is presentation-only — the sim and the replay hashes never see a
// pixel. The player-facing FAST/CINE tier was removed; the composer is always
// on in real play. The one path that still bypasses it is the headless
// determinism bypass — ?verify=1 replays (and refshot --gfx fast review
// captures) fall back to renderer.render with renderer-level ACES, so
// swiftshader doesn't pay for cine pixels nobody hashes (Game.forceFast).

// Speed → blur-strength curve (m/s). Below ONSET the periphery is sharp; the
// smear ramps in above cruising and saturates near boost top speed. BOOST adds
// an extra kick so nitrous reads as a clear (but not nauseating) edge streak.
const SPEED_ONSET = 34; // m/s — calm below this (matches the wind-streak onset feel)
const SPEED_FULL = 52; // m/s — full smear at/above boost top speed
const BOOST_BONUS = 0.22; // extra strength while boosting (clamped to 1 in the effect)

/** Map player speed (m/s) + boost flag to the radial-blur strength [0..1].
 *  Exported so the wiring (Game.ts) and the effect stay in lockstep. */
export function speedBlurStrength(speed: number, boosting: boolean): number {
  const t = (speed - SPEED_ONSET) / (SPEED_FULL - SPEED_ONSET);
  const base = Math.min(1, Math.max(0, t));
  // ease-in so cruising stays subtle and the climb to top speed is where the
  // periphery really opens up (square the linear ramp)
  return Math.min(1, base * base + (boosting ? BOOST_BONUS : 0));
}

export class Postfx {
  private composer: EffectComposer;
  private radialBlur: RadialBlurEffect;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number) {
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 4, // WebGL2 MSAA on the scene buffer — no SMAA pass needed
    });
    this.composer.addPass(new RenderPass(scene, camera));

    // velocity G-buffer (second scene pass) feeding per-pixel motion blur:
    // the world smears with camera motion, the car — moving with the
    // camera — stays sharp. Exactly the chase-cam footage look.
    const velocity = new VelocityDepthNormalPass(scene, camera);
    this.composer.addPass(velocity);

    const ao = new N8AOPostPass(scene, camera, width, height);
    ao.configuration.halfRes = true;
    ao.configuration.aoRadius = 2.2;
    ao.configuration.distanceFalloff = 0.7;
    ao.configuration.intensity = 2.6;
    this.composer.addPass(ao);

    const motionBlur = new MotionBlurEffect(velocity, { intensity: 0.6, jitter: 0.6 });
    const bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 0.45,
      radius: 0.72,
      luminanceThreshold: 1.4, // true HDR hotspots only: sun, emissives, glints
      luminanceSmoothing: 0.25,
    });
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.composer.addPass(new EffectPass(camera, motionBlur, bloom, tone));

    // RADIAL EDGE SPEED BLUR (its own pass): the scene + AO + per-pixel motion
    // blur + bloom + tonemap are baked into the frame by now, so the radial
    // smear streaks the finished, graded image at the periphery — exactly what
    // a Burnout-3 boost run looks like. It's a CONVOLUTION effect (samples the
    // input at offsets) so it can't share a pass with bloom/aberration anyway;
    // its own EffectPass keeps the chain clean. setSpeedBlur() drives it.
    this.radialBlur = new RadialBlurEffect();
    this.composer.addPass(new EffectPass(camera, this.radialBlur));

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

  /** Per render frame: feed the player's speed (m/s) + boost flag; the radial
   *  edge blur strength follows the speed→strength curve (subtle at cruise,
   *  full peripheral smear near boost top speed). Presentation-only — reads
   *  render state, writes a uniform, never the sim. */
  setSpeedBlur(speed: number, boosting: boolean): void {
    this.radialBlur.setStrength(speedBlurStrength(speed, boosting));
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
