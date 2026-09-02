import * as THREE from 'three';
import { CRUSH_MAX, CRUSH_VISUAL } from '../constants';
import type { Actor, DeformablePart } from '../types';
import { applyNormalSmoothing, buildNormalSmoothing } from '../geometry';
import { applyHullGroups } from '../models';
import { buildSuspension, buildWheels } from './factory';

// ---------- crumple deformation ----------
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _ldir = new THREE.Vector3();
const _wq = new THREE.Quaternion();

/** Map every vertex slot to the first slot sharing its base position (1 mm
 *  grid). The baked models are flat-shaded, so each corner exists as 2–7
 *  copies with split normals — the player hull has 2984 slots on 740
 *  positions. The crumple's per-vertex randomness must move those copies as
 *  one, or every shared edge tears and a hard wreck shreds into confetti.
 *  Glass and body never weld together: glass sits out the crumple, and a
 *  body corner with a glass representative would be frozen with it. */
function buildWeld(base: Float32Array, glassMask?: Uint8Array): Uint32Array {
  const n = base.length / 3;
  const weld = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const g = glassMask ? glassMask[i] : 0;
    const key = `${g}|${Math.round(base[i * 3] * 1000)}|${Math.round(base[i * 3 + 1] * 1000)}|${Math.round(base[i * 3 + 2] * 1000)}`;
    const rep = seen.get(key);
    if (rep === undefined) {
      seen.set(key, i);
      weld[i] = i;
    } else {
      weld[i] = rep;
    }
  }
  return weld;
}

function buildGlassMask(part: DeformablePart): Uint8Array | undefined {
  if (!part.glass?.length) return undefined;
  const mask = new Uint8Array(part.base.length / 3);
  for (const [s, e] of part.glass) mask.fill(1, s, e);
  return mask;
}

/** Crumple the hull around a world-space impact point. `impactDir` is the
 *  world direction the hitting matter travels (relative velocity) — vertices
 *  near the hit fold mostly along it, BP-style, so a front-left wall hit
 *  reads as a caved front-left corner instead of a uniform shrink. Without
 *  it (explosion-adjacent calls pass none) the fold falls back to pushing
 *  toward the hull core. */
export function deformActor(actor: Actor, worldPoint: THREE.Vector3, strength: number, impactDir?: THREE.Vector3 | null): void {
  if (!actor.deformables.length) return;
  actor.group.updateMatrixWorld(true);
  const R = 0.9 + strength * 0.16;

  for (const part of actor.deformables) {
    _lp.copy(worldPoint);
    part.mesh.worldToLocal(_lp);
    let hasDir = false;
    if (impactDir && impactDir.lengthSq() > 0.5) {
      // direction into mesh space (meshes carry no scale — quaternion is enough)
      part.mesh.getWorldQuaternion(_wq).invert();
      _ldir.copy(impactDir).applyQuaternion(_wq).normalize();
      hasDir = true;
    }
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const base = part.base;
    if (!part.weld) {
      part.glassMask = buildGlassMask(part);
      part.weld = buildWeld(base, part.glassMask);
      // first deform — normals are still pristine, the only safe moment
      // to derive the smoothing clusters
      part.smooth = buildNormalSmoothing(pos, geo.attributes.normal as THREE.BufferAttribute);
    }
    const weld = part.weld;
    const glassMask = part.glassMask;
    let touched = false;

    for (let i = 0; i < pos.count; i++) {
      if (glassMask && glassMask[i]) continue; // glass doesn't bend — it shatters
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const d = _v.distanceTo(_lp);
      if (d > R) continue;
      touched = true;
      let f = 1 - d / R;
      f *= f;

      const rep = weld[i];
      if (rep !== i) {
        // a flat-shading copy of an earlier corner (rep < i, so it has been
        // displaced this pass): take its position verbatim to keep shared
        // edges stitched. Paint scuffs per slot — copies can belong to
        // differently-colored prims.
        pos.setXYZ(i, pos.getX(rep), pos.getY(rep), pos.getZ(rep));
      } else {
        _dir.set(_v.x, _v.y * 0.35, _v.z);
        if (_dir.lengthSq() < 0.001) _dir.set(0, -1, 0);
        _dir.normalize().negate(); // push toward hull core
        if (hasDir) _dir.multiplyScalar(0.4).addScaledVector(_ldir, 0.85).normalize();
        const amt = strength * CRUSH_VISUAL * f * (0.75 + Math.random() * 0.5);
        _v.addScaledVector(_dir, amt);
        _v.x += (Math.random() - 0.5) * 0.03 * f; // crumple jitter
        _v.y += (Math.random() - 0.5) * 0.03 * f;
        _v.z += (Math.random() - 0.5) * 0.03 * f;

        const bx = base[i * 3];
        const by = base[i * 3 + 1];
        const bz = base[i * 3 + 2];
        const dx = _v.x - bx;
        const dy = _v.y - by;
        const dz = _v.z - bz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl > CRUSH_MAX) {
          const s = CRUSH_MAX / dl;
          _v.set(bx + dx * s, by + dy * s, bz + dz * s);
        }
        pos.setXYZ(i, _v.x, _v.y, _v.z);
      }

      const k = Math.max(0.35, 1 - 0.45 * f); // scuffed paint
      col.setXYZ(i, col.getX(i) * k + 0.05 * f, col.getY(i) * k + 0.045 * f, col.getZ(i) * k + 0.04 * f);
    }
    if (touched) {
      pos.needsUpdate = true;
      col.needsUpdate = true;
      geo.computeVertexNormals();
      if (part.smooth) applyNormalSmoothing(geo.attributes.normal as THREE.BufferAttribute, part.smooth);
    }
  }
}

