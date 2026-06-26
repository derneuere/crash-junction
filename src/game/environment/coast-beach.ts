import * as THREE from 'three';
import { makeWetSandTexture } from '../textures';
import type { CoastCtx } from './coast-skirts';

// BEACH skirt (replaces addFlatSkirt for 'beach' runs): the sand slope from
// the dune rim down past the waterline, but multi-row and shaded as a real
// shoreline instead of one flat sand sheet. A WET/DRY gradient bakes into
// the vertex colours — pale dry sand high up darkens through a damp band to
// the wet, water-soaked sand at the toe (the swash zone) — and a separate
// low-roughness WET-SAND overlay covers the splash zone so the PMREM sky
// gives it a sheen the matte dry sand never gets. The wet read is the key
// shoreline cue: dry → damp → wet → foam → sea, never a hard cut edge.
//   wet/dry darkening + alpha-blended wet zone: Cyanilux shoreline
//   breakdown; smoother low-noise wet sand + drag: 80.lv Substance study.
const ROWS_BEACH = 7;
const dryHi = new THREE.Color(0xe6d2a8); // sun-bleached dry sand crest
const dryLo = new THREE.Color(0xcbb488); // dry sand toward the damp line
const dampC = new THREE.Color(0x9a8763); // the damp transition band
const wetC = new THREE.Color(0x6f6045); // dark water-soaked sand at the swash

