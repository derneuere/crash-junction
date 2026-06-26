import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { LevelDef } from '../types';
import { GROUP_DECOR, type PhysicsContext } from '../physics';
import {
  makeChevronTexture,
  makePatchTexture,
  makeWindowTextures,
  type PatchKind,
} from '../textures';
import { type Sea } from '../sea';
import { applyBakedAO } from '../ao';
import { buildGrass, type GrassField } from '../grass';
import { instanceChunked, mergeChunked, type ChunkMergeItem } from '../chunkbatch';
import { addMarkInstances } from './marks';
import { buildCoast } from './coast';
import { addDuneFringe } from './embankment';
import { buildRace } from './race-build';

/** What buildEnvironment hands back to the frame loop: the animated sea (coast
 *  levels) and the instanced blade-grass field (coast levels). Both are
 *  render-driven, pin-safe presentation handles — never in the sim hash. */
export interface Environment {
  sea: Sea | null;
  grass: GrassField | null;
}

// Z-ORDER CONTRACT for coplanar ground paint (the camera never goes under
// the road, so tiny y offsets beat polygonOffset): grass/island ground 0 →
// ground patches 0.006 (GroundPatchDef default) → shortcut ribbons 0.010 →
// main race ribbon 0.012 → decals 0.014 → centre dashes / stripes 0.015.
// New paint must keep to its slot or the junction overlaps will shimmer.

/** @returns the render-driven presentation handles (coast levels populate the
 *  animated sea + instanced grass field; both null on inland levels). The
 *  frame loop drives their render-time animation — neither is in the sim hash. */
