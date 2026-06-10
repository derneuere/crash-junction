import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { LevelDef } from './types';
import { GROUP_DECOR, type PhysicsContext } from './physics';
import { makeChevronTexture, makeWindowTexture } from './textures';
import type { HeightSampler } from './suspension';

/** Vertical height field for the suspension rays: flat road, ramp wedges
 *  and the 0.16 m sidewalk plinths. The chassis box ignores this décor
 *  entirely (GROUP_DECOR filtering) — the springs are the only thing that
 *  touches it, so jumps and kerb hops are pure suspension + ballistics. */
export function makeHeightSampler(level: LevelDef): HeightSampler {
  const ramps = level.ramps;
  const slabs = level.buildings;
  return (x, z) => {
    let h = 0;
    for (const r of ramps) {
      // lateral skirt: the wedge fades out over a metre past its edge, so
      // clipping a ramp side rides up like a steep kerb instead of the
      // height field teleporting a wheel a metre into the air
      const lat = Math.abs(x - r.x) - r.width / 2;
      if (lat > 1) continue;
      const t = (z - r.zStart) / r.length;
      if (t < 0 || t > 1) continue;
      h = Math.max(h, r.height * t * (lat <= 0 ? 1 : 1 - lat));
    }
    for (const s of slabs) {
      // plinth edge blends over 0.35 m — the springs walk up it smoothly
      const edge = Math.max(Math.abs(x - s.x), Math.abs(z - s.z)) - 7;
      if (edge < 0.35) h = Math.max(h, 0.16 * (edge <= 0 ? 1 : 1 - edge / 0.35));
    }
    return h;
  };
}

