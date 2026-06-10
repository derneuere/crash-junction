import * as THREE from 'three';
import { applyUniformColor } from './shared';

/** The tanker's fuel tank: a z-axis cylinder. Stays attached — it's the bomb. */
export function makeTankGeometry(r: number, len: number, hex: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 16, 6);
  g.rotateX(Math.PI / 2); // axis along z
  applyUniformColor(g, hex);
  g.computeVertexNormals();
  return g;
}
