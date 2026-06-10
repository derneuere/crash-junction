import type * as THREE from 'three';
import { CB_PER_WRECK } from './constants';
import type { Actor } from './types';
import type { EventBus, ScoreEvents } from './events';

/** Crash-scoring: the damage-cash total, the pickup multiplier, the
 *  crashbreaker meter and the on-screen cash floaters. All payout formulas
 *  live here; after construction this is the only writer of Actor.cashLeft.
 *  Modes that score compose a Scoreboard — a race has none. */
export class Scoreboard {
  private damage = 0;
  private displayed = 0;
  private lastEmitted = -1;
  private mult = 1;
  private cb = 0; // crashbreaker meter 0..1 — earned by wrecking cars
  private cashId = 0;
  private blastPayout = 0;

  constructor(
    private events: EventBus<ScoreEvents>,
    /** World point → HUD pixel coords, or null when behind the camera. */
    private project: (p: THREE.Vector3) => { x: number; y: number } | null,
  ) {}

  get total(): number {
    return this.damage;
  }

  /** Take up to `amount` from an actor's remaining damage-money budget. */
  private draw(a: Actor, amount: number): number {
    const pay = Math.min(a.cashLeft, amount);
    a.cashLeft -= pay;
    return pay;
  }

  /** Collision payout — drawn from this actor's finite damage budget, so a
   *  car (or a wreck grinding the road) can only ever pay out its full value. */
  impactPayout(self: Actor, impact: number, scenery: boolean, p: THREE.Vector3, showFloat: boolean): void {
    const dmg = this.draw(self, impact * (scenery ? 80 : 135) * (0.85 + Math.random() * 0.3) * self.valueMult * this.mult);
    this.damage += dmg;
    if (dmg > 800 && showFloat) this.floatAt(p, '+$' + Math.round(dmg).toLocaleString('en-US'));
  }

  /** Shunt takedown: drain a chunk of the victim's value on top of the hit. */
  takedownBonus(victim: Actor, p: THREE.Vector3): void {
    const bonus = this.draw(victim, 2500 * victim.valueMult * this.mult);
    if (bonus > 0) {
      this.damage += bonus;
      this.floatAt(p, '+$' + Math.round(bonus).toLocaleString('en-US'));
    }
  }

  /** Explosions pay one lump sum: a per-detonation base plus a draw from
   *  every vehicle caught in the blast, floated once at the fireball. */
  beginBlast(power: number): void {
    this.blastPayout = 1500 * power * this.mult; // one-shot per detonation
  }

  blastDraw(a: Actor, power: number, fall: number): void {
    this.blastPayout += this.draw(a, 950 * power * fall * a.valueMult * this.mult);
  }

  endBlast(p: THREE.Vector3): void {
    this.damage += this.blastPayout;
    this.floatAt(p, '+$' + Math.round(this.blastPayout).toLocaleString('en-US'));
    this.blastPayout = 0;
  }

  /** Each non-player vehicle wrecked charges the meter a step, Revenge-style. */
  chargeCrashbreaker(): void {
    this.cb = Math.min(1, this.cb + CB_PER_WRECK);
    this.events.emit('crashbreaker', this.cb);
  }

  /** True when the meter was full — spends it. */
  spendCrashbreaker(): boolean {
    if (this.cb < 1) return false;
    this.cb = 0; // spent — wreck more cars to charge it again
    this.events.emit('crashbreaker', 0);
    return true;
  }

  /** Pickup rings only ever raise the multiplier. */
  raiseMultiplier(m: number): void {
    if (m > this.mult) {
      this.mult = m;
      this.events.emit('multiplier', m);
    }
  }

  floatAt(p: THREE.Vector3, text: string): void {
    const at = this.project(p);
    if (!at) return;
    this.events.emit('cash', { id: this.cashId++, x: at.x, y: at.y, text });
  }

  /** Per-render-frame: ease the displayed total toward the real one. */
  update(dt: number): void {
    this.displayed += (this.damage - this.displayed) * Math.min(1, dt * 6);
    if (this.damage - this.displayed < 1) this.displayed = this.damage;
    const v = Math.round(this.displayed);
    if (v !== this.lastEmitted) {
      this.lastEmitted = v;
      this.events.emit('damage', v);
    }
  }

  /** Zero everything and resync the HUD. */
  reset(): void {
    this.damage = 0;
    this.displayed = 0;
    this.lastEmitted = -1;
    this.mult = 1;
    this.cb = 0;
    this.blastPayout = 0;
    this.events.emit('damage', 0);
    this.events.emit('crashbreaker', 0);
    this.events.emit('multiplier', 1);
  }
}
