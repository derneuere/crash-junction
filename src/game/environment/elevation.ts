import type { LevelDef } from '../types';
import { buildOpenSections, SHORTCUT_SPACING } from '../race';
import type { HeightSampler } from '../suspension';

// ---- the road-base elevation field (elevation.md Phase 1) ----
// Full elevation holds across the corridor plus a shoulder (the walls and
// posts at halfW+1.65 must stand on the plateau, not its slope), then an
// embankment fade back to grade. The doc's bounds: fade ≥ 15 m at ≤ ~25%
// slope — 6 m over 26 m ≈ 23%, gentler than ANY feature skirt today (the
// ramp side-skirt is 220%/m). Every number here is a SIM tunable: the
// sampler feeds physics, so retuning either repeats the determinism bill.
//
// C1-CONTINUITY (the bumpy-drift fix): the field must be C1 — slope
// continuous, no kinks — along BOTH axes, or a drift up/over/down the
// north arc reads as a washboard. Two sources of slope steps were removed:
//
//   * LONGITUDINAL. The old field took max() over per-segment nearest-point
//     LINEAR lerps, each clamped at its endpoints. Near every section vertex
//     both neighbouring segments clamp to the shared endpoint and FREEZE
//     their slope to 0, so the max held the road flat across the seam, then
//     stepped — a staircase of ~0.1–0.23 slope jumps every 8 m (measured).
//     Fixed by projecting each query onto the WHOLE chain polyline once (its
//     arc position s) and reading height from a Catmull-Rom spline in y over
//     arc length: H(s) is C1 by construction, and the single projection has
//     no per-segment clamp seam.
//   * LATERAL. The old shoulder→grade fade was LINEAR — a C0 ramp with a
//     ~0.24 slope kink at BOTH ends (felt as a bump when a wide drift crosses
//     the shoulder edge). Fixed with a smoothstep falloff (zero slope at both
//     the plateau lip and the grade toe — C1).
//
// On flat tracks the chain list is empty and base() is the literal 0 it
// always was; nothing here runs.
export const ROAD_SHOULDER = 3.5; // m past the ribbon edge at full elevation
// Fade widened 26→32 m alongside the C1 falloff: the filleted-linear fade
// (below) eases its corners with a slope factor 1/(1−EDGE)≈1.22 over the
// linear core, so at 26 m the core would have read ~30% — steeper than the
// old C0 linear's 25% and a quiet loosening of the off-road launch margin.
// At 32 m the C1 core sits at ~6/32·1.22 ≈ 23%, GENTLER than the old 25%
// while gaining slope-continuity. Still well inside the doc's ≥15 m bound.
export const EMBANKMENT_FADE = 32; // m from the shoulder back down to grade

/** One elevated chain (the main loop, or a shortcut branch) reduced to a
 *  polyline with cumulative arc length and a C1 height-vs-arc spline. */
interface ElevChain {
  /** Vertices of the elevated span (x, z, y, cumulative arc length s). */
  vx: number[];
  vz: number[];
  vy: number[];
  vs: number[];
  plateau: number; // halfW + shoulder
  minX: number; // influence AABB (plateau + fade inflated)
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Catmull-Rom in y over arc length, clamped at the chain ends. The vy/vs
 *  arrays are dense (one entry per ~8 m section), so the spline rides the
 *  already-smooth section heights and is C1 across every interior knot —
 *  the longitudinal grade never steps. */
function heightAlong(c: ElevChain, s: number): number {
  const vs = c.vs;
  const n = vs.length;
  if (n === 1) return c.vy[0];
  if (s <= vs[0]) return c.vy[0];
  if (s >= vs[n - 1]) return c.vy[n - 1];
  // locate the span s ∈ [vs[i], vs[i+1]]
  let i = 0;
  while (i < n - 2 && vs[i + 1] < s) i++;
  const s0 = vs[i];
  const s1 = vs[i + 1];
  const t = (s - s0) / (s1 - s0 || 1);
  const y0 = c.vy[i];
  const y1 = c.vy[i + 1];
  // endpoint-clamped neighbours give the standard clamped Catmull tangents
  const ym = c.vy[i - 1 < 0 ? 0 : i - 1];
  const yp = c.vy[i + 2 > n - 1 ? n - 1 : i + 2];
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * y0 + (y1 - ym) * t + (2 * ym - 5 * y0 + 4 * y1 - yp) * t2 + (3 * y0 - ym - 3 * y1 + yp) * t3);
}

