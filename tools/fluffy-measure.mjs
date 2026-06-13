// One-shot: measure the FluffyGrass demo's grass DENSITY (blades/m²) and blade
// height, exactly as the demo builds them, so we can match it in our game.
//
//   # fetch the demo's assets first (its public/*.glb), then run:
//   git clone --depth 1 https://github.com/thebenezer/FluffyGrass.git ../_fluffy_tmp
//   fnm exec --using=22 -- node tools/fluffy-measure.mjs
//
// Replicates src/main.ts of thebenezer/FluffyGrass:
//   * island.glb  -> child.geometry.scale(3,3,3)              (terrain)
//   * grassLODs.glb LOD00 -> child.geometry.scale(5,5,5)      (one blade TUFT)
//   * MeshSurfaceSampler(terrain).setWeightAttribute("color") (color-weighted)
//   * grassCount = 8000 instances
//
// KEY FINDING (2026-06-13): island.glb has NO vertex-color attribute, so
// setWeightAttribute("color") is a no-op — the 8000 instances scatter
// UNIFORMLY over the whole terrain surface. So density = 8000 / terrain area.
// Measured: terrain ~2546 m² of triangle area (~3180 m² footprint, ~55x58 m)
//   -> ~3.14 blades/m² over triangle area  (~2.5 over the flat footprint).
// Each "blade" is GrassLOD00, a 66-triangle TUFT of ~6 fanned blades, ~0.70 m
// tall / ~1.6 m wide after its 5x scale. THIS is the near-field density our
// grass.ts now matches (DENSITY = 3.1 tufts/m²).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(here, '..', '..', '_fluffy_tmp', 'public');

if (!existsSync(PUB)) {
  console.error(
    `FluffyGrass assets not found at ${PUB}\n` +
      `Clone the demo first:\n` +
      `  git clone --depth 1 https://github.com/thebenezer/FluffyGrass.git ` +
      path.resolve(here, '..', '..', '_fluffy_tmp'),
  );
  process.exit(1);
}

function loadGlb(file) {
  const buf = readFileSync(path.join(PUB, file));
  const loader = new GLTFLoader();
  return new Promise((res, rej) => {
    loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (g) => res(g), rej);
  });
}

function triAreas(geo) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const out = [];
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const area = ab.cross(ac).length() * 0.5;
    out.push({ area, i0, i1, i2 });
  }
  return out;
}

// MeshSurfaceSampler weight = average of the color attribute's chosen channel
// (default channel 0 = R) over the triangle's 3 verts, multiplied by area.
function faceWeight(geo, tri) {
  const col = geo.getAttribute('color');
  if (!col) return 1;
  // MeshSurfaceSampler reads weightAttribute component 0 (the .r channel)
  const w = (i) => col.getX(i);
  return (w(tri.i0) + w(tri.i1) + w(tri.i2)) / 3;
}

const island = await loadGlb('island.glb');
let terrain = null;
island.scene.traverse((c) => {
  if (c.isMesh) {
    c.geometry.scale(3, 3, 3);
    terrain = c;
  }
});

const grass = await loadGlb('grassLODs.glb');
let blade = null;
grass.scene.traverse((c) => {
  if (c.isMesh && c.name.includes('LOD00')) {
    c.geometry.scale(5, 5, 5);
    blade = c.geometry;
  }
});

// blade height (world units, after 5x scale) = bbox.y of the LOD00 geometry
blade.computeBoundingBox();
const bb = blade.boundingBox;
const bladeH = bb.max.y - bb.min.y;
const bladeW = bb.max.x - bb.min.x;

// terrain area
const tg = terrain.geometry;
tg.computeBoundingBox();
const tbb = tg.boundingBox;
const tris = triAreas(tg);
let totalArea = 0;
let weightedArea = 0; // sum(w_i * A_i)  -> what the sampler integrates over
let posWeightArea = 0; // area of faces with weight > small epsilon
let sumW2A = 0;
const hasColor = !!tg.getAttribute('color');
for (const tri of tris) {
  totalArea += tri.area;
  const w = faceWeight(tg, tri);
  weightedArea += w * tri.area;
  sumW2A += w * w * tri.area;
  if (w > 0.05) posWeightArea += tri.area;
}

// "effective area" the 8000 blades spread over: the sampler places ~ proportional
// to w_i*A_i, so the perceived blades/m² in the GREEN region is
//   density_green = grassCount / posWeightArea       (uniform-green approximation)
// and the flat upper bound (whole terrain) is grassCount/totalArea.
const grassCount = 8000;

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();

console.log('FLUFFYGRASS DEMO — measured');
console.log('  grassCount (blades):           ', grassCount);
console.log('  terrain bbox (scaled, m):       x',
  fmt(tbb.max.x - tbb.min.x), 'y', fmt(tbb.max.y - tbb.min.y), 'z', fmt(tbb.max.z - tbb.min.z));
console.log('  terrain footprint (x*z, m²):   ', fmt((tbb.max.x - tbb.min.x) * (tbb.max.z - tbb.min.z)));
console.log('  terrain triangle area (m²):    ', fmt(totalArea), `(has vertex color: ${hasColor})`);
console.log('  color-weighted area  Σw·A:     ', fmt(weightedArea));
console.log('  green area (w>0.05, m²):       ', fmt(posWeightArea));
console.log('');
console.log('  blade size (after 5x): height  ', fmt(bladeH), 'm   width', fmt(bladeW), 'm');
console.log('');
console.log('  DENSITY — blades / footprint:  ', fmt(grassCount / ((tbb.max.x - tbb.min.x) * (tbb.max.z - tbb.min.z))), 'blades/m²');
console.log('  DENSITY — blades / total tri A:', fmt(grassCount / totalArea), 'blades/m²');
console.log('  DENSITY — blades / green area: ', fmt(grassCount / Math.max(1, posWeightArea)), 'blades/m²  <-- effective near-field density');
