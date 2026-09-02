import * as THREE from 'three';
import type { PanelDef } from '../panels';
import type { PanelCut, VehicleModel } from './types';

// ---------- hull cutting ----------
// Carve each panel's actual bodywork out of the baked hull (#2 step 2): a
// triangle whose centroid lies in a panel's region moves from the hull to
// that panel's cutout, so a torn-off door is the door, and the wound it
// leaves is a hole. The hull keeps its vertices and loses only index
// entries, which is what keeps the paint/glass VERTEX ranges valid with no
// remapping — orphaned verts cost a little memory and deformer time, fine.
// Glass never moves: windows stay on the hull and shatter independently.

const DOOR_GRAB = 0.2; // how far inboard of the door plane a door cut reaches
const LID_GRAB = 0.13; // vertical capture around a lid's probed surface line
const CUT_SLACK = 0.05; // general region margin

function inPanelRegion(def: PanelDef, x: number, y: number, z: number): boolean {
  const [cx, cy, cz] = def.center;
  const [sx, sy, sz] = def.size;
  switch (def.kind) {
    case 'door':
      // outboard slab on the door's side; z stays tight so the cut never
      // eats into the wheel arches
      return (
        Math.sign(x) === Math.sign(cx) &&
        Math.abs(x) > Math.abs(cx) - DOOR_GRAB &&
        y > cy - sy / 2 - CUT_SLACK &&
        y < cy + sy / 2 + CUT_SLACK &&
        z > cz - sz / 2 &&
        z < cz + sz / 2
      );
    case 'bonnet':
    case 'boot': {
      // a band around the probed hood/deck line (the def's rest tilt)
      if (Math.abs(x) > sx / 2 + CUT_SLACK) return false;
      if (z < cz - sz / 2 - 0.03 || z > cz + sz / 2 + 0.03) return false;
      const lineY = cy + Math.tan(-(def.tilt ?? 0)) * (z - cz);
      return Math.abs(y - lineY) < LID_GRAB;
    }
    case 'bumper':
      // the fascia strip; the box straddles the nose/tail plane
      return (
        Math.abs(z - cz) < sz / 2 + 0.08 &&
        y > cy - sy / 2 - CUT_SLACK &&
        y < cy + sy / 2 + CUT_SLACK
      );
  }
}

/** `noCut` vertex ranges (the lamp dressing) stay on the hull whatever
 *  region their centroid lands in — they are display-only units, not
 *  bodywork, and letting them into a cut would move its physics box. */
export function cutPanelTemplates(model: VehicleModel, defs: PanelDef[], noCut: [number, number][] = []): (PanelCut | null)[] {
  const geo = model.body;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const norm = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  if (!geo.index) {
    // non-indexed merge — a sequential index makes triangle removal a pure
    // index edit for that case too
    const seq = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) seq[i] = i;
    geo.setIndex(new THREE.BufferAttribute(seq, 1));
  }
  const index = geo.index!;
  const isGlass = new Uint8Array(pos.count);
  for (const [s, e] of model.glassRanges) isGlass.fill(1, s, e);
  const isPaint = new Uint8Array(pos.count);
  for (const [s, e] of model.paintRanges) isPaint.fill(1, s, e);
  const isKeep = new Uint8Array(pos.count);
  for (const [s, e] of noCut) isKeep.fill(1, s, e);

  // assign each triangle to the first region that claims its centroid
  const triCount = index.count / 3;
  const owner = new Int8Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    if (isGlass[a] || isGlass[b] || isGlass[c]) continue;
    if (isKeep[a] || isKeep[b] || isKeep[c]) continue;
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    for (let d = 0; d < defs.length; d++) {
      if (inPanelRegion(defs[d], x, y, z)) {
        owner[t] = d;
        break;
      }
    }
  }

  // build the cutouts (before the hull index is replaced)
  const bb = new THREE.Box3();
  const cuts = defs.map((def, d) => {
    const tris: number[] = [];
    for (let t = 0; t < triCount; t++) if (owner[t] === d) tris.push(t);
    if (tris.length < 2) {
      // a sliver isn't a panel — leave those triangles on the hull
      for (const t of tris) owner[t] = -1;
      return null;
    }
    const n = tris.length * 3;
    const cPos = new Float32Array(n * 3);
    const cNorm = new Float32Array(n * 3);
    const cCol = new Float32Array(n * 3);
    const paint = new Uint8Array(n);
    bb.makeEmpty();
    let j = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const i = index.getX(t * 3 + k);
        const px = pos.getX(i) - def.center[0];
        const py = pos.getY(i) - def.center[1];
        const pz = pos.getZ(i) - def.center[2];
        cPos[j * 3] = px;
        cPos[j * 3 + 1] = py;
        cPos[j * 3 + 2] = pz;
        cNorm[j * 3] = norm.getX(i);
        cNorm[j * 3 + 1] = norm.getY(i);
        cNorm[j * 3 + 2] = norm.getZ(i);
        cCol[j * 3] = col.getX(i);
        cCol[j * 3 + 1] = col.getY(i);
        cCol[j * 3 + 2] = col.getZ(i);
        paint[j] = isPaint[i];
        bb.expandByPoint(_cv.set(px, py, pz));
        j++;
      }
    }
    const cut = new THREE.BufferGeometry();
    cut.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
    cut.setAttribute('normal', new THREE.BufferAttribute(cNorm, 3));
    cut.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
    const size = bb.getSize(new THREE.Vector3());
    return { geo: cut, paint, size: { x: size.x, y: size.y, z: size.z } };
  });

  // the hull keeps everything nobody claimed
  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (owner[t] !== -1) continue;
    kept.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
  }
  geo.setIndex(kept);
  return cuts;
}

const _cv = new THREE.Vector3();
