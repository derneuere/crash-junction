import * as THREE from 'three';
import { makeSmokeTexture } from '../textures';

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  grow: number;
  base: number;
  vel: THREE.Vector3;
}

export interface SmokeOptions {
  big?: boolean;
  dark?: boolean;
  vel?: THREE.Vector3;
}

export class Smoke {
  private pool: Puff[] = [];
  private idx = 0;

  constructor(scene: THREE.Scene) {
    const tex = makeSmokeTexture();
    for (let i = 0; i < 64; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, color: 0x868c93 }),
      );
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, life: 0, max: 1, grow: 1, base: 1, vel: new THREE.Vector3() });
    }
  }

  spawn(p: THREE.Vector3, opts: SmokeOptions = {}): void {
    const s = this.pool[this.idx++ % this.pool.length];
    s.life = s.max = (opts.big ? 2.4 : 1.5) + Math.random() * 0.8;
    s.base = opts.big ? 1.5 : 0.9;
    s.grow = opts.big ? 3.0 : 1.8;
    if (opts.vel) s.vel.copy(opts.vel);
    else s.vel.set((Math.random() - 0.5) * 0.7, 1.0 + Math.random() * 0.8, (Math.random() - 0.5) * 0.7);
    s.sprite.position.set(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.3, p.z + (Math.random() - 0.5) * 0.6);
    s.sprite.material.color.setHex(opts.dark ? 0x3c4046 : 0x9aa0a6);
    s.sprite.visible = true;
  }

  update(dt: number): void {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.sprite.visible = false;
        s.sprite.material.opacity = 0;
        continue;
      }
      const k = s.life / s.max;
      s.sprite.position.addScaledVector(s.vel, dt);
      const sc = s.base * (1 + (1 - k) * s.grow);
      s.sprite.scale.set(sc, sc, 1);
      s.sprite.material.opacity = k * (1 - k) * 4 * 0.32;
    }
  }

  reset(): void {
    for (const s of this.pool) {
      s.life = 0;
      s.sprite.visible = false;
      s.sprite.material.opacity = 0;
    }
  }
}