function addMarkInstances(
  scene: THREE.Scene,
  marks: { x: number; z: number; w: number; l: number; yaw: number }[],
): void {
  const mGeo = new THREE.PlaneGeometry(1, 1);
  const mMat = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.85 });
  const inst = new THREE.InstancedMesh(mGeo, mMat, marks.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  marks.forEach((mk, i) => {
    e.set(-Math.PI / 2, mk.yaw, 0, 'YXZ');
    q.setFromEuler(e);
    s.set(mk.w, mk.l, 1);
    m4.compose(new THREE.Vector3(mk.x, 0.015, mk.z), q, s);
    inst.setMatrixAt(i, m4);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.receiveShadow = true;
  scene.add(inst);
}

export function buildEnvironment(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshStandardMaterial({ color: 0x59614f, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.95 });

  if (level.race) {
    // the circuit ribbon: a triangle strip between the left/right edges of
    // every race section, with centre dashes and a start/finish stripe
    const secs = level.race.sections;
    const w2 = level.race.width / 2;
    const N = secs.length;
    const pos = new Float32Array((N + 1) * 2 * 3);
    for (let i = 0; i <= N; i++) {
      const s = secs[i % N];
      const o = i * 6;
      pos[o] = s.x - s.dirZ * w2;
      pos[o + 1] = 0.012;
      pos[o + 2] = s.z + s.dirX * w2;
      pos[o + 3] = s.x + s.dirZ * w2;
      pos[o + 4] = 0.012;
      pos[o + 5] = s.z - s.dirX * w2;
    }
    const idx: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const ribbon = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.95, side: THREE.DoubleSide }),
    );
    ribbon.receiveShadow = true;
    scene.add(ribbon);

    const marks = secs
      .filter((_, i) => i % 2 === 0)
      .map((s) => ({ x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ) }));
    marks.push({
      x: secs[0].x,
      z: secs[0].z,
      w: level.race.width - 2,
      l: 1.0,
      yaw: Math.atan2(secs[0].dirX, secs[0].dirZ),
    });
    addMarkInstances(scene, marks);
  }

  if (level.ground === 'pad') {
    // open practice asphalt with painted skidpad rings and dash lines
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(170, 170), roadMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.005;
    pad.receiveShadow = true;
    scene.add(pad);
    if (level.padDecals) {
      for (const r of level.padDecals.rings) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r.r - 0.35, r.r + 0.35, 64),
          new THREE.MeshBasicMaterial({ color: 0xd9dde2, transparent: true, opacity: 0.4, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(r.x, 0.02, r.z);
        scene.add(ring);
      }
      addMarkInstances(
        scene,
        level.padDecals.dashes.map((d) => ({ x: d.x, z: d.z, w: 0.25, l: 2.0, yaw: d.yaw })),
      );
    }
  } else if (level.ground === 'field') {
    // bare grass — the race ribbon above is the only paving
  } else {
    // crossroad: roads run ±140 so looping traffic recycles deep in the fog
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(14, 280), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.005;
    roadNS.receiveShadow = true;
    scene.add(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(280, 14), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.004;
    roadEW.receiveShadow = true;
    scene.add(roadEW);

    const marks: { x: number; z: number; w: number; l: number; yaw: number }[] = [];
    const addMark = (x: number, z: number, w: number, l: number, yaw: number) => marks.push({ x, z, w, l, yaw });
    for (let z = -136; z <= 136; z += 4.4) if (Math.abs(z) > 8.5) addMark(0, z, 0.22, 2.0, 0);
    for (let x = -136; x <= 136; x += 4.4) if (Math.abs(x) > 8.5) addMark(x, 0, 0.22, 2.0, Math.PI / 2);
    addMark(0, 7.7, 9.4, 0.5, 0);
    addMark(0, -7.7, 9.4, 0.5, 0);
    addMark(7.7, 0, 9.4, 0.5, Math.PI / 2);
    addMark(-7.7, 0, 9.4, 0.5, Math.PI / 2);
    for (let i = -3; i <= 3; i++) {
      addMark(i * 1.25, 9.6, 0.55, 2.4, 0);
      addMark(i * 1.25, -9.6, 0.55, 2.4, 0);
      addMark(9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
      addMark(-9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
    }
    addMarkInstances(scene, marks);
  }

  // corner blocks: sidewalk slabs + buildings (static colliders → pinball walls)
  const winTex = makeWindowTexture();
  for (const { x: cx, z: cz, h, color } of level.buildings) {
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.16, 14),
      new THREE.MeshStandardMaterial({ color: 0x80868e, roughness: 1 }),
    );
    walk.position.set(cx, 0.08, cz);
    walk.receiveShadow = true;
    scene.add(walk);
    const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
    wb.addShape(new CANNON.Box(new CANNON.Vec3(7, 0.08, 7)));
    wb.position.set(cx, 0.08, cz);
    wb.collisionFilterGroup = GROUP_DECOR; // live chassis drive over via springs
    phys.world.addBody(wb);
    phys.noCrashIds.add(wb.id); // curbs scuff, they don't wreck

    const tex = winTex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(3, Math.max(2, Math.round(h / 3)));
    const bld = new THREE.Mesh(
      new THREE.BoxGeometry(11, h, 11),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, map: tex }),
    );
    bld.position.set(cx, h / 2 + 0.16, cz);
    bld.castShadow = bld.receiveShadow = true;
    scene.add(bld);
    const bb = new CANNON.Body({ mass: 0, material: phys.matGround });
    bb.addShape(new CANNON.Box(new CANNON.Vec3(5.5, h / 2, 5.5)));
    bb.position.set(cx, h / 2 + 0.16, cz);
    phys.world.addBody(bb);
  }

  // launch ramps: a rotated slab; the suspension rays read the matching
  // height field, the physics box only matters for landings and wrecks
  const chevron = makeChevronTexture();
  for (const r of level.ramps) {
    const theta = Math.atan2(r.height, r.length);
    const slopeLen = Math.hypot(r.length, r.height);
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.9 });
    const topTex = chevron.clone();
    topTex.needsUpdate = true;
    topTex.repeat.set(1, Math.max(1, Math.round(slopeLen / 3)));
    const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.85 });
    const geo = new THREE.BoxGeometry(r.width, 0.3, slopeLen);
    const mesh = new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    mesh.rotation.x = -theta;
    mesh.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: phys.matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(r.width / 2, 0.15, slopeLen / 2)));
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -theta);
    body.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    body.collisionFilterGroup = GROUP_DECOR; // springs ride it; box is for wrecks
    phys.world.addBody(body);
    phys.noCrashIds.add(body.id);
  }
}
