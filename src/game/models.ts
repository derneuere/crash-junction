import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec, Variant } from './types';
import { panelDefs, type PanelDef } from './panels';
import { applyNormalSmoothing, applyUniformColor, buildNormalSmoothing } from './geometry';

// Quaternius CC0 vehicle models (public/models/*/glb), converted from FBX by
// tools/convert-models.mjs. The game's whole damage pipeline — crumple,
// scuff, char, glass — runs on per-vertex paint, so each model is baked once
// at load into a single vertex-colored BufferGeometry: one primitive per
// source material, colors from the material (cars pack) or a name palette
// (the transport FBX lost its colors — only the .blend has them).
//
// Wheels are cut out of the model (they're separate nodes in both packs) and
// rescaled so their radius equals the spec's physics wheelRadius; the wheel
// ARCH positions drive wheel-mesh placement, and buildSuspension derives its
// corner anchors from those meshes — so each model's stance is also its
// suspension geometry. Everything here happens before the first take and is
// deterministic, which the replay system depends on.

interface ModelConfig {
  url: string;
  /** Yaw applied first so the nose faces -z (game forward). */
  rotY: number;
  /** Material names to tint with the spawn color; '*biggest*' = the
   *  primitive with the most vertices (the paint body, in the cars pack). */
  paint: string[];
  /** Material name → color override (the transport pack ships grey). */
  palette?: Record<string, number>;
}

export interface VehicleModel {
  /** Normalized to the spec's dims, centered, vertex-colored. */
  body: THREE.BufferGeometry;
  paintRanges: [number, number][]; // vertex ranges painted in spawn color
  glassRanges: [number, number][];
  wheelL: THREE.BufferGeometry; // centered, radius = spec.wheelRadius
  wheelR: THREE.BufferGeometry;
  arch: { x: number; zFront: number; zRear: number }; // wheel centers, group space
  wheelY: number; // rest height of wheel centers, group space
  panelMetrics: PanelMetrics;
  /** Real bodywork cut from the hull, aligned with panelDefs(spec, model).
   *  null slots cut to slivers and keep the colored-box fallback. */
  panelCuts: (PanelCut | null)[];
  /** Dark blocker masses inside the body (engine bay / cabin / trunk) —
   *  wounds reveal these instead of daylight through the one-sided shell. */
  interior: THREE.BufferGeometry | null;
}

/** A panel's actual bodywork, carved out of the baked hull at bake time.
 *  Geometry is panel-local (origin at the def's box center, so the hinge
 *  pivot and detach physics work exactly as for the boxes). */
export interface PanelCut {
  geo: THREE.BufferGeometry;
  paint: Uint8Array; // per-vertex: repaint in the spawn color
  size: { x: number; y: number; z: number }; // cutout bounds → physics box
}

/** The nose or tail face of the body: the outermost FACE_DEPTH slice. */
export interface PanelFace {
  halfW: number;
  y0: number;
  y1: number;
}

/** A lid's resting surface (hood or rear deck), probed along the
 *  centerline: height at the band's midpoint + slope along z. */
export interface LidFit {
  y: number;
  slope: number;
}

/** Where doors live: the z band (between the arches; ahead of them on the
 *  bus), the side plane, and the sill→window-line vertical span. */
export interface DoorFit {
  x: number;
  z0: number;
  z1: number;
  sillY: number;
  waistY: number;
}

/** Where the bodywork actually is, measured off the normalized baked body
 *  in group space. buildPanels rigs the detachable panels to these instead
 *  of the procedural-hull guesses: doors on the side plane between sill and
 *  window line, bonnet/boot lying on the probed hood/deck surfaces,
 *  bumpers wrapping the true nose/tail faces. */
export interface PanelMetrics {
  minY: number;
  maxY: number;
  noseZ: number; // forward is -z
  tailZ: number;
  door: DoorFit;
  bonnet: LidFit;
  boot: LidFit;
  nose: PanelFace;
  tail: PanelFace;
}

const GLASS_MATS = ['windows', 'window', 'glass'];
const CAR = (name: string): ModelConfig => ({
  url: `/models/cars/glb/${name}.glb`,
  rotY: Math.PI,
  paint: ['*biggest*'],
});

