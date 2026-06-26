import * as THREE from 'three';
import { makeFoamTexture } from '../textures';
import { SEA_MAX_AMPLITUDE } from '../sea';
import type { CoastCtx } from './coast-skirts';

// FOAM: layered shore-line foam riding the waterline toe of every skirt, a
// hair above the sea so the transparent-vs-opaque planes never z-fight.
// Two stacked rings sell the wash instead of one static stripe:
//   • a FIXED leading edge hugging the shore toe (the bright lacy line
//     where the last sheet of water meets the sand) — never moves much, so
//     the waterline always reads as a solid contour;
//   • a wider SWASH ring drifting in and out (the spent wave sliding up the
//     sand and retreating), built from a second foam-texture variant.
// Both animate off the RENDER clock (performance.now in onBeforeRender) —
// NEVER sim time — so the wash breathes without ever touching determinism:
// onBeforeRender runs only when a frame is drawn, the replay/sim path never
// invokes it, and it writes only to visual texture/material state.
//
// SEAM CONTRACT: the foam sits at sea + a small lift, and the swash slides
// over a band sized to an ASSUMED wave amplitude (~0.15–0.3 m). The water
// sibling owns the real sea surface + wave height; from this worktree we
// can't see their final numbers, so we anchor to the CURRENT seaLevel
// (sea) + FOAM_AMP. MERGE: align FOAM_AMP / the foam lift to the water
// agent's actual wave amplitude so the foam tracks the wet crest, not a
// guessed height. (Contour-foam + scrolling-swash technique: Cyanilux
// shoreline breakdown, Alisavakis stylized-water foam.)
// MERGE: align to sea.ts amplitude — the OCEAN sibling now EXPORTS the real
// peak crest height (SEA_MAX_AMPLITUDE ≈ 0.288 m at seaLevel -2.2 after the
// art-ocean rewrite), so we read it directly instead of the round-1 0.22
// guess (or sand's own round-1 0.207); the foam swash throw
// tracks the actual wave amplitude. yAt() below still clamps the foam y to
// max(sea, slope) so the band drapes on the wet sand inland and floats on
// the sea surface seaward, never sinking under the opaque sea plane.
const FOAM_AMP = SEA_MAX_AMPLITUDE; // real sea-surface wave amplitude (sea.ts)

