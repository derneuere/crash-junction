// Minimal typings for the untyped post-processing companions. Only the
// surface postfx.ts touches — extend if more of their APIs come into play.

declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import { Pass } from 'postprocessing';

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: Color;
      aoSamples: number;
      denoiseSamples: number;
      denoiseRadius: number;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}

declare module 'realism-effects' {
  import type { Camera, Scene } from 'three';
  import { Effect, Pass } from 'postprocessing';

  export class VelocityDepthNormalPass extends Pass {
    constructor(scene: Scene, camera: Camera);
  }

  export class MotionBlurEffect extends Effect {
    constructor(velocityPass: VelocityDepthNormalPass, options?: { intensity?: number; jitter?: number; samples?: number });
  }
}
