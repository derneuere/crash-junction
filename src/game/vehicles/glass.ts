import * as THREE from 'three';
import type { Actor } from '../types';
import { glassParams } from '../geometry';
import { applyHullGroups } from '../models';
import { VIRGIN_GLASS } from './factory';

// ---------- glass shatter (three stages) ----------
// BP-style progressive glass, now speed-aware so a gentle knock and a full
// T-bone read differently:
//   stage 0→1  CRACK   a spider-web of bright radial arms + a frosted halo
//                      blooms from the impact; the pane STAYS in the hull
//   stage 1→2  FROST   a second hit (or a hard first hit) whites the whole
//                      struck region — the spalled, about-to-go look
//   stage 2→3  BLOW    the frosted triangles leave the hull index (a hole
//                      onto the interior), and the shard burst flies
// `power` (impact speed proxy) lets one hard hit jump straight past CRACK to
// FROST/BLOW, while a soft tap only spider-webs. Visual only (the verts that
// leave the index are presentation; the chassis collider never changes), and
// the crack-arm angles use Math.random like the rest of the FX — the sim and
// replay hashes never read glass colour or the hull index.
//
// Spider-web painting (ROUND 2): the crack web is now the RAY + CONCENTRIC-RING
// model from CJT-Jackton/SmashTheGlass (_ref/SmashTheGlass; learn-only, no
// licence on the repo — TECHNIQUE adapted, no code ported). That project places
// Voronoi crack sites on a polar grid centred on the impact: a set of radial
// RAYS at evenly-spaced angles with a little Gaussian jitter, crossed by a few
// concentric RINGS whose spacing widens outward (RandomPoint.cs:
// base_radius[i] = base_radius[i-1] + 1 + i*centrifugation → densest near the
// hit). We can't re-mesh a window into Voronoi shards on the per-vertex-colour
// rail, but we CAN paint exactly that pattern: a struck vertex lights up bright
// where it sits near a radial ray OR near a shock ring, brightest at the centre.
// The result reads as real fracture propagation — sharp radial lines plus the
// concentric "shatter rings" a stone leaves — instead of round-1's five flat
// arms. SPEED-AWARE: a gentle tap gets a few short rays and one tight ring (a
// local star-crack); a hard hit gets many rays + several rings reaching the
// pane edge (a full craze before blowout). Still visual-only and Math.random
// like the rest of the FX — the sim/replay hashes never read glass colour or
// the hull index.

const _v = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _glassN = new THREE.Vector3();
const _glassT = new THREE.Vector3();
const _glassB = new THREE.Vector3();
const _glassRel = new THREE.Vector3();

/** A per-impact crack web: ray angles + ring radii, sized by hit power. Built
 *  once per shatterGlass call (per pane) so the whole web is coherent. */
interface CrackWeb {
  rays: number[]; // ray angles (radians)
  rayJitter: number[]; // small per-ray angular wobble so lines aren't laser-straight
  rings: number[]; // ring radii as a fraction of `radius` (0..1)
  centerGlow: number; // pulverised bloom radius fraction at the impact
}

/** Build the ray/ring web for one hit. `power` (impact speed proxy) drives how
 *  far the fracture propagates: soft → few rays, one near ring; hard → many
 *  rays, rings out to the edge. Mirrors SmashTheGlass RandomPoint's ring/ray
 *  counts and outward-widening ring spacing. */
function buildCrackWeb(power: number): CrackWeb {
  // SmashTheGlass uses ~9–11 rays; we scale with power for the speed-aware feel
  const rayCount = Math.max(4, Math.min(12, Math.round(4 + power * 1.1)));
  const ringCount = Math.max(1, Math.min(4, Math.round(1 + power * 0.45)));
  const phase = Math.random() * Math.PI * 2;
  const step = (Math.PI * 2) / rayCount;
  const rays: number[] = [];
  const rayJitter: number[] = [];
  for (let i = 0; i < rayCount; i++) {
    // even spacing + Gaussian-ish jitter (RandomPoint base_theta), so the star
    // isn't perfectly regular
    rays.push(phase + i * step + (Math.random() - 0.5) * step * 0.35);
    rayJitter.push((Math.random() - 0.5) * 0.18);
  }
  // rings widen outward (centrifugation), normalised into 0..1 of the radius
  const raw: number[] = [];
  let r = 0.35;
  for (let i = 0; i < ringCount; i++) {
    r += 0.25 + i * 0.3;
    raw.push(r);
  }
  const max = raw[raw.length - 1];
  const rings = raw.map((v) => Math.min(0.96, v / max * 0.96));
  // harder hits pulverise a wider patch at the very centre
  const centerGlow = Math.min(0.5, 0.12 + power * 0.03);
  return { rays, rayJitter, rings, centerGlow };
}

/** Spider-web crack tone for a glass vertex: max of its nearness to a radial
 *  ray, to a concentric shock ring, and a bright centre bloom — all faded by
 *  distance. Returns a 0..1 brightness boost; ~0 between the cracks (the pane
 *  stays clear there), ~1 right on a fracture line. */
