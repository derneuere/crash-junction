import type * as THREE from 'three';
import { Sparks } from './sparks';
import { Smoke } from './smoke';
import { Debris } from './debris';
import { Scorch } from './scorch';
import { Skidmarks } from './skidmarks';
import { ExplosionFX } from './explosion';
import { GlassFX } from './glass';
import { Streaks } from './streaks';

/** All pooled visual effects behind one update/reset. */
export class Effects {
  readonly sparks: Sparks;
  readonly smoke: Smoke;
  readonly debris: Debris;
  readonly scorch: Scorch;
  readonly skid: Skidmarks;
  readonly explosion: ExplosionFX;
  readonly glass: GlassFX;
  readonly streaks: Streaks;

  constructor(scene: THREE.Scene) {
    this.sparks = new Sparks(scene);
    this.smoke = new Smoke(scene);
    this.debris = new Debris(scene);
    this.scorch = new Scorch(scene);
    this.skid = new Skidmarks(scene);
    this.explosion = new ExplosionFX(scene, this.smoke);
    this.glass = new GlassFX(scene);
    this.streaks = new Streaks(scene);
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
    this.skid.update(dt);
    this.explosion.update(dt);
    this.glass.update(dt);
    // streaks tick via their own frame() — they need the camera + player
    // speed, which the Game passes after the camera director has run
  }

  reset(): void {
    this.sparks.reset();
    this.smoke.reset();
    this.debris.reset();
    this.scorch.reset();
    this.skid.reset();
    this.explosion.reset();
    this.glass.reset();
    this.streaks.reset();
  }
}
