import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { LevelDef, RaceDef, RaceWaypoint } from '../types';
import type { PhysicsContext } from '../physics';
import { buildOpenSections, SHORTCUT_SPACING } from '../race';
import { addMarkInstances, addRibbon } from './marks';
import { addEmbankments } from './embankment';
import { makeHeightSampler } from './elevation';
import { WALL_H, buildPlainBarriers, buildThemedWalls, type WallKind, type WallSeg } from './race-walls';

/** Race circuit: the ribbon, centre dashes + start/finish stripe, glowing
 *  checkpoint gates, shortcut branch ribbons, the barrier chain (visual +
 *  physics, with shortcut-mouth gaps and per-range wall styles) and the
 *  embankment drape under every elevated span. Split out of buildEnvironment
 *  unchanged — same draw order, same bodies, same wallDirs judging. */
export function buildRace(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef, race: RaceDef): void {
  // the circuit ribbon: a triangle strip between the left/right edges of
  // every race section, with centre dashes and a start/finish stripe
  const secs = race.sections;
  const w2 = race.width / 2;
  const N = secs.length;
  addRibbon(scene, secs, race.width, 0.012, 0x2e3138, true);

  // paint pitch on a grade: a flat dash 2.2 m long would bury one end in
  // a 6% climb and float the other — tilt it about its length axis to
  // the local chain grade (the mark's length axis points BACKWARDS along
  // the chain after the YXZ euler, hence the minus). 0 on flat ground.
  const gradeAt = (chain: { x: number; z: number; y: number }[], i: number, closed: boolean): number => {
    const n = chain.length;
    const a = chain[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = chain[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const run = Math.hypot(b.x - a.x, b.z - a.z);
    return run > 0 ? (b.y - a.y) / run : 0;
  };
  interface Mark {
    x: number;
    z: number;
    w: number;
    l: number;
    yaw: number;
    color?: number;
    y?: number;
    pitch?: number;
  }
  const marks: Mark[] = [];
  secs.forEach((s, i) => {
    if (i % 2 !== 0) return;
    marks.push({
      x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
      y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
    });
  });
  marks.push({
    x: secs[0].x,
    z: secs[0].z,
    w: race.width - 2,
    l: 1.0,
    yaw: Math.atan2(secs[0].dirX, secs[0].dirZ),
    y: secs[0].y + 0.015,
  });

  // checkpoints: a painted stripe + glowing gate posts every 6th section,
  // so the racing line always has a visible next target. Posts and
  // stripes ride the section's road elevation on the north arc.
  //
  // The ~70 gate posts are one shared cylinder geometry + one shared
  // (night-emissive) material, so they BATCH into instanced draws — but
  // chunked SPATIALLY (per ~80 m run of the lap) so the batch's bounding
  // sphere stays local and three's frustum culling still drops the gates
  // behind the camera. A single level-spanning InstancedMesh would wrap the
  // whole 2 km lap and draw every gate every frame (and ×6 through the cube
  // reflection) — the spatial bins keep the cull working, same lesson as the
  // prop batcher and grass. Pure presentation; the painted stripe (marks)
  // and the gate placement are unchanged.
  const postGeo = new THREE.CylinderGeometry(0.12, 0.16, 2.6, 8);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x22262c,
    emissive: 0xffb327,
    emissiveIntensity: 1.4,
  });
  postMat.userData.night = { intensity: 2.4, day: 1.4 };
  const postBins = new Map<number, { x: number; y: number; z: number }[]>();
  const POST_BIN = 80; // m of lap per instanced chunk
  let postRun = 0; // running arc length, for the spatial bin
  for (let i = 6; i < N; i += 6) {
    const s = secs[i];
    marks.push({
      x: s.x, z: s.z, w: race.width - 2, l: 0.7, yaw: Math.atan2(s.dirX, s.dirZ),
      y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
    });
    const bin = Math.floor((postRun += 6 * 8 /* ~section spacing */) / POST_BIN);
    let bucket = postBins.get(bin);
    if (!bucket) postBins.set(bin, (bucket = []));
    for (const side of [1, -1]) {
      bucket.push({
        x: s.x - side * s.dirZ * (w2 + 1.1),
        y: s.y + 1.3,
        z: s.z + side * s.dirX * (w2 + 1.1),
      });
    }
  }
  for (const bucket of postBins.values()) {
    const inst = new THREE.InstancedMesh(postGeo, postMat, bucket.length);
    inst.castShadow = true;
    inst.frustumCulled = true;
    const pm = new THREE.Matrix4();
    bucket.forEach((p, k) => {
      pm.makeTranslation(p.x, p.y, p.z);
      inst.setMatrixAt(k, pm);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
  }
  // shortcut branch ribbons: same strip builder, own narrower chain, a
  // dirt or asphalt tint, and a hair LOWER than the main road (0.010 vs
  // 0.012) so the junction overlaps at the mouths never z-fight. No
  // walls along a branch — running out of road is part of the price.
  const shortcuts = race.shortcuts ?? [];
  for (const sc of shortcuts) {
    const chain = buildOpenSections(sc.waypoints, SHORTCUT_SPACING);
    addRibbon(scene, chain, sc.width, 0.01, sc.surface === 'dirt' ? 0x6b5d40 : 0x2e3138, false);
    // sparse centre dashes — enough to read as road at speed, not enough
    // to dress a branch up as the main line
    for (let i = 2; i < chain.length - 1; i += 4) {
      const s = chain[i];
      marks.push({
        x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
        y: s.y + 0.015, pitch: -Math.atan(gradeAt(chain, i, false)),
      });
    }
  }
  addMarkInstances(scene, marks);

  // shortcut mouths punch gaps in the barrier: skip main-loop wall
  // segments [entry-1, entry+1] and [exit-1, exit+1], on the attachment
  // side ONLY — inferred from the cross product of the section direction
  // with (branch endpoint − section centre), so the far wall still pins
  // rivals through the junction
  const gapped = new Set<string>(); // "side:segIndex"
  for (const sc of shortcuts) {
    const mouths: [number, RaceWaypoint][] = [
      [sc.entry, sc.waypoints[0]],
      [sc.exit, sc.waypoints[sc.waypoints.length - 1]],
    ];
    for (const [secIdx, wp] of mouths) {
      const s = secs[secIdx % N];
      // 2D cross dir × offset: positive = the side the +1 wall runs on
      // (its offset is along the left perpendicular (-dirZ, dirX))
      const cross = s.dirX * (wp[1] - s.z) - s.dirZ * (wp[0] - s.x);
      const side = cross >= 0 ? 1 : -1;
      for (let k = -1; k <= 1; k++) gapped.add(`${side}:${(secIdx + k + N) % N}`);
    }
  }

  // barriers: wall segments chained just outside both edges (see race-walls.ts
  // for the style table + visuals). Deliberately NOT in noCrashIds: a wall is
  // a wall.
  const wallT = 0.5;
  // 'left'/'right' are relative to race direction: side +1 offsets along
  // the left perpendicular (-dirZ, dirX) — same convention as the
  // shortcut-mouth cross product above. Overlapping ranges: last wins.
  const styleFor = (side: 1 | -1, i: number): WallKind | 'none' => {
    let st: WallKind | 'none' = 'race';
    for (const ws of race.wallStyles ?? []) {
      if (ws.side !== 'both' && (ws.side === 'left' ? 1 : -1) !== side) continue;
      // from > to wraps the lap seam, mirroring how section indices loop
      if (ws.from <= ws.to ? i >= ws.from && i <= ws.to : i >= ws.from || i <= ws.to) st = ws.style;
    }
    return st;
  };
  // Wall segments on a grade sit at their section pair's MEAN elevation —
  // stepped seams, not pitched boxes, per elevation.md's costed tradeoff:
  // at the profile's steepest ~7% a 9.5 m segment steps ~±0.3 m, hidden
  // by the 0.5 m overlap, and the embankment shoulder under the wall is
  // at full road elevation so no gap opens beneath the box. wallDirs
  // judging stays 2D and untouched.
  const wallSegs: WallSeg[] = [];
  for (const side of [1, -1] as const) {
    for (let i = 0; i < N; i++) {
      if (gapped.has(`${side}:${i}`)) continue; // a shortcut mouth opens here
      const style = styleFor(side, i);
      if (style === 'none') continue; // deliberate gap — no wall, no body
      const a = secs[i];
      const b = secs[(i + 1) % N];
      const off = w2 + wallT / 2 + 0.15;
      const ax = a.x - side * a.dirZ * off;
      const az = a.z + side * a.dirX * off;
      const bx = b.x - side * b.dirZ * off;
      const bz = b.z + side * b.dirX * off;
      const len = Math.hypot(bx - ax, bz - az) + 0.5; // overlap hides the seams
      wallSegs.push({ x: (ax + bx) / 2, z: (az + bz) / 2, y0: a.y, y1: b.y, len, yaw: Math.atan2(bx - ax, bz - az), style });
    }
  }
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  // The barrier boxes (and the chain-link below) are ALREADY collapsed into a
  // handful of InstancedMeshes / one merged mesh by a prior pass. NOTE
  // (perf-geo): these are kept as the lap-wide batches on purpose. GANTRY
  // POINT is a COMPACT island loop, so from almost every vantage a large arc
  // of the barrier is in view at once; splitting these into per-region chunks
  // (as we do for the sparse patches/walks) was measured to ADD draw calls at
  // every pose — main frame AND each cube face — because the visible arc just
  // fragments into more draws while little of the loop is ever off-screen to
  // cull (tests/drawcall-poses.mjs sweep). For a draw-call goal the single
  // instanced batch is already optimal here, so the chunked-batch helper is
  // applied only to the genuinely sparse static one-offs (ground patches,
  // building sidewalks), not to the omnipresent barrier chain.
  buildPlainBarriers(scene, wallGeo, wallT, wallSegs);

  // themed wall visuals: everything is batched — boxes by material into
  // InstancedMeshes, the chain-link into one merged cutout mesh
  buildThemedWalls(scene, wallGeo, wallT, wallSegs);

  // physics: one static box per segment regardless of dressing — only the
  // height varies by style. Same chain, same wallDirs judging as always.
  // On a grade the box rides the segment's mean road elevation (stepped,
  // like the visual): the shoulder under it is at full elevation, so the
  // worst seam mismatch is ~0.3 m of box bottom against solid embankment.
  for (const sg of wallSegs) {
    const h = WALL_H[sg.style];
    const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
    wb.addShape(new CANNON.Box(new CANNON.Vec3(wallT / 2, h / 2, sg.len / 2)));
    wb.position.set(sg.x, (sg.y0 + sg.y1) / 2 + h / 2, sg.z);
    wb.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), sg.yaw);
    phys.world.addBody(wb);
    phys.wallDirs.set(wb.id, { x: Math.sin(sg.yaw), z: Math.cos(sg.yaw) });
  }

  // the visual ground under every elevated span (no-op on flat tracks);
  // a fresh sampler instance keeps this builder self-contained — same
  // plain-number inputs, same field, build-time only
  addEmbankments(
    scene,
    [
      { secs, halfW: w2, closed: true },
      ...shortcuts.map((sc) => ({
        secs: buildOpenSections(sc.waypoints, SHORTCUT_SPACING),
        halfW: sc.width / 2,
        closed: false,
      })),
    ],
    level.coast,
    makeHeightSampler(level).base,
  );
}
