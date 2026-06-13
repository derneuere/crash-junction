import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LevelDef } from './types';
import type { PhysicsContext } from './physics';
import { BUILTINS } from './builtins';
import { applyBakedAO, aoKeyForUrl } from './ao';

// Level props: GLB set dressing (gantry cranes, containers, rocks) with
// hand-placed box colliders. The split is the determinism contract, same as
// models.ts for vehicles: the cannon body is built synchronously from the
// PropDef's plain numbers — it exists BEFORE the first physics step — while
// the GLB visual loads whenever the network delivers and simply drapes over
// it. Physics never sees the mesh.
//
// Colliders register in phys.wallDirs with the box's local z-axis as the
// along-wall direction: that is what makes a prop judge exactly like a
// track barrier in collision.ts — shoving a destabilized rival into a
// crane leg counts as a WALL wreck (i.e. a signature-zone takedown), and a
// clean head-on into one is a crash. Deliberately NOT in noCrashIds: a
// crane leg is a wall, not a kerb.

const sceneCache = new Map<string, Promise<THREE.Group>>();

/** One fetch+parse per URL; every instance clones the cached scene.
 *  'builtin:<name>' urls skip the network and resolve from the BUILTINS
 *  registry below — same cache, same clone path, so tint/scale/yaw and the
 *  collider-first contract behave identically. */
function loadPropScene(url: string): Promise<THREE.Group> {
  let p = sceneCache.get(url);
  if (!p) {
    if (url.startsWith('builtin:')) {
      const make = BUILTINS[url.slice('builtin:'.length)];
      p = make ? Promise.resolve(make()) : Promise.reject(new Error(`unknown builtin prop '${url}'`));
    } else {
      p = new GLTFLoader().loadAsync(url).then((gltf) => {
        // The Kenney kits ship glTF's DEFAULT metallicFactor of 1. That was
        // pure black before the sky IBL existed (no scene.environment = no
        // ambient on metal); now it would render as full chrome — equally
        // wrong for the sunlit matte low-poly concepts. Cap metalness at a
        // brushed-metal level: enough sky pickup to gleam, colormaps still
        // speak. Template-level (cached), so it covers every clone; visual
        // only, physics never sees materials.
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const std = m as THREE.MeshStandardMaterial;
            if (std.isMeshStandardMaterial) std.metalness = Math.min(std.metalness, 0.35);
          }
        });
        return gltf.scene;
      });
    }
    sceneCache.set(url, p);
  }
  return p;
}

/** Multiply every opaque material's base color toward the tint, cloning per
 *  tinted instance so the cached template (and untinted siblings) keep
 *  their colors. Transparent and glass-named materials are skipped — a
 *  green-tinted container shouldn't get green windows. */
function applyTint(root: THREE.Group, tint: number): void {
  const t = new THREE.Color(tint);
  const cloned = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material): THREE.Material => {
      if (m.transparent || /glass|window/i.test(m.name)) return m;
      let c = cloned.get(m);
      if (!c) {
        c = m.clone(); // clone() deep-copies userData, so night tags survive
        (c as THREE.MeshStandardMaterial).color?.multiply(t);
        cloned.set(m, c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

/** Build every PropDef of the level: colliders synchronously (call this
 *  before the first physics step), visuals async. collider 'none' or
 *  absent = pure decor, no body. */
export function loadLevelProps(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): void {
  for (const def of level.props ?? []) {
    if (def.collider && def.collider !== 'none') {
      const { hx, hy, hz } = def.collider;
      const body = new CANNON.Body({ mass: 0, material: phys.matGround });
      body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
      // ground-planted at hy regardless of the visual's y lift — a floating
      // collider would be an invisible ceiling for the cars beneath it
      body.position.set(def.x, hy, def.z);
      body.quaternion.setFromAxisAngle(UP, def.yaw);
      phys.world.addBody(body);
      phys.wallDirs.set(body.id, { x: Math.sin(def.yaw), z: Math.cos(def.yaw) });
    }

    void loadPropScene(def.url)
      .then((tpl) => {
        const inst = tpl.clone(true);
        if (def.tint !== undefined) applyTint(inst, def.tint);
        inst.position.set(def.x, def.y ?? 0, def.z);
        inst.rotation.y = def.yaw;
        inst.scale.setScalar(def.scale);
        inst.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.castShadow = m.receiveShadow = true;
        });
        // baked ambient occlusion (tools/bake-ao.mjs → public/baked-ao.json):
        // per-prototype self-occlusion darkening dropped into a vertex `aoVert`
        // attribute and folded into ONLY the indirect/ambient light (see
        // ao.ts). Geometric, so the one bake reads identically day/dusk/night,
        // and ambient-only so it deepens the boxes' corners and the crane
        // lattice without re-darkening what the screen-space N8AO already
        // catches. Keyed off the prop URL; no-op when no bake covers it.
        applyBakedAO(inst, aoKeyForUrl(def.url));
        scene.add(inst);
      })
      .catch((err) => {
        // visuals are best-effort: a missing GLB leaves the (already live)
        // collider as an invisible wall, never a broken sim
        console.error(`[props] failed to load ${def.url}`, err);
      });
  }
}

const UP = new CANNON.Vec3(0, 1, 0);

// The code-built dockyard furniture (gantry crane, floodlight mast, bollard,
// lamp post) lives in builtins.ts — a PURE-THREE module the offline AO baker
// imports to build byte-identical geometry. See that file's header.
