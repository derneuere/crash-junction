import * as THREE from 'three';
import type { DeformablePart, PanelState, VehicleSpec } from '../types';
import type { PanelCut, VehicleModel } from '../models';
import { hullMat, makeColoredBox, registerCarMaterial, registerPlayerSwappable } from '../geometry';
import { panelDefs } from './defs';

/** Torn bodywork tumbles — show its inside too (the hull is a one-sided
 *  shell, so a FrontSide door would vanish seen from behind). */
const panelMat = hullMat.clone();
panelMat.side = THREE.DoubleSide;
registerCarMaterial(panelMat, 0.5); // same gloss as the hull paint
// the player's panels join the live-reflection swap — without this the
// bonnet would mirror the street while a torn door mirrors the showroom
registerPlayerSwappable(panelMat, 0.6);

/** Clone a cutout template and repaint its paint verts in the spawn color
 *  (the cutout keeps its baked trim/handle colors elsewhere). */
function paintCut(cut: PanelCut, color: number): THREE.BufferGeometry {
  const geo = cut.geo.clone();
  const col = geo.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color(color);
  for (let i = 0; i < cut.paint.length; i++) {
    if (cut.paint[i]) col.setXYZ(i, c.r, c.g, c.b);
  }
  return geo;
}

export function buildPanels(
  group: THREE.Group,
  spec: VehicleSpec,
  color: number,
  deformables: DeformablePart[],
  model: VehicleModel | null,
): PanelState[] {
  const out: PanelState[] = [];
  panelDefs(spec, model).forEach((def, i) => {
    // dressed vehicles hang real bodywork cut from their hull; the colored
    // box is the fallback (procedural hulls, regions that cut to slivers)
    const cut = model?.panelCuts[i] ?? null;
    const mesh = cut
      ? new THREE.Mesh(paintCut(cut, color), panelMat)
      : new THREE.Mesh(makeColoredBox(...def.size, color), hullMat);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    pivot.position.set(
      def.center[0] + def.hingeOffset[0],
      def.center[1] + def.hingeOffset[1],
      def.center[2] + def.hingeOffset[2],
    );
    mesh.position.set(-def.hingeOffset[0], -def.hingeOffset[1], -def.hingeOffset[2]);
    // a box lid leans onto the hood slope; a cutout has the slope baked in
    if (!cut && def.tilt) mesh.quaternion.setFromAxisAngle(new THREE.Vector3(...def.axis), def.tilt);
    pivot.add(mesh);
    group.add(pivot);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const col = mesh.geometry.attributes.color as THREE.BufferAttribute;
    deformables.push({
      mesh,
      base: Float32Array.from(pos.array as Float32Array),
      baseCol: Float32Array.from(col.array as Float32Array),
    });
    out.push({
      kind: def.kind,
      mesh,
      pivot,
      size: cut ? cut.size : { x: def.size[0], y: def.size[1], z: def.size[2] },
      hingeAxis: new THREE.Vector3(...def.axis),
      flapDir: def.flapDir,
      maxAngle: def.maxAngle,
      outward: new THREE.Vector3(...def.outward),
      threshold: def.threshold,
      home: mesh.position.clone(),
      homeQ: mesh.quaternion.clone(),
      damage: 0,
      angle: 0,
      detached: false,
    });
  });
  return out;
}