// transport-pack palette (FBX materials are all flat grey 0.8)
const BUS_PALETTE: Record<string, number> = {
  Top: 0xf0ece1,
  Bottom: 0x4a5058, // tinted by spawn color via paint below
  Bumper: 0x33373d,
  Windows: 0x1d2733,
  Lights: 0xffc06a,
  Details: 0x6a7077,
  Material: 0x202327,
  Wheel: 0x202327,
};

const SEDAN_TRAFFIC = ['NormalCar1', 'NormalCar2', 'Taxi', 'SUV', 'Cop'].map(CAR);
const SEDAN_PLAYER = CAR('SportsCar2');
const BUS: ModelConfig = {
  url: '/models/transport/glb/Bus.glb',
  rotY: -Math.PI / 2,
  paint: ['Bottom'],
  palette: BUS_PALETTE,
};

interface Library {
  sedanTraffic: VehicleModel[];
  sedanPlayer: VehicleModel;
  bus: VehicleModel;
}

let library: Library | null = null;
let trafficPick = 0;

/** Take boundary: traffic model choice must restart with the actors, or a
 *  replayed take would dress (and hang suspension on) different cars. */
export function resetModelPicker(): void {
  trafficPick = 0;
}

export function getVehicleModel(variant: Variant, isPlayer: boolean): VehicleModel | null {
  if (!library) return null;
  if (variant === 'sedan') {
    if (isPlayer) return library.sedanPlayer;
    return library.sedanTraffic[trafficPick++ % library.sedanTraffic.length];
  }
  if (variant === 'bus') return library.bus;
  return null; // tanker stays procedural — no matching model in the packs
}

/** Load + bake every vehicle model. Call once before the Game constructs;
 *  on failure the game falls back to the procedural hulls. */
export async function loadVehicleModels(specs: Record<Variant, VehicleSpec>): Promise<void> {
  const loader = new GLTFLoader();
  const bake = async (cfg: ModelConfig, spec: VehicleSpec) => bakeModel(await loader.loadAsync(cfg.url), cfg, spec);
  const [player, bus, ...traffic] = await Promise.all([
    bake(SEDAN_PLAYER, specs.sedan),
    bake(BUS, specs.bus),
    ...SEDAN_TRAFFIC.map((cfg) => bake(cfg, specs.sedan)),
  ]);
  library = { sedanPlayer: player, bus, sedanTraffic: traffic };
}

// ---------- baking ----------

interface BodyPrim {
  geo: THREE.BufferGeometry;
  matName: string;
  color: THREE.Color;
  verts: number;
}