export function buildEnvironment(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): Environment {
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  let sea: Sea | null = null;
  let grass: GrassField | null = null;

  if (level.coast) {
    // an island in the sea: the outline polygon IS the grass, with skirts
    // down to the water — the auto-sized square below would poke through it
    sea = buildCoast(scene, level.coast);
  } else {
    // ground plane sized from level content — the hard-coded 320 cropped any
    // circuit bigger than SILVER LAKE RING; sections, shortcut waypoints,
    // props and buildings all count, plus margin so the rim never shows
    let extent = 0;
    const grow = (x: number, z: number) => {
      extent = Math.max(extent, Math.abs(x), Math.abs(z));
    };
    if (race) {
      for (const s of race.sections) grow(s.x, s.z);
      for (const sc of race.shortcuts ?? []) for (const [wx, wz] of sc.waypoints) grow(wx, wz);
    }
    for (const p of level.props ?? []) grow(p.x, p.z);
    for (const b of level.buildings) grow(b.x, b.z);
    const groundSize = Math.max(320, (extent + 60) * 2);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({ color: 0x59614f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ground patches: textured aprons/sand/dry grass UNDER the paving — see
  // the z-order contract at the top of this file (default y 0.006 keeps
  // them beneath the 0.010/0.012 ribbons). Visual only, no grip change.
  //
  // [perf-geo] BATCHED: a level dresses ~10 patches, each its own ShapeGeometry
  // mesh = a draw call (×6 through the cube reflection). Patches that share a
  // KIND already share one material; we now also MERGE their geometry per
  // (kind, spatial chunk) so same-kind patches in a region draw as one mesh.
  // Each patch's transform (rotate -PI/2 about X so shape-Y → world-Z, plus its
  // y slot) is baked into the merged buffer, so vertices — and the raw-shape-
  // coord UVs that world-tile the texture — land exactly where the per-mesh
  // build drew them. Chunking keeps frustum culling dropping off-screen tiles
  // (a level-spanning merge would wrap the whole island and always draw). The
  // material creation is unchanged (perf-mem owns texture/material dedup); only
  // the mesh batching changed.
  if (level.patches?.length) {
    const patchMats = new Map<PatchKind, THREE.MeshStandardMaterial>();
    const TILE: Record<PatchKind, number> = { concrete: 9, sand: 6, drygrass: 8, gravel: 4 };
    const patchItems = new Map<PatchKind, ChunkMergeItem[]>();
    const rotX = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    for (const p of level.patches) {
      if (!patchMats.has(p.kind)) {
        const tex = makePatchTexture(p.kind);
        // ShapeGeometry UVs are raw shape coords (= world metres), so the
        // repeat alone gives seamless world-space tiling across patches
        tex.repeat.setScalar(1 / TILE[p.kind]);
        patchMats.set(p.kind, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
      }
      const geo = new THREE.ShapeGeometry(new THREE.Shape(p.poly.map(([x, z]) => new THREE.Vector2(x, -z))));
      // bake rotation.x = -PI/2 then position.y = (p.y ?? 0.006), in that order
      const mat = new THREE.Matrix4().makeTranslation(0, p.y ?? 0.006, 0).multiply(rotX);
      // tile-assignment point: the patch polygon centroid (world x/z)
      let cx = 0, cz = 0;
      for (const [x, z] of p.poly) { cx += x; cz += z; }
      cx /= p.poly.length; cz /= p.poly.length;
      let arr = patchItems.get(p.kind);
      if (!arr) patchItems.set(p.kind, (arr = []));
      arr.push({ geometry: geo, matrix: mat, x: cx, z: cz });
    }
    for (const [kind, items] of patchItems) {
      mergeChunked(scene, items, patchMats.get(kind)!, { receiveShadow: true, name: 'cj-patch-batch' });
      for (const it of items) it.geometry.dispose(); // the source clones are merged
    }
  }

  // [art-grass-sand] grass-side dune-lip transition: a grass-tongue fringe
  // over the sand at the beach so the green→tan boundary reads as the lawn
  // thinning into sand, not a polygon seam. Own block; reads patch geometry
  // only, never edits the shared patch loop above.
  addDuneFringe(scene, level);

  // [art-grass round-2] Instanced 3D-blade grass over the SW beach-approach
  // band, swaying in the wind and thinning into the sand at the dune lip. It
  // AUGMENTS the textured ground + dune fringe above (does not replace them).
  // Coast levels only (the band is GANTRY-specific); render-driven, pin-safe.
  // See grass.ts for the bounded-band + tier perf strategy and attribution.
  if (level.coast) grass = buildGrass(scene, level);

  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.95 });

  if (race) {
    // the circuit ribbon, dashes, checkpoint gates, shortcut ribbons, the
    // barrier chain (visual + physics) and the elevated-span embankments —
    // see race-build.ts (extracted unchanged).
    buildRace(scene, phys, level, race);
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

  // level decals: painted lane markings on the aprons — the road-dash
  // instancer with per-decal colors, at 0.014 so they ride above the
  // ribbons but never fight the 0.015 race dashes (z-order contract)
  if (level.decals?.length) addMarkInstances(scene, level.decals, 0.014);

  // corner blocks: sidewalk slabs + buildings (static colliders → pinball walls)
  const winTex = makeWindowTextures();
  // [perf-geo] every building's sidewalk slab is the SAME box + SAME material,
  // so the visual walks BATCH into one InstancedMesh per spatial chunk (the
  // tower blocks above keep their per-building window materials — perf-mem's
  // domain — so they stay separate). Colliders are untouched: the cannon
  // sidewalk + tower bodies are still added per building below, so physics and
  // takedown behaviour are identical. Shared geometry + material so the
  // daynight sweep + any baked attribute still reach the batch.
  const walkGeo = new THREE.BoxGeometry(14, 0.16, 14);
  const walkMat = new THREE.MeshStandardMaterial({ color: 0x80868e, roughness: 1 });
  const walkItems: { matrix: THREE.Matrix4; x: number; z: number }[] = [];
  for (const { x: cx, z: cz, h, color } of level.buildings) {
    walkItems.push({ matrix: new THREE.Matrix4().makeTranslation(cx, 0.08, cz), x: cx, z: cz });
    const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
    wb.addShape(new CANNON.Box(new CANNON.Vec3(7, 0.08, 7)));
    wb.position.set(cx, 0.08, cz);
    wb.collisionFilterGroup = GROUP_DECOR; // live chassis drive over via springs
    phys.world.addBody(wb);
    phys.noCrashIds.add(wb.id); // curbs scuff, they don't wreck

    const tex = winTex.map.clone();
    tex.needsUpdate = true;
    tex.repeat.set(3, Math.max(2, Math.round(h / 3)));
    const lit = winTex.lit.clone();
    lit.needsUpdate = true;
    lit.repeat.copy(tex.repeat);
    // at night the warm windows glow (daynight.ts sweeps the intensity)
    const bldMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      map: tex,
      emissive: 0xffffff,
      emissiveMap: lit,
      emissiveIntensity: 0,
    });
    bldMat.userData.night = { intensity: 2.6 };
    const bld = new THREE.Mesh(new THREE.BoxGeometry(11, h, 11), bldMat);
    bld.position.set(cx, h / 2 + 0.16, cz);
    bld.castShadow = bld.receiveShadow = true;
    // baked AO contact-darkening at the base of the block (ao.ts / the offline
    // bake). A BoxGeometry is always 24 verts in a fixed order, so the bake's
    // 'building' prototype — a unit box sat on its sidewalk — drapes onto any
    // building height: the bottom ring darkens where wall meets ground while
    // the sunlit upper faces keep their key light (ambient-only, see ao.ts).
    applyBakedAO(bld, 'building');
    scene.add(bld);
    const bb = new CANNON.Body({ mass: 0, material: phys.matGround });
    bb.addShape(new CANNON.Box(new CANNON.Vec3(5.5, h / 2, 5.5)));
    bb.position.set(cx, h / 2 + 0.16, cz);
    phys.world.addBody(bb);
  }
  // emit the batched sidewalk walks (receiveShadow only, like the per-mesh
  // build; the flat slab cast no meaningful shadow before and casts none now)
  instanceChunked(scene, walkGeo, walkMat, walkItems, { receiveShadow: true, name: 'cj-walk-batch' });

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

  return { sea, grass };
}
