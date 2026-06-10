import * as THREE from 'three';
import { makeFireTexture } from '../textures';
import type { Smoke } from './smoke';

// Just Cause-style explosion: a white-hot core flash, a rolling dome of
// additive fire puffs that cool from white → orange → deep red, a ground
// shockwave ring, a radial dust donut, a lingering black smoke column and
// a point-light flash. Physics impulses live in Game.explode() — this
// module is visuals only.

interface FireParticle {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  max: number;
  base: number;
  grow: number;
  flash: boolean;
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  max: number;
  radius: number;
}

interface Glow {
  light: THREE.PointLight;
  life: number;
  max: number;
  peak: number;
}

interface Column {
  p: THREE.Vector3;
  delay: number;
  dur: number;
  power: number;
  acc: number;
}

const C_HOT = new THREE.Color(1.0, 0.97, 0.82);
const C_MID = new THREE.Color(1.0, 0.55, 0.13);
const C_LOW = new THREE.Color(0.38, 0.06, 0.02);

export class ExplosionFX {
  private pool: FireParticle[] = [];
  private idx = 0;
  private rings: Ring[] = [];
  private ringIdx = 0;
  private glows: Glow[] = [];
  private glowIdx = 0;
  private columns: Column[] = [];

  constructor(scene: THREE.Scene, private smoke: Smoke) {
    const tex = makeFireTexture();
    for (let i = 0; i < 90; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, vel: new THREE.Vector3(), life: 0, max: 1, base: 1, grow: 2, flash: false });
    }

    const ringGeo = new THREE.RingGeometry(0.78, 1, 48);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffc27d, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.07 + i * 0.011; // stacked rings never z-fight
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0, max: 1, radius: 10 });
    }

    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xff8a3c, 0, 60, 2);
      scene.add(light);
      this.glows.push({ light, life: 0, max: 1, peak: 0 });
    }
  }

  spawn(p: THREE.Vector3, power: number): void {
    // white-hot core flash
    this.emit(p, new THREE.Vector3(0, 1.2, 0), 0.28, 2.0 + power, 2.2, true);

    // fireball: a dome of puffs with upward bias — the rolling orange part
    const n = 14 + Math.round(8 * power);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const up = 0.25 + Math.random() * 0.75;
      const horiz = Math.sqrt(Math.max(0, 1 - up * up));
      const dir = new THREE.Vector3(Math.cos(th) * horiz, up, Math.sin(th) * horiz);
      const speed = 3.5 + Math.random() * (4 + 3.5 * power);
      this.emit(
        new THREE.Vector3().copy(p).addScaledVector(dir, 0.4),
        dir.multiplyScalar(speed),
        0.75 + Math.random() * 0.8 + power * 0.12,
        0.9 + Math.random() * (0.5 + 0.55 * power),
        2.6 + power,
        false,
      );
    }

    // ground shockwave ring
    const r = this.rings[this.ringIdx++ % this.rings.length];
    r.mesh.position.x = p.x;
    r.mesh.position.z = p.z;
    r.life = r.max = 0.55;
    r.radius = 11 + 6 * power;
    r.mesh.visible = true;

    // light flash
    const gl = this.glows[this.glowIdx++ % this.glows.length];
    gl.light.position.set(p.x, p.y + 2.5, p.z);
    gl.life = gl.max = 0.5;
    gl.peak = 1100 * power;

    // radial dust donut hugging the ground
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      this.smoke.spawn(new THREE.Vector3(p.x + Math.cos(a) * 1.5, 0.4, p.z + Math.sin(a) * 1.5), {
        big: true,
        vel: new THREE.Vector3(Math.cos(a) * (5 + 2.5 * power), 0.7, Math.sin(a) * (5 + 2.5 * power)),
      });
    }

    // rising black smoke column once the fire fades
    this.columns.push({ p: p.clone(), delay: 0.25, dur: 1.1 + 0.5 * power, power, acc: 0 });
  }

  private emit(p: THREE.Vector3, vel: THREE.Vector3, life: number, base: number, grow: number, flash: boolean): void {
    const f = this.pool[this.idx++ % this.pool.length];
    f.sprite.position.copy(p);
    f.vel.copy(vel);
    f.life = f.max = life;
    f.base = base;
    f.grow = grow;
    f.flash = flash;
    f.sprite.visible = true;
  }

  update(dt: number): void {
    for (const f of this.pool) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const m = f.sprite.material;
      if (f.life <= 0) {
        f.sprite.visible = false;
        m.opacity = 0;
        continue;
      }
      const k = f.life / f.max; // 1 → 0
      const q = 1 - k;
      if (f.flash) {
        const s = f.base * (1 + q * f.grow);
        f.sprite.scale.set(s, s, 1);
        m.color.setRGB(1, 0.96, 0.85);
        m.opacity = Math.pow(k, 1.4);
      } else {
        f.vel.multiplyScalar(1 / (1 + 2.1 * dt));
        f.vel.y += 5.5 * q * dt; // late-life buoyancy: the fireball rolls upward
        f.sprite.position.addScaledVector(f.vel, dt);
        const s = f.base * (0.55 + q * f.grow);
        f.sprite.scale.set(s, s, 1);
        if (k > 0.62) m.color.copy(C_HOT).lerp(C_MID, (1 - k) / 0.38);
        else m.color.copy(C_MID).lerp(C_LOW, 1 - k / 0.62);
        m.opacity = Math.min(1, k * 2.4) * 0.92;
      }
    }

    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        r.mat.opacity = 0;
        continue;
      }
      const q = 1 - r.life / r.max;
      const s = 0.6 + (r.radius - 0.6) * Math.pow(q, 0.62);
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = 0.85 * Math.pow(1 - q, 1.3);
    }

    for (const g of this.glows) {
      if (g.life <= 0) continue;
      g.life -= dt;
      if (g.life <= 0) {
        g.light.intensity = 0;
        continue;
      }
      const k = g.life / g.max;
      g.light.intensity = g.peak * k * k;
    }

    for (let i = this.columns.length - 1; i >= 0; i--) {
      const col = this.columns[i];
      if (col.delay > 0) {
        col.delay -= dt;
        continue;
      }
      col.dur -= dt;
      col.acc -= dt;
      if (col.dur <= 0) {
        this.columns.splice(i, 1);
        continue;
      }
      if (col.acc <= 0) {
        col.acc = 0.07;
        this.smoke.spawn(
          new THREE.Vector3(col.p.x + (Math.random() - 0.5) * 1.2, col.p.y + 0.5, col.p.z + (Math.random() - 0.5) * 1.2),
          { big: true, dark: true, vel: new THREE.Vector3((Math.random() - 0.5) * 0.8, 2.4 + col.power * 0.9, (Math.random() - 0.5) * 0.8) },
        );
      }
    }
  }

  reset(): void {
    for (const f of this.pool) {
      f.life = 0;
      f.sprite.visible = false;
      f.sprite.material.opacity = 0;
    }
    for (const r of this.rings) {
      r.life = 0;
      r.mesh.visible = false;
      r.mat.opacity = 0;
    }
    for (const g of this.glows) {
      g.life = 0;
      g.light.intensity = 0;
    }
    this.columns.length = 0;
  }
}
