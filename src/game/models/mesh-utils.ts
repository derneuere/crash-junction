import * as THREE from 'three';
import { applyUniformColor } from '../geometry';

/** Contrasting hub disc + 5 radial spokes on each ±X face of a baked road
 *  wheel (centered at origin, axle along X, radius `r` in the Y/Z plane), so
 *  the wheel's rotation is legible instead of reading as a static dark disc.
 *  Parts are non-indexed with position/normal/color to match the stripped
 *  baked wheel for mergeGeometries. Mirrors the procedural wheelGeometry. */
export function wheelHubDetail(r: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const hubR = r * 0.5;
  // a touch outside the tyre's outer faces; tyre half-width ~ r*0.38 in shared.ts
  const faceX = r * 0.38 + 0.006;
  for (const sx of [faceX, -faceX]) {
    const disc = new THREE.CircleGeometry(hubR, 12).toNonIndexed();
    disc.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2); // face ±X
    disc.translate(sx, 0, 0);
    stripToPosNormal(disc);
    applyUniformColor(disc, 0x8f9399);
    parts.push(disc);

    const spokeLen = r - hubR * 0.6;
    const spokeMid = (hubR * 0.6 + r) / 2;
    for (let s = 0; s < 5; s++) {
      const ang = (s / 5) * Math.PI * 2;
      const spoke = new THREE.BoxGeometry(r * 0.06, spokeLen, r * 0.1, 1, 1, 1).toNonIndexed();
      spoke.translate(0, spokeMid, 0);
      spoke.rotateX(ang); // spread radially in the Y/Z face plane
      spoke.translate(sx, 0, 0);
      stripToPosNormal(spoke);
      applyUniformColor(spoke, 0x5a5d63);
      parts.push(spoke);
    }
  }
  return parts;
}

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
