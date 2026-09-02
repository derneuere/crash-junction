import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from '../types';
import { panelDefs } from '../panels';
import { applyNormalSmoothing, buildNormalSmoothing, buildWheelGeometry, type WheelStyle } from '../geometry';
import type { ModelConfig, VehicleModel } from './types';
import { measurePanelMetrics } from './metrics';
import { cutPanelTemplates } from './cutting';
import { buildInterior } from './interior';
import { filterTrianglesByX, stripToPosNormal } from './mesh-utils';
import { dressLamps } from './lampdress';

const GLASS_MATS = ['windows', 'window', 'glass'];

// ---------- baking ----------

interface BodyPrim {
  geo: THREE.BufferGeometry;
  matName: string;
  color: THREE.Color;
  verts: number;
  /** Per-vertex colours (lamp dressing shades its bowls); else `color`. */
  colors?: Float32Array;
  /** Lamp dressing rides the merge but never the size normalisation. */
  dressing?: boolean;
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
  const isReverse = (p: BodyPrim) => p.matName.toLowerCase().includes('reverse');

  // the pack's own bounds drive the size normalisation below — captured
  // BEFORE the lamp dressing joins, so bezels proud of the fascia can't
  // rescale the body (wheel arches and panel boxes are sim state)
  const rawBox = new THREE.Box3();
  for (const p of bodyPrims) {
    p.geo.computeBoundingBox();
    rawBox.union(p.geo.boundingBox!);
  }
  // lamp units over the flat lamp polygons (lampdress.ts); their matNames
  // route them through the same role classification as the pack's prims
  const headName = (n: string) => n.toLowerCase().includes('headlight') || n === 'Lights';
  const tailName = (n: string) => n.toLowerCase().includes('taillight');
  // Each dressing prim is spliced in right BEHIND a pack prim of the same
  // material slot (bezels after the paint body, bowls after the lamp prims)
  // so it extends that prim's index run instead of opening a new material
  // group — a group is a draw call, and the traffic pool is 20+ cars.
  // Only the reverse lenses are a new slot (+1 group per car).
  const dressing = dressLamps(bodyPrims, headName, tailName, !!bodyPrims[0].geo.index).map((d) => ({
    geo: d.geo,
    matName: d.matName,
    color: new THREE.Color(0x141619),
    verts: (d.geo.attributes.position as THREE.BufferAttribute).count,
    colors: d.colors,
    dressing: true,
  }));
  const takeDress = (name: string): BodyPrim[] => {
    const i = dressing.findIndex((d) => d.matName === name);
    return i < 0 ? [] : dressing.splice(i, 1);
  };
  const spliced: BodyPrim[] = [];
  for (const p of bodyPrims) {
    spliced.push(p);
    if (p === biggest) spliced.push(...takeDress('LampBezel'));
    if (isHead(p)) spliced.push(...takeDress('Headlights'));
    if (isTail(p)) spliced.push(...takeDress('TailLights'), ...takeDress('ReverseLights'));
  }
  spliced.push(...dressing); // anything without a host prim
  bodyPrims.length = 0;
  bodyPrims.push(...spliced);