function bakeModel(gltf: { scene: THREE.Group }, cfg: ModelConfig, spec: VehicleSpec): VehicleModel {
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

  // merge primitives → one deformable geometry + role vertex ranges
  const merged = mergeGeometries(bodyPrims.map((p) => p.geo), false);
  if (!merged) throw new Error(`${cfg.url}: merge failed`);
  const total = (merged.attributes.position as THREE.BufferAttribute).count;
  const colors = new Float32Array(total * 3);
  const paintRanges: [number, number][] = [];
  const glassRanges: [number, number][] = [];
  let cursor = 0;
  for (const p of bodyPrims) {
    for (let i = cursor; i < cursor + p.verts; i++) {
      colors[i * 3] = p.color.r;
      colors[i * 3 + 1] = p.color.g;
      colors[i * 3 + 2] = p.color.b;
    }
    if (isPaint(p)) paintRanges.push([cursor, cursor + p.verts]);
    if (isGlass(p)) glassRanges.push([cursor, cursor + p.verts]);
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
  const wheelL = tmpl.geo;
  wheelL.scale(ws, ws, ws);
  const wheelR = wheelL.clone();
  wheelR.rotateY(Math.PI);
  for (const w of wheelGeos) if (w.geo !== wheelL) w.geo.dispose();

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
  applyGlassGroups(merged, glassRanges); // after the cuts replace the index
  return model;
}

/** Split the hull's index into body/glass material groups so one mesh can
 *  wear glossy paint AND mirror glass ([hullMat, glassMat]). Must rerun
 *  after any index surgery — panel cuts, pane blowouts, repair reglaze —
 *  because groups address index positions, not vertices. */
export function applyGlassGroups(geo: THREE.BufferGeometry, glassRanges: [number, number][]): void {
  const idx = geo.index;
  if (!idx || !idx.count || !glassRanges.length) return;
  const isGlass = (v: number) => glassRanges.some(([s, e]) => v >= s && v < e);
  geo.clearGroups();
  let runStart = 0;
  let runMat = isGlass(idx.getX(0)) ? 1 : 0;
  for (let t = 3; t <= idx.count; t += 3) {
    const mat = t === idx.count ? -1 : isGlass(idx.getX(t)) ? 1 : 0;
    if (mat !== runMat) {
      geo.addGroup(runStart, t - runStart, runMat);
      runStart = t;
      runMat = mat;
    }
  }
}

const FACE_DEPTH = 0.2; // how deep a slice of the nose/tail is "the bumper face"
const LID_RAYS = 8; // probes along a lid band's centerline
const SILL_STEPS = 14; // vertical resolution of the door-sill probe

/** Survey the normalized body for the panel-fit landmarks (PanelMetrics).
 *  Pure geometry work — deterministic, run once per template at bake.
 *  Two tricks carry it: the glass ranges are the waistline landmark (the
 *  bottom of the side windows is where doors end, and a probe ray whose
 *  first hit is glass is over the greenhouse, not over a lid), and surfaces
 *  are measured with rays, not vertices — a low-poly lid or door skin has
 *  vertices only at its corners, so vertex slices read garbage between. */
function measurePanelMetrics(
  geo: THREE.BufferGeometry,
  arch: { x: number; zFront: number; zRear: number },
  spec: VehicleSpec,
  glassRanges: [number, number][],
): PanelMetrics {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const halfW = Math.max(bb.max.x, -bb.min.x);
  const r = spec.wheelRadius;
  // the bus door rides ahead of the front arch; car doors between the arches
  const doorZ0 = spec.variant === 'bus' ? bb.min.z + FACE_DEPTH : arch.zFront + r;
  const doorZ1 = spec.variant === 'bus' ? arch.zFront - r : arch.zRear - r;
  const isGlass = new Uint8Array(pos.count);
  for (const [s, e] of glassRanges) isGlass.fill(1, s, e);
  const mesh = new THREE.Mesh(geo);
  const ray = new THREE.Raycaster();

  // waist: the side windows' bottom edge — where doors end
  let waistY = bb.max.y;
  for (let i = 0; i < pos.count; i++) {
    if (!isGlass[i]) continue;
    const z = pos.getZ(i);
    if (z > doorZ0 && z < doorZ1) waistY = Math.min(waistY, pos.getY(i));
  }
  if (waistY === bb.max.y) waistY = bb.min.y + (bb.max.y - bb.min.y) * 0.55;

  // door plane: widest body point in the band below the waist
  let sideX = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z > doorZ0 && z < doorZ1 && pos.getY(i) < waistY) {
      sideX = Math.max(sideX, Math.abs(pos.getX(i)));
    }
  }
  if (sideX === 0) sideX = halfW; // degenerate band — use the bbox

  // sill: walk down the side surface at the door's z until the shell steps
  // away from the door plane (the bus skirt tucks inside its window band,
  // so a vertex scan near the plane would stop at the window trim)
  const doorZc = (doorZ0 + doorZ1) / 2;
  const sideProbe = new THREE.Vector3(-1, 0, 0);
  let sillY = waistY;
  for (let j = 1; j <= SILL_STEPS; j++) {
    const y = waistY - ((waistY - bb.min.y - 0.02) * j) / SILL_STEPS;
    ray.set(new THREE.Vector3(halfW + 1, y, doorZc), sideProbe);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit || hit.point.x < sideX - 0.2) break;
    sillY = y;
  }
  if (sillY > waistY - 0.2) sillY = waistY - 0.35;

  // hood / rear deck: downward centerline probes
  const probe = (z: number): number | null => {
    ray.set(new THREE.Vector3(0, bb.max.y + 1, z), _down);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit?.face) return null;
    const f = hit.face;
    return isGlass[f.a] || isGlass[f.b] || isGlass[f.c] ? null : hit.point.y;
  };
  const fallbackY = waistY + 0.05;
  const bonnet = probeLid(probe, bb.min.z + FACE_DEPTH, arch.zFront + r, fallbackY);
  const boot = probeLid(probe, arch.zRear, bb.max.z - FACE_DEPTH, fallbackY);

  // nose/tail faces (bumper regions)
  const nose: PanelFace = { halfW: 0, y0: bb.max.y, y1: bb.min.y };
  const tail: PanelFace = { halfW: 0, y0: bb.max.y, y1: bb.min.y };
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const face = z < bb.min.z + FACE_DEPTH ? nose : z > bb.max.z - FACE_DEPTH ? tail : null;
    if (!face) continue;
    const y = pos.getY(i);
    face.halfW = Math.max(face.halfW, Math.abs(pos.getX(i)));
    face.y0 = Math.min(face.y0, y);
    face.y1 = Math.max(face.y1, y);
  }
  return {
    minY: bb.min.y,
    maxY: bb.max.y,
    noseZ: bb.min.z,
    tailZ: bb.max.z,
    door: { x: sideX, z0: doorZ0, z1: doorZ1, sillY, waistY },
    bonnet,
    boot,
    nose,
    tail,
  };
}

