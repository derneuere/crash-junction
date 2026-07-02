import * as THREE from 'three';
import { FLOOR_Y, BAY_SPACING, BAY_HALF_W, CAR_YAW, WALL_Z, CEILING_Y } from './constants';

/** A sink for GL resources created here that the caller must dispose later. */
type Track = (...items: { dispose(): void }[]) => void;

/** Build the static parking-garage shell around `bayCount` bays centred at
 *  x = i·BAY_SPACING — concrete floor with a translucent reflection pane,
 *  painted bay lines, a hazard-striped back wall, square pillars between the
 *  bays, a ceiling with fluorescent fixtures, blob contact shadows, oil
 *  stains and a cone cluster. Every mesh goes into `scene`; every geometry/
 *  material/texture we create registers with `track` for disposal. */
export function buildShowroom(scene: THREE.Scene, track: Track, bayCount = 4): void {
  const midX = ((bayCount - 1) * BAY_SPACING) / 2;

  // floor — dark concrete; the translucent pane over the mirrored cars gives
  // the wet sheen, this is the matte base under it
  const floorGeo = new THREE.PlaneGeometry(70, 44);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x181b21, roughness: 0.88, metalness: 0.08 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(midX, FLOOR_Y - 0.001, 4);
  scene.add(floor);
  track(floorGeo, floorMat);

  // the translucent reflection pane that dims the mirrored copies into a sheen
  const paneGeo = new THREE.PlaneGeometry(70, 44);
  const paneMat = new THREE.MeshStandardMaterial({
    color: 0x0c0e12, roughness: 0.45, metalness: 0.4, transparent: true, opacity: 0.7, depthWrite: false,
  });
  const pane = new THREE.Mesh(paneGeo, paneMat);
  pane.rotation.x = -Math.PI / 2;
  pane.position.set(midX, FLOOR_Y, 4);
  scene.add(pane);
  track(paneGeo, paneMat);

  // painted stall lines + blob contact shadow per bay, grouped and yawed with
  // the angle-parked car so the markings run parallel to the bodywork. The
  // blob (a radial-gradient disc) seats the car on the concrete — there are
  // no shadow maps anywhere in this scene.
  const lineMat = new THREE.MeshStandardMaterial({
    color: 0xb9bec8, roughness: 0.7, emissive: 0x30343c, emissiveIntensity: 0.5,
  });
  const lineGeo = new THREE.PlaneGeometry(0.09, 5.4);
  const blobTex = radialShadowTexture();
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTex, transparent: true, opacity: 0.5, depthWrite: false,
  });
  const blobGeo = new THREE.PlaneGeometry(2.9, 5.2);
  track(lineMat, lineGeo, blobTex, blobMat, blobGeo);
  for (let i = 0; i < bayCount; i++) {
    const bay = new THREE.Group();
    bay.position.set(i * BAY_SPACING, 0, 0);
    bay.rotation.y = CAR_YAW - Math.PI; // stall markings parallel to the parked car
    for (const side of [-1, 1]) {
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(side * BAY_HALF_W, FLOOR_Y + 0.004, -0.1);
      bay.add(line);
    }
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(0, FLOOR_Y + 0.012, 0);
    blob.renderOrder = 2; // over the pane, under nothing that matters
    bay.add(blob);
    scene.add(bay);
  }

  // oil stains — dark translucent discs, one per gap, for lived-in concrete
  const stainMat = new THREE.MeshBasicMaterial({ color: 0x05060a, transparent: true, opacity: 0.35, depthWrite: false });
  const stainGeo = new THREE.CircleGeometry(0.55, 20);
  track(stainMat, stainGeo);
  const stainSpots: [number, number, number][] = [
    [-BAY_SPACING * 0.55, 1.4, 1],
    [midX + 1.1, 3.1, 0.7],
    [(bayCount - 1) * BAY_SPACING + 2.6, 0.4, 1.3],
  ];
  for (const [sx, sz, s] of stainSpots) {
    const stain = new THREE.Mesh(stainGeo, stainMat);
    stain.rotation.x = -Math.PI / 2;
    stain.position.set(sx, FLOOR_Y + 0.006, sz);
    stain.scale.setScalar(s);
    scene.add(stain);
  }

  // back wall — raw concrete with a hazard-striped skirt (B3 garage flavour)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x272c35, roughness: 0.95, metalness: 0.04 });
  const wallGeo = new THREE.PlaneGeometry(70, CEILING_Y - FLOOR_Y + 0.4);
  track(wallMat, wallGeo);
  const wall = new THREE.Mesh(wallGeo, wallMat);
  wall.position.set(midX, (CEILING_Y + FLOOR_Y) / 2, WALL_Z);
  scene.add(wall);

  const hazardTex = hazardStripeTexture();
  hazardTex.wrapS = THREE.RepeatWrapping;
  hazardTex.repeat.set(26, 1);
  const hazardMat = new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.7 });
  const hazardGeo = new THREE.PlaneGeometry(70, 0.42);
  track(hazardTex, hazardMat, hazardGeo);
  const hazard = new THREE.Mesh(hazardGeo, hazardMat);
  hazard.position.set(midX, FLOOR_Y + 0.5, WALL_Z + 0.012);
  scene.add(hazard);

  // dress the wall band above the cars so it isn't a black void: a burnt-
  // orange level stripe at roof height and a services duct along the top —
  // standard parking-structure furniture, B3 palette
  const stripeMat = new THREE.MeshStandardMaterial({
    color: 0x7a3c10, roughness: 0.85, emissive: 0x33170a, emissiveIntensity: 0.6,
  });
  const stripeGeo = new THREE.PlaneGeometry(70, 0.34);
  track(stripeMat, stripeGeo);
  const stripe = new THREE.Mesh(stripeGeo, stripeMat);
  stripe.position.set(midX, 2.05, WALL_Z + 0.012);
  scene.add(stripe);

  const ductMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.55, metalness: 0.55 });
  const ductGeo = new THREE.BoxGeometry(70, 0.34, 0.34);
  track(ductMat, ductGeo);
  const duct = new THREE.Mesh(ductGeo, ductMat);
  duct.position.set(midX, CEILING_Y - 0.35, WALL_Z + 0.4);
  scene.add(duct);

  // square concrete pillars between the bays (and one past each end), tight
  // to the wall so the angled cars' rear corners never read as touching them
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x2b313b, roughness: 0.92, metalness: 0.05 });
  const pillarGeo = new THREE.BoxGeometry(0.72, CEILING_Y - FLOOR_Y, 0.72);
  const baseMat = new THREE.MeshStandardMaterial({ map: hazardTexSquare(track), roughness: 0.75 });
  const baseGeo = new THREE.BoxGeometry(0.8, 0.5, 0.8);
  track(pillarMat, pillarGeo, baseMat, baseGeo);
  for (let i = -1; i < bayCount; i++) {
    const px = i * BAY_SPACING + BAY_SPACING / 2;
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(px, (CEILING_Y + FLOOR_Y) / 2, WALL_Z + 0.45);
    scene.add(pillar);
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(px, FLOOR_Y + 0.25, WALL_Z + 0.45);
    scene.add(base);
  }

  // ceiling — flat slab with one fluorescent fixture strip per bay. The
  // fixtures are MeshBasic (unlit) so they read as the light source; the
  // actual illumination is the per-bay spotlights in lights.ts.
  const ceilGeo = new THREE.PlaneGeometry(70, 26);
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x14171d, roughness: 0.95 });
  const ceil = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(midX, CEILING_Y, 6);
  scene.add(ceil);
  track(ceilGeo, ceilMat);

  // fixtures hang on short stems INTO the camera's frame — flush-mounted they
  // sat just above the visible band and the light pools read as sourceless
  const tubeGeo = new THREE.BoxGeometry(0.22, 0.08, 3.6);
  const tubeMat = new THREE.MeshBasicMaterial({ color: 0xdfeaff });
  const housingGeo = new THREE.BoxGeometry(0.34, 0.1, 3.8);
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.6, metalness: 0.4 });
  const stemGeo = new THREE.BoxGeometry(0.05, 0.5, 0.05);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x22262d, roughness: 0.7, metalness: 0.5 });
  track(tubeGeo, tubeMat, housingGeo, housingMat, stemGeo, stemMat);
  for (let i = 0; i < bayCount; i++) {
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.position.set(i * BAY_SPACING, CEILING_Y - 0.5, -0.4);
    scene.add(housing);
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.position.set(i * BAY_SPACING, CEILING_Y - 0.56, -0.4);
    scene.add(tube);
    for (const sz of [-1.5, 1.5]) {
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.set(i * BAY_SPACING, CEILING_Y - 0.25, -0.4 + sz);
      scene.add(stem);
    }
  }

  // marker-cone cluster past the last bay, tucked toward the wall — set
  // dressing that never crosses the hero car's sightline
  const coneGeo = new THREE.ConeGeometry(0.26, 0.7, 14);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6, emissive: 0x401200, emissiveIntensity: 0.4 });
  track(coneGeo, coneMat);
  const endX = (bayCount - 1) * BAY_SPACING + BAY_SPACING;
  for (const [cx, cz] of [[endX, -1.6], [endX + 0.7, -1.1], [endX + 0.35, -2.0]] as const) {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(cx, FLOOR_Y + 0.35, cz);
    scene.add(cone);
  }
}

/** Soft elliptical shadow — white-to-transparent radial alpha, tinted black. */
function radialShadowTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

/** Diagonal yellow/black hazard stripes for the wall skirt + pillar bases. */
function hazardStripeTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 32;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#181410';
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#c9930f';
  for (let x = -32; x < 64; x += 32) {
    g.beginPath();
    g.moveTo(x, 32);
    g.lineTo(x + 16, 0);
    g.lineTo(x + 32, 0);
    g.lineTo(x + 16, 32);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function hazardTexSquare(track: Track): THREE.CanvasTexture {
  const tex = hazardStripeTexture();
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  track(tex);
  return tex;
}
