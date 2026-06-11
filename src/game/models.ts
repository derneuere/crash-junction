import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec, Variant } from './types';

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

  return {
    body: merged,
    paintRanges,
    glassRanges,
    wheelL,
    wheelR,
    arch: {
      x: rawX * sx,
      zFront: (rawZFront - center.z) * sz,
      zRear: (rawZRear - center.z) * sz,
    },
    wheelY,
  };
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
