import * as THREE from 'three';
import type { Group, Scene } from 'three';

// BURNOUT-3 NITROUS BOOST FLAME — a blue/cyan jet of flame out the car's
// exhaust(s) whenever boost is active, so "am I boosting?" reads on the CAR
// itself (the boost bar tells you too). Each exhaust grows a short tapered
// CONE of additive sprites pointing backward: a tiny hot WHITE-BLUE core at
// the pipe, cooling out through CYAN to a fading deep blue at the tip, with a
// quick per-frame flicker and a soft point-light glow. The bright blue core
// pokes above the composer's bloom threshold so it blooms at day AND night.
//
// PRESENTATION ONLY. Driven by the boost flag + render time; the flicker rolls
// Math.random like every other effect in this folder. It reads the player
// group transform (already written by syncMeshes), writes nothing the sim,
// the worldHash, the camera, or the recorded key path can see — the
// determinism pins are untouched.

/** A single backward-pointing flame node in one jet's cone. */
interface Node {
  sprite: THREE.Sprite;
  /** where it sits along the jet axis, 0 (at the pipe) … 1 (tip) */
  t: number;
  /** lateral jitter offsets in the jet's local right/up, re-rolled per frame */
  jx: number;
  jy: number;
  base: number; // base sprite size for this node
}

interface Jet {
  /** exhaust anchor in the car group's LOCAL space (forward is -z; +z is rear) */
  anchor: THREE.Vector3;
  nodes: Node[];
  light: THREE.PointLight;
}

// colour ramp along the jet: hot white-blue core → electric cyan → deep blue
// tip. Kept >1 on the core channels so the additive stack clears the bloom
// luminanceThreshold (1.4) and the core blooms.
const C_CORE = new THREE.Color(1.7, 2.0, 2.4); // white-blue, over 1 → blooms
const C_MID = new THREE.Color(0.25, 1.05, 1.7); // electric cyan
const C_TIP = new THREE.Color(0.06, 0.22, 0.85); // fading deep blue

const NODES_PER_JET = 9;
const _tmp = new THREE.Color();
const _ax = new THREE.Vector3(); // jet axis (backward) in world space
const _up = new THREE.Vector3(); // jet up in world space
const _rt = new THREE.Vector3(); // jet right in world space
const _wp = new THREE.Vector3(); // scratch world position
const _q = new THREE.Quaternion();

/** Soft round additive blob — a flame puff, brightest dead centre. The blue
 *  tint comes entirely from the per-node sprite colour; the texture is white
 *  so it can be tinted hot-white at the core and deep-blue at the tip. */
