import * as THREE from 'three';

const N = 480;

/** GPU point cloud of hot sparks with ground bounce and fire-colored fade. */
export class Sparks {
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
        size: 0.13, vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, sizeAttenuation: true,
      }),
    );
    points.frustumCulled = false;
    scene.add(points);
  }

  spawn(p: THREE.Vector3, n: number, power: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.idx++ % N;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = Math.max(0.05, p.y + (Math.random() - 0.5) * 0.3);
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.3;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.random() * Math.PI;
      const sp = 2 + Math.random() * (2 + power);
      this.vel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this.vel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * 0.9 + 1.2;
      this.vel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
      this.life[i] = 0.35 + Math.random() * 0.55;
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
      vel[i * 3 + 1] -= 14 * dt;
      const drag = 1 / (1 + 1.3 * dt);
      vel[i * 3] *= drag;
      vel[i * 3 + 1] *= drag;
      vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.03) {
        pos[i * 3 + 1] = 0.03;
        vel[i * 3 + 1] *= -0.35;
        vel[i * 3] *= 0.7;
        vel[i * 3 + 2] *= 0.7;
      }
      const l = life[i];
      col[i * 3] = Math.min(1, 0.55 + l * 1.5);
      col[i * 3 + 1] = Math.min(1, l * 1.55);
      col[i * 3 + 2] = l * 0.45;
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
