import * as THREE from 'three';

const N = 240;

/** Pale glittering window shards — the Sparks family, but glassy: cool
 *  tones, normal blending, a hard fall and one weak bounce. */
export class GlassFX {
  private pos = new Float32Array(N * 3).fill(-999);
  private col = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private life = new Float32Array(N);
  private idx = 0;
  private geo = new THREE.BufferGeometry();

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const points = new THREE.Points(
      this.geo,
      new THREE.PointsMaterial({
        size: 0.085, vertexColors: true, transparent: true, opacity: 0.9,
        depthWrite: false, sizeAttenuation: true,
      }),
    );
    points.frustumCulled = false;
    scene.add(points);
  }

  spawn(p: THREE.Vector3, n: number, power: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.idx++ % N;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.5;
      this.pos[i * 3 + 1] = Math.max(0.05, p.y + (Math.random() - 0.2) * 0.4);
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.5;
      const th = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * (1.5 + power);
      this.vel[i * 3] = Math.cos(th) * sp;
      this.vel[i * 3 + 1] = 1 + Math.random() * 2.5;
      this.vel[i * 3 + 2] = Math.sin(th) * sp;
      this.life[i] = 0.5 + Math.random() * 0.5;
    }
  }

  update(dt: number): void {
    const { pos, vel, col, life } = this;
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        pos[i * 3 + 1] = -999;
        continue;
      }
      vel[i * 3 + 1] -= 16 * dt; // glass drops, it doesn't float
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02) {
        pos[i * 3 + 1] = 0.02;
        vel[i * 3 + 1] *= -0.2;
        vel[i * 3] *= 0.5;
        vel[i * 3 + 2] *= 0.5;
      }
      // glint: most shards pale blue-white, a few flash bright
      const tw = Math.random() < 0.12 ? 1 : 0.62 + life[i] * 0.3;
      col[i * 3] = tw * 0.82;
      col[i * 3 + 1] = tw * 0.88;
      col[i * 3 + 2] = tw;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.pos.fill(-999);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
