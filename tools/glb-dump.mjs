// Dump per-mesh/per-primitive vertex+tri structure of one or more GLBs.
// Usage: node tools/glb-dump.mjs <relpath-substr>
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const io = new NodeIO();
const want = (process.argv[2] ?? '').toLowerCase();
const dirs = [
  'public/models/props/quaternius-cargo',
  'public/models/props/polypizza-dockyard-ccby',
  'public/models/props/polypizza-coastal',
];
for (const dir of dirs) {
  let files;
  try { files = await fs.readdir(path.join(root, dir)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.glb') || !f.toLowerCase().includes(want)) continue;
    const doc = await io.read(path.join(root, dir, f));
    console.log(`\n=== ${dir}/${f}`);
    for (const mesh of doc.getRoot().listMeshes()) {
      const prims = mesh.listPrimitives();
      for (const prim of prims) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        const v = pos?.getCount() ?? 0;
        const t = (idx ? idx.getCount() : v) / 3;
        const mat = prim.getMaterial();
        const bmin = pos?.getMin([]) ?? [0, 0, 0];
        const bmax = pos?.getMax([]) ?? [0, 0, 0];
        const dim = bmin.map((m, i) => +(bmax[i] - m).toFixed(2));
        console.log(`  mesh="${mesh.getName()}" prim v=${v} tris=${Math.round(t)} mat="${mat?.getName()}" attrs=${prim.listSemantics().join(',')} dim=${JSON.stringify(dim)}`);
      }
    }
  }
}
