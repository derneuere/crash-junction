import * as THREE from 'three';

/** Round burn decals stamped on the asphalt. */
export class Scorch {
  private pool: THREE.Mesh[] = [];
  private idx = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.CircleGeometry(1.3, 12);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0x07080a, transparent: true, opacity: 0.38, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.022 + i * 0.0008;
      m.visible = false;
      scene.add(m);
      this.pool.push(m);
    }
  }

  add(x: number, z: number, scale = 1): void {
    const m = this.pool[this.idx++ % this.pool.length];
    m.position.x = x;
    m.position.z = z;
    m.scale.setScalar(scale * (0.8 + Math.random() * 0.8));
    m.rotation.z = Math.random() * Math.PI * 2;
    m.visible = true;
  }

  reset(): void {
    for (const m of this.pool) m.visible = false;
  }
}