const _down = new THREE.Vector3(0, -1, 0);

/** Fit a resting line to a lid band: probe along it, line through the first
 *  and last surface hits. Rays over glass drop out, so a band that overlaps
 *  the windshield shrinks to the real hood. */
function probeLid(
  probe: (z: number) => number | null,
  z0: number,
  z1: number,
  fallbackY: number,
): LidFit {
  const hits: { z: number; y: number }[] = [];
  for (let i = 0; i < LID_RAYS; i++) {
    const z = z0 + ((i + 0.5) / LID_RAYS) * (z1 - z0);
    const y = probe(z);
    if (y !== null) hits.push({ z, y });
  }
  if (!hits.length) return { y: fallbackY, slope: 0 };
  const a = hits[0];
  const b = hits[hits.length - 1];
  const slope = b.z - a.z > 0.01 ? (b.y - a.y) / (b.z - a.z) : 0;
  return { y: a.y + slope * ((z0 + z1) / 2 - a.z), slope };
}

// ---------- hull cutting ----------
// Carve each panel's actual bodywork out of the baked hull (#2 step 2): a
// triangle whose centroid lies in a panel's region moves from the hull to
// that panel's cutout, so a torn-off door is the door, and the wound it
// leaves is a hole. The hull keeps its vertices and loses only index
// entries, which is what keeps the paint/glass VERTEX ranges valid with no
// remapping — orphaned verts cost a little memory and deformer time, fine.
// Glass never moves: windows stay on the hull and shatter independently.

const DOOR_GRAB = 0.2; // how far inboard of the door plane a door cut reaches
const LID_GRAB = 0.13; // vertical capture around a lid's probed surface line
const CUT_SLACK = 0.05; // general region margin

function inPanelRegion(def: PanelDef, x: number, y: number, z: number): boolean {
  const [cx, cy, cz] = def.center;
  const [sx, sy, sz] = def.size;
  switch (def.kind) {
    case 'door':
      // outboard slab on the door's side; z stays tight so the cut never
      // eats into the wheel arches
      return (
        Math.sign(x) === Math.sign(cx) &&
        Math.abs(x) > Math.abs(cx) - DOOR_GRAB &&
        y > cy - sy / 2 - CUT_SLACK &&
        y < cy + sy / 2 + CUT_SLACK &&
        z > cz - sz / 2 &&
        z < cz + sz / 2
      );
    case 'bonnet':
    case 'boot': {
      // a band around the probed hood/deck line (the def's rest tilt)
      if (Math.abs(x) > sx / 2 + CUT_SLACK) return false;
      if (z < cz - sz / 2 - 0.03 || z > cz + sz / 2 + 0.03) return false;
      const lineY = cy + Math.tan(-(def.tilt ?? 0)) * (z - cz);
      return Math.abs(y - lineY) < LID_GRAB;
    }
    case 'bumper':
      // the fascia strip; the box straddles the nose/tail plane
      return (
        Math.abs(z - cz) < sz / 2 + 0.08 &&
        y > cy - sy / 2 - CUT_SLACK &&
        y < cy + sy / 2 + CUT_SLACK
      );
  }
}

