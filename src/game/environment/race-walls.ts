import * as THREE from 'three';
import { makeChainLinkTexture } from '../textures';

// barriers: wall segments chained just outside both edges — hard enough
// to wreck on head-on, perfect for pinning a rival. Deliberately NOT in
// noCrashIds: a wall is a wall. The default 'race' chain is today's
// 1.0 m red/white boxes; RaceDef.wallStyles swaps section ranges for a
// coastal guardrail (0.75 m), a quay kerb (0.45 m), dockyard chain-link
// (2.2 m) or 'none' (an open gap). Each style sets the matching physics
// box height too, so a kerb is hoppable where the fence is a cage.
export const WALL_H = { race: 1.0, guardrail: 0.75, kerb: 0.45, fence: 2.2 } as const;
export type WallKind = keyof typeof WALL_H;

/** A built wall segment: its centre, both endpoint road elevations (so a box
 *  rides the pair's mean while posts/chain-link follow the grade), length,
 *  yaw and resolved style. */
export interface WallSeg {
  x: number;
  z: number;
  y0: number;
  y1: number;
  len: number;
  yaw: number;
  style: WallKind;
}

/** the plain red/white barrier boxes (style 'race'). The chain is split by
 *  parity over the FULL segment array so it stays pixel-identical to the
 *  pre-wallStyles build when every segment is 'race'. Lap-wide instanced
 *  batches on purpose (see the perf-geo note in buildRace). */
export function buildPlainBarriers(scene: THREE.Scene, wallGeo: THREE.BoxGeometry, wallT: number, wallSegs: WallSeg[]): void {
  const wallColors = [0xd8dde2, 0xc23a2c]; // alternating white/red
  for (const parity of [0, 1]) {
    // parity over the FULL segment array keeps the chain pixel-identical
    // to the pre-wallStyles build when every segment is 'race'
    const mine = wallSegs.filter((sg, i) => sg.style === 'race' && i % 2 === parity);
    const inst = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshStandardMaterial({ color: wallColors[parity], roughness: 0.8 }),
      mine.length,
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    mine.forEach((sg, i) => {
      q.setFromAxisAngle(up, sg.yaw);
      sc.set(wallT, WALL_H.race, sg.len);
      m4.compose(new THREE.Vector3(sg.x, (sg.y0 + sg.y1) / 2 + WALL_H.race / 2, sg.z), q, sc);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = inst.receiveShadow = true;
    scene.add(inst);
  }
}

/** themed wall visuals: everything is batched — boxes by material into
 *  InstancedMeshes, the chain-link into one merged cutout mesh. */
export function buildThemedWalls(scene: THREE.Scene, wallGeo: THREE.BoxGeometry, wallT: number, wallSegs: WallSeg[]): void {
  interface BoxInst {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    sz: number;
    yaw: number;
  }
  const addBoxInstances = (color: number, roughness: number, boxes: BoxInst[]): void => {
    if (!boxes.length) return;
    const inst = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshStandardMaterial({ color, roughness }),
      boxes.length,
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    boxes.forEach((bx, i) => {
      q.setFromAxisAngle(up, bx.yaw);
      sc.set(bx.sx, bx.sy, bx.sz);
      m4.compose(new THREE.Vector3(bx.x, bx.y, bx.z), q, sc);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = inst.receiveShadow = true;
    scene.add(inst);
  };
  const kerbs: BoxInst[] = [];
  const rails: BoxInst[] = [];
  const woodPosts: BoxInst[] = [];
  const fencePosts: BoxInst[] = [];
  const fPos: number[] = [];
  const fUv: number[] = [];
  const fIdx: number[] = [];
  for (const sg of wallSegs) {
    const dx = Math.sin(sg.yaw);
    const dz = Math.cos(sg.yaw);
    const yMid = (sg.y0 + sg.y1) / 2; // road elevation under the segment
    // per-spot elevation along the segment — posts follow the grade
    // smoothly even though the long boxes step at the seams
    const yAt = (t: number) => sg.y0 + (sg.y1 - sg.y0) * (t + 0.5);
    if (sg.style === 'kerb') {
      // a plain concrete curb — hop it and pay in undercarriage scrape
      kerbs.push({ x: sg.x, y: yMid + WALL_H.kerb / 2, z: sg.z, sx: wallT, sy: WALL_H.kerb, sz: sg.len, yaw: sg.yaw });
    } else if (sg.style === 'guardrail') {
      // coastal highway: weathered wood posts carrying a grey W-rail
      rails.push({ x: sg.x, y: yMid + 0.58, z: sg.z, sx: 0.09, sy: 0.3, sz: sg.len, yaw: sg.yaw });
      const cnt = Math.max(2, Math.round(sg.len / 2.4));
      for (let k = 0; k < cnt; k++) {
        const t = (k + 0.5) / cnt - 0.5; // interior spots only — no seam doubles
        woodPosts.push({
          x: sg.x + dx * sg.len * t,
          y: yAt(t) + 0.36,
          z: sg.z + dz * sg.len * t,
          sx: 0.16,
          sy: 0.72,
          sz: 0.16,
          yaw: sg.yaw,
        });
      }
    } else if (sg.style === 'fence') {
      const cnt = Math.max(1, Math.round(sg.len / 3));
      for (let k = 0; k < cnt; k++) {
        const t = (k + 0.5) / cnt - 0.5;
        fencePosts.push({
          x: sg.x + dx * sg.len * t,
          y: yAt(t) + WALL_H.fence / 2,
          z: sg.z + dz * sg.len * t,
          sx: 0.09,
          sy: WALL_H.fence,
          sz: 0.09,
          yaw: sg.yaw,
        });
      }
      // one vertical quad per segment, u in metres so the mesh tiles;
      // the corners carry their end's road elevation, so the chain-link
      // (unlike the boxes) follows a grade without stepping
      const hx = (dx * sg.len) / 2;
      const hz = (dz * sg.len) / 2;
      const base = fPos.length / 3;
      fPos.push(
        sg.x - hx, sg.y0, sg.z - hz,
        sg.x + hx, sg.y1, sg.z + hz,
        sg.x + hx, sg.y1 + WALL_H.fence, sg.z + hz,
        sg.x - hx, sg.y0 + WALL_H.fence, sg.z - hz,
      );
      fUv.push(0, 0, sg.len, 0, sg.len, WALL_H.fence, 0, WALL_H.fence);
      fIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  addBoxInstances(0xc9cbc7, 0.9, kerbs); // light concrete
  addBoxInstances(0x9aa1a7, 0.55, rails); // galvanized rail
  addBoxInstances(0x77624c, 1.0, woodPosts); // weathered timber
  addBoxInstances(0x474c51, 0.7, fencePosts); // fence steel
  if (fIdx.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fPos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(fUv), 2));
    geo.setIndex(fIdx);
    geo.computeVertexNormals();
    const fence = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        map: makeChainLinkTexture(),
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.7,
      }),
    );
    // no castShadow: the cutout has no custom depth material, so the sun
    // would project the plane as a solid slab — a lie worse than no shadow
    fence.receiveShadow = true;
    scene.add(fence);
  }
}
