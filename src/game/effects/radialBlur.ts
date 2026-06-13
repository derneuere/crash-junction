import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

// RADIAL EDGE SPEED BLUR (sense-of-speed, the Burnout-3 periphery streak).
//
// A screen-space post effect that smears the FRAME EDGES radially outward from
// screen-centre while leaving the centre sharp. At speed the periphery streaks
// the way the eye reads fast forward motion — the optic-flow vectors all point
// away from the focus of expansion (dead ahead), so a radial smear from the
// centre IS that flow, sold as a blur.
//
// TECHNIQUE — for each pixel:
//   • work in ASPECT-CORRECTED screen space so the blur is circular, not
//     elliptical (a 16:9 frame would otherwise smear harder horizontally).
//   • r = distance from centre (0 at centre, ~1.0 at the frame edge mid-side,
//     ~1.3 in the corners). A smoothstep gate keeps the inner ~45% UNTOUCHED
//     and ramps the smear in toward the edges — the centre stays razor sharp.
//   • sample TAPS times stepping from the pixel back toward the centre along
//     the radius (so the streak points OUTWARD: each pixel pulls colour from
//     nearer the centre, the classic zoom-blur trail). Triangular weights bias
//     toward the pixel itself so the smear reads as a trail, not a wash.
//   • the smear LENGTH scales with uStrength (speed) AND with the edge gate, so
//     even at full strength the centre is clean and only the rim streaks.
//
// CONVOLUTION effect: it reads inputBuffer at several offsets, so it must own
// its own EffectPass (postprocessing can't merge two convolution effects into
// one pass — bloom + chromatic-aberration already force their own splits).
//
// PRESENTATION ONLY: uStrength is driven per render frame from the player's
// speed via setStrength(); the shader reads inputBuffer + uniforms and writes
// pixels. It touches no sim / RNG / camera transform — the determinism pins
// never see it (and ?verify=1 bypasses the whole composer anyway).

const TAPS = 6; // handful of taps — it's a cheap edge effect

const fragmentShader = /* glsl */ `
uniform float uStrength; // 0 = off, 1 = full peripheral smear (speed-driven)

// inner radius (aspect-corrected, ~0..1 mid-side) below which the frame is
// left fully sharp; the smear ramps in from here out to the corners.
#define INNER 0.45
#define OUTER 1.15
#define TAPS ${TAPS}
#define MAX_SHIFT 0.16 // max fraction of the centre->pixel vector smeared at edge+full speed

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // centre->pixel vector, aspect-corrected so r is circular on screen.
  vec2 d = uv - vec2(0.5);
  vec2 dc = d * vec2(aspect, 1.0);
  float r = length(dc);

  // edge gate: 0 inside INNER (sharp centre), ramps to 1 by OUTER.
  float edge = smoothstep(INNER, OUTER, r);

  // nothing to do where the gate or speed is zero — keep the centre pixel-exact
  // and skip the taps entirely (cheap on the dominant inner region).
  float amount = edge * uStrength;
  if (amount <= 0.0) {
    outputColor = inputColor;
    return;
  }

  // smear back toward the centre along the radius: each tap pulls colour from
  // nearer the focus of expansion, so the trail points OUTWARD. The total reach
  // is a fraction of the full centre->pixel vector, scaled by speed * edge.
  vec2 step = -d * (MAX_SHIFT * amount) / float(TAPS - 1);

  vec3 acc = inputColor.rgb;       // tap 0 = the pixel itself (full weight)
  float wsum = 1.0;
  vec2 p = uv;
  for (int i = 1; i < TAPS; i++) {
    p += step;
    // triangular falloff: nearer taps weigh more -> reads as a trailing smear
    float w = 1.0 - float(i) / float(TAPS);
    acc += texture2D(inputBuffer, p).rgb * w;
    wsum += w;
  }
  outputColor = vec4(acc / wsum, inputColor.a);
}
`;

/** Radial/edge speed blur. Add as its own EffectPass after AO/bloom. Drive
 *  setStrength() per render frame from the (normalized) player speed. */
export class RadialBlurEffect extends Effect {
  constructor() {
    super('RadialSpeedBlur', fragmentShader, {
      // samples inputBuffer at offsets -> convolution -> owns its own pass
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([['uStrength', new THREE.Uniform(0)]]),
    });
  }

  /** Per render frame: 0 keeps the frame pixel-exact, 1 is the full peripheral
   *  smear. Presentation-only; safe to call every frame from the render path. */
  setStrength(strength: number): void {
    (this.uniforms.get('uStrength') as THREE.Uniform).value = THREE.MathUtils.clamp(strength, 0, 1);
  }
}