function cutPanelTemplates(model: VehicleModel, defs: PanelDef[]): (PanelCut | null)[] {
  const geo = model.body;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const norm = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute;
  if (!geo.index) {
    // non-indexed merge — a sequential index makes triangle removal a pure
    // index edit for that case too
    const seq = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) seq[i] = i;
    geo.setIndex(new THREE.BufferAttribute(seq, 1));
  }
  const index = geo.index!;
  const isGlass = new Uint8Array(pos.count);
  for (const [s, e] of model.glassRanges) isGlass.fill(1, s, e);
  const isPaint = new Uint8Array(pos.count);
  for (const [s, e] of model.paintRanges) isPaint.fill(1, s, e);

  // assign each triangle to the first region that claims its centroid
  const triCount = index.count / 3;
  const owner = new Int8Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    if (isGlass[a] || isGlass[b] || isGlass[c]) continue;
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    for (let d = 0; d < defs.length; d++) {
      if (inPanelRegion(defs[d], x, y, z)) {
        owner[t] = d;
        break;
      }
    }
  }

  // build the cutouts (before the hull index is replaced)
  const bb = new THREE.Box3();
  const cuts = defs.map((def, d) => {
    const tris: number[] = [];
    for (let t = 0; t < triCount; t++) if (owner[t] === d) tris.push(t);
    if (tris.length < 2) {
      // a sliver isn't a panel — leave those triangles on the hull
      for (const t of tris) owner[t] = -1;
      return null;
    }
    const n = tris.length * 3;
    const cPos = new Float32Array(n * 3);
    const cNorm = new Float32Array(n * 3);
    const cCol = new Float32Array(n * 3);
    const paint = new Uint8Array(n);
    bb.makeEmpty();
    let j = 0;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const i = index.getX(t * 3 + k);
        const px = pos.getX(i) - def.center[0];
        const py = pos.getY(i) - def.center[1];
        const pz = pos.getZ(i) - def.center[2];
        cPos[j * 3] = px;
        cPos[j * 3 + 1] = py;
        cPos[j * 3 + 2] = pz;
        cNorm[j * 3] = norm.getX(i);
        cNorm[j * 3 + 1] = norm.getY(i);
        cNorm[j * 3 + 2] = norm.getZ(i);
        cCol[j * 3] = col.getX(i);
        cCol[j * 3 + 1] = col.getY(i);
        cCol[j * 3 + 2] = col.getZ(i);
        paint[j] = isPaint[i];
        bb.expandByPoint(_cv.set(px, py, pz));
        j++;
      }
    }
    const cut = new THREE.BufferGeometry();
    cut.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
    cut.setAttribute('normal', new THREE.BufferAttribute(cNorm, 3));
    cut.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
    const size = bb.getSize(new THREE.Vector3());
    return { geo: cut, paint, size: { x: size.x, y: size.y, z: size.z } };
  });

  // the hull keeps everything nobody claimed
  const kept: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (owner[t] !== -1) continue;
    kept.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
  }
  geo.setIndex(kept);
  return cuts;
}

const _cv = new THREE.Vector3();

// ---------- interior ----------
// The hull is a one-sided shell, so every wound — torn bonnet, missing
// bumper, blown-out window — used to show daylight straight through the
// car. Bake a stripped-chassis interior instead, like a car with its
// bodywork pulled: a bare-metal floor platform, engine bay and trunk
// masses (metal group → metalMat), and dash, seats and a steering wheel
// (cabin group → cabinMat). Everything rides the deformable list, so it
// crumples and chars with the body.

const FLOOR_TINT = 0x969ca4; // bare aluminum platform
const ENGINE_TINT = 0x4a4e54;
const TRUNK_TINT = 0x55585e;
const DASH_TINT = 0x16181c;
const SEAT_TINT = 0x2b2f37;
const WHEEL_TINT = 0x101214;

type BlockOrNull = THREE.BufferGeometry | null;

