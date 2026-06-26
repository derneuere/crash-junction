import * as THREE from 'three';
import type { CoastDef } from '../types';
import { makeGrassTexture, makeQuayTexture } from '../textures';
import { buildSea, type Sea } from '../sea';
import { SKIRT_W, makeSandMaterial, type CoastEdge } from './sand-material';
import { addCliffSkirt, addFlatSkirt, type CoastCtx } from './coast-skirts';
import { addBeachSkirt } from './coast-beach';
import { addFoamRings } from './coast-foam';

/** Island silhouette + sea + coastline skirts (LevelDef.coast). ALL VISUAL:
 *  the physics ground stays the flat y=0 plane out to infinity, so a car
 *  carried past the rim hovers over the water until the off-track rescue
 *  collects it — the accepted arcade tradeoff documented on CoastDef.
 *  Returns the animated-sea handle so the frame loop can drive its waves. */
export function buildCoast(scene: THREE.Scene, coast: CoastDef): Sea {
  const o = coast.outline;
  const n = o.length;
  const sea = coast.seaLevel;
  const depth = Math.max(0.5, -sea);
  // every skirt overshoots the waterline along its own slope; the opaque
  // sea hides the hem, so type transitions never flash a raw edge
  const BOT = sea - 1.2;
  const botF = (depth + 1.2) / depth;

  // island ground: the outline polygon replaces the auto-sized grass
  // square. Shape space (x, -z) lands back on world (x, z) under the same
  // rotation.x = -PI/2 the plane ground uses.
  // [art-grass-sand] Textured lawn instead of the old flat 0x59614f fill:
  // ShapeGeometry UVs are raw shape coords (= world metres), so the repeat
  // alone world-tiles the grass seamlessly across the whole island — same
  // (x,−z) rule the ground patches use. A faint base tint keeps the lit
  // material grounded under the Preetham sky; the map carries the variation.
  const grassTex = makeGrassTexture();
  grassTex.repeat.setScalar(1 / 7); // ~7 m tile: clumps read as metres of meadow
  const island = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape(o.map((p) => new THREE.Vector2(p.x, -p.z)))),
    new THREE.MeshStandardMaterial({ map: grassTex, color: 0xdfe2d2, roughness: 1 }),
  );
  island.rotation.x = -Math.PI / 2;
  island.receiveShadow = true;
  scene.add(island);

  // ── SEA SEAM (art-ocean) ───────────────────────────────────────────────
  // The old static blue-green plane with baked whitecaps lived here. It is
  // now an ANIMATED ocean built in sea.ts: a 12-wave Gerstner body with
  // tanh-softened crests, a 5-layer domain-warped fragment NORMAL perturbation
  // (the dense micro-ripple), Schlick fresnel, PMREM sky reflection from OUR
  // scene.environment, subsurface scatter, triple-lobe sun specular and a
  // multi-layer foam system — still a pure-visual backdrop with no collider.
  // seaLevel is UNCHANGED at -2.2; max wave amplitude at the shoreline is
  // SEA_MAX_AMPLITUDE (~0.29 m), so the foam strip below (riding sea + 0.04)
  // still sits clear of the crests. The returned handle's update() is driven
  // from the render loop (Game.ts), off RENDER time — pin-safe.
  const seaHandle = buildSea(scene, sea);
  // ───────────────────────────────────────────────────────────────────────

  // per-segment outward normals — the shoelace sign makes the offset robust
  // to either winding even though the CoastDef contract says CCW
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    area2 += a.x * b.z - b.x * a.z;
  }
  const sgn = area2 > 0 ? 1 : -1;
  const segOut: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    segOut.push({ x: (sgn * (b.z - a.z)) / l, z: (-sgn * (b.x - a.x)) / l });
  }

  // per-vertex mitred outward (capped so hairpins don't explode) and skirt
  // width averaged across the two adjacent segments: where a beach meets a
  // quay the sand pinches out against the concrete instead of tearing a
  // hole in the ring
  const vOut: { x: number; z: number }[] = [];
  const vW: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = segOut[(i - 1 + n) % n];
    const c = segOut[i];
    let mx = p.x + c.x;
    let mz = p.z + c.z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) {
      mx = c.x;
      mz = c.z;
    } else {
      const scale = Math.min(2, 1 / Math.max(0.5, (mx / ml) * c.x + (mz / ml) * c.z));
      mx = (mx / ml) * scale;
      mz = (mz / ml) * scale;
    }
    vOut.push({ x: mx, z: mz });
    vW.push((SKIRT_W[o[(i - 1 + n) % n].edge] + SKIRT_W[o[i].edge]) / 2);
  }

  // group consecutive same-edge segments into runs; starting at a type
  // change keeps a run from straddling the array seam (all one type = a
  // single closed run around the whole island)
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (o[i].edge !== o[0].edge) {
      start = i;
      break;
    }
  }
  const runs: { edge: CoastEdge; segs: number[] }[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const last = runs[runs.length - 1];
    if (last && last.edge === o[i].edge) last.segs.push(i);
    else runs.push({ edge: o[i].edge, segs: [i] });
  }

  // shared geometry context for the skirt builders (coast-skirts.ts /
  // coast-beach.ts); cliffKey advances across every addCliffSkirt call
  const ctx: CoastCtx = { scene, o, n, sea, BOT, botF, vOut, vW, segOut, cliffKey: 0 };

  // skirt materials, built once per coast (a level has one coastline)
  // [art-sand] the dry beach skirt now carries the Alan-Zucconi sand material
  // (normal-mapped grain + dune ripples, sun-tied glitter sparkle, rim) — see
  // makeSandMaterial. Cloned per skirt in addBeachSkirt to add vertexColors.
  const beachMat = makeSandMaterial(scene);
  const quayMat = new THREE.MeshStandardMaterial({ map: makeQuayTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x4f5944, roughness: 1, side: THREE.DoubleSide });
  for (const run of runs) {
    if (run.edge === 'beach') addBeachSkirt(ctx, run.segs, beachMat); // wet/dry shaded sand
    else if (run.edge === 'wall') addFlatSkirt(ctx, run.segs, quayMat, 6);
    else if (run.edge === 'bank') addFlatSkirt(ctx, run.segs, bankMat, 6);
    else addCliffSkirt(ctx, run.segs);
  }

  // layered shore-line foam riding the waterline toe of every skirt (see
  // coast-beach.ts addFoamRings / makeFoamRing): a fixed leading edge plus a
  // wider drifting swash ring, both animated off the RENDER clock — pin-safe.
  addFoamRings(ctx);

  return seaHandle;
}
