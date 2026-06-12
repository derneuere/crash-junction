// Generates chevron-sign.glb — the yellow/black corner chevron board that
// Burnout plants on the outside of every fast bend. Self-made (CC0): the
// stock packs have no chevron sign and the transport TrafficSign GLBs are
// untextured grey. Native size ~2.6 m wide x 2.2 m tall; the board faces
// LOCAL -Z and the chevrons point LOCAL -X, so yaw = atan2(dirX, dirZ) of
// the approaching traffic turns the face to the driver with the arrows
// sweeping into a left-hander.
// Run from the repo root: fnm exec --using=22 -- node public/models/props/cliff-roadside/make-chevron.mjs
import { Document, NodeIO } from '@gltf-transform/core';

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('chevron-sign');

const mat = (name, rgb) =>
  doc.createMaterial(name).setBaseColorFactor([...rgb, 1]).setMetallicFactor(0).setRoughnessFactor(0.9);
// baseColorFactor is linear-space; these land on sRGB ~#ffc400 / #0c0c0c / #3c4044
const yellow = mat('chevronYellow', [1.0, 0.55, 0.0]);
const black = mat('chevronBlack', [0.018, 0.018, 0.018]);
const steel = mat('postSteel', [0.045, 0.05, 0.058]);

/** Axis-aligned box as its own primitive: 24 verts (split normals — the
 *  kits are flat-shaded and the deformer-free props keep that look). */
function boxPrim(hx, hy, hz, material) {
  const faces = [
    [[1, 0, 0], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]],
    [[-1, 0, 0], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]],
    [[0, 1, 0], [-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]],
    [[0, -1, 0], [-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]],
    [[0, 0, 1], [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]],
    [[0, 0, -1], [hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]],
  ];
  const pos = [];
  const nrm = [];
  const idx = [];
  for (const [n, ...quad] of faces) {
    const base = pos.length / 3;
    for (const v of quad) {
      pos.push(...v);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer);
  const normal = doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer);
  const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer);
  return doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setIndices(indices).setMaterial(material);
}

function addBox(name, material, hx, hy, hz, x, y, z, rotZ = 0) {
  const mesh = doc.createMesh(name).addPrimitive(boxPrim(hx, hy, hz, material));
  const node = doc.createNode(name).setMesh(mesh).setTranslation([x, y, z]);
  if (rotZ) node.setRotation([0, 0, Math.sin(rotZ / 2), Math.cos(rotZ / 2)]);
  scene.addChild(node);
}

// two steel posts + the yellow board (front face at z -0.04)
addBox('postL', steel, 0.06, 0.55, 0.06, -0.95, 0.55, 0);
addBox('postR', steel, 0.06, 0.55, 0.06, 0.95, 0.55, 0);
addBox('board', yellow, 1.3, 0.65, 0.04, 0, 1.55, 0);
// three chevrons pointing local -X: each apex at (c - 0.25, 1.55), two
// 45-degree strokes sweeping back to +x, floated just proud of the board
const A = Math.PI / 4;
const R = 0.21; // (L/2)*cos45 stroke-centre offset from the apex
for (const c of [-0.75, 0, 0.75]) {
  addBox(`chevU${c}`, black, 0.3, 0.085, 0.015, c - 0.25 + R, 1.55 + R, -0.055, A);
  addBox(`chevD${c}`, black, 0.3, 0.085, 0.015, c - 0.25 + R, 1.55 - R, -0.055, -A);
}

await new NodeIO().write(new URL('./chevron-sign.glb', import.meta.url).pathname.slice(1), doc);
console.log('wrote chevron-sign.glb');
