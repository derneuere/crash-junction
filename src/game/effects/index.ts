import type * as THREE from 'three';
import { Sparks } from './sparks';
import { Smoke } from './smoke';
import { Debris } from './debris';
import { Scorch } from './scorch';
import { Skidmarks } from './skidmarks';
import { ExplosionFX } from './explosion';

/** All pooled visual effects behind one update/reset. */
export class Effects {
  readonly sparks: Sparks;
  readonly smoke: Smoke;
  readonly debris: Debris;
  readonly scorch: Scorch;
  readonly skid: Skidmarks;
  readonly explosion: ExplosionFX;

  constructor(scene: THREE.Scene) {
    this.sparks = new Sparks(scene);
    this.smoke = new Smoke(scene);
    this.debris = new Debris(scene);
    this.scorch = new Scorch(scene);
    this.skid = new Skidmarks(scene);
    this.explosion = new ExplosionFX(scene, this.smoke);
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
    this.skid.update(dt);
    this.explosion.update(dt);
  }

  reset(): void {
    this.sparks.reset();
    this.smoke.reset();
    this.debris.reset();
    this.scorch.reset();
    this.skid.reset();
    this.explosion.reset();
  }
}
