import * as THREE from 'three';
import { type VehicleModel } from '../models';
import { panelDefs } from '../panels';
import { SPECS } from '../vehicles';
import { FLOOR_Y } from './constants';
import { carMats, interiorMat, wheelMat } from './materials';

/** A sink for GL resources created here that the caller must dispose later. */
type Track = (...items: { dispose(): void }[]) => void;

/** Build a CLEAN, INTACT showroom car from a baked template.
 *
 *  The baked `model.body` is the crash rig's hull: its detachable panels
 *  (doors/bonnet/boot/bumpers) have been CARVED OUT of the index at bake time
 *  (models.ts cutPanelTemplates) and live separately in `model.panelCuts`, so
 *  the hull alone is full of holes and reveals the stripped-chassis interior.
 *  In-game that's correct — panels hang on hinges and tear off. The SHOWROOM
 *  car must be whole, so we re-attach every panel cut at its REST position
 *  (the spot it was carved from) to close the bodywork back up. No detach, no
 *  flap, no debris/cones — those are gameplay-only. We still draw the interior
 *  so the cabin reads through the glass, but no wound exposes it.
 *
 *  Mirrors vehicles.ts's makeModelHull + panels.ts's buildPanels rest pose,
 *  with garage-local, glossier materials and a single set of wheels. */
export function buildCar(model: VehicleModel, color: number, track: Track): THREE.Group {
  const group = new THREE.Group();
  const c = new THREE.Color(color);

  // hull geometry — clone (the template is shared/read-only) and repaint
  const bodyGeo = model.body.clone();
  track(bodyGeo);
  const col = bodyGeo.attributes.color as THREE.BufferAttribute;
  for (const [s, e] of model.paintRanges) {
    for (let i = s; i < e; i++) col.setXYZ(i, c.r, c.g, c.b);
  }
  // lift the dark-baked glass toward a tinted-but-readable showroom tone
  for (const [s, e] of model.glassRanges) {
    for (let i = s; i < e; i++) col.setXYZ(i, 0.16, 0.2, 0.26);
  }
  col.needsUpdate = true;

  const mats = carMats(track);
  const hull = new THREE.Mesh(bodyGeo, mats);
  hull.castShadow = false;
  group.add(hull);

  // re-attach the carved bodywork (intact, at rest) so the hull's panel
  // holes close up. panelDefs() is pure and gives the same defs the bake
  // cut against; cut geometry is panel-local (origin at def.center), so a
  // mesh placed at def.center sits exactly back in its wound. Paint the cut's
  // paint verts in the body colour to match the hull; trim/handles keep their
  // baked colour. Reuse the hull's paint material — its index has no glass/
  // lens groups, so a single-material mesh is correct. */
  const panelPaint = (mats[0] as THREE.Material); // [paint, glass, head, tail]
  for (const [i, def] of panelDefs(SPECS.sedan, model).entries()) {
    const cut = model.panelCuts[i];
    if (!cut) continue; // sliver region — nothing was carved, hull kept it
    const geo = cut.geo.clone();
    track(geo);
    const pcol = geo.attributes.color as THREE.BufferAttribute;
    for (let v = 0; v < cut.paint.length; v++) {
      if (cut.paint[v]) pcol.setXYZ(v, c.r, c.g, c.b);
    }
    pcol.needsUpdate = true;
    const panel = new THREE.Mesh(geo, panelPaint);
    panel.position.set(def.center[0], def.center[1], def.center[2]);
    group.add(panel);
  }

  if (model.interior) {
    const inner = new THREE.Mesh(model.interior.clone(), interiorMat(track));
    track(inner.geometry as THREE.BufferGeometry);
    group.add(inner);
  }

  // wheels at the arch corners (front/rear × left/right)
  const corners: [number, number, THREE.BufferGeometry][] = [
    [-model.arch.x, model.arch.zFront, model.wheelL],
    [model.arch.x, model.arch.zFront, model.wheelR],
    [-model.arch.x, model.arch.zRear, model.wheelL],
    [model.arch.x, model.arch.zRear, model.wheelR],
  ];
  const wmat = wheelMat(track);
  for (const [wx, wz, geo] of corners) {
    const wh = new THREE.Mesh(geo, wmat);
    wh.position.set(wx, model.wheelY, wz);
    group.add(wh);
  }

  // seat the car on the floor: the bake's group origin sits at COM height, so
  // the wheels rest at wheelY; drop the group so wheelY meets the floor.
  group.position.y = -model.wheelY + FLOOR_Y;
  return group;
}

/** Build the faked floor reflection: a mirrored (scaleY = -1) copy of `car`
 *  sitting under the floor, dimmed by the translucent floor pane over it.
 *  Cheaper than a Reflector render-target and reads as a wet-concrete sheen. */
export function buildMirror(car: THREE.Group, track: Track): THREE.Group {
  const mirror = car.clone(true);
  mirror.scale.y = -1;
  mirror.position.y = FLOOR_Y * 2; // reflect across the floor plane
  mirror.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const src = m.material as THREE.Material | THREE.Material[];
      const dim = (mat: THREE.Material) => {
        const cc = mat.clone();
        cc.transparent = true;
        (cc as THREE.Material & { opacity: number }).opacity = 0.28;
        cc.depthWrite = false;
        track(cc);
        return cc;
      };
      m.material = Array.isArray(src) ? src.map(dim) : dim(src);
      m.castShadow = false;
    }
  });
  return mirror;
}