// one foam ring: inner/outer are metres of the skirt's outward normal
// relative to the WATERLINE — the point where the sand slope crosses the
// sea surface, NOT the skirt toe (the toe is ~18 m out and metres below
// the sea, so foam pinned there hid under the slope). Anchoring at the
// crossing puts the foam exactly on the wet sand at the water's edge.
// `tex` and `speed` drive the animation.
export function makeFoamRing(
  ctx: CoastCtx,
  inner: number,
  outer: number,
  tex: THREE.CanvasTexture,
  speed: number,
  baseOpacity: number,
): void {
  const { scene, o, n, sea, BOT, botF, vOut, vW } = ctx;
  const cols = n + 1;
  const pos = new Float32Array(cols * 6);
  const uv = new Float32Array(cols * 4);
  let u = 0;
  for (let c = 0; c < cols; c++) {
    const vi = c % n;
    if (c > 0) {
      const pv = (c - 1) % n;
      u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 3;
    }
    // waterline crossing: fraction along rim→toe where the slope hits sea
    const rimY = o[vi].y ?? 0;
    const runW = Math.max(0.01, vW[vi] * botF); // horizontal rim→toe run
    // [fix-water] CLAMP the inland slope. On a real beach (vW≈18 m) the
    // rim→toe run is wide, so (rimY−BOT)/runW is a gentle few-percent grade.
    // But on a ZERO-WIDTH edge — a quay 'wall' (SKIRT_W.wall = 0) with an
    // authored rim up to ~2.7 m — runW collapses to the 0.01 floor and the
    // slope blows up to several-hundred-per-metre. The inland foam offset
    // (inner, NEGATIVE) is then projected up that near-vertical pseudo-slope
    // in yAt(), launching that foam vertex HUNDREDS of metres into the sky.
    // Because the foam is an unlit full-bright MeshBasicMaterial, that
    // runaway sheet read as a tall bright white vertical band rising from
    // the shore (very visible at dusk/night, and it tripped the bloom pass).
    // Foam belongs on the wet-sand wedge at the water's edge — at most a few
    // decimetres of lift — so cap the grade at SLOPE_MAX. A vertical quay has
    // no wet-sand wedge anyway, so flattening the foam onto the sea there is
    // exactly right (it just hugs the waterline at the wall's foot).
    const SLOPE_MAX = 0.35; // ~19° — gentler than any authored beach grade
    const slope = Math.min(SLOPE_MAX, (rimY - BOT) / runW); // rise per m inland
    const tSea = Math.min(1, Math.max(0, (rimY - sea) / Math.max(0.01, rimY - BOT)));
    const wlx = o[vi].x + vOut[vi].x * vW[vi] * botF * tSea;
    const wlz = o[vi].z + vOut[vi].z * vW[vi] * botF * tSea;
    // foam rides the WET SAND inland of the waterline (where the slope is
    // above sea, follow the slope so the band drapes on the sand) and the
    // SEA SURFACE seaward of it (clamp to sea so it floats, never sinks
    // under the opaque sea plane). +0.05 keeps it off both to avoid
    // z-fight. inner is inland (negative offset → +height via -off*slope).
    const yAt = (off: number) => Math.max(sea, sea - off * slope) + 0.05;
    const k = c * 6;
    pos[k] = wlx + vOut[vi].x * inner;
    pos[k + 1] = yAt(inner);
    pos[k + 2] = wlz + vOut[vi].z * inner;
    pos[k + 3] = wlx + vOut[vi].x * outer;
    pos[k + 4] = yAt(outer);
    pos[k + 5] = wlz + vOut[vi].z * outer;
    uv[c * 4] = u;
    uv[c * 4 + 1] = 0;
    uv[c * 4 + 2] = u;
    uv[c * 4 + 3] = 1;
  }
  const idx: number[] = [];
  for (let c = 0; c < cols - 1; c++) {
    const a = c * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    opacity: baseOpacity,
    side: THREE.DoubleSide,
  });
  const foam = new THREE.Mesh(geo, mat);
  foam.renderOrder = 2; // after the sea (0/1) and the wet sheen (1)
  // RENDER-TIME animation (determinism-safe — see block header): scroll
  // the foam crests along the shore + a slow seaward drift, and pulse the
  // swash opacity like a wave running up and sliding back. performance.now
  // is the wall clock, independent of the sim/replay dt stream.
  if (speed !== 0) {
    const ampV = FOAM_AMP; // ties the swash throw to the assumed wave amp
    foam.onBeforeRender = () => {
      const tm = performance.now() / 1000;
      tex.offset.x = (tm * 0.03 * speed) % 1; // drift along the coast
      tex.offset.y = -Math.sin(tm * 0.6 * speed) * 0.12 * ampV * 6; // swash in/out
      // breathe the swash brightness so the spent wave fades as it slides
      mat.opacity = baseOpacity * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tm * 0.6 * speed - 0.5)));
    };
  }
  scene.add(foam);
}

/** Build both foam rings for a coast. Kept beside makeFoamRing so the two
 *  ring presets (leading edge + outer swash) stay co-located with the ring
 *  builder they parameterise. */
export function addFoamRings(ctx: CoastCtx): void {
  // leading edge: a fat lacy band straddling the waterline — runs from ~2 m
  // up the wet sand (inner, inland/negative) out ~2 m over the sea (outer),
  // so the bright crest sits ON the water's edge at readable width from a
  // low camera. Bright, barely drifting — the waterline always reads.
  makeFoamRing(ctx, -2.2, 2.0, makeFoamTexture(0), 1, 1.0);
  // outer swash: wider still, a second variant, drifting + pulsing seaward —
  // the spent sheet of a broken wave sliding up the sand and retreating
  makeFoamRing(ctx, -3.4, 4.2, makeFoamTexture(1), 1.35, 0.78);
}
