// Convert the Quaternius FBX packs to GLB for the game.
// Usage: node tools/convert-models.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import convert from 'fbx2gltf';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JOBS = [
  { src: 'public/models/cars/FBX', dst: 'public/models/cars/glb' },
  { src: 'public/models/transport/FBX', dst: 'public/models/transport/glb' },
];

for (const job of JOBS) {
  const srcDir = path.join(root, job.src);
  const dstDir = path.join(root, job.dst);
  await fs.mkdir(dstDir, { recursive: true });
  for (const f of await fs.readdir(srcDir)) {
    if (!f.toLowerCase().endsWith('.fbx')) continue;
    const dst = path.join(dstDir, f.replace(/\.fbx$/i, '.glb'));
    try {
      await convert(path.join(srcDir, f), dst, ['--binary']);
      console.log('ok ', path.relative(root, dst));
    } catch (err) {
      console.error('FAIL', f, String(err).slice(0, 300));
    }
  }
}
