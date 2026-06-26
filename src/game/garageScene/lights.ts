import * as THREE from 'three';
import { FLOOR_Y } from './constants';

/** Add the showroom rig to `scene`: soft ambient, a dramatic overhead spotlight
 *  cone on the turntable, a warm key + cool rim + dim fill three-point set, and
 *  a faint glow point under the rim ring. Lights hold no GL resources of their
 *  own, so nothing here needs disposal tracking. */
export function buildLights(scene: THREE.Scene): void {
  // soft ambient so the dark shell isn't pure black
  const amb = new THREE.AmbientLight(0x2a3340, 0.6);
  scene.add(amb);

  // dramatic overhead spotlight on the turntable — a tight warm cone, the
  // signature "SELECT A CAR" pool of light
  const spot = new THREE.SpotLight(0xffe6c0, 90, 22, 0.5, 0.55, 1.4);
  spot.position.set(0.5, 9, 1.2);
  spot.target.position.set(0, 0, 0);
  scene.add(spot);
  scene.add(spot.target);

  // warm key from the front-left
  const key = new THREE.DirectionalLight(0xfff0dd, 1.7);
  key.position.set(-6, 6, 7);
  scene.add(key);

  // cool rim from behind-right — separates the car from the dark wall
  const rim = new THREE.DirectionalLight(0x7fb0ff, 2.2);
  rim.position.set(7, 4, -8);
  scene.add(rim);

  // dim blue fill from the left to keep the shadow side readable
  const fill = new THREE.DirectionalLight(0x4a6ea0, 0.5);
  fill.position.set(8, 3, 4);
  scene.add(fill);

  // a faint glow point under the rim ring so the plinth reads as lit
  const rimGlow = new THREE.PointLight(0xff7a18, 6, 7, 2);
  rimGlow.position.set(0, FLOOR_Y + 0.4, 0);
  scene.add(rimGlow);
}
