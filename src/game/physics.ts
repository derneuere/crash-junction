import * as CANNON from 'cannon-es';
import { GRAVITY } from './constants';

/** Collision group for drivable terrain décor (ramps, sidewalk plinths).
 *  Live vehicle chassis exclude this group from their mask: the suspension
 *  height field is what drives over these, so the box never hard-clips a
 *  ramp kink or plinth edge (the wheels have suspension, you know). Wrecks
 *  get the full mask back and tumble over everything. */
export const GROUP_DECOR = 2;

export interface PhysicsContext {
  world: CANNON.World;
  matGround: CANNON.Material;
  matCar: CANNON.Material;
  groundBody: CANNON.Body;
  /** Static scenery (ground, sidewalks, ramps) that should neither wreck
   *  the player nor trigger crashtime when touched. Buildings are NOT in
   *  here — slamming a wall at full speed is a crash. */
  noCrashIds: Set<number>;
}

export function createPhysics(): PhysicsContext {
  const world = new CANNON.World();
  world.gravity.set(0, GRAVITY, 0);
  world.broadphase = new CANNON.SAPBroadphase(world);
  (world.solver as CANNON.GSSolver).iterations = 10;
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.35;
  world.defaultContactMaterial.restitution = 0.3;

  const matGround = new CANNON.Material('ground');
  const matCar = new CANNON.Material('car');
  world.addContactMaterial(new CANNON.ContactMaterial(matGround, matCar, { friction: 0.65, restitution: 0.03 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matCar, matCar, { friction: 0.25, restitution: 0.45 }));

  const groundBody = new CANNON.Body({ mass: 0, material: matGround });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
  world.addBody(groundBody);

  return { world, matGround, matCar, groundBody, noCrashIds: new Set([groundBody.id]) };
}
