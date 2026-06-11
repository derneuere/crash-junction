// Dump GLB structure: node tree, mesh prims, materials, vert counts, bounds.
// Usage: node tools/inspect-models.mjs [glob-substring]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const io = new NodeIO();
const filter = process.argv[2] ?? '';

const dirs = ['public/models/cars/glb', 'public/models/transport/glb'];
for (const dir of dirs) {
  for (const f of await fs.readdir(path.join(root, dir))) {
    if (!f.endsWith('.glb') || !f.toLowerCase().includes(filter.toLowerCase())) continue;
    const doc = await io.read(path.join(root, dir, f));
    const r = doc.getRoot();
    console.log(`\n=== ${dir}/${f}`);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const walk = (node, depth) => {
      const mesh = node.getMesh();
      const t = node.getTranslation().map((v) => +v.toFixed(3));
      const s = node.getScale().map((v) => +v.toFixed(3));
      let info = '';
      if (mesh) {
        for (const prim of mesh.listPrimitives()) {
          const posAcc = prim.getAttribute('POSITION');
          const n = posAcc?.getCount() ?? 0;
          const mn = posAcc?.getMin([]) ?? [0, 0, 0];
          const mx = posAcc?.getMax([]) ?? [0, 0, 0];
          for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], mn[i] * s[i] + t[i]);
            max[i] = Math.max(max[i], mx[i] * s[i] + t[i]);
          }
          const mat = prim.getMaterial();
          const col = mat?.getBaseColorFactor().map((v) => +v.toFixed(2));
          info += ` [${n}v mat="${mat?.getName()}" rgba=${JSON.stringify(col)} attrs=${prim.listSemantics().join(',')}]`;
        }
      }
      console.log(`${'  '.repeat(depth)}${node.getName() || '(node)'} t=${JSON.stringify(t)} s=${JSON.stringify(s)}${info}`);
      for (const c of node.listChildren()) walk(c, depth + 1);
    };
    for (const scene of r.listScenes()) for (const n of scene.listChildren()) walk(n, 0);
    console.log(`bounds min=${min.map((v) => +v.toFixed(2))} max=${max.map((v) => +v.toFixed(2))}`);
  }
}