function crackBoost(angle: number, dist: number, radius: number, web: CrackWeb): number {
  const f = dist / radius; // 0 at impact … 1 at the crack radius
  // nearest radial ray — the wobble makes the line waver as it runs outward
  let nearestRay = Math.PI;
  for (let a = 0; a < web.rays.length; a++) {
    const armAng = web.rays[a] + web.rayJitter[a] * f * 4;
    let d = Math.abs(angle - armAng);
    if (d > Math.PI) d = Math.PI * 2 - d;
    nearestRay = Math.min(nearestRay, d);
  }
  // ray lines thin out toward the tip (a real crack tapers)
  const rayWidth = 0.5 - f * 0.32;
  const ray = Math.max(0, 1 - nearestRay / Math.max(0.05, rayWidth));
  // nearest concentric ring (a thin bright band at each ring radius)
  let ring = 0;
  for (const rr of web.rings) {
    const band = Math.max(0, 1 - Math.abs(f - rr) / 0.09);
    ring = Math.max(ring, band);
  }
  // pulverised centre
  const center = Math.max(0, 1 - f / Math.max(0.05, web.centerGlow));
  const arms = ray * ray * 1.2 + ring * ring * 0.85 + center * center * 0.9;
  // overall fade so the web dims toward the crack radius
  return Math.min(1, arms * (1 - f * 0.4));
}

export function shatterGlass(actor: Actor, worldPoint: THREE.Vector3, radius: number, power = 1): number {
  let broken = 0;
  for (const part of actor.deformables) {
    if (!part.glass) continue;
    _lp.copy(worldPoint);
    part.mesh.worldToLocal(_lp);
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    part.glassStage ??= new Uint8Array(pos.count);
    const stage = part.glassStage;
    let touched = false;
    let blow: Set<number> | null = null;

    // a pane plane to project the crack web onto: use the local up/right of
    // the mesh (windows are roughly vertical/curved — close enough for the
    // angular web), with the impact's local normal-ish removed
    const web = buildCrackWeb(power);
    _glassN.set(_lp.x, 0, _lp.z); // outward-ish from hull centreline
    if (_glassN.lengthSq() < 1e-4) _glassN.set(0, 0, 1);
    _glassN.normalize();
    _glassT.set(0, 1, 0); // pane "up"
    _glassB.crossVectors(_glassN, _glassT).normalize(); // pane "right"

    // a hard hit pushes the starting stage up: soft tap cracks, big T-bone
    // frosts or blows on first contact
    const hardKick = power > 6 ? 2 : power > 3 ? 1 : 0;

    for (const [s, e] of part.glass) {
      for (let i = s; i < e; i++) {
        _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const dist = _v.distanceTo(_lp);
        if (dist > radius) continue;
        const cur = stage[i];
        const next = cur === 3 ? 3 : Math.min(3, Math.max(cur + 1, hardKick + 1));
        if (cur === next) continue; // already at/past this damage
        stage[i] = next;
        broken++;
        touched = true;

        if (next === 1) {
          // CRACK: ray+ring spider-web recolour. Virgin glass is near-white
          // (clear), so a fracture line reads as a cool MILKY-WHITE craze that
          // pops against the see-through pane; verts off the web stay clear.
          _glassRel.set(_v.x - _lp.x, _v.y - _lp.y, _v.z - _lp.z);
          const angle = Math.atan2(_glassRel.dot(_glassT), _glassRel.dot(_glassB));
          const b = crackBoost(angle, dist, radius, web);
          // a hint of grain so the craze isn't a clean gradient (LiquidGlass
          // noise idea, carried onto the crack paint)
          const grain = (Math.random() - 0.5) * 0.06 * b;
          // off-web keeps the clear virgin tone; on-web goes bright milky-white
          const tone = VIRGIN_GLASS - 0.08 + (1.02 - (VIRGIN_GLASS - 0.08)) * b + grain;
          const c = Math.min(1, Math.max(0, tone));
          col.setXYZ(i, c, Math.min(1, c + 0.02 * b), Math.min(1, c + 0.04 * b));
        } else if (next === 2) {
          // FROST: spalled, about to let go — the tweakable FROST amount sets
          // how white it goes (privacy glass can stay a touch darker)
          const t = glassParams.frost + Math.random() * 0.12;
          col.setXYZ(i, t, t + 0.03, t + 0.06);
        } else if (next === 3) {
          (blow ??= new Set()).add(i); // BLOW: the pane lets go
        }
      }
    }
    if (touched) col.needsUpdate = true;
    if (blow && geo.index) {
      // stash the pristine index once — repairVehicle reglazes from it
      part.baseIndex ??= (geo.index.array as Uint16Array | Uint32Array).slice();
      const idx = geo.index;
      const keep: number[] = [];
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t);
        const b = idx.getX(t + 1);
        const c = idx.getX(t + 2);
        if (blow.has(a) || blow.has(b) || blow.has(c)) continue;
        keep.push(a, b, c);
      }
      geo.setIndex(keep);
      applyHullGroups(geo, part.glass, part.head ?? [], part.tail ?? [], part.reverse ?? []); // groups address the index
    }
  }
  return broken;
}
