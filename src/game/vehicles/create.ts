import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Actor, CollideEvent, DeformablePart, VehicleSpawn } from '../types';
import { GROUP_DECOR, type PhysicsContext } from '../physics';
import { simRand } from '../rng';
import { GLASS, cabinMat, hullMat, makeBoxHullGeometry, makeSedanGeometry, makeTankGeometry, metalMat, adoptPlayerMaterials } from '../geometry';
import { buildPanels } from '../panels';
import { makeBarrelTexture } from '../textures';
import { getVehicleModel } from '../models';
import { SPECS } from './specs';
import {
  buildSuspension, buildWheels, makeActor, makeModelHull, makeVehicleLights, registerDeformable,
  type CollideHandler,
} from './factory';

export function createVehicle(
  scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler,
  spawn: VehicleSpawn, isPlayer: boolean,
): Actor {
  const spec = SPECS[spawn.variant];
  const group = new THREE.Group();
  const deformables: DeformablePart[] = [];
  const model = getVehicleModel(spawn.variant, isPlayer);

  if (model) {
    const hull = makeModelHull(model, spawn.color);
    group.add(hull);
    registerDeformable(hull, deformables, model.glassRanges, model.headRanges, model.tailRanges, model.reverseRanges);
    if (model.interior) {
      // stripped-chassis innards — wounds show these, not daylight
      const inner = new THREE.Mesh(model.interior.clone(), [metalMat, cabinMat]);
      group.add(inner);
      registerDeformable(inner, deformables);
    }
  } else if (spawn.variant === 'sedan') {
    const hull = new THREE.Mesh(makeSedanGeometry(spec.width, spec.height, spec.length, spawn.color, GLASS), hullMat);
    hull.position.y = spec.hullY;
    hull.castShadow = hull.receiveShadow = true;
    group.add(hull);
    registerDeformable(hull, deformables);
  } else if (spawn.variant === 'bus') {
    const hull = new THREE.Mesh(makeBoxHullGeometry(spec.width, spec.height, spec.length, spawn.color, GLASS), hullMat);
    hull.position.y = spec.hullY;
    hull.castShadow = hull.receiveShadow = true;
    group.add(hull);
    registerDeformable(hull, deformables);
  } else {
    // tanker: cab up front, fuel tank behind (the tank never detaches —
    // it's the explosive payload, like BP's eAncillaries_PetrolTank_Truck)
    const cab = new THREE.Mesh(makeBoxHullGeometry(2.2, 2.0, 2.2, spawn.color, GLASS, 0.45, 0.88), hullMat);
    cab.position.set(0, 0.05, -3.3);
    cab.castShadow = cab.receiveShadow = true;
    group.add(cab);
    registerDeformable(cab, deformables);
    const tank = new THREE.Mesh(makeTankGeometry(1.0, 6.2, 0xd8dde2), hullMat);
    tank.position.set(0, 0.3, 0.9);
    tank.castShadow = tank.receiveShadow = true;
    group.add(tank);
    registerDeformable(tank, deformables);
  }

  const panels = buildPanels(group, spec, spawn.color, deformables, model);

  if (isPlayer && !model) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.07, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x551612, roughness: 0.5, flatShading: true }),
    );
    wing.position.set(0, 0.78, 2.0);
    wing.castShadow = true;
    group.add(wing);
  }

  const wheels = buildWheels(spec, group, model);
  const nightLights = makeVehicleLights(spec, group);
  // the player's paint/glass/lens/panel materials swap to the live
  // CubeCamera reflection set (one traversal — panels hang in the group)
  if (isPlayer) adoptPlayerMaterials(group);
  scene.add(group);

  const body = new CANNON.Body({ mass: isPlayer ? spec.mass + 130 : spec.mass, material: phys.matCar });
  body.addShape(new CANNON.Box(new CANNON.Vec3(spec.width / 2, spec.halfY, spec.length / 2)));
  // ground clearance is tiny — the chassis box must never hard-clip ramp
  // kinks or plinth edges, the suspension height field drives over those.
  // Wrecks get the full mask back (Game.markCrashed) and tumble on décor.
  body.collisionFilterMask = ~GROUP_DECOR;
  body.position.set(spawn.x, spec.rideHeight, spawn.z);
  const yaw = Math.atan2(spawn.dir.x, spawn.dir.z) + Math.PI; // hull forward is -z
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  body.linearDamping = 0.05;
  body.angularDamping = 0.3;
  // traffic sleeps until its wave starts; the player must never doze off
  // while waiting at the line (velocity writes don't wake a sleeping body)
  body.allowSleep = !isPlayer;
  phys.world.addBody(body);
  if (!isPlayer) body.sleep();

  const susp = buildSuspension(spec, wheels, body.mass);

  const actor = makeActor('vehicle', body, group, spec.valueMult, spec.cashCap);
  actor.spec = spec;
  actor.model = model;
  actor.wheels = wheels;
  actor.susp = susp;
  actor.deformables = deformables;
  actor.panels = panels;
  actor.nightLights = nightLights;
  actor.scripted = { dir: { x: spawn.dir.x, z: spawn.dir.z }, speed: spawn.speed, delay: spawn.delay ?? 0 };
  actor.curSpeed = isPlayer ? 0 : spawn.speed;
  actor.isPlayer = isPlayer;
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.6, metalness: 0.4 });
const poleHeadMat = new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: 0xff9a2a, emissiveIntensity: 0.9 });
poleHeadMat.userData.night = { intensity: 2.2, day: 0.9 };
const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 4.8, 8);
const poleHeadGeo = new THREE.BoxGeometry(0.34, 0.8, 0.3);

