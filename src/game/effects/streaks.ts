import * as THREE from 'three';

const N = 96; // pooled segments — the doc's budget, reused ring-style
const ONSET = 30; // m/s — below this the air reads calm
const FULL = 48; // m/s — boost top speed, max spawn rate
const MAX_RATE = 80; // streaks per second at FULL
const LIFE = 0.15; // s
const ALPHA = 0.25;
const R_MIN = 5; // cylinder radius around the camera-forward axis (m)
const R_MAX = 9;
const AHEAD_MIN = 6; // spawn distance ahead of the camera (m)
const AHEAD_MAX = 14;

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Peripheral wind streaks (sense-of-speed A3): the cheap stand-in for
 *  radial blur. Short additive line segments spawn on a cylinder around the
 *  camera-forward axis ahead of the camera and stream past, elongated along
 *  the travel direction — peripheral optic flow is where the speed read
 *  lives, so this is most of what a full-screen blur pass would buy, for
 *  the cost of one LineSegments draw.
 *
 *  Geometry keeps the road sharp by construction: with radius ≥ 5 m and
 *  spawn distance ≤ 14 m every streak sits ≥ atan(5/14) ≈ 20° off-axis,
 *  clear of the central ±15° the doc wants untouched.
 *
 *  PRESENTATION ONLY: reads the camera and the controller speed, rolls
 *  Math.random (never simRand), writes nothing physics or worldHash can
 *  see — replays and the determinism pins are untouched. */
export class Streaks {
  // two verts per segment for the LineSegments buffer…
  private pos = new Float32Array(N * 6).fill(-999);
  private col = new Float32Array(N * 6);
  // …plus per-streak head/axis/velocity state for the update walk
  private head = new Float32Array(N * 3);
  private axis = new Float32Array(N * 3); // unit travel direction at spawn
  private len = new Float32Array(N);
  private vel = new Float32Array(N); // world drift speed along -axis
  private life = new Float32Array(N);
  private idx = 0;
  private alive = 0;
  private acc = 0; // fractional spawns carried between frames
  private geo = new THREE.BufferGeometry();

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const lines = new THREE.LineSegments(
      this.geo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    lines.frustumCulled = false;
    scene.add(lines);
  }

  /** Per rendered frame, after the camera director has moved the camera.
   *  `speed` is the player's controller speed in m/s (0 while not driving). */
  frame(dt: number, camera: THREE.PerspectiveCamera, speed: number, boosting: boolean): void {
    // spawn ramp: nothing below 30 m/s, 80/s at boost top speed — the
    // streaks themselves are the "you are now going FAST" signal
    const rate = Math.min(1, Math.max(0, (speed - ONSET) / (FULL - ONSET))) * MAX_RATE;
    if (rate > 0) {
      this.acc += rate * dt;
      let n = Math.floor(this.acc);
      this.acc -= n;
      // camera basis: the camera sits at scene level, so its quaternion is
      // already world-space. Read-only — presentation may look, never touch.
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
      while (n-- > 0) this.spawn(camera.position, speed, boosting);
    } else {
      this.acc = 0;
    }
    if (this.alive === 0) return;

    const { pos, col, head, axis, len, vel, life } = this;
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        this.alive--;
        pos[i * 6 + 1] = pos[i * 6 + 4] = -999;
        continue;
      }
      // drift backwards along the spawn axis — the camera's own motion adds
      // the other half of the closure, so streaks always pass the eye
      const d = vel[i] * dt;
      head[i * 3] -= axis[i * 3] * d;
      head[i * 3 + 1] -= axis[i * 3 + 1] * d;
      head[i * 3 + 2] -= axis[i * 3 + 2] * d;
      const l = len[i];
      pos[i * 6] = head[i * 3];
      pos[i * 6 + 1] = head[i * 3 + 1];
      pos[i * 6 + 2] = head[i * 3 + 2];
      pos[i * 6 + 3] = head[i * 3] + axis[i * 3] * l;
      pos[i * 6 + 4] = head[i * 3 + 1] + axis[i * 3 + 1] * l;
      pos[i * 6 + 5] = head[i * 3 + 2] + axis[i * 3 + 2] * l;
      // triangle envelope: fade in fast, out fast — additive lines, so the
      // vertex color IS the alpha; a cool tint keeps them reading as air
      const a = ALPHA * Math.sin(Math.PI * Math.max(0, life[i] / LIFE));
      col[i * 6] = col[i * 6 + 3] = a * 0.85;
      col[i * 6 + 1] = col[i * 6 + 4] = a * 0.92;
      col[i * 6 + 2] = col[i * 6 + 5] = a;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private spawn(camPos: THREE.Vector3, speed: number, boosting: boolean): void {
    const i = this.idx++ % N;
    if (this.life[i] <= 0) this.alive++;
    const th = Math.random() * Math.PI * 2;
    const r = R_MIN + Math.random() * (R_MAX - R_MIN);
    const ahead = AHEAD_MIN + Math.random() * (AHEAD_MAX - AHEAD_MIN);
    const cx = Math.cos(th) * r;
    const cy = Math.sin(th) * r;
    this.head[i * 3] = camPos.x + _fwd.x * ahead + _right.x * cx + _up.x * cy;
    this.head[i * 3 + 1] = camPos.y + _fwd.y * ahead + _right.y * cx + _up.y * cy;
    this.head[i * 3 + 2] = camPos.z + _fwd.z * ahead + _right.z * cx + _up.z * cy;
    this.axis[i * 3] = _fwd.x;
    this.axis[i * 3 + 1] = _fwd.y;
    this.axis[i * 3 + 2] = _fwd.z;
    // streak length 0.08·v (doc tunable), a touch longer under boost — the
    // smear, not the count, is what sells the extra closing speed
    this.len[i] = 0.08 * speed * (boosting ? 1.25 : 1);
    this.vel[i] = 0.6 * speed + 8;
    // jitter only downward — the envelope normalizes by LIFE, so a life
    // above it would start the sine past π and flash negative color
    this.life[i] = LIFE * (0.7 + Math.random() * 0.3);
  }

  reset(): void {
    this.life.fill(0);
    this.pos.fill(-999);
    this.alive = 0;
    this.acc = 0;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
