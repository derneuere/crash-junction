import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// White base material: the dark tyre / lighter hub / mid-grey spokes all ride
// in per-vertex colours so the wheel's rotation is legible (a flat-dark cylinder
// reads as static no matter how fast it spins). MeshStandard with vertexColors
// multiplies albedo by the vertex colour, so a white base shows them unaltered.
export const wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });

const wheelGeoCache = new Map<number, THREE.BufferGeometry>();

/** Procedural road wheel with a contrasting hub + spokes so the BP wheel-roll
 *  (Wheel::UpdateRotation accumulates a real angle every step) is VISIBLE.
 *  A featureless cylinder hides that spin; the hub disc and radial spokes on
 *  both faces make each revolution unmistakable. Per-vertex coloured + merged
 *  into one cached BufferGeometry per radius (keyed by `r`). */
export function wheelGeometry(r: number): THREE.BufferGeometry {
  let g = wheelGeoCache.get(r);
  if (!g) {
    const width = r * 0.76;
    const parts: THREE.BufferGeometry[] = [];

    // tyre: dark rubber cylinder, axis along X (rotateZ), enough radial segs to
    // read as round once the hub/spokes give it a turning reference
    const tyre = new THREE.CylinderGeometry(r, r, width, 16);
    tyre.rotateZ(Math.PI / 2);
    applyUniformColor(tyre, 0x191b1f);
    parts.push(tyre);

    // hub + spokes on BOTH axial faces (±X) so the turning detail shows from
    // either side. The disc is lighter metallic grey; thin radial spoke boxes
    // bridge hub→rim in mid-grey — the high-contrast pattern that makes roll obvious.
    const hubR = r * 0.5;
    for (const sx of [width / 2 + 0.004, -(width / 2 + 0.004)]) {
      const disc = new THREE.CircleGeometry(hubR, 12);
      // CircleGeometry faces +Z; rotate so it faces ±X and sits on the wheel face
      disc.rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
      disc.translate(sx, 0, 0);
      applyUniformColor(disc, 0x6a6e74);
      parts.push(disc);

      // 5 radial spokes — thin boxes from just outside the hub to near the rim
      const spokeLen = r - hubR * 0.6;
      const spokeMid = (hubR * 0.6 + r) / 2;
      for (let s = 0; s < 5; s++) {
        const ang = (s / 5) * Math.PI * 2;
        const spoke = new THREE.BoxGeometry(r * 0.06, spokeLen, r * 0.1, 1, 1, 1);
        spoke.translate(0, spokeMid, 0); // push out along +Y before rotating into place
        spoke.rotateX(ang); // spread the spokes around the wheel face (Y/Z plane)
        // No rotateZ: the box is already flat against the ±X face (its thin r*0.06
        // axis is local x), spanning radially hub→rim in the face plane. A rotateZ
        // here would swing the long radial axis out along the axle into a spike.
        spoke.translate(sx, 0, 0);
        applyUniformColor(spoke, 0x4a4d52);
        parts.push(spoke);
      }
    }

    g = mergeGeometries(parts, false)!;
    wheelGeoCache.set(r, g);
  }
  return g;
}

export function applyUniformColor(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = (g.attributes.position as THREE.BufferAttribute).count;
  const cols: number[] = [];
  for (let i = 0; i < count; i++) cols.push(c.r, c.g, c.b);
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return g;
}

/** Segmented colored box — enough vertices for the crumple deformer. */
export function makeColoredBox(sx: number, sy: number, sz: number, hex: number): THREE.BufferGeometry {
  return applyUniformColor(new THREE.BoxGeometry(sx, sy, sz, 2, 2, 2), hex);
}
