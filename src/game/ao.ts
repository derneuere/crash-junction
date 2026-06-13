import * as THREE from 'three';

// BAKED AMBIENT OCCLUSION — runtime apply side.
//
// The artifact (public/baked-ao.json) is produced OFFLINE by tools/bake-ao.mjs:
// a CPU hemisphere raycaster (built-in THREE.Raycaster, no new dependency)
// computes per-vertex SELF-occlusion for each unique static prototype — the
// dockyard buildings, shipping containers, cranes, the gantries and the masts.
// Self-occlusion is geometric and identical for every placed instance, so one
// bake covers the whole level and reads the same at day, dusk and night (it is
// NOT a directional sun lightmap).
//
// How it's applied (the part that keeps it honest alongside the screen-space
// N8AO in the cine composer): the per-vertex AO is dropped into a custom
// `aoVert` attribute and folded into ONLY the material's indirect/ambient
// light (the hemisphere + IBL share), never the direct sun. So a corner gets
// its crease darkened in ambient — the classic baked contact-shadow read —
// while sunlit faces keep their key light, and N8AO is left to do the
// view-dependent fine occlusion without the two stacking into mud.
//
// VISUAL ONLY: this never touches geometry the physics sees, the camera, or
// any RNG. It mutates materials/attributes on the cloned visual instances.

interface BakedMesh {
  count: number; // vertex count this AO array belongs to (the match key)
  ao: number[]; // per-vertex occlusion in [0,1]; 1 = fully open, 0 = fully buried
}
interface BakedProto {
  meshes: BakedMesh[];
}
interface BakedArtifact {
  version: number;
  /** baseline strength baked into the artifact's docs; the runtime scales on
   *  top via AO_STRENGTH so it can be tuned without re-baking. */
  strength?: number;
  prototypes: Record<string, BakedProto>;
}

// How hard the baked AO darkens the ambient term. Deliberately modest: the
// cine tier already runs N8AO, so a heavy bake would double-darken the same
// creases into black. 0.85 lets a fully-buried vertex drop ambient to ~15%,
// which reads as a firm contact shadow on the FAST tier (no N8AO there) and
// still as believable extra depth under the composer.
export const AO_STRENGTH = 0.85;

let artifact: BakedArtifact | null = null;
let loadPromise: Promise<void> | null = null;
// instances that asked for AO before the artifact finished loading — replayed
// once it lands so a fast level build never loses its bake to a fetch race.
const pending: { object: THREE.Object3D; key: string }[] = [];

/** Kick the one-time fetch of the baked-AO artifact. Idempotent; safe to call
 *  from module load. A missing/!ok artifact is non-fatal — every applyBakedAO
 *  becomes a no-op and the scene renders exactly as it did before the bake. */
function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = fetch('baked-ao.json')
    .then((r) => (r.ok ? (r.json() as Promise<BakedArtifact>) : null))
    .then((data) => {
      artifact = data;
      if (!data) return;
      // drain anything that arrived before the artifact did
      for (const { object, key } of pending.splice(0)) applyBakedAO(object, key);
    })
    .catch(() => {
      // offline / no artifact baked yet — leave AO off, never throw into a build
      artifact = null;
    });
  return loadPromise;
}

/** Map a PropDef url to its bake key. 'builtin:<name>' urls key on the bare
 *  name (the procedural gantry/floodlight/bollard/lamp); a GLB url keys on the
 *  url itself, the same string the bake walked. */
export function aoKeyForUrl(url: string): string {
  return url.startsWith('builtin:') ? url.slice('builtin:'.length) : url;
}

// GLSL injected into MeshStandardMaterial. We carry AO in our own attribute
// (not the stock vertexColors path, which would multiply the WHOLE albedo —
// direct sun included) and apply it at the aomap stage so it scales only the
// indirect light, exactly like a real aoMap but vertex-sourced and UV-free.
const VERT_PARS = '\nattribute float aoVert;\nvarying float vAoVert;\n';
const VERT_MAIN = '\n\tvAoVert = aoVert;\n';
const FRAG_PARS = '\nvarying float vAoVert;\nuniform float aoVertStrength;\n';
// three computes ambient/IBL into reflectedLight.indirectDiffuse before the
// aomap_fragment chunk runs, so multiplying it here is the ambient-only hook.
const FRAG_AO =
  '\n\tfloat aoVertFactor = 1.0 - aoVertStrength * ( 1.0 - clamp( vAoVert, 0.0, 1.0 ) );\n' +
  '\treflectedLight.indirectDiffuse *= aoVertFactor;\n';

function patchMaterial(mat: THREE.Material): void {
  const m = mat as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return;
  if (m.userData.__aoPatched) return;
  m.userData.__aoPatched = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.aoVertStrength = { value: AO_STRENGTH };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_PARS)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>' + FRAG_AO);
  };
  m.needsUpdate = true;
}

/** Apply baked self-occlusion to a freshly-cloned prop/structure instance.
 *  Walks the instance's meshes in clone order and, for each, finds the baked
 *  array whose vertex count matches (a prototype's sub-meshes are unambiguous
 *  by count + order). No bake for the key, or no count match, is a clean
 *  no-op. Strength is shared (AO_STRENGTH) so a clone never needs its own. */
export function applyBakedAO(object: THREE.Object3D, key: string): void {
  if (!artifact) {
    // not loaded yet (or load failed). Queue for replay; the fetch is in flight.
    if (artifact === null && loadPromise) pending.push({ object, key });
    void ensureLoaded();
    return;
  }
  const proto = artifact.prototypes[key];
  if (!proto) return;

  // a per-mesh cursor into the proto's baked meshes: clone(true) preserves the
  // template's traversal order, so matching by (order, count) is stable across
  // every instance of the prototype.
  let cursor = 0;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const count = pos.count;
    // find the next baked mesh (from the cursor) whose count matches; tolerate
    // a prototype mesh the bake skipped (e.g. a glass sub-mesh) by scanning on.
    let baked: BakedMesh | undefined;
    for (let i = cursor; i < proto.meshes.length; i++) {
      if (proto.meshes[i].count === count) {
        baked = proto.meshes[i];
        cursor = i + 1;
        break;
      }
    }
    if (!baked) return;
    // the cloned geometry shares the template's BufferGeometry (clone(true)
    // clones the Object3D graph, not the geometry), so a fresh attribute would
    // be shared by every instance — which is fine, the AO is identical for all
    // instances of a prototype. Only set it once per geometry.
    if (!geo.getAttribute('aoVert')) {
      geo.setAttribute('aoVert', new THREE.Float32BufferAttribute(baked.ao, 1));
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of mats) patchMaterial(mt);
  });
}

// start the fetch eagerly so the artifact is usually in hand before the async
// GLB props finish loading (and before any structure apply)
void ensureLoaded();
