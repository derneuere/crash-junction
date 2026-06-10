import * as THREE from 'three';

// Rubber laid down while drifting: a ring buffer of dark quads, one trail
// per rear tyre, fading out over a few seconds. Like the scorch decals,
// segments are stamped at road level — good enough for the flat maps.

const MAX = 900; // quad segments in the ring buffer
const WIDTH = 0.14; // half-width of a tyre stripe
const SEGMENT = 0.45; // minimum travel (m) before a new quad is laid
const MAX_ALPHA = 0.72;
const FADE = 0.1; // alpha per second

export class Skidmarks {
  private geo = new THREE.BufferGeometry();
  private posArr = new Float32Array(MAX * 4 * 3);
  private colArr = new Float32Array(MAX * 4 * 4); // RGBA per vertex
  private life = new Float32Array(MAX);
  private idx = 0;
  private lastL = new THREE.Vector3();
  private lastR = new THREE.Vector3();
  private down = false; // tyres currently laying rubber

  constructor(scene: THREE.Scene) {
    const indices = new Uint32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const v = i * 4;
      const t = i * 6;
      indices[t] = v;
      indices[t + 1] = v + 2;
      indices[t + 2] = v + 1;
      indices[t + 3] = v + 1;
      indices[t + 4] = v + 2;
      indices[t + 5] = v + 3;
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colArr, 4));
    this.geo.setIndex(new THREE.BufferAttribute(indices, 1));
    const mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    );
    mesh.frustumCulled = false;
    scene.add(mesh);
  }

  /** Feed the two rear-tyre ground points every frame while sliding. */
  stamp(left: THREE.Vector3, right: THREE.Vector3): void {
    if (!this.down) {
      this.lastL.copy(left);
      this.lastR.copy(right);
      this.down = true;
      return;
    }
    const jump = this.lastL.distanceToSquared(left);
    if (jump < SEGMENT * SEGMENT) return;
    if (jump > 3 * 3) {
      // teleport / heavily-throttled background frame — restart the trail
      this.lastL.copy(left);
      this.lastR.copy(right);
      return;
    }
    this.segment(this.lastL, left);
    this.segment(this.lastR, right);
    this.lastL.copy(left);
    this.lastR.copy(right);
  }

  /** The slide ended — don't connect to the next one. */
  lift(): void {
    this.down = false;
  }

  private segment(a: THREE.Vector3, b: THREE.Vector3): void {
    const i = this.idx++ % MAX;
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const px = -dz * WIDTH;
    const pz = dx * WIDTH;
    const y = 0.022 + (i % 7) * 0.0007; // staggered to dodge z-fighting
    const P = this.posArr;
    const o = i * 12;
    P[o] = a.x - px;
    P[o + 1] = y;
    P[o + 2] = a.z - pz;
    P[o + 3] = a.x + px;
    P[o + 4] = y;
    P[o + 5] = a.z + pz;
    P[o + 6] = b.x - px;
    P[o + 7] = y;
    P[o + 8] = b.z - pz;
    P[o + 9] = b.x + px;
    P[o + 10] = y;
    P[o + 11] = b.z + pz;
    this.life[i] = MAX_ALPHA;
    const C = this.colArr;
    for (let k = 0; k < 4; k++) {
      const co = i * 16 + k * 4;
      C[co] = 0.012;
      C[co + 1] = 0.014;
      C[co + 2] = 0.016;
      C[co + 3] = MAX_ALPHA;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number): void {
    const C = this.colArr;
    let touched = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= FADE * dt;
      const a = Math.max(0, this.life[i]);
      const co = i * 16;
      C[co + 3] = a;
      C[co + 7] = a;
      C[co + 11] = a;
      C[co + 15] = a;
      touched = true;
    }
    if (touched) (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.colArr.fill(0);
    this.down = false;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
