import * as THREE from 'three';
import { BAY_SPACING, CEILING_Y, WALL_Z } from './constants';

/** Add the garage rig to `scene`: soft ambient + hemisphere so the concrete
 *  shell never goes pure black, one warm spotlight POOL over every parking
 *  bay (the B3 "each car under its own lamp" look), a cool rim from behind
 *  the wall line to separate roofs from the dark backdrop, and a dim front
 *  fill so the shadow side of the hero car stays readable. Lights hold no GL
 *  resources of their own, so nothing here needs disposal tracking. */
export function buildLights(scene: THREE.Scene, bayCount = 4): void {
  const amb = new THREE.AmbientLight(0x323a46, 0.7);
  scene.add(amb);

  const hemi = new THREE.HemisphereLight(0x3a434f, 0x16181c, 0.55);
  scene.add(hemi);

  // a warm pool per bay, hung just under the fluorescent fixture
  for (let i = 0; i < bayCount; i++) {
    const spot = new THREE.SpotLight(0xffe8c4, 70, 15, 0.62, 0.5, 1.5);
    spot.position.set(i * BAY_SPACING, CEILING_Y - 0.1, 0.4);
    spot.target.position.set(i * BAY_SPACING, 0, 0);
    scene.add(spot);
    scene.add(spot.target);
  }

  // cool rim from high behind the wall — reads as spill from the next level
  const rim = new THREE.DirectionalLight(0x7fb0ff, 1.3);
  rim.position.set(4, 6, WALL_Z - 6);
  scene.add(rim);

  // dim neutral fill from the viewer's side of the garage, centred on the row
  // (a warm off-centre fill smeared one end of the wall orange)
  const fill = new THREE.DirectionalLight(0xdfe6f0, 0.3);
  fill.position.set(((bayCount - 1) * BAY_SPACING) / 2, 4, 11);
  scene.add(fill);
}
