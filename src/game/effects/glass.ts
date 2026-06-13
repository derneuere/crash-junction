import * as THREE from 'three';

const N = 320; // a touch deeper pool — a full windscreen blow throws a lot

/** Pale glittering window shards — the Sparks family, but glassy: cool
 *  tones, normal blending, a hard fall and one weak bounce. Each shard
 *  carries its own size and a twinkle phase so the burst reads as tumbling
 *  splinters catching the light, not a uniform puff. A harder hit (bigger
 *  `power`) throws faster, wider and slightly larger shards. */
export class GlassFX {
  private pos = new Float32Array(N * 3).fill(-999);
  private col = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private size = new Float32Array(N).fill(1);
  private phase = new Float32Array(N); // twinkle offset per shard
  private life = new Float32Array(N);
  private idx = 0;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.PointsMaterial;

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    // per-shard point size: three reads a `size` attribute only via a shader
    // tweak, so drive variety through colour brightness + an onBeforeCompile
    // size attribute. Simpler and just as readable: bake size into the base
    // PointsMaterial size and modulate brightness per shard (small shards read
    // dimmer), which keeps the material stock and composer-safe.
    this.mat = new THREE.PointsMaterial({
      size: 0.1, vertexColors: true, transparent: true, opacity: 0.92,
      depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(this.geo, this.mat);
    points.frustumCulled = false;
    scene.add(points);
  }

  spawn(p: THREE.Vector3, n: number, power: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.idx++ % N;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.55;
      this.pos[i * 3 + 1] = Math.max(0.05, p.y + (Math.random() - 0.2) * 0.45);
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.55;
      // a flat-ish lateral spray (glass sheets out sideways) with a few that
      // pop up high; faster hits throw wider
      const th = Math.random() * Math.PI * 2;
      const sp = 1.6 + Math.random() * (1.8 + power);
      this.vel[i * 3] = Math.cos(th) * sp;
      this.vel[i * 3 + 1] = 0.8 + Math.random() * (2.2 + power * 0.3);
      this.vel[i * 3 + 2] = Math.sin(th) * sp;
      // shard size: mostly fine grit, a few big chunks; harder hits coarser
      const big = Math.random() < 0.18 + power * 0.02;
      this.size[i] = big ? 1.4 + Math.random() * 1.1 : 0.55 + Math.random() * 0.5;
      this.phase[i] = Math.random() * Math.PI * 2;
      this.life[i] = 0.55 + Math.random() * 0.6;
    }
  }

  update(dt: number): void {
    const { pos, vel, col, size, phase, life } = this;
    for (let i = 0; i < N; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        pos[i * 3 + 1] = -999;
        continue;
      }
      vel[i * 3 + 1] -= 17 * dt; // glass drops, it doesn't float
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.02) {
        pos[i * 3 + 1] = 0.02;
        vel[i * 3 + 1] *= -0.22;
        vel[i * 3] *= 0.5;
        vel[i * 3 + 2] *= 0.5;
      }
      // glint: a fast twinkle so tumbling shards flash; small shards read
      // dimmer (size baked into brightness), a few flare bright white. The
      // twinkle uses the shard's own phase so the field sparkles incoherently.
      const tw = 0.5 + 0.5 * Math.sin(phase[i] + life[i] * 22);
      const flash = Math.random() < 0.1 ? 1 : 0;
      const sz = Math.min(1, size[i] * 0.7);
      const b = Math.max(0.35, flash ? 1 : (0.5 + life[i] * 0.32) * (0.55 + sz * 0.55) * (0.7 + tw * 0.4));
      col[i * 3] = b * 0.84;
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b;
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
