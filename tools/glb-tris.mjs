// Offline GLB triangle census for the dockyard prop kits. Walks the prop
// asset dirs and reports per-file triangle totals + per-primitive cylinder/
// sphere hints, so the heaviest props can be ranked WITHOUT a browser.
// Usage: node tools/glb-tris.mjs [substr]
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const io = new NodeIO();
const filter = (process.argv[2] ?? '').toLowerCase();

const dirs = [
  'public/models/props/quaternius-cargo',
  'public/models/props/polypizza-dockyard-ccby',
  'public/models/props/polypizza-coastal',
  'public/models/props/kenney-city-kit-industrial',
  'public/models/props/kenney-factory-kit',
  'public/models/props/kenney-racing-kit',
  'public/models/props/kenney-pirate-kit',
];

const rows = [];
for (const dir of dirs) {
  let files;
  try { files = await fs.readdir(path.join(root, dir)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.glb') || !f.toLowerCase().includes(filter)) continue;
    let doc;
    try { doc = await io.read(path.join(root, dir, f)); } catch (e) { console.log(`SKIP ${dir}/${f}: ${e.message}`); continue; }
    let tris = 0, verts = 0, prims = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        prims++;
        const pos = prim.getAttribute('POSITION');
        const v = pos?.getCount() ?? 0;
        verts += v;
        const idx = prim.getIndices();
        tris += (idx ? idx.getCount() : v) / 3;
      }
    }
    rows.push({ name: `${path.basename(dir)}/${f}`, tris: Math.round(tris), verts, prims });
  }
}
rows.sort((a, b) => b.tris - a.tris);
console.log('tris   verts  prims  file');
for (const r of rows) {
  console.log(`${String(r.tris).padStart(6)} ${String(r.verts).padStart(6)} ${String(r.prims).padStart(5)}  ${r.name}`);
}
