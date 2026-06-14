import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

// SCREEN-SPACE TRANSLATIONAL MOTION BLUR (the chase-cam speed smear).
//
// A directional, velocity-style blur that streaks the whole finished frame
// along the screen-projected direction the CAMERA IS TRAVELLING THROUGH THE
// WORLD — i.e. driven by the camera's TRANSLATION, never its rotation. When
// the car drives forward the world slides past the lens and the frame smears
// along that flow; when the camera only ROTATES/pans (takedown orbit, idle
// orbit) the translation is ~zero, so the smear vanishes. This is the WebGL2 /
// pmndrs-postprocessing adaptation of the three.js webgpu motion-blur demo's
// idea (camera-motion velocity → directional gather), minus the rotational
// component, which we deliberately exclude on the CPU side (Game.ts feeds only
// the translation-projected direction).
//
// TECHNIQUE — for each pixel:
//   • uVelocity is a screen-space vector (in UV units, already aspect-baked by
//     the caller's projection) pointing along the apparent travel direction,
//     its LENGTH proportional to how fast the camera is translating. Game.ts
//     projects the camera world-position delta into clip space each frame and
//     hands us the resulting screen direction × a speed-scaled magnitude.
//   • gather TAPS samples symmetrically along ±uVelocity (a true directional
//     box/triangle blur centred on the pixel) so the streak reads as motion,
//     not a one-sided ghost. Triangular weights bias toward the pixel itself.
//   • when |uVelocity| ≈ 0 (stationary, or rotating-only) the offsets collapse
//     to the pixel and we early-out pixel-exact — no blur on a pure pan.
//
// CONVOLUTION effect: it reads inputBuffer at several offsets, so it must own
// its own EffectPass (postprocessing can't merge two convolution effects into
// one pass — bloom + chromatic-aberration already force their own splits).
//
// PRESENTATION ONLY: uVelocity is driven per render frame from the camera's
// world-position delta via setVelocity(); the shader reads inputBuffer +
// uniforms and writes pixels. It touches no sim / RNG / camera transform — the
// determinism pins never see it (and ?verify=1 bypasses the whole composer).

const TAPS = 11; // odd: a centre tap + equal taps each side along the velocity

const fragmentShader = /* glsl */ `
// screen-space motion vector in UV units; its length = blur reach (speed). The
// caller projects the camera TRANSLATION delta into screen space, so a pure
// rotation/pan leaves this ~zero and the frame stays sharp.
uniform vec2 uVelocity;

#define TAPS ${TAPS}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // pure rotation / stationary → no translation → no smear (cheap early-out,
  // keeps idle/takedown/menu frames pixel-exact).
  float speed = length(uVelocity);
  if (speed < 1e-4) {
    outputColor = inputColor;
    return;
  }

  // sample symmetrically along ±uVelocity. Half the taps each side of centre;
  // the step is uVelocity spread over that half so the total reach is uVelocity.
  const int HALF = (TAPS - 1) / 2;
  vec2 step = uVelocity / float(HALF);

  vec3 acc = inputColor.rgb;   // centre tap, full weight
  float wsum = 1.0;
  for (int i = 1; i <= HALF; i++) {
    // triangular falloff: nearer taps weigh more → a soft directional streak
    float w = 1.0 - float(i) / float(HALF + 1);
    vec2 off = step * float(i);
    acc += texture2D(inputBuffer, uv + off).rgb * w;
    acc += texture2D(inputBuffer, uv - off).rgb * w;
    wsum += 2.0 * w;
  }
  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

/** Screen-space translational motion blur. Add as its own EffectPass after
 *  AO/bloom/tonemap. Drive setVelocity() per render frame with the screen-space
 *  camera-translation vector (Game.ts projects the world-position delta). */
export class RadialBlurEffect extends Effect {
  constructor() {
    super('TranslationMotionBlur', fragmentShader, {
      // samples inputBuffer at offsets -> convolution -> owns its own pass
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([['uVelocity', new THREE.Uniform(new THREE.Vector2(0, 0))]]),
    });
  }

  /** Per render frame: the screen-space motion vector (UV units). Its length is
   *  the blur reach — feed 0 (or a near-zero vector) to keep the frame
   *  pixel-exact (stationary, idle orbit, or pure camera rotation). The vector
   *  is clamped so a teleport/huge delta can't smear the whole screen.
   *  Presentation-only; safe to call every frame from the render path. */
  setVelocity(x: number, y: number): void {
    const MAX = 0.06; // cap the reach: ≤6% of the frame per side even at top speed
    const v = (this.uniforms.get('uVelocity') as THREE.Uniform).value as THREE.Vector2;
    v.set(x, y);
    const len = v.length();
    if (len > MAX) v.multiplyScalar(MAX / len);
  }
}
