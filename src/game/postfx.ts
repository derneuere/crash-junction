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

// The film-look chain ("cinematic" gfx tier): HDR scene render → ambient
// occlusion → per-pixel motion blur → bloom → ACES tonemap → vignette /
// chromatic aberration / grain. In three r152+, renderer-level tone mapping
// only applies when drawing straight to the canvas, so ACES moves into the
// chain here; the renderer's exposure still flows through (three binds the
// toneMappingExposure uniform on any program that declares it).
//
// All of it is presentation-only — the sim and the replay hashes never see
// a pixel. The "fast" tier bypasses this entirely (Game falls back to
// renderer.render with renderer-level ACES, today's exact path).

export class Postfx {
  private composer: EffectComposer;

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

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  dispose(): void {
    this.composer.dispose();
  }
}
