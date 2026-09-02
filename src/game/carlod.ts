import * as THREE from 'three';
import type { Actor } from './types';

// ============================================================================
// CAR DRAW-CALL LOD (perf-mobile-tier round 3)
// ============================================================================
// Profiling the chase perspective showed cars are the #1 draw source: one car
// is ~33 main draws + ~15 shadow draws (multi-material hull ≈ 4, detachable
// panels, 4 wheels, the crash-wound interior, the wing) and the race runs 26
// actors. The dockyard top-down barely sees cars — which is exactly why the
// car-height chase view measured 2× its draws (546 vs 255).
//
// Three static facts make this safely tierable:
//   * the HULL is a complete baked body — panels/wheels/wing are attachments
//     ON TOP of it, so hiding them leaves a whole car, not a holed one;
//   * the INTERIOR (stripped-chassis innards) is only ever revealed through
//     deformation wounds — beyond a few car lengths it reads as shadow;
//   * beyond the fog horizon the whole car is rasterised fog-coloured.
//
// So per NON-PLAYER car:
//   interior    drawn only while the car is DAMAGED and near — a pristine
//               car's innards are fully occluded at any distance, yet they
//               cost 2 draws each; the whole 26-car field is pristine at the
//               race start
//   > NEAR      wheels swap to their coarse twin (factory.ts tags each wheel
//               mesh with userData.lodGeometry): the parametric wheel is
//               ~1.1k triangles, and four of them on every car in the field
//               would be the biggest triangle source after the terrain, while
//               past a few car lengths the tread grooves and lug nuts are
//               sub-pixel anyway. Same draw count, a third of the triangles.
//   > FAR       panels + wheels + small bits hidden -> hull-only (~4 draws)
//   > fog line  whole group hidden (was invisible anyway)
// and, once per car, everything except the hull stops casting shadows — the
// sun blob is the hull's silhouette; panel/wheel shadows never read.
//
// PURE PRESENTATION: visibility + castShadow flags flipped in the render tail
// off the render camera, exactly the grass-tile / prop-cull contract. The sim
// (cannon bodies, deformation state, recorded keys, worldHash) never reads a
// visual flag, so replay pins are untouched by construction.
// ============================================================================

// hysteresis pairs (m): flip out farther than you flip back in, so a car
// hovering on a ring boundary doesn't strobe its parts.
const NEAR_HIDE = 30;
const NEAR_SHOW = 24;
const FAR_HIDE = 52;
const FAR_SHOW = 44;

interface WheelLod {
  mesh: THREE.Mesh;
  full: THREE.BufferGeometry;
  coarse: THREE.BufferGeometry;
}

interface CarLodState {
  /** attachments safe to drop at FAR: panels, wheels, wing, small bits */
  small: THREE.Object3D[];
  /** wheel meshes with a coarse geometry twin (see NEAR above) */
  wheels: WheelLod[];
  wheelsFull: boolean;
  /** the crash-wound innards mesh(es) — drawn only while damaged AND near */
  interior: THREE.Object3D[];
  interiorShown: boolean;
  farHidden: boolean;
  groupHidden: boolean;
}

export class CarLod {
  private states = new WeakMap<Actor, CarLodState>();
  // every classified hull, so the blob-shadow tier can switch ALL car
  // shadow-casting off in one call (blobs replace the depth-pass silhouette)
  private hulls: THREE.Mesh[] = [];
  private hullsCast = true;

  /** Blob-shadow tier switch: hulls stop casting into the sun's depth pass
   *  when the batched ground blobs take over (carshadow.ts). Applies to the
   *  already-classified hulls and to every future classify. Presentation-only
   *  castShadow flags, same contract as the classify-time prune. */
  setHullShadows(cast: boolean): void {
    if (cast === this.hullsCast) return;
    this.hullsCast = cast;
    for (const h of this.hulls) h.castShadow = cast;
  }

