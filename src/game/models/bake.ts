import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from '../types';
import { panelDefs } from '../panels';
import { applyNormalSmoothing, buildNormalSmoothing } from '../geometry';
import type { ModelConfig, VehicleModel } from './types';
import { measurePanelMetrics } from './metrics';
import { cutPanelTemplates } from './cutting';
import { buildInterior } from './interior';
import { filterTrianglesByX, stripToPosNormal, wheelHubDetail } from './mesh-utils';

const GLASS_MATS = ['windows', 'window', 'glass'];

// ---------- baking ----------

interface BodyPrim {
  geo: THREE.BufferGeometry;
  matName: string;
  color: THREE.Color;
  verts: number;
}

export function bakeModel(gltf: { scene: THREE.Group }, cfg: ModelConfig, spec: VehicleSpec): VehicleModel {
  const root = gltf.scene;
  root.rotation.y = cfg.rotY;
  root.updateMatrixWorld(true);

  // top-level split: wheel nodes vs body nodes (both packs name them *Wheel*)
  const bodyPrims: BodyPrim[] = [];
  const wheelNodes: THREE.Object3D[] = [];
  // RootNode wrapper → its children are the body + wheel nodes
  const wrapper = root.children[0]?.children?.length ? root.children[0] : root;
  for (const top of wrapper.children) {
    if (top.name.toLowerCase().includes('wheel')) {
      wheelNodes.push(top);
      continue;
    }
    top.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = stripToPosNormal(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const name = mat.name ?? '';
      const override = cfg.palette?.[name];
      bodyPrims.push({
        geo,
        matName: name,
        color: override !== undefined ? new THREE.Color(override) : mat.color.clone(),
        verts: (geo.attributes.position as THREE.BufferAttribute).count,
      });
    });
  }
  if (!bodyPrims.length || !wheelNodes.length) throw new Error(`${cfg.url}: unexpected node layout`);

  // which prims are spawn-color paint
  const biggest = bodyPrims.reduce((a, b) => (b.verts > a.verts ? b : a));
  const isPaint = (p: BodyPrim) =>
    cfg.paint.includes('*biggest*') ? p === biggest : cfg.paint.includes(p.matName);
  const isGlass = (p: BodyPrim) => GLASS_MATS.some((g) => p.matName.toLowerCase().includes(g));
  const isHead = (p: BodyPrim) => p.matName.toLowerCase().includes('headlight') || p.matName === 'Lights';
  const isTail = (p: BodyPrim) => p.matName.toLowerCase().includes('taillight');

  // merge primitives → one deformable geometry + role vertex ranges
  const merged = mergeGeometries(bodyPrims.map((p) => p.geo), false);
  if (!merged) throw new Error(`${cfg.url}: merge failed`);
  const total = (merged.attributes.position as THREE.BufferAttribute).count;
  const colors = new Float32Array(total * 3);
  const paintRanges: [number, number][] = [];
  const glassRanges: [number, number][] = [];
  const headRanges: [number, number][] = [];
  const tailRanges: [number, number][] = [];
  let cursor = 0;
  for (const p of bodyPrims) {
    for (let i = cursor; i < cursor + p.verts; i++) {
      colors[i * 3] = p.color.r;
      colors[i * 3 + 1] = p.color.g;
      colors[i * 3 + 2] = p.color.b;
    }
    if (isPaint(p)) paintRanges.push([cursor, cursor + p.verts]);
    if (isGlass(p)) glassRanges.push([cursor, cursor + p.verts]);
    if (isHead(p)) headRanges.push([cursor, cursor + p.verts]);
    else if (isTail(p)) tailRanges.push([cursor, cursor + p.verts]);
    cursor += p.verts;
    p.geo.dispose();
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // wheels: bake each node, split side-pairs, take arch positions from the
  // node origins / half centroids
  const wheelGeos: { geo: THREE.BufferGeometry; x: number; y: number; z: number }[] = [];
  const _wp = new THREE.Vector3();
  for (const node of wheelNodes) {
    const parts: THREE.BufferGeometry[] = [];
    node.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = stripToPosNormal(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const override = cfg.palette?.[mat.name ?? ''];
      const c = override !== undefined ? new THREE.Color(override) : mat.color;
      const n3 = (geo.attributes.position as THREE.BufferAttribute).count;
      const wcol = new Float32Array(n3 * 3);
      for (let i = 0; i < n3; i++) {
        wcol[i * 3] = c.r;
        wcol[i * 3 + 1] = c.g;
        wcol[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(wcol, 3));
      parts.push(geo);
    });
    if (!parts.length) continue;
    const whole = parts.length > 1 ? mergeGeometries(parts, false)! : parts[0];
    whole.computeBoundingBox();
    const bb = whole.boundingBox!;
    node.getWorldPosition(_wp);
    const span = bb.max.x - bb.min.x;
    const height = bb.max.y - bb.min.y;
    if (span > height * 1.6) {
      // a side pair (BackWheels / FrontWheels) — split at its x center
      const midX = (bb.min.x + bb.max.x) / 2;
      for (const side of [-1, 1] as const) {
        const half = filterTrianglesByX(whole, midX, side);
        half.computeBoundingBox();
        const hb = half.boundingBox!;
        const c = hb.getCenter(new THREE.Vector3());
        half.translate(-c.x, -c.y, -c.z);
        wheelGeos.push({ geo: half, x: c.x, y: c.y, z: c.z });
      }
      whole.dispose();
    } else {
      const c = bb.getCenter(new THREE.Vector3());
      whole.translate(-c.x, -c.y, -c.z);
      wheelGeos.push({ geo: whole, x: c.x, y: c.y, z: c.z });
    }
  }
  if (wheelGeos.length < 3) throw new Error(`${cfg.url}: found ${wheelGeos.length} wheels`);

  // arch metrics in raw model space
  const zs = wheelGeos.map((w) => w.z);
  const rawZFront = Math.min(...zs);
  const rawZRear = Math.max(...zs);
  const rawX = Math.max(...wheelGeos.map((w) => Math.abs(w.x)));
  const rawWheelY = wheelGeos.reduce((s, w) => s + w.y, 0) / wheelGeos.length;

  // pick one left wheel as the template (x < 0 after yaw normalization)
  const tmpl = wheelGeos.reduce((a, b) => (b.x < a.x ? b : a));
  tmpl.geo.computeBoundingBox();
  const tb = tmpl.geo.boundingBox!;
  const rawRadius = (tb.max.y - tb.min.y) / 2 || 0.3;
  const ws = spec.wheelRadius / rawRadius;
  let wheelL = tmpl.geo;
  wheelL.scale(ws, ws, ws);
  // Baked wheels are a near-flat dark disc/cap that reads as static no matter
  // how fast it spins. Merge a contrasting hub + radial spokes onto the ±X
  // faces (same trick as the procedural wheelGeometry) so the player's wheel
  // roll is legible. Deterministic, presentation-only — runs once at bake.
  // Everything is forced non-indexed so the merge succeeds regardless of the
  // source wheel's index state (wheels are display-only, never deformed).
  const wheelNI = wheelL.index ? wheelL.toNonIndexed() : wheelL;
  const withHub = mergeGeometries([wheelNI, ...wheelHubDetail(spec.wheelRadius)], false);
  if (withHub) {
    if (wheelNI !== wheelL) wheelNI.dispose();
    wheelL.dispose();
    wheelL = withHub;
  } else if (wheelNI !== wheelL) {
    wheelNI.dispose();
  }
  const wheelR = wheelL.clone();
  wheelR.rotateY(Math.PI);
  for (const w of wheelGeos) if (w.geo !== wheelL && w.geo !== tmpl.geo) w.geo.dispose();

  // normalize the body to spec dims: center xz, stretch to width/height/
  // length, then drop it so the model's wheel line lands on the game's
  merged.computeBoundingBox();
  const box = merged.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const sx = spec.width / size.x;
  const sy = spec.height / size.y;
  const sz = spec.length / size.z;
  const wheelY = -(spec.rideHeight - spec.wheelRadius);
  merged.translate(-center.x, 0, -center.z);
  merged.scale(sx, sy, sz);
  merged.translate(0, wheelY - rawWheelY * sy, 0);
  merged.computeVertexNormals();
  // PS2-style paint: curved panels get smooth (creased) normals so env
  // reflections sweep across them; hard edges keep their split normals.
  // Done before the panel cuts, so the cutouts inherit the smoothing.
  applyNormalSmoothing(
    merged.attributes.normal as THREE.BufferAttribute,
    buildNormalSmoothing(merged.attributes.position as THREE.BufferAttribute, merged.attributes.normal as THREE.BufferAttribute),
  );

  const arch = {
    x: rawX * sx,
    zFront: (rawZFront - center.z) * sz,
    zRear: (rawZRear - center.z) * sz,
  };

  const metrics = measurePanelMetrics(merged, arch, spec, glassRanges);
  const model: VehicleModel = {
    body: merged,
    paintRanges,
    glassRanges,
    headRanges,
    tailRanges,
    wheelL,
    wheelR,
    arch,
    wheelY,
    panelMetrics: metrics,
    panelCuts: [],
    // built BEFORE the panel cuts, so width probes still see the door skin
    interior: buildInterior(metrics, arch, spec, merged),
  };
  model.panelCuts = cutPanelTemplates(model, panelDefs(spec, model));
  applyHullGroups(merged, glassRanges, headRanges, tailRanges); // after the cuts replace the index
  return model;
}

/** Split the hull's index into material groups so one mesh can wear paint,
 *  mirror glass and light lenses at once ([hullMat, glassMat, headlightMat,
 *  taillightMat]). Must rerun after any index surgery — panel cuts, pane
 *  blowouts, repair reglaze — because groups address index positions. */
export function applyHullGroups(
  geo: THREE.BufferGeometry,
  glass: [number, number][],
  head: [number, number][],
  tail: [number, number][],
): void {
  const idx = geo.index;
  if (!idx || !idx.count || (!glass.length && !head.length && !tail.length)) return;
  const within = (v: number, ranges: [number, number][]) => ranges.some(([s, e]) => v >= s && v < e);
  const slot = (v: number) => (within(v, glass) ? 1 : within(v, head) ? 2 : within(v, tail) ? 3 : 0);
  geo.clearGroups();
  let runStart = 0;
  let runMat = slot(idx.getX(0));
  for (let t = 3; t <= idx.count; t += 3) {
    const mat = t === idx.count ? -1 : slot(idx.getX(t));
    if (mat !== runMat) {
      geo.addGroup(runStart, t - runStart, runMat);
      runStart = t;
      runMat = mat;
    }
  }
}
