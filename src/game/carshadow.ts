import * as THREE from 'three';
import type { Actor } from './types';

// ============================================================================
// BLOBBY CAR SHADOWS (perf-mobile-tier round 4 — the Burnout Paradise trick)
// ============================================================================
// On the phone tier, cars stop rendering into the sun's shadow depth pass
// entirely. Instead every vehicle gets a soft dark "blob" quad projected on
// the ground beneath it — all blobs live in ONE InstancedMesh, so the whole
// field's car shadows cost exactly ONE draw call (they used to cost ~27–97
// depth-pass draws even after the hull-only pruning). At Burnout speeds a
// soft under-car blob reads as a perfectly convincing contact shadow; the
// crisp sun-projected silhouette only ever registered when parked.
//
// Look: a radial-gradient disc texture, multiply-blended so the ground
// darkens (per-instance instanceColor lerps toward white to FADE the blob —
// with multiply blending, white = no darkening, so colour doubles as alpha).
// Grounded cars pin the blob to the car's own contact plane (body quaternion
// keeps it flush on ramps); airborne cars project it down to the height
// field, growing and fading with altitude like BP's height-off-ground term.
//
// PURE PRESENTATION: reads actor poses + the static height field in the
// render tail, writes instance matrices on a render-only mesh. The sim (and
// so every replay pin) never sees it.
// ============================================================================

const MAX_BLOBS = 32;
/** darkest multiply factor at rest (0 = black hole, 1 = invisible) */
const CORE_DARKNESS = 0.55;
/** altitude (m) at which the blob has fully faded out */
const FADE_HEIGHT = 5;
/** blob footprint growth per metre of altitude */
const GROW_PER_M = 0.12;
/** lift above the surface to dodge z-fighting on the road */
const SURFACE_EPSILON = 0.07;
/** cars farther than this from the camera skip their blob (it's sub-pixel) */
const BLOB_RANGE = 90;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function makeBlobTexture(): THREE.Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  // multiply-blend space: white = no darkening. Soft elliptical falloff from
  // a dark core to pure white at the rim.
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgb(0,0,0)');
  g.addColorStop(0.55, 'rgb(110,110,110)');
  g.addColorStop(0.85, 'rgb(225,225,225)');
  g.addColorStop(1, 'rgb(255,255,255)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export class CarBlobShadows {
  readonly mesh: THREE.InstancedMesh;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // lie flat, +y up
    const mat = new THREE.MeshBasicMaterial({
      map: makeBlobTexture(),
      blending: THREE.MultiplyBlending, // dst * src: white texels are a no-op
      transparent: true,
      depthWrite: false,
      fog: false, // a multiply decal must not pick up additive fog colour
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_BLOBS);
    this.mesh.name = 'cj-car-blob-shadows';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // one draw, instances move every frame
    this.mesh.renderOrder = 1; // after the opaque ground it multiplies over
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.visible = false; // setEnabled turns it on (phone tier)
    scene.add(this.mesh);
  }

  setEnabled(on: boolean): void {
    this.mesh.visible = on;
    if (!on) this.mesh.count = 0;
  }

  /** Re-place every car's blob for this frame (render tail, presentation
   *  only). `heightAt` is the level's static ground/ramp height field. */
  update(actors: readonly Actor[], camPos: THREE.Vector3, heightAt: (x: number, z: number) => number): void {
    if (!this.mesh.visible) return;
    let n = 0;
    for (const actor of actors) {
      if (n >= MAX_BLOBS) break;
      if (actor.kind !== 'vehicle' || !actor.spec || actor.exploded) continue;
      if (!actor.group.visible) continue; // past the fog: no car, no blob
      const pos = actor.group.position;
      const dx = pos.x - camPos.x;
      const dz = pos.z - camPos.z;
      if (dx * dx + dz * dz > BLOB_RANGE * BLOB_RANGE) continue;

      const grounded = actor.susp.some((s) => s.grounded);
      const groundY = grounded
        ? pos.y - actor.spec.rideHeight
        : heightAt(pos.x, pos.z);
      const altitude = Math.max(0, pos.y - actor.spec.rideHeight - groundY);
      if (altitude >= FADE_HEIGHT) continue; // fully faded — skip the quad

      // grounded: the car's own quaternion keeps the quad flush with ramps;
      // airborne: only the yaw survives (a tumbling car's blob stays flat).
      if (grounded && !actor.crashed) {
        _q.copy(actor.group.quaternion);
      } else {
        _e.setFromQuaternion(actor.group.quaternion, 'YXZ');
        _qYaw.setFromAxisAngle(UP, _e.y);
        _q.copy(_qYaw);
      }
      const grow = 1 + altitude * GROW_PER_M;
      _s.set(actor.spec.width * 1.35 * grow, 1, actor.spec.length * 1.15 * grow);
      _p.set(pos.x, groundY + SURFACE_EPSILON, pos.z);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(n, _m);

      // fade by lerping the multiply colour toward white (= transparent)
      const fade = Math.min(1, altitude / FADE_HEIGHT);
      const w = CORE_DARKNESS + (1 - CORE_DARKNESS) * fade;
      _c.setRGB(w, w, w);
      this.mesh.setColorAt(n, _c);
      n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
