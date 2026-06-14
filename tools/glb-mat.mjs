// Report whether a GLB's materials carry a baseColor texture (so we know if
// UVs are load-bearing before decimation). Usage: node tools/glb-mat.mjs <substr>
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const io = new NodeIO();
const want = (process.argv[2] ?? '').toLowerCase();
const dirs = ['public/models/props/quaternius-cargo', 'public/models/props/polypizza-dockyard-ccby', 'public/models/props/polypizza-coastal'];
for (const dir of dirs) {
  let files; try { files = await fs.readdir(path.join(root, dir)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith('.glb') || !f.toLowerCase().includes(want)) continue;
    const doc = await io.read(path.join(root, dir, f));
    console.log(`\n=== ${dir}/${f}`);
    for (const m of doc.getRoot().listMaterials()) {
      const base = m.getBaseColorTexture();
      const bc = m.getBaseColorFactor().map((v) => +v.toFixed(2));
      console.log(`  mat="${m.getName()}" baseTex=${base ? base.getName() || 'YES' : 'none'} baseColor=${JSON.stringify(bc)}`);
    }
  }
}
