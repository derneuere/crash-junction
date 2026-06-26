import * as THREE from 'three';
import { FLOOR_Y } from './constants';

/** A sink for GL resources created here that the caller must dispose later. */
type Track = (...items: { dispose(): void }[]) => void;

/** Build the static showroom shell — floor, reflection pane, turntable plinth,
 *  back walls, columns, hazard stripes and marker cones — adding every mesh to
 *  `scene` and registering its geometry/material with `track` for disposal. */
export function buildShowroom(scene: THREE.Scene, track: Track): void {
  // floor — dark polished concrete; the translucent pane over the mirrored
  // car gives the wet sheen, this is the matte base under it
  const floorGeo = new THREE.CircleGeometry(40, 64);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.85, metalness: 0.1 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y - 0.001;
  scene.add(floor);
  track(floorGeo, floorMat);

  // the translucent reflection pane that dims the mirrored copy into a sheen
  const paneGeo = new THREE.CircleGeometry(40, 64);
  const paneMat = new THREE.MeshStandardMaterial({
    color: 0x0c0e12, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.72, depthWrite: false,
  });
  const pane = new THREE.Mesh(paneGeo, paneMat);
  pane.rotation.x = -Math.PI / 2;
  pane.position.y = FLOOR_Y;
  scene.add(pane);
  track(paneGeo, paneMat);

  // turntable plinth — a low dark disc with a glowing orange rim ring, B3
  // garage flavour
  const discGeo = new THREE.CylinderGeometry(3.2, 3.4, 0.12, 56);
  const discMat = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.7, metalness: 0.2 });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.y = FLOOR_Y - 0.06;
  scene.add(disc);
  track(discGeo, discMat);

  const ringGeo = new THREE.TorusGeometry(3.25, 0.045, 8, 80);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, emissive: 0xff7a18, emissiveIntensity: 1.4 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = FLOOR_Y + 0.01;
  scene.add(ring);
  track(ringGeo, ringMat);

  // back wall + side columns for depth — kept dark so the car pops
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x101319, roughness: 0.95, metalness: 0.05 });
  track(wallMat);
  const wallGeo = new THREE.PlaneGeometry(46, 16);
  track(wallGeo);
  for (const ry of [0, Math.PI]) {
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(0, 8 + FLOOR_Y, ry === 0 ? -13 : 13);
    wall.rotation.y = ry;
    scene.add(wall);
  }

  // concrete columns flanking the car — gives the orbit something to sweep past
  const colGeo = new THREE.CylinderGeometry(0.55, 0.65, 16, 18);
  const colMat = new THREE.MeshStandardMaterial({ color: 0x191c22, roughness: 0.92, metalness: 0.05 });
  track(colGeo, colMat);
  for (const [cx, cz] of [[-9, -8], [9, -8], [-9, 8], [9, 8]] as const) {
    const pillar = new THREE.Mesh(colGeo, colMat);
    pillar.position.set(cx, 8 + FLOOR_Y, cz);
    scene.add(pillar);
  }

  // hazard-stripe floor markings (B3 garage cones-and-tape flavour) — thin
  // angled bars on the concrete, emissive so they catch the spotlight edge
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x2a2410, emissive: 0xffb046, emissiveIntensity: 0.25, roughness: 0.8 });
  track(stripeMat);
  const stripeGeo = new THREE.PlaneGeometry(0.34, 5);
  track(stripeGeo);
  for (let i = -3; i <= 3; i++) {
    const bar = new THREE.Mesh(stripeGeo, stripeMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = Math.PI / 4;
    bar.position.set(i * 0.6 - 6.2, FLOOR_Y + 0.005, -6.5);
    scene.add(bar);
  }

  // a couple of marker cones beside the plinth
  const coneGeo = new THREE.ConeGeometry(0.26, 0.7, 14);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6, emissive: 0x401200, emissiveIntensity: 0.4 });
  track(coneGeo, coneMat);
  for (const [cx, cz] of [[-3.9, 1.6], [3.9, -1.4]] as const) {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(cx, FLOOR_Y + 0.29, cz);
    scene.add(cone);
  }
}
