import * as THREE from 'three';

/** A sink for GL resources created here that the caller must dispose later. */
type Track = (...items: { dispose(): void }[]) => void;

/** Hull material set [paint, glass, headlight, taillight] to mirror the
 *  baked hull's four index groups (applyHullGroups). Glossy clearcoat over
 *  vertex colours = B3 paint; glass is a dark tinted pane (no transmission —
 *  the garage has no framebuffer interior pre-pass worth paying for). */
export function carMats(track: Track): THREE.Material[] {
  const paint = new THREE.MeshPhysicalMaterial({
    vertexColors: true, color: 0xffffff, roughness: 0.28, metalness: 0.05,
    clearcoat: 1, clearcoatRoughness: 0.06,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    vertexColors: true, color: 0xffffff, roughness: 0.08, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.62,
  });
  const head = new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 0.35, roughness: 0.3,
  });
  const tail = new THREE.MeshStandardMaterial({
    vertexColors: true, color: 0xffffff, emissive: 0xff2a16, emissiveIntensity: 0.4, roughness: 0.35,
  });
  track(paint, glass, head, tail);
  return [paint, glass, head, tail];
}

export function interiorMat(track: Track): THREE.Material[] {
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
  const cabin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  track(metal, cabin);
  return [metal, cabin];
}

export function wheelMat(track: Track): THREE.Material {
  // smooth-shaded: the wheel geometry carries its own normals (round tyre,
  // hard rim lip); a touch of metalness lets the alloy pick up the showroom lights
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 });
  track(m);
  return m;
}
