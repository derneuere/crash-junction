import type { RaceWaypoint } from '../types';

// Race navigation modeled on BP's AISections resource (AIMapData 0x10001):
// the track is an ordered loop of quad sections — each with a centre, a
// direction and a speed class — and the link from one section to the next
// is the portal. Rivals steer toward a look-ahead section (BP drives its
// AI with a PID on a look-ahead point) and brake for the slowest section
// coming up. Respawns follow the SectionResetPair semantics: crash in
// section X → placed back into its mapped section at SLOW speed, facing
// down the track.

export interface RaceSection {
  x: number;
  z: number;
  /** Road elevation at the centre (m above the flat physics plane) — 0
   *  everywhere on flat tracks. Fed by the waypoints' optional third
   *  component (elevation.md Phase 1); progress, speed classes and
   *  gate-reach stay deliberately 2D (roads never stack vertically). */
  y: number;
  dirX: number; // unit direction toward the next section (the portal)
  dirZ: number;
  v: number; // section speed class, m/s (VERY_SLOW … VERY_FAST)
}

export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Catmull-Rom through the waypoints, finely sampled. Closed wraps the
 *  control points around the seam; open clamps them at the ends (the
 *  standard clamped spline) and lands exactly on the last waypoint.
 *  y rides the same spline weights; arc length below stays 2D, so a
 *  profile tweak can never move a section or change a speed class. */
function catmullFine(waypoints: RaceWaypoint[], closed: boolean): [number, number, number][] {
  const n = waypoints.length;
  const at = (i: number) => waypoints[closed ? ((i % n) + n) % n : clamp(i, 0, n - 1)];
  const fine: [number, number, number][] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const y0 = p0[2] ?? 0;
    const y1 = p1[2] ?? 0;
    const y2 = p2[2] ?? 0;
    const y3 = p3[2] ?? 0;
    for (let s = 0; s < 20; s++) {
      const t = s / 20;
      const t2 = t * t;
      const t3 = t2 * t;
      fine.push([
        0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3),
        0.5 * (2 * y1 + (y2 - y0) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (3 * y1 - y0 - 3 * y2 + y3) * t3),
      ]);
    }
  }
  if (!closed) fine.push([waypoints[n - 1][0], waypoints[n - 1][1], waypoints[n - 1][2] ?? 0]);
  return fine;
}

/** Walk the fine polyline's arc length, dropping a point every `spacing`
 *  metres. Closed wraps back to the seam (and drops a too-close duplicate);
 *  open must END at the final waypoint — that's where the exit gate lives. */
function resampleEvery(fine: [number, number, number][], spacing: number, closed: boolean): [number, number, number][] {
  const pts: [number, number, number][] = [];
  let acc = 0;
  let prev = fine[0];
  pts.push(prev);
  const last = closed ? fine.length : fine.length - 1;
  for (let i = 1; i <= last; i++) {
    const cur = fine[closed ? i % fine.length : i];
    acc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
    if (acc >= spacing) {
      pts.push(cur);
      acc = 0;
    }
  }
  if (closed) {
    if (pts.length > 2 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < spacing * 0.6) {
      pts.pop(); // don't double up the seam
    }
  } else {
    const end = fine[fine.length - 1];
    const tail = pts[pts.length - 1];
    const d = Math.hypot(end[0] - tail[0], end[1] - tail[1]);
    if (d < spacing * 0.5 && pts.length > 1) pts[pts.length - 1] = end; // snap, don't stutter
    else if (d > 1e-6) pts.push(end);
  }
  return pts;
}

/** Shared tail of both resamplers: evenly spaced points → sections with
 *  curvature speed classes and backward brake propagation. `closed` only
 *  controls whether index math wraps (a loop) or clamps (an open branch) —
 *  the clamped next() makes the open brake pass a self-min no-op at the
 *  last section, so the same passes serve both shapes. */
function finishSections(pts: [number, number, number][], spacing: number, closed: boolean): RaceSection[] {
  const N = pts.length;
  const next = (i: number) => (closed ? (i + 1) % N : Math.min(i + 1, N - 1));
  const secs: RaceSection[] = pts.map((p, i) => {
    const q = pts[next(i)];
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    // max(0, y): the Catmull tangents at a flat→climb seam overshoot a few
    // centimetres BELOW grade on the approach segment — clamping keeps the
    // flat zones at exact 0 (the determinism contract for the flat levels)
    // and turns the overshoot into a slightly later climb start. The clamp
    // boundary's slope step is ~1%, far under any pin/launch threshold.
    return { x: p[0], z: p[1], y: Math.max(0, p[2]), dirX: dx / l, dirZ: dz / l, v: 0 };
  });
  if (!closed && N >= 2) {
    // the final section has no portal of its own — keep the previous
    // direction so the chain's last gate still faces down the branch
    secs[N - 1].dirX = secs[N - 2].dirX;
    secs[N - 1].dirZ = secs[N - 2].dirZ;
  }
  // curvature → corner speed (v = sqrt(a_lat · R)), then brake backwards.
  // the lateral-accel budget is generous: corners are meant to be taken
  // flat-out (with a drift), never on the brakes
  for (let i = 0; i < N; i++) {
    const h0 = Math.atan2(secs[i].dirX, secs[i].dirZ);
    const h1 = Math.atan2(secs[next(i)].dirX, secs[next(i)].dirZ);
    const R = spacing / Math.max(1e-4, Math.abs(wrapAngle(h1 - h0)));
    secs[i].v = clamp(Math.sqrt(16 * R), 18, 38);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      secs[i].v = Math.min(secs[i].v, secs[next(i)].v + 4); // brake zone
    }
  }
  return secs;
}

/** Resample a closed waypoint polygon into evenly spaced sections with
 *  curvature-derived speed classes (slow apex, fast straight), brake
 *  distance propagated backwards so the AI slows BEFORE the corner. */
export function buildLoopSections(waypoints: RaceWaypoint[], spacing: number): RaceSection[] {
  return finishSections(resampleEvery(catmullFine(waypoints, true), spacing, true), spacing, true);
}

/** The same resampler for an OPEN polyline (shortcut branch ribbons):
 *  clamped spline endpoints, no wrap — the final section keeps the previous
 *  section's direction so its gate still faces down the branch. */
export function buildOpenSections(waypoints: RaceWaypoint[], spacing: number): RaceSection[] {
  return finishSections(resampleEvery(catmullFine(waypoints, false), spacing, false), spacing, false);
}

/** Section spacing for shortcut chains — the GDD's main-loop request, so a
 *  branch corridor samples about as densely as the road it forks from.
 *  environment.ts builds the visual ribbons from the same chains. */
export const SHORTCUT_SPACING = 8;
