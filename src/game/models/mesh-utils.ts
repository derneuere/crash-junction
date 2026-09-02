import * as THREE from 'three';

/** Drop UVs/colors/tangents so primitives merge; we rebuild color ourselves. */
export function stripToPosNormal(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  return g;
}

/** Keep only triangles whose centroid lies on `side` of x = midX. */
export function filterTrianglesByX(g: THREE.BufferGeometry, midX: number, side: -1 | 1): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const norm = g.attributes.normal as THREE.BufferAttribute | undefined;
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  const index = g.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outCol: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const cx = (pos.getX(ia) + pos.getX(ib) + pos.getX(ic)) / 3;
    if (Math.sign(cx - midX) !== side) continue;
    for (const i of [ia, ib, ic]) {
      outPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) outNorm.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      if (col) outCol.push(col.getX(i), col.getY(i), col.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  if (outNorm.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(outNorm, 3));
  if (outCol.length) out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  return out;
}