/** `baseY` is the road-grade elevation under the pole (elevation.md Phase 1:
 *  furniture learns a y). Flat levels pass the sampler's literal-0 base, so
 *  the spawn position stays bit-identical there — only furniture seated on
 *  the GANTRY POINT north arc actually lifts. */
export function createPole(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number, baseY = 0): Actor {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.castShadow = true;
  group.add(pole);
  const head = new THREE.Mesh(poleHeadGeo, poleHeadMat);
  head.position.set(0, 2.0, 0.22);
  head.castShadow = true;
  group.add(head);
  // a real lamp at night — parented to the pole, so a toppled streetlight
  // drags its glow across the asphalt with it
  const lamp = new THREE.PointLight(0xffc97a, 50, 18, 1.8);
  lamp.position.set(0, 1.95, 0.28);
  lamp.visible = false;
  group.add(lamp);
  scene.add(group);

  const body = new CANNON.Body({ mass: 90, material: phys.matCar });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.13, 2.4, 0.13)));
  body.position.set(x, baseY + 2.4, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(-x, -z)); // signal faces the junction
  body.linearDamping = 0.05;
  body.angularDamping = 0.2;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.4;
  body.sleepTimeLimit = 0.3;
  phys.world.addBody(body);
  body.sleep();

  const actor = makeActor('pole', body, group, 0.5, 900);
  actor.nightLights = { lamp };
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

let barrelTex: THREE.CanvasTexture | null = null;
const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.85, 12);

/** `baseY` as in createPole — barrels at the LOOKOUT LEDGE mouth sit on a
 *  +6 m embankment; without the lift they spawn buried inside it, inert. */
export function createBarrel(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number, baseY = 0): Actor {
  if (!barrelTex) barrelTex = makeBarrelTexture();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({ map: barrelTex, roughness: 0.55, metalness: 0.25 }));
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);

  const body = new CANNON.Body({ mass: 55, material: phys.matCar });
  body.addShape(new CANNON.Cylinder(0.32, 0.32, 0.85, 10));
  body.position.set(x, baseY + 0.425, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), simRand() * Math.PI);
  body.linearDamping = 0.1;
  body.angularDamping = 0.2;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.3;
  body.sleepTimeLimit = 0.4;
  phys.world.addBody(body);
  body.sleep();

  const actor = makeActor('barrel', body, group, 0.4, 2200);
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}
