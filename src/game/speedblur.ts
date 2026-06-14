import * as THREE from 'three';
import { Effect } from 'postprocessing';

// SPEED BLUR — a screen-space radial/zoom motion blur that conveys the car's
// TRANSLATIONAL speed. The world streaks outward from a focal point (the
// screen-projected travel / vanishing point) while a STRONG center-sharp
// falloff keeps the car and the focal region crisp. Only the periphery smears.
// This is the classic Burnout speed blur.
//
// WHY THIS AND NOT A VELOCITY BUFFER: the chase cam moves a STATIC world past a
// translating camera. realism-effects' VelocityDepthNormalPass computes its
// per-object "previous" matrix from the CURRENT camera inside the same render
// call, so static geometry always reports ZERO screen-space velocity under
// pure camera translation — the velocity texture is identically 0 at any speed
// (verified: maxVelUv 0 / nonZeroFrac 0 even at 48 m/s). The per-pixel
// MotionBlurEffect therefore early-outs to the input unchanged and NOTHING
// blurs. Rather than patch a node_modules library's prev-frame bookkeeping, we
// drive a self-contained radial blur from the car's own translational speed.
//
// Presentation-only: the sim/replay hashes never see a pixel of this. The
// strength is fed from the render tail of Game.frame() (below the sim read-back
// line) via setStrength()/setFocus().

// Radial samples per pixel along the streak toward the focal point. More =
// smoother streak at a linear cost; 18 is plenty for a clean smear at 1080p
// without being a swiftshader hog.
const SAMPLES = 18;

const fragmentShader = /* glsl */ `
uniform float strength;   // 0..1 overall blur amount (from car speed)
uniform vec2 focus;       // focal point in UV (the travel vanishing point)
uniform float centerSharp;// radius (UV) inside which the frame stays sharp

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (strength <= 0.0001) {
    outputColor = inputColor;
    return;
  }

  // Vector from the focal point to this pixel. The streak runs ALONG this
  // direction (a zoom/radial blur): samples are taken between the pixel and the
  // focal point, so everything appears to rush past the focus toward the edges.
  vec2 toPixel = uv - focus;
  float dist = length(toPixel);

  // CENTER-SHARP falloff: zero blur inside centerSharp, ramping to full out at
  // the frame edges. smoothstep gives a soft shoulder so there is no hard ring.
  // This is what keeps the CAR (which sits near the focal region) crisp while
  // the periphery / world streaks — i.e. NOT a uniform whole-screen smear.
  float radial = smoothstep(centerSharp, 0.95, dist);

  // total streak length in UV: scaled by strength, the radial falloff, and how
  // far this pixel is from the focus (peripheral pixels travel further). Capped
  // so a focal point off-screen can't run the streak across the whole frame.
  float reach = strength * radial * min(dist, 0.6) * 1.7;
  if (reach <= 0.0) {
    outputColor = inputColor;
    return;
  }

  // sample from the pixel back TOWARD the focus by 'reach', accumulating — the
  // tail points at the vanishing point so the world reads as rushing outward.
  vec2 dir = dist > 1e-5 ? toPixel / dist : vec2(0.0);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${SAMPLES}; i++) {
    float t = float(i) / float(${SAMPLES} - 1);     // 0..1 along the streak
    // weight the head (the true pixel) heavier than the tail so the streak
    // fades out instead of ghosting a hard second image
    float w = 1.0 - t * 0.6;
    vec2 sampleUv = uv - dir * (reach * t);
    acc += texture2D(inputBuffer, sampleUv).rgb * w;
    wsum += w;
  }
  vec3 blurred = acc / max(wsum, 1e-4);
  outputColor = vec4(blurred, inputColor.a);
}
`;

export class SpeedBlurEffect extends Effect {
  constructor() {
    super('SpeedBlurEffect', fragmentShader, {
      uniforms: new Map<string, THREE.Uniform>([
        ['strength', new THREE.Uniform(0)],
        ['focus', new THREE.Uniform(new THREE.Vector2(0.5, 0.55))],
        ['centerSharp', new THREE.Uniform(0.18)],
      ]),
    });
  }

  /** Overall blur amount [0..1], from the car's translational speed (postfx.ts
   *  speedBlurStrength). 0 disables the effect entirely (early-out). */
  setStrength(s: number): void {
    (this.uniforms.get('strength') as THREE.Uniform).value = Math.max(0, Math.min(1, s));
  }

  /** Focal point in UV (the screen-projected travel direction / vanishing
   *  point). Pixels stream radially away from here; the region around it stays
   *  sharp. Defaults to just below screen-centre (down-the-track chase feel). */
  setFocus(u: number, v: number): void {
    (this.uniforms.get('focus') as THREE.Uniform).value.set(u, v);
  }

  /** Radius (UV) of the always-sharp core around the focus. Larger = more of the
   *  frame stays crisp (only the far periphery streaks). */
  setCenterSharp(r: number): void {
    (this.uniforms.get('centerSharp') as THREE.Uniform).value = r;
  }
}