/** Full body-shop pass: un-crumple every panel, restore the paint, re-hang
 *  detached panels at their hinges and refit any popped wheels. Loose-part
 *  physics bodies for torn panels must be reclaimed by the caller (they
 *  share the panel meshes). */
export function repairVehicle(actor: Actor): void {
  for (const part of actor.deformables) {
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    (pos.array as Float32Array).set(part.base);
    pos.needsUpdate = true;
    const col = geo.attributes.color as THREE.BufferAttribute;
    (col.array as Float32Array).set(part.baseCol);
    col.needsUpdate = true;
    if (part.baseIndex) {
      geo.setIndex(new THREE.BufferAttribute(part.baseIndex.slice(), 1)); // reglaze
      if (part.glass) applyHullGroups(geo, part.glass, part.head ?? [], part.tail ?? [], part.reverse ?? []);
    }
    part.glassStage?.fill(0); // panes are virgin again after a body-shop pass
    // never-deformed parts still carry pristine normals — derive the
    // smoothing clusters now or the recompute below would flatten them
    part.smooth ??= buildNormalSmoothing(pos, geo.attributes.normal as THREE.BufferAttribute);
    geo.computeVertexNormals();
    applyNormalSmoothing(geo.attributes.normal as THREE.BufferAttribute, part.smooth);
  }
  for (const p of actor.panels) {
    if (p.detached) {
      p.pivot.add(p.mesh); // re-parent from the scene back onto the hinge
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.copy(p.homeQ);
    }
    p.detached = false;
    p.damage = 0;
    p.angle = 0;
    p.pivot.quaternion.set(0, 0, 0, 1);
  }
  if (actor.spec && actor.wheels.length < 4) {
    for (const w of actor.wheels) actor.group.remove(w); // geometry is cached/shared — don't dispose
    actor.wheels = buildWheels(actor.spec, actor.group, actor.model);
    actor.susp = buildSuspension(actor.spec, actor.wheels, actor.body.mass);
  }
  for (const s of actor.susp) s.sag = 1; // un-bend the axles too
  actor.popped = 0;
  actor.damageLvl = 0;
  actor.smokeT = 0;
}

/** Darken the paint after a vehicle burns/detonates. */
export function charActor(actor: Actor): void {
  for (const part of actor.deformables) {
    const col = part.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < col.count; i++) {
      col.setXYZ(i, col.getX(i) * 0.42, col.getY(i) * 0.4, col.getZ(i) * 0.38);
    }
    col.needsUpdate = true;
  }
}
