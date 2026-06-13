import * as THREE from 'three';

// Code-built set dressing for the dockyard furniture the CC0 packs don't
// carry — most of all a true ship-to-shore container gantry for the GANTRY
// POINT skyline. Flat-shaded primitive assemblies in the Kenney size world;
// native sizes are at scale 1, and like every prop the collider comes from
// the PropDef's explicit half-extents, never from this geometry.
//
// PURE THREE, NO SIDE-EFFECTS: this module imports only `three` so the OFFLINE
// AO baker (tools/bake-ao.mjs, plain Node) can build byte-identical geometry
// to the runtime without dragging in GLTFLoader / cannon-es. props.ts
// re-exports BUILTINS; the bake imports it straight. Keep it that way — the
// self-occlusion AO is only correct if both sides build the SAME meshes.

function flatMat(color: number, rough = 0.85, name?: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true });
  if (name) m.name = name;
  return m;
}

function addBox(
  g: THREE.Group,
  mat: THREE.Material,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
): void {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  g.add(m);
}

function addCyl(g: THREE.Group, mat: THREE.Material, rT: number, rB: number, h: number, x: number, y: number, z: number): void {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rT, rB, h, 10), mat);
  m.position.set(x, y, z);
  g.add(m);
}

/** Ship-to-shore container gantry, ~28 m tall at scale 1. The boom
 *  cantilevers along local -z — yaw it so the long arm reaches over the
 *  water, the way a working berth lines its cranes up over the ship. */
export function buildGantryCrane(): THREE.Group {
  const g = new THREE.Group();
  const orange = flatMat(0xd9772a); // safety orange, the working-port classic
  const dark = flatMat(0x33373c, 0.7);
  const glass = flatMat(0x223040, 0.3, 'glass'); // named so tint skips it

  // four legs on a wide portal (two A-frame pairs along z), bogies at the feet
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addBox(g, orange, 0.9, 19, 0.9, sx * 8.5, 9.5, sz * 5.2);
      addBox(g, dark, 1.6, 0.9, 1.4, sx * 8.5, 0.45, sz * 5.2);
    }
  }
  // portal beams tie each leg pair across x; side beams run the z span
  for (const sz of [-1, 1]) addBox(g, orange, 18, 1.2, 0.9, 0, 18.5, sz * 5.2);
  for (const sx of [-1, 1]) addBox(g, orange, 0.7, 0.7, 11.3, sx * 8.5, 16.6, 0);
  // A-frame: each pair leans into the apex spine that anchors the stays
  const aLen = Math.hypot(8, 5.2);
  const aTilt = Math.atan2(5.2, 8);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) addBox(g, orange, 0.55, aLen, 0.55, sx * 8.5, 23, sz * 2.6, -sz * aTilt);
  }
  addBox(g, orange, 17.5, 0.8, 0.8, 0, 27, 0); // apex spine
  // machinery house on the portal, operator cab hung under the boom
  addBox(g, dark, 5, 2.6, 4.2, 0, 20.4, 4.8);
  addBox(g, dark, 2.2, 1.8, 2.4, 0, 19, -3.5);
  addBox(g, glass, 2.0, 1.2, 0.1, 0, 18.9, -4.75);
  // the boom: backreach to z +8.5, working arm out to z -22.5
  addBox(g, orange, 1.5, 1.1, 31, 0, 21.5, -7);
  // forestay + backstay from the apex hold the cantilever up
  addBox(g, dark, 0.14, Math.hypot(5.5, 22.5), 0.14, 0, 24.25, -11.25, Math.atan2(22.5, 5.5));
  addBox(g, dark, 0.14, Math.hypot(5.5, 8.5), 0.14, 0, 24.25, 4.25, Math.atan2(-8.5, 5.5));
  // trolley riding the boom, hoist cables, container spreader below
  addBox(g, dark, 1.9, 0.8, 2.4, 0, 20.5, -14);
  for (const sx of [-1, 1]) addBox(g, dark, 0.07, 5.5, 0.07, sx * 0.7, 17.35, -14);
  addBox(g, dark, 6.1, 0.5, 2.44, 0, 14.3, -14); // a 20-footer's footprint
  return g;
}

/** Port floodlight mast, ~16 m: pole + crossarm with four lamp boxes that
 *  blaze at night (daynight.ts sweeps the userData.night tag). */
export function buildFloodlightMast(): THREE.Group {
  const g = new THREE.Group();
  const steel = flatMat(0x596067, 0.6);
  addCyl(g, steel, 0.14, 0.22, 16, 0, 8, 0);
  addBox(g, steel, 3.6, 0.22, 0.3, 0, 15.9, 0);
  const lamp = flatMat(0x2c3034, 0.5);
  lamp.emissive = new THREE.Color(0xfff1c4);
  lamp.emissiveIntensity = 0;
  lamp.userData.night = { intensity: 2.4 };
  for (const x of [-1.35, -0.45, 0.45, 1.35]) addBox(g, lamp, 0.7, 0.5, 0.3, x, 15.5, 0.1, 0.3);
  return g;
}

/** Squat quayside mooring bollard, ~0.8 m — the mushroom cap overhangs so
 *  it reads as cast iron, not a fire hydrant. */
export function buildBollard(): THREE.Group {
  const g = new THREE.Group();
  const iron = flatMat(0x1f2226, 0.45);
  addCyl(g, iron, 0.24, 0.3, 0.62, 0, 0.31, 0);
  addCyl(g, iron, 0.36, 0.3, 0.18, 0, 0.71, 0);
  return g;
}

/** Quayside lamp post, ~6 m, single night-emissive head. The short arm
 *  reaches local +z — yaw it over the road. */
export function buildLampPost(): THREE.Group {
  const g = new THREE.Group();
  const paint = flatMat(0x2b3134, 0.7);
  addCyl(g, paint, 0.07, 0.1, 5.7, 0, 2.85, 0);
  addBox(g, paint, 0.12, 0.12, 0.9, 0, 5.75, 0.38);
  const head = flatMat(0x3a4046, 0.5);
  head.emissive = new THREE.Color(0xffe2a8);
  head.emissiveIntensity = 0;
  head.userData.night = { intensity: 2.6 };
  addBox(g, head, 0.34, 0.2, 0.62, 0, 5.7, 0.78);
  return g;
}

export const BUILTINS: Record<string, () => THREE.Group> = {
  'gantry-crane': buildGantryCrane,
  'floodlight-mast': buildFloodlightMast,
  bollard: buildBollard,
  'lamp-post': buildLampPost,
};