export function addBeachSkirt(ctx: CoastCtx, segs: number[], dryMat: THREE.Material): void {
  const { scene, o, n, sea, BOT, botF, vOut, vW } = ctx;
  // SEAM CONTRACT: the wet/damp bands + sheen are placed in v relative to
  // the CURRENT seaLevel (sea, from CoastDef) and the swash REACH — how far
  // up the slope spent waves still wet the sand. A flat beach's swash runs
  // metres past the still waterline, so the damp band is anchored well
  // ABOVE sea (SWASH_HI), not at a thin wave-amplitude sliver, or it
  // foreshortens to nothing from a low camera. The water sibling owns the
  // real sea surface + wave height; from this worktree we anchor to the
  // current sea. MERGE: if the water agent's wave amplitude differs,
  // retune SWASH_HI / the heights below so the wet sand tracks their crest.
  const SWASH_HI = 1.7; // metres above sea the damp sand reaches (swash run-up)
  const cols = segs.length + 1;
  const pos = new Float32Array(cols * ROWS_BEACH * 3);
  const uv = new Float32Array(cols * ROWS_BEACH * 2);
  const col = new Float32Array(cols * ROWS_BEACH * 3);
  const tmp = new THREE.Color();
  let u = 0;
  for (let c = 0; c < cols; c++) {
    const vi = (segs[0] + c) % n;
    if (c > 0) {
      const pv = (segs[0] + c - 1) % n;
      u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 7;
    }
    const rimY = o[vi].y ?? 0;
    const topX = o[vi].x;
    const topZ = o[vi].z;
    const dx = vOut[vi].x * vW[vi] * botF;
    const dz = vOut[vi].z * vW[vi] * botF;
    // v fraction (0 rim → 1 toe) where the slope crosses a given height
    const fAt = (h: number) => Math.min(1, Math.max(0, (rimY - h) / Math.max(0.01, rimY - BOT)));
    const fDamp = fAt(sea + SWASH_HI); // top of the damp band (swash run-up)
    const fSea = fAt(sea); // the waterline itself
    for (let r = 0; r < ROWS_BEACH; r++) {
      const t = r / (ROWS_BEACH - 1);
      const k = (c * ROWS_BEACH + r) * 3;
      pos[k] = topX + dx * t;
      pos[k + 1] = rimY + (BOT - rimY) * t;
      pos[k + 2] = topZ + dz * t;
      uv[(c * ROWS_BEACH + r) * 2] = u;
      uv[(c * ROWS_BEACH + r) * 2 + 1] = t;
      // colour: dry crest → dry-low → damp at the swash top → dark wet sand
      // toward the waterline → darkest underwater (hidden by the sea plane).
      // The wide damp→wet ramp is what reads as a real shoreline gradient
      // instead of a clean cut at the water's edge.
      if (t < fDamp) tmp.copy(dryHi).lerp(dryLo, t / Math.max(0.001, fDamp));
      else if (t < fSea) tmp.copy(dryLo).lerp(dampC, (t - fDamp) / Math.max(0.001, fSea - fDamp));
      else tmp.copy(dampC).lerp(wetC, Math.min(1, (t - fSea) / 0.18));
      col[k] = tmp.r;
      col[k + 1] = tmp.g;
      col[k + 2] = tmp.b;
    }
  }
  const idx: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < ROWS_BEACH - 1; r++) {
      const a = c * ROWS_BEACH + r;
      const b = (c + 1) * ROWS_BEACH + r;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // dry skirt carries the sand texture, tinted by the wet/dry vertex
  // gradient (vertexColors multiplies the map) — one matte mesh, the whole
  // slope. The wet sheen rides as a thin overlay below.
  // [art-sand] use the shared Zucconi sand material directly (vertexColors
  // already on) — NOT a clone: the glitter/rim injection stores its compiled
  // shader + sun-pump on this single material instance, and a clone would
  // recompile into a second shader the per-frame uniform pump can't see.
  const mesh = new THREE.Mesh(geo, dryMat);
  mesh.receiveShadow = true;
  // RENDER-TIME glitter pump (determinism-safe — see makeSandMaterial): drive
  // the sun-tied sparkle uniforms from the mesh's own draw callback. Reads
  // performance.now + the live sun, writes only visual uniforms.
  const updateGlitter = (dryMat as THREE.Material).userData.updateGlitter as (() => void) | undefined;
  if (updateGlitter) mesh.onBeforeRender = updateGlitter;
  scene.add(mesh);

  // WET-SAND SHEEN overlay: a thin strip riding the splash zone (the
  // high-water line down to just below the waterline), a hair proud of the
  // dry slope along its surface normal so the two never z-fight. Low
  // roughness + a touch of metalness so scene.environment (the PMREM sky)
  // mirrors across it — that wet glint, brightest at a glancing angle from
  // a low camera, is what separates wet sand from a dark paint stripe. The
  // wet texture's dark base + drag arcs do the rest. Transparent with an
  // alpha that fades the sheen out toward the dry sand so there's no edge.
  // three rows down the splash zone so the sheen ramps in and back out
  // smoothly: transparent at the dry top, peak just above the waterline
  // (the still-glistening wet sand), tapering under the sea.
  const SHEEN_ROWS = 3;
  const sHeights = [sea + 1.5, sea + 0.2, sea - 0.5]; // dry edge → waterline → under
  const sAlphas = [0, 0.85, 0.4]; // fade in, peak at the wet line, fade under
  const sPos = new Float32Array(cols * SHEEN_ROWS * 3);
  const sUv = new Float32Array(cols * SHEEN_ROWS * 2);
  const sAlpha = new Float32Array(cols * SHEEN_ROWS); // per-vertex sheen alpha
  let su = 0;
  for (let c = 0; c < cols; c++) {
    const vi = (segs[0] + c) % n;
    if (c > 0) {
      const pv = (segs[0] + c - 1) % n;
      su += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 6;
    }
    const rimY = o[vi].y ?? 0;
    const dx = vOut[vi].x * vW[vi] * botF;
    const dz = vOut[vi].z * vW[vi] * botF;
    const fAt = (h: number) => Math.min(1, Math.max(0, (rimY - h) / Math.max(0.01, rimY - BOT)));
    const lift = 0.012; // proud of the slope so it wins the depth test
    for (let r = 0; r < SHEEN_ROWS; r++) {
      const t = fAt(sHeights[r]);
      const k = (c * SHEEN_ROWS + r) * 3;
      sPos[k] = o[vi].x + dx * t + vOut[vi].x * lift;
      sPos[k + 1] = rimY + (BOT - rimY) * t + lift;
      sPos[k + 2] = o[vi].z + dz * t + vOut[vi].z * lift;
      sUv[(c * SHEEN_ROWS + r) * 2] = su;
      sUv[(c * SHEEN_ROWS + r) * 2 + 1] = r / (SHEEN_ROWS - 1);
      sAlpha[c * SHEEN_ROWS + r] = sAlphas[r];
    }
  }
  const sIdx: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    for (let r = 0; r < SHEEN_ROWS - 1; r++) {
      const a = c * SHEEN_ROWS + r;
      const b = (c + 1) * SHEEN_ROWS + r;
      sIdx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const sGeo = new THREE.BufferGeometry();
  sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  sGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));
  sGeo.setAttribute('alpha', new THREE.BufferAttribute(sAlpha, 1));
  sGeo.setIndex(sIdx);
  sGeo.computeVertexNormals();
  const sMat = new THREE.MeshStandardMaterial({
    map: makeWetSandTexture(),
    roughness: 0.24, // low → a crisp grazing-angle sky glint = the wet read
    metalness: 0.0, // dielectric: Fresnel rim reflection, no metallic colour cast
    envMapIntensity: 1.3,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // per-vertex alpha fade (no shader rewrite — just feed gl_FragColor.a the
  // attribute): the sheen dissolves into the dry sand instead of edging it
  sMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float alpha;\nvarying float vAlpha;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = alpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vAlpha;\nvoid main() {')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
  };
  const sMesh = new THREE.Mesh(sGeo, sMat);
  sMesh.renderOrder = 1; // over the dry slope, under the foam
  sMesh.receiveShadow = true;
  scene.add(sMesh);
}
