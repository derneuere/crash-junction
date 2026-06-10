import * as THREE from 'three';
import { GRAVITY } from '../constants';

interface Chunk {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  ang: THREE.Vector3;
  life: number;
  base: number;
  glass: boolean;
}

/** Cheap ballistic chunks (no physics bodies) — panels and glass shards. */
export class Debris {
  private pool: Chunk[] = [];
  private idx = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const matMetal = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.7, flatShading: true });
    const matGlass = new THREE.MeshStandardMaterial({ color: 0xbfe3ff, roughness: 0.15, metalness: 0.1, flatShading: true });
    for (let i = 0; i < 90; i++) {
      const glass = i % 3 === 0;
      const m = new THREE.Mesh(geo, glass ? matGlass : matMetal);
      m.visible = false;
      m.castShadow = true;
      scene.add(m);
      this.pool.push({ mesh: m, vel: new THREE.Vector3(), ang: new THREE.Vector3(), life: 0, base: 1, glass });
    }
  }

  spawn(p: THREE.Vector3, n: number, power: number): void {
    for (let k = 0; k < n; k++) {
      const d = this.pool[this.idx++ % this.pool.length];
      d.life = 2.2 + Math.random() * 1.6;
      d.base = 0.07 + Math.random() * 0.16;
      d.mesh.scale.set(d.base, d.glass ? d.base * 0.18 : d.base, d.base);
      d.mesh.position.set(p.x + (Math.random() - 0.5) * 0.4, p.y + Math.random() * 0.3, p.z + (Math.random() - 0.5) * 0.4);
      const th = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * power * 0.7;
      d.vel.set(Math.cos(th) * sp, 2 + Math.random() * 4, Math.sin(th) * sp);
      d.ang.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      d.mesh.visible = true;
    }
  }

  update(dt: number): void {
    for (const d of this.pool) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        continue;
      }
      d.vel.y += GRAVITY * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.ang.x * dt;
      d.mesh.rotation.y += d.ang.y * dt;
      d.mesh.rotation.z += d.ang.z * dt;
      const r = d.base / 2;
      if (d.mesh.position.y < r && d.vel.y < 0) {
        d.mesh.position.y = r;
        d.vel.y *= -0.42;
        d.vel.x *= 0.62;
        d.vel.z *= 0.62;
        d.ang.multiplyScalar(0.6);
      }
      if (d.life < 0.4) {
        const s = d.base * (d.life / 0.4);
        d.mesh.scale.set(s, d.glass ? s * 0.18 : s, s);
      }
    }
  }

  reset(): void {
    for (const d of this.pool) {
      d.life = 0;
      d.mesh.visible = false;
    }
  }
}