  // merge primitives → one deformable geometry + role vertex ranges
  const merged = mergeGeometries(bodyPrims.map((p) => p.geo), false);
  if (!merged) throw new Error(`${cfg.url}: merge failed`);
  const total = (merged.attributes.position as THREE.BufferAttribute).count;
  const colors = new Float32Array(total * 3);
  const paintRanges: [number, number][] = [];
  const glassRanges: [number, number][] = [];
  const headRanges: [number, number][] = [];
  const tailRanges: [number, number][] = [];
  const reverseRanges: [number, number][] = [];
  const dressRanges: [number, number][] = [];
  // the pack's own body, merged alone: the panel landmarks are measured on
  // THIS so the dressing can't move a panel box (sim state)
  const undressed = mergeGeometries(bodyPrims.filter((p) => !p.dressing).map((p) => p.geo), false);
  if (!undressed) throw new Error(`${cfg.url}: merge failed`);
  // its glass ranges index ITS buffer (the dressing is spliced between the
  // pack's prims in the merged one, so those ranges don't transfer)
  const undressedGlass: [number, number][] = [];
  let uCursor = 0;
  for (const p of bodyPrims) {
    if (p.dressing) continue;
    if (isGlass(p)) undressedGlass.push([uCursor, uCursor + p.verts]);
    uCursor += p.verts;
  }
  let cursor = 0;
  for (const p of bodyPrims) {
    if (p.dressing) dressRanges.push([cursor, cursor + p.verts]);
    if (p.colors) colors.set(p.colors, cursor * 3);
    else {
      for (let i = cursor; i < cursor + p.verts; i++) {
        colors[i * 3] = p.color.r;
        colors[i * 3 + 1] = p.color.g;
        colors[i * 3 + 2] = p.color.b;
      }
    }
    if (isPaint(p)) paintRanges.push([cursor, cursor + p.verts]);
    if (isGlass(p)) glassRanges.push([cursor, cursor + p.verts]);
    if (isHead(p)) headRanges.push([cursor, cursor + p.verts]);
    else if (isTail(p)) tailRanges.push([cursor, cursor + p.verts]);
    else if (isReverse(p)) reverseRanges.push([cursor, cursor + p.verts]);
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

  // The packs' wheels are near-flat dark discs that read as static no matter
  // how fast they spin, so only their PLACEMENT is kept (the arch metrics
  // above). The templates themselves come from the shared parametric builder
  // — the same design the generated cars and the generic wheel use — at the
  // spec's radius, so the suspension seating is exactly as before. Alloys on
  // cars, pressed steel on the bus. Deterministic, presentation-only, once
  // per bake.
  for (const w of wheelGeos) w.geo.dispose();
  const style: WheelStyle = spec.variant === 'bus' ? 'steelie' : 'five-spoke';
  const wheelL = buildWheelGeometry(style, spec.wheelRadius, 'L');
  const wheelR = buildWheelGeometry(style, spec.wheelRadius, 'R');
  const wheelCoarseL = buildWheelGeometry(style, spec.wheelRadius, 'L', 'coarse');
  const wheelCoarseR = buildWheelGeometry(style, spec.wheelRadius, 'R', 'coarse');

  // normalize the body to spec dims: center xz, stretch to width/height/
  // length, then drop it so the model's wheel line lands on the game's
  const box = rawBox; // undressed bounds (see above)
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
  undressed.translate(-center.x, 0, -center.z);
  undressed.scale(sx, sy, sz);
  undressed.translate(0, wheelY - rawWheelY * sy, 0);
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

  const metrics = measurePanelMetrics(undressed, arch, spec, undressedGlass);
  undressed.dispose();
  const model: VehicleModel = {
    body: merged,
    paintRanges,
    glassRanges,
    headRanges,
    tailRanges,
    reverseRanges,
    dressRanges,
    wheelL,
    wheelR,
    wheelCoarseL,
    wheelCoarseR,
    showroomWheels: true, // parametric wheels — the garage should show THEM
    arch,
    wheelY,
    panelMetrics: metrics,
    panelCuts: [],
    // built BEFORE the panel cuts, so width probes still see the door skin
    interior: buildInterior(metrics, arch, spec, merged),
  };
  model.panelCuts = cutPanelTemplates(model, panelDefs(spec, model), dressRanges);
  applyHullGroups(merged, glassRanges, headRanges, tailRanges, reverseRanges); // after the cuts replace the index
  return model;
}

/** Split the hull's index into material groups so one mesh can wear paint,
 *  mirror glass and light lenses at once ([hullMat, glassMat, headlightMat,
 *  taillightMat, reverseMat]). Must rerun after any index surgery — panel cuts, pane
 *  blowouts, repair reglaze — because groups address index positions. */
export function applyHullGroups(
  geo: THREE.BufferGeometry,
  glass: [number, number][],
  head: [number, number][],
  tail: [number, number][],
  reverse: [number, number][] = [],
): void {
  const idx = geo.index;
  if (!idx || !idx.count || (!glass.length && !head.length && !tail.length && !reverse.length)) return;
  const within = (v: number, ranges: [number, number][]) => ranges.some(([s, e]) => v >= s && v < e);
  const slot = (v: number) =>
    within(v, glass) ? 1 : within(v, head) ? 2 : within(v, tail) ? 3 : within(v, reverse) ? 4 : 0;
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
