import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LevelDef } from './types';
import type { PhysicsContext } from './physics';
import { BUILTINS } from './builtins';
import { applyBakedAO, aoKeyForUrl } from './ao';
import { PropInstancer } from './propinstancer';

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

// TINT IS NOW A PER-INSTANCE COLOR, not a per-prop material clone.
//
// The old path clone()'d each prop's material and multiplied its base colour by
// the tint. That gave every distinctly-tinted container its OWN material, which
// fragmented the instancer (one InstancedMesh per geometry+material) so a
// container row in five weathered tints became five tiny batches. Instead we
// keep the ONE shared base material and carry the tint as the instance's
// per-instance colour (InstancedMesh.instanceColor) — three multiplies the
// material colour by it exactly as the clone did (`colormap · matColor · tint`),
// so the look is identical while ALL same-geometry containers, every tint,
// collapse into one instanced draw per region.
//
// The glass/window skip survives: applyTint's rule was "don't tint transparent
// or glass-named materials". The instancer reproduces it by forcing those
// sub-meshes' instance colour to white regardless of the prop's tint (see
// propinstancer.ts), so a green-tinted container still gets clear windows.
//
// White (0xffffff) is the identity multiplier, so untinted props need no
// special case — they simply carry a white instance colour.

/** Handle returned by loadLevelProps: the group every prop visual lives under
 *  (one visible flip = whole set) plus the distance-cull entry point Game
 *  drives from the render tail (presentation-only — see PropInstancer.cull). */
export interface LevelProps {
  group: THREE.Group;
  cull: (camX: number, camZ: number, maxDist: number) => void;
}

/** Build every PropDef of the level: colliders synchronously (call this
 *  before the first physics step), visuals async. collider 'none' or
 *  absent = pure decor, no body. */
export function loadLevelProps(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): LevelProps {
  // All prop visuals live under ONE group so the graphics 'props' toggle can
  // hide the whole set with a single group.visible flip (and props that stream
  // in after the toggle inherit it). Identity transform — the batcher bakes
  // world matrices, so a child lands exactly where adding to the scene would.
  const propsGroup = new THREE.Group();
  propsGroup.name = 'cj-props';
  scene.add(propsGroup);

  // The DRAW-CALL BATCHER (propinstancer.ts): every positioned prop visual is
  // harvested into this collector instead of being added to the scene one mesh
  // at a time. Once all the GLBs have streamed in we flush() — collapsing the
  // ~300 hand-placed props' repeated geometry (containers, rocks, crates,
  // builtins, …) into per-region instanced draws. Identical scene, far fewer
  // draw calls; that win then multiplies ×6 through the live cube reflection.
  // PRESENTATION ONLY — colliders below are untouched (the determinism contract).
  const instancer = new PropInstancer(propsGroup);
  const visuals: Promise<unknown>[] = [];

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

    visuals.push(
      loadPropScene(def.url)
        .then((tpl) => {
          const inst = tpl.clone(true);
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
          // Runs on the cloned instance BEFORE batching so the shared
          // geometry's aoVert attribute and the material's AO shader patch are
          // in place when the InstancedMesh inherits them (tint is no longer a
          // material clone — it rides as the per-instance colour, so AO patches
          // the one shared base material exactly once).
          applyBakedAO(inst, aoKeyForUrl(def.url));
          // batch instead of scene.add: collect this positioned prop's meshes
          // (world matrices folded in) for the per-region instanced flush below.
          // tint rides along as a per-instance colour (see propinstancer.ts).
          instancer.collect(inst, def.tint);
        })
        .catch((err) => {
          // visuals are best-effort: a missing GLB leaves the (already live)
          // collider as an invisible wall, never a broken sim
          console.error(`[props] failed to load ${def.url}`, err);
        }),
    );
  }

  // once every prop visual has resolved (or failed), emit the batched draws.
  // Ordering is pure presentation — colliders already exist — so awaiting the
  // whole set here can't touch determinism.
  void Promise.all(visuals).then(() => instancer.flush());

  return { group: propsGroup, cull: (camX, camZ, maxDist) => instancer.cull(camX, camZ, maxDist) };
}

const UP = new CANNON.Vec3(0, 1, 0);

// The code-built dockyard furniture (gantry crane, floodlight mast, bollard,
// lamp post) lives in builtins.ts — a PURE-THREE module the offline AO baker
// imports to build byte-identical geometry. See that file's header.
