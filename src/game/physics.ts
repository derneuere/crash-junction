import * as CANNON from 'cannon-es';
import { GRAVITY } from './constants';

/** Collision group for drivable terrain décor (ramps, sidewalk plinths).
 *  Live vehicle chassis exclude this group from their mask: the suspension
 *  height field is what drives over these, so the box never hard-clips a
 *  ramp kink or plinth edge (the wheels have suspension, you know). Wrecks
 *  get the full mask back and tumble over everything. */
export const GROUP_DECOR = 2;

/**
 * cannon-es's SAPBroadphase with the static-body scan degeneration fixed.
 *
 * The stock inner loop tests `needBroadphaseCollision` BEFORE the sorted-axis
 * bounds test and `continue`s on rejection — so for a STATIC or SLEEPING body
 * (the reject is "both static-or-sleeping") the `break` that ends the sweep is
 * never reached and the loop scans the ENTIRE remaining list. Our world holds
 * ~490 static prop/wall/building bodies out of ~515, which degenerates the
 * sweep to O(n²): measured ~265k rejected-pair calls — ~1.0 ms — per frame,
 * 60% of the whole sim step.
 *
 * The fix keeps the emitted pair list BIT-IDENTICAL (same pairs, same order,
 * same early-exit points — replay determinism is proven by the replay suite):
 *  - bodies are flagged once per sweep as "inert" (static or sleeping — the
 *    exact reject predicate);
 *  - an inert body only sweeps the ascending list of NON-inert bodies ahead
 *    of it: every skipped inert-inert pair is one the stock loop `continue`d
 *    over without side effects, and the first bounds-fail against a non-inert
 *    body breaks exactly where the stock loop would have;
 *  - non-inert bodies sweep the full tail as before (their sweep already
 *    terminates quickly — every pair reaches the bounds test).
 */
class StaticAwareSAPBroadphase extends CANNON.SAPBroadphase {
  private inert: boolean[] = [];
  private awakeIdx: number[] = [];

  collisionPairs(world: CANNON.World, p1: CANNON.Body[], p2: CANNON.Body[]): void {
    const bodies = this.axisList;
    const N = bodies.length;
    const axisIndex = this.axisIndex;
    if (this.dirty) {
      this.sortList();
      this.dirty = false;
    }
    const inert = this.inert;
    const awake = this.awakeIdx;
    inert.length = N;
    awake.length = 0;
    for (let i = 0; i < N; i++) {
      const b = bodies[i];
      const isInert = (b.type & CANNON.Body.STATIC) !== 0 || b.sleepState === CANNON.Body.SLEEPING;
      inert[i] = isInert;
      if (!isInert) awake.push(i);
    }
    let a = 0; // first entry of `awake` whose index is > i (amortized O(N))
    for (let i = 0; i !== N; i++) {
      const bi = bodies[i];
      while (a < awake.length && awake[a] <= i) a++;
      if (inert[i]) {
        // only a non-inert bj can survive the reject — visit just those, in
        // the same ascending order the stock sweep would reach them.
        for (let k = a; k < awake.length; k++) {
          const bj = bodies[awake[k]];
          if (!this.needBroadphaseCollision(bi, bj)) continue;
          if (!CANNON.SAPBroadphase.checkBounds(bi, bj, axisIndex)) break;
          this.intersectionTest(bi, bj, p1, p2);
        }
      } else {
        for (let j = i + 1; j < N; j++) {
          const bj = bodies[j];
          if (!this.needBroadphaseCollision(bi, bj)) continue;
          if (!CANNON.SAPBroadphase.checkBounds(bi, bj, axisIndex)) break;
          this.intersectionTest(bi, bj, p1, p2);
        }
      }
    }
  }
}

export interface PhysicsContext {
  world: CANNON.World;
  matGround: CANNON.Material;
  matCar: CANNON.Material;
  groundBody: CANNON.Body;
  /** Static scenery (ground, sidewalks, ramps) that should neither wreck
   *  the player nor trigger crashtime when touched. Buildings are NOT in
   *  here — slamming a wall at full speed is a crash. */
  noCrashIds: Set<number>;
  /** Track-barrier bodies → their along-wall direction. Wall contacts are
   *  judged against this (the segment's side normal), never the raw engine
   *  contact normal — segment END faces would otherwise read as head-ons. */
  wallDirs: Map<number, { x: number; z: number }>;
}

export function createPhysics(): PhysicsContext {
  const world = new CANNON.World();
  world.gravity.set(0, GRAVITY, 0);
  world.broadphase = new StaticAwareSAPBroadphase(world);
  (world.solver as CANNON.GSSolver).iterations = 10;
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.35;
  world.defaultContactMaterial.restitution = 0.3;

  const matGround = new CANNON.Material('ground');
  const matCar = new CANNON.Material('car');
  world.addContactMaterial(new CANNON.ContactMaterial(matGround, matCar, { friction: 0.65, restitution: 0.03 }));
  // Car-on-car barely bounces. The OLD 0.45 had the solver pop the pair apart
  // on its own, on TOP of the manual shove — a love-tap and a boost-ram both
  // ended with the cars springing off each other, the opposite of Burnout's
  // shunt. Burnout speed-gates restitution to ~0 below a threshold so
  // low-speed shunts STICK and the rammer powers through; we approximate that
  // with a single low coeff and let the contact-normal kick (Game.applyShuntKick,
  // itself speed-gated) own the launch. Low enough that the cars don't visibly
  // separate on their own; the kick decides how far the victim goes.
  world.addContactMaterial(new CANNON.ContactMaterial(matCar, matCar, { friction: 0.25, restitution: 0.12 }));

  const groundBody = new CANNON.Body({ mass: 0, material: matGround });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  world.addBody(groundBody);

  return { world, matGround, matCar, groundBody, noCrashIds: new Set([groundBody.id]), wallDirs: new Map() };
}