function makeFlameSprite(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** The player's twin nitrous jets. One instance, pooled, anchored to the car
 *  group each frame. Rivals/traffic never boost, so only the player owns it. */
export class Nitrous {
  private jets: Jet[] = [];
  private intensity = 0; // smoothed 0 (off) … 1 (full boost) for fade in/out
  private clock = 0; // render-time accumulator for the flicker phase

  constructor(scene: Scene) {
    const tex = makeFlameSprite();
    // two exhausts. The actual anchors are set per car in attach(); seed them
    // so a render before the first attach() is harmless.
    for (let j = 0; j < 2; j++) {
      const nodes: Node[] = [];
      for (let i = 0; i < NODES_PER_JET; i++) {
        const sprite = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        sprite.visible = false;
        scene.add(sprite);
        nodes.push({ sprite, t: i / (NODES_PER_JET - 1), jx: 0, jy: 0, base: 0 });
      }
      // a real coloured glow at the pipe — keeps the flame lighting the road
      // and the bodywork behind the car at night. Intensity is driven; the
      // light never leaves the render list while attached (count keys shaders).
      const light = new THREE.PointLight(0x2bd0ff, 0, 9, 2);
      light.visible = false;
      scene.add(light);
      this.jets.push({ anchor: new THREE.Vector3(), nodes, light });
    }
  }

  /** Point the two jets at this car's exhaust anchors (local-space, forward
   *  is -z). Called once when the player car is (re)built. */
  attach(anchors: [THREE.Vector3, THREE.Vector3]): void {
    this.jets[0].anchor.copy(anchors[0]);
    this.jets[1].anchor.copy(anchors[1]);
    for (const jet of this.jets) jet.light.visible = true;
  }

  /** Per frame, AFTER syncMeshes has placed the car group.
   *  @param active   true while boost is burning (the boost flag)
   *  @param burnout  full-bar sustained Burnout → a longer, fiercer jet
   *  @param speed    player speed (m/s) — the jet stretches a touch with it
   *  @param group    the player car group (world transform source) or null
   *  @param dt       render dt (presentation clock; never the sim dt) */
  update(active: boolean, burnout: boolean, speed: number, group: Group | null, dt: number): void {
    // fast attack, quick-but-soft release so the jet snaps on and tails off
    const goal = active && group ? 1 : 0;
    const rate = goal > this.intensity ? 22 : 12; // on faster than off
    this.intensity += (goal - this.intensity) * Math.min(1, rate * dt);
    this.clock += dt;

    if (this.intensity < 0.01 || !group) {
      if (this.intensity < 0.01) this.intensity = 0;
      for (const jet of this.jets) {
        for (const n of jet.nodes) {
          if (n.sprite.visible) {
            n.sprite.visible = false;
            n.sprite.material.opacity = 0;
          }
        }
        jet.light.intensity = 0;
      }
      return;
    }

    group.updateMatrixWorld();
    group.getWorldQuaternion(_q);
    // jet basis in world space from the car's orientation: axis = backward
    // (+z local), up = +y local, right = +x local
    _ax.set(0, 0, 1).applyQuaternion(_q); // points out the back
    _up.set(0, 1, 0).applyQuaternion(_q);
    _rt.set(1, 0, 0).applyQuaternion(_q);

    // jet length: base + a touch from speed, longer/fiercer in Burnout, all
    // scaled by the fade so it grows out of the pipe on tip-in
    const speedK = Math.min(1, speed / 44);
    const len = (1.45 + speedK * 0.9 + (burnout ? 0.7 : 0)) * this.intensity;
    // a fast global flicker (two beats) + a slow pulse so it breathes, not
    // strobes. Visual-only Math.random hits per node below.
    const flick =
      0.78 +
      0.22 * Math.sin(this.clock * 47) * Math.sin(this.clock * 23) +
      (Math.random() - 0.5) * 0.12;
    const coreBoost = burnout ? 1.25 : 1; // Burnout cores blaze a little harder

    for (const jet of this.jets) {
      // anchor → world position of the pipe mouth
      _wp.copy(jet.anchor).applyQuaternion(_q).add(group.position);
      for (const n of jet.nodes) {
        const t = n.t; // 0 at the pipe, 1 at the tip
        // re-roll a little lateral wander each frame so the flame licks about
        n.jx = (Math.random() - 0.5) * (0.05 + t * 0.16);
        n.jy = (Math.random() - 0.5) * (0.05 + t * 0.16);
        // sit along the backward axis; the cone widens a hair toward the tip
        const along = t * len;
        n.sprite.position
          .copy(_wp)
          .addScaledVector(_ax, along)
          .addScaledVector(_rt, n.jx)
          .addScaledVector(_up, n.jy - 0.02 * t); // droop a touch with heat
        // size: fat near the pipe, tapering to the tip, jittered by the flicker
        const taper = 0.42 + (1 - t) * 0.66;
        const s = taper * (0.9 + flick * 0.3) * (0.55 + 0.45 * this.intensity) * (burnout ? 1.12 : 1);
        n.sprite.scale.set(s, s, 1);
        // colour ramp: core → mid → tip, brighter at the very root
        if (t < 0.45) _tmp.copy(C_CORE).lerp(C_MID, t / 0.45);
        else _tmp.copy(C_MID).lerp(C_TIP, (t - 0.45) / 0.55);
        if (t < 0.25) _tmp.multiplyScalar(coreBoost); // the white-blue core blooms
        n.sprite.material.color.copy(_tmp);
        // opacity: solid at the root, fading down the cone, all under the fade
        const op = (1 - t * 0.72) * flick * this.intensity;
        n.sprite.material.opacity = Math.min(1, op);
        n.sprite.visible = op > 0.02;
      }
      // glow light sits just behind the pipe, breathing with the flicker
      jet.light.position
        .copy(_wp)
        .addScaledVector(_ax, len * 0.4);
      jet.light.intensity = (burnout ? 34 : 22) * this.intensity * (0.7 + 0.3 * flick);
    }
  }

  /** Hard off — wreck, reset, level swap. */
  reset(): void {
    this.intensity = 0;
    this.clock = 0;
    for (const jet of this.jets) {
      for (const n of jet.nodes) {
        n.sprite.visible = false;
        n.sprite.material.opacity = 0;
      }
      jet.light.intensity = 0;
    }
  }
}