function buildInterior(
  m: PanelMetrics,
  arch: { x: number; zFront: number; zRear: number },
  spec: VehicleSpec,
  hull: THREE.BufferGeometry,
): THREE.BufferGeometry | null {
  // boxes vs curved bodywork: any guessed width pokes through SOME model,
  // so the wide pieces measure their safe half-width with inward rays
  // against the hull over their (y, z) face
  const mesh = new THREE.Mesh(hull);
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const inward = new THREE.Vector3(-1, 0, 0);
  const safeHalfW = (y0: number, y1: number, z0: number, z1: number): number => {
    let w = Infinity;
    for (let iy = 0; iy < 4; iy++) {
      for (let iz = 0; iz < 7; iz++) {
        const y = y0 + ((iy + 0.5) / 4) * (y1 - y0);
        const z = z0 + ((iz + 0.5) / 7) * (z1 - z0);
        ray.set(origin.set(3, y, z), inward);
        const hit = ray.intersectObject(mesh, false)[0];
        // a miss or a far-side hit means the ray flew through an opening
        // (wheel arch) — that sample can't bound the width
        if (!hit || hit.point.x < 0.05) continue;
        w = Math.min(w, hit.point.x - 0.07);
      }
    }
    return w;
  };
  const boxAt = (x: number, w: number, y0: number, y1: number, z0: number, z1: number, tint: number): BlockOrNull => {
    if (w < 0.04 || y1 - y0 < 0.04 || z1 - z0 < 0.04) return null;
    const g = stripToPosNormal(new THREE.BoxGeometry(w, y1 - y0, z1 - z0));
    applyUniformColor(g, tint);
    g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  };
  const metal: BlockOrNull[] = [];
  const cabin: BlockOrNull[] = [];

  const sill = m.door.sillY + 0.04;
  const waist = m.door.waistY;
  const gh = m.maxY - waist; // greenhouse height
  const dz0 = m.door.z0;
  const dz1 = m.door.z1;
  const floorHalfW = Math.min(safeHalfW(sill, waist - 0.05, dz0 + 0.05, dz1 - 0.05) - 0.02, m.door.x - 0.06);
  if (!isFinite(floorHalfW) || floorHalfW < 0.2) return null; // unmeasurable side — skip dressing

  const seats = (x: number, w: number, zFront: number, zBack: number) => {
    const top = sill + 0.07;
    cabin.push(boxAt(x, w, top, top + 0.17, zFront, zBack - 0.1, SEAT_TINT)); // cushion
    cabin.push(boxAt(x, w, top, waist + 0.3 * gh, zBack - 0.1, zBack, SEAT_TINT)); // backrest
  };
  const steeringWheel = (x: number, y: number, z: number, tilt: number) => {
    const g = stripToPosNormal(new THREE.TorusGeometry(0.155, 0.026, 6, 14));
    applyUniformColor(g, WHEEL_TINT);
    g.rotateX(tilt);
    g.translate(x, y, z);
    cabin.push(g);
    cabin.push(boxAt(x, 0.05, y - 0.12, y - 0.02, z - 0.2, z, DASH_TINT)); // column
  };

  if (spec.variant === 'bus') {
    metal.push(boxAt(0, floorHalfW * 2, sill, sill + 0.08, m.noseZ + 0.55, m.tailZ - 0.55, FLOOR_TINT));
    // rear-engine bus: a metal mass behind the last row plugs the tail wound
    metal.push(boxAt(0, floorHalfW * 2 * 0.9, sill, waist - 0.1, m.tailZ - 1.2, m.tailZ - 0.4, ENGINE_TINT));
    cabin.push(boxAt(0, floorHalfW * 2 * 0.94, waist - 0.3, waist, m.noseZ + 0.55, m.noseZ + 0.9, DASH_TINT));
    const driverX = -floorHalfW * 0.5;
    steeringWheel(driverX, waist - 0.02, m.noseZ + 1.0, -0.9); // bus wheels lie flatter
    seats(driverX, 0.5, m.noseZ + 1.15, m.noseZ + 1.75);
    for (let z = m.noseZ + 2.2; z + 0.55 < m.tailZ - 1.3; z += 1.15) {
      seats(0, floorHalfW * 2 * 0.85, z, z + 0.55);
    }
  } else {
    const r = spec.wheelRadius;
    // engine/trunk tops stay under the LOW end of each sloped lid line —
    // and the lines are chords, so the rounded nose/tail dip below them
    const bonnetZ1 = arch.zFront + r;
    const bonnetLow = m.bonnet.y - (Math.abs(m.bonnet.slope) * (bonnetZ1 - m.noseZ - FACE_DEPTH)) / 2;
    const bootZ1 = m.tailZ - FACE_DEPTH;
    const bootLow = m.boot.y - (Math.abs(m.boot.slope) * (bootZ1 - arch.zRear)) / 2;
    const engineHalfW = Math.min(safeHalfW(sill, bonnetLow - 0.09, m.noseZ + 0.18, bonnetZ1 - 0.05), m.nose.halfW) - 0.02;
    const trunkHalfW = Math.min(safeHalfW(sill, bootLow - 0.09, arch.zRear + 0.1, m.tailZ - 0.18), m.tail.halfW) - 0.02;
    if (isFinite(engineHalfW)) metal.push(boxAt(0, engineHalfW * 2, sill, bonnetLow - 0.09, m.noseZ + 0.18, bonnetZ1 - 0.05, ENGINE_TINT));
    if (isFinite(trunkHalfW)) metal.push(boxAt(0, trunkHalfW * 2, sill, bootLow - 0.09, arch.zRear + 0.1, m.tailZ - 0.18, TRUNK_TINT));
    metal.push(boxAt(0, floorHalfW * 2, sill, sill + 0.07, dz0 + 0.04, dz1 - 0.04, FLOOR_TINT));

    cabin.push(boxAt(0, floorHalfW * 2 * 0.94, waist - 0.26, waist + 0.02, dz0 + 0.04, dz0 + 0.34, DASH_TINT));
    const driverX = -floorHalfW * 0.5;
    steeringWheel(driverX, waist + 0.02, dz0 + 0.52, -0.5);
    const cabMid = (dz0 + dz1) / 2;
    const seatW = Math.min(0.46, floorHalfW * 0.85);
    seats(driverX, seatW, cabMid - 0.32, cabMid + 0.2);
    seats(floorHalfW * 0.5, seatW, cabMid - 0.32, cabMid + 0.2);
    if (dz1 - 0.1 - (cabMid + 0.42) > 0.25) seats(0, floorHalfW * 2 * 0.88, cabMid + 0.42, dz1 - 0.1); // rear bench
  }

  const metalReal = metal.filter((b): b is THREE.BufferGeometry => b !== null);
  const cabinReal = cabin.filter((b): b is THREE.BufferGeometry => b !== null);
  const metalGeo = metalReal.length ? mergeGeometries(metalReal, false) : null;
  const cabinGeo = cabinReal.length ? mergeGeometries(cabinReal, false) : null;
  for (const b of [...metalReal, ...cabinReal]) b.dispose();
  // two material groups: 0 = metalMat, 1 = cabinMat (vehicles.ts)
  if (metalGeo && cabinGeo) {
    const out = mergeGeometries([metalGeo, cabinGeo], true);
    metalGeo.dispose();
    cabinGeo.dispose();
    return out;
  }
  const single = metalGeo ?? cabinGeo;
  if (single) single.addGroup(0, single.index ? single.index.count : (single.attributes.position as THREE.BufferAttribute).count, metalGeo ? 0 : 1);
  return single;
}

/** Drop UVs/colors/tangents so primitives merge; we rebuild color ourselves. */
function stripToPosNormal(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  return g;
}

/** Keep only triangles whose centroid lies on `side` of x = midX. */
function filterTrianglesByX(g: THREE.BufferGeometry, midX: number, side: -1 | 1): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const norm = g.attributes.normal as THREE.BufferAttribute | undefined;
  const col = g.attributes.color as THREE.BufferAttribute | undefined;
  const index = g.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const outPos: number[] = [];
  const outNorm: number[] = [];
  const outCol: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index.getX(t * 3) : t * 3;
    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const cx = (pos.getX(ia) + pos.getX(ib) + pos.getX(ic)) / 3;
    if (Math.sign(cx - midX) !== side) continue;
    for (const i of [ia, ib, ic]) {
      outPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (norm) outNorm.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      if (col) outCol.push(col.getX(i), col.getY(i), col.getZ(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  if (outNorm.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(outNorm, 3));
  if (outCol.length) out.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  return out;
}