  /** Classify a car's meshes once. The hull is the largest-radius
   *  shadow-casting mesh; the interior is the large non-casting one (built
   *  that way in vehicles/create.ts); everything else is an attachment. Also
   *  prunes shadow casters down to the hull, once — the one-mesh silhouette
   *  is the whole readable shadow. */
  private classify(actor: Actor): CarLodState {
    const meshes: THREE.Mesh[] = [];
    // traverse, not children: the deformable panels hang inside pivot Groups
    // (their hinge seams), wheels and hull are direct children.
    actor.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    let hull: THREE.Mesh | null = null;
    let hullR = -1;
    for (const m of meshes) {
      if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
      const r = m.geometry.boundingSphere?.radius ?? 0;
      if (m.castShadow && r > hullR) {
        hullR = r;
        hull = m;
      }
    }
    const state: CarLodState = {
      small: [], wheels: [], wheelsFull: true, interior: [], interiorShown: true, farHidden: false, groupHidden: false,
    };
    if (hull) {
      this.hulls.push(hull);
      hull.castShadow = this.hullsCast; // blob tier may already be active
    }
    for (const m of meshes) {
      if (m === hull) continue;
      const r = m.geometry.boundingSphere?.radius ?? 0;
      if (!m.castShadow && r > 1.5) state.interior.push(m);
      else state.small.push(m);
      const coarse = m.userData.lodGeometry as THREE.BufferGeometry | undefined;
      if (coarse) state.wheels.push({ mesh: m, full: m.geometry, coarse });
      // shadow prune (all tiers, player too — the caller classifies it):
      // only the hull's silhouette reads in the sun blob.
      m.castShadow = false;
    }
    return state;
  }

  /** Flip a part list, skipping (and dropping) anything that left the car's
   *  group — a shunt-detached panel is world debris now; resurrecting or
   *  hiding it from here would fight looseParts.ts. Panels sit under pivot
   *  sub-groups, so the check walks ancestors, not the direct parent. */
  private setVisible(actor: Actor, list: THREE.Object3D[], visible: boolean): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i];
      let n: THREE.Object3D | null = o.parent;
      while (n && n !== actor.group) n = n.parent;
      if (n !== actor.group) {
        list.splice(i, 1);
        continue;
      }
      o.visible = visible;
    }
  }

  /** Drive the tiers for this frame. `fogCull` is the whole-car drop distance
   *  (the fog horizon ×margin the props already cull at). The player is only
   *  shadow-pruned (classify runs), never part-hidden — it owns the screen. */
  update(actors: readonly Actor[], player: Actor | null, camPos: THREE.Vector3, fogCull: number): void {
    for (const actor of actors) {
      if (actor.kind !== 'vehicle') continue;
      let st = this.states.get(actor);
      if (!st) {
        // defer until the car has its meshes (models stream in async)
        if (actor.group.children.length === 0) continue;
        st = this.classify(actor);
        this.states.set(actor, st);
      }
      if (actor === player) continue; // full detail, always

      const dx = actor.group.position.x - camPos.x;
      const dz = actor.group.position.z - camPos.z;
      const d = Math.sqrt(dx * dx + dz * dz);

      const groupHide = d > fogCull + 8 ? true : d < fogCull - 8 ? false : st.groupHidden;
      if (groupHide !== st.groupHidden) {
        st.groupHidden = groupHide;
        actor.group.visible = !groupHide;
      }
      if (groupHide) continue; // parts don't matter while the car is dropped

      // the innards only ever show through deformation wounds — a pristine
      // car occludes them completely, so they draw only once the car has
      // taken visible damage AND is close enough for a wound to read.
      const damaged = actor.damageLvl > 0 || actor.crashed || actor.popped > 0;
      const showInterior = damaged && (st.interiorShown ? d < NEAR_HIDE : d < NEAR_SHOW);
      if (showInterior !== st.interiorShown) {
        st.interiorShown = showInterior;
        this.setVisible(actor, st.interior, showInterior);
      }
      // wheel density: the full parametric wheel only within the near ring
      const wheelsFull = st.wheelsFull ? d < NEAR_HIDE : d < NEAR_SHOW;
      if (wheelsFull !== st.wheelsFull) {
        st.wheelsFull = wheelsFull;
        for (const w of st.wheels) w.mesh.geometry = wheelsFull ? w.full : w.coarse;
      }
      const farHide = d > FAR_HIDE ? true : d < FAR_SHOW ? false : st.farHidden;
      if (farHide !== st.farHidden) {
        st.farHidden = farHide;
        this.setVisible(actor, st.small, !farHide);
      }
    }
  }
}