/** Vertical height field for the suspension rays, decomposed per the
 *  HeightSampler contract (suspension.ts): a smooth road-grade BASE from
 *  the race section chains, plus launchable FEATURES — ramp wedges and the
 *  0.16 m sidewalk plinths — stacked on top. The chassis box ignores all
 *  of it (GROUP_DECOR filtering) — the springs are the only thing that
 *  touches it, so jumps and kerb hops are pure suspension + ballistics.
 *
 *  Determinism: on a track with no elevation profile the segment list is
 *  EMPTY, base() returns literal 0 and total degenerates to the feature
 *  loops alone — bit-identical to the pre-elevation sampler on every flat
 *  level (the two replay pins prove it). The field history of this engine
 *  is one long fight against edges: the base field adds NO new edges, only
 *  C0-continuous grades with a linear lateral fade. */
export function makeHeightSampler(level: LevelDef): HeightSampler {
  const ramps = level.ramps;
  const slabs = level.buildings;
  const feature = (x: number, z: number): number => {
    let h = 0;
    for (const r of ramps) {
      // lateral skirt: the wedge fades out over a metre past its edge, so
      // clipping a ramp side rides up like a steep kerb instead of the
      // height field teleporting a wheel a metre into the air
      const lat = Math.abs(x - r.x) - r.width / 2;
      if (lat > 1) continue;
      const t = (z - r.zStart) / r.length;
      if (t < 0 || t > 1) continue;
      h = Math.max(h, r.height * t * (lat <= 0 ? 1 : 1 - lat));
    }
    for (const s of slabs) {
      // plinth edge blends over 0.35 m — the springs walk up it smoothly
      const edge = Math.max(Math.abs(x - s.x), Math.abs(z - s.z)) - 7;
      if (edge < 0.35) h = Math.max(h, 0.16 * (edge <= 0 ? 1 : 1 - edge / 0.35));
    }
    return h;
  };

  // collect the elevated chains — a contiguous run of sections where any
  // section carries height, taken as ONE polyline (not per-segment) so the
  // projection below has a single arc parameter with no clamp seams. Each
  // run is padded by one cold section on each side: the flat neighbour gives
  // the Catmull spline a y=0 anchor so the climb feathers in/out to grade
  // smoothly (and keeps the flat zones at exact 0).
  const chains: ElevChain[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    const collect = (chain: { x: number; z: number; y: number }[], halfW: number, closed: boolean): void => {
      const plateau = halfW + ROAD_SHOULDER;
      const reach = plateau + EMBANKMENT_FADE;
      const n = chain.length;
      const hot = chain.map((c) => c.y > 0.0005);
      if (!hot.some((h) => h)) return;
      // dilate hot runs by 1 cold section each side, then walk them into
      // polylines. Closed chains start the scan at a cold section so a run
      // never straddles the array seam (the elevated arc is one contiguous
      // span on every level that has one).
      const warm = chain.map((_, i) => {
        for (let k = -1; k <= 1; k++) {
          const j = closed ? (i + k + n) % n : i + k;
          if (j >= 0 && j < n && hot[j]) return true;
        }
        return false;
      });
      let start = 0;
      if (closed) {
        start = warm.findIndex((w) => !w);
        if (start < 0) start = 0; // whole loop elevated (no real level does this)
      }
      const order: number[] = [];
      for (let k = 0; k < n; k++) order.push(closed ? (start + k) % n : k);
      let run: number[] = [];
      const flush = (): void => {
        if (run.length < 1) {
          run = [];
          return;
        }
        const vx: number[] = [];
        const vz: number[] = [];
        const vy: number[] = [];
        const vs: number[] = [];
        let s = 0;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let r = 0; r < run.length; r++) {
          const c = chain[run[r]];
          if (r > 0) s += Math.hypot(c.x - vx[r - 1], c.z - vz[r - 1]);
          vx.push(c.x);
          vz.push(c.z);
          vy.push(Math.max(0, c.y));
          vs.push(s);
          minX = Math.min(minX, c.x);
          maxX = Math.max(maxX, c.x);
          minZ = Math.min(minZ, c.z);
          maxZ = Math.max(maxZ, c.z);
        }
        chains.push({ vx, vz, vy, vs, plateau, minX: minX - reach, maxX: maxX + reach, minZ: minZ - reach, maxZ: maxZ + reach });
        run = [];
      };
      for (const i of order) {
        if (warm[i]) run.push(i);
        else flush();
      }
      flush();
    };
    collect(race.sections, race.width / 2, true);
    for (const sc of race.shortcuts ?? []) {
      collect(buildOpenSections(sc.waypoints, SHORTCUT_SPACING), sc.width / 2, false);
    }
  }

  if (chains.length === 0) {
    // flat level: total IS the feature field, base is the constant 0 —
    // not just equivalent but the same float ops as before the decompose
    return Object.assign((x: number, z: number) => feature(x, z), { base: () => 0, feature });
  }

  let gMinX = Infinity;
  let gMaxX = -Infinity;
  let gMinZ = Infinity;
  let gMaxZ = -Infinity;
  for (const c of chains) {
    gMinX = Math.min(gMinX, c.minX);
    gMaxX = Math.max(gMaxX, c.maxX);
    gMinZ = Math.min(gMinZ, c.minZ);
    gMaxZ = Math.max(gMaxZ, c.maxZ);
  }
  // Lateral falloff over the embankment band: 1 across the plateau, down to 0
  // at the grade toe. A pure linear ramp is C0 — slope kinks (~0.24) at BOTH
  // the plateau lip and the grade toe, felt as a bump when a wide drift crosses
  // the shoulder. A pure smoothstep is C1 but spikes the mid-band slope to 1.5×
  // the average (0.37 here) — steeper than the old linear 0.25, which would
  // loosen the off-road launch margin. So: a FILLETED LINEAR ramp — linear in
  // the core, smoothstep fillets over the first/last EDGE fraction — C1 at both
  // ends with the core slope held near the gentle linear value (peak ~0.27,
  // under the proving-ground budget). f(0)=1, f(1)=0, f'(0)=f'(1)=0.
  const FADE = EMBANKMENT_FADE;
  const EDGE = 0.18; // fillet fraction of the band at each end
  const K = 1 / (1 - EDGE); // |core slope| (normalized) — keeps the whole 1→0 span
  // Antiderivative of smoothstep g(t)=3t²−2t³ is G(t)=t³−t⁴/2 (G(0)=0, G(1)=½):
  // the fillet integrates the slope ramping 0→K, so it drops K·EDGE·G(t).
  const falloff = (u: number): number => {
    if (u <= 0) return 1;
    if (u >= 1) return 0;
    if (u < EDGE) {
      const t = u / EDGE;
      return 1 - K * EDGE * (t * t * t - 0.5 * t * t * t * t);
    }
    if (u > 1 - EDGE) {
      const t = (1 - u) / EDGE; // mirror of the entry fillet
      return K * EDGE * (t * t * t - 0.5 * t * t * t * t);
    }
    return 1 - 0.5 * K * EDGE - K * (u - EDGE); // linear core
  };
  // Combining chains with a hard max() is C0: where two elevated chains cross
  // (the Lookout Ess fork, where the +6 LEDGE high-line runs beside the main
  // road dipping to +3.5) the max switches with a slope step — a ridge the
  // drift feels. A polynomial smooth-max (Quilez smooth-union, negated)
  // rounds that crossover into a C1 ramp within SMAX_K m of the tie, and is
  // an exact passthrough everywhere the two differ by more than SMAX_K (so
  // single-chain road — the entire climb and descent — is untouched). On
  // flat levels base() never runs, so this is invisible to the pins.
  const SMAX_K = 1.6; // blend half-width (m of height) — ~the fork ridge size
  const smoothMax = (a: number, b: number): number => {
    const hk = Math.max(SMAX_K - Math.abs(a - b), 0) / SMAX_K;
    return Math.max(a, b) + hk * hk * SMAX_K * 0.25;
  };
  const base = (x: number, z: number): number => {
    if (x < gMinX || x > gMaxX || z < gMinZ || z > gMaxZ) return 0;
    let e = 0;
    let any = false;
    for (const c of chains) {
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      // project onto the WHOLE chain polyline once: nearest point gives both
      // the lateral distance d and the arc position s (no per-segment clamp,
      // so the longitudinal grade is continuous across every section seam).
      let bestD = Infinity;
      let bestS = 0;
      const m = c.vx.length;
      for (let i = 0; i < m - 1; i++) {
        const ax = c.vx[i], az = c.vz[i];
        const dx = c.vx[i + 1] - ax;
        const dz = c.vz[i + 1] - az;
        const segLen2 = dx * dx + dz * dz || 1;
        let t = ((x - ax) * dx + (z - az) * dz) / segLen2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + dx * t;
        const cz = az + dz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d < bestD) {
          bestD = d;
          bestS = c.vs[i] + t * (c.vs[i + 1] - c.vs[i]);
        }
      }
      if (m === 1) {
        bestD = Math.hypot(x - c.vx[0], z - c.vz[0]);
        bestS = 0;
      }
      if (bestD >= c.plateau + FADE) continue;
      const h = heightAlong(c, bestS);
      const cElev = h * falloff((bestD - c.plateau) / FADE);
      e = any ? smoothMax(e, cElev) : cElev;
      any = true;
    }
    return e;
  };
  return Object.assign((x: number, z: number) => base(x, z) + feature(x, z), { base, feature });
}
