import * as THREE from 'three';

// Live paint reflections for the player car: a CubeCamera re-renders the
// world into a small HDR cube map centred on the player's roof every frame,
// and the player's cloned car materials (geometry/shared.ts) wear it as
// their envMap — so buildings, cranes and walls visibly sweep through the
// clearcoat as the car moves, instead of the static showroom bake.
//
// Presentation only: reads the scene, writes a texture. The sim, and so
// replay determinism, never sees it.

const CUBE_SIZE = 128; // per face — reflections are streaks on curved paint,
// not mirrors; 128 reads sharp on a clearcoat and keeps the 6-face
// re-render + PMREM refilter comfortably under ~2 ms

export class PlayerReflections {
  private rt = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, { type: THREE.HalfFloatType });
  private cam = new THREE.CubeCamera(0.5, 320, this.rt);

  get texture(): THREE.Texture {
    return this.rt.texture;
  }

  /** Re-capture the world from the player's position. `hide` lists scene
   *  objects that must not appear in the capture: the player's own meshes
   *  (a car can't reflect itself) and screen-space dressing like the lens
   *  flare. Loose detached panels are world objects and stay visible. */
  update(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    center: THREE.Vector3,
    hide: readonly THREE.Object3D[],
  ): void {
    if (document.hidden) return; // rAF-starved hidden tabs render garbage
    const restore: THREE.Object3D[] = [];
    for (const o of hide) {
      if (o.visible) {
        o.visible = false;
        restore.push(o);
      }
    }
    // reuse this frame's shadow map — six extra shadow passes would more
    // than double the capture cost for no visible gain
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.cam.position.set(center.x, center.y + 0.9, center.z);
    this.cam.update(renderer, scene);
    renderer.shadowMap.autoUpdate = auto;
    for (const o of restore) o.visible = true;
    // tell three the PBR prefilter is stale — PMREM re-runs lazily for
    // whichever materials sample this cube next frame
    this.rt.texture.needsPMREMUpdate = true;
  }

  dispose(): void {
    this.rt.dispose();
  }
}
