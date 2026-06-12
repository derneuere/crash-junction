// MERGE-PASS audit for GANTRY POINT: unlike audit-gantry-dressing.mjs (a
// one-off with hand-copied tables), this bundles the REAL level module via
// esbuild and checks, against the live data:
//   1. coast outline: closed, non-self-intersecting, winding, edge-type runs
//   2. every prop/building inside the outline (reporting deliberate floaters)
//   3. every SOLID collider's clearance to the main + branch chains
//      (required = ribbon half-width + collider half-diagonal + 1.5)
//   4. ramp landing corridors prop-free
//   5. final per-segment wall style after last-wins resolution
//   6. knockable furniture (barrels/poles) off every driving line — with
//      the documented ROADBLOCK outer-band exception
//   7. signature circles actually covering their corners
//   8. shortcut polylines touching the main ribbon at both forks
// Run: fnm exec --using=22 -- node tools/audit-merge-gantry.mjs
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// bundle INSIDE the repo so the external deps resolve from node_modules
const out = join(root, 'tools', '.audit-level-bundle.tmp.mjs');
await build({
  entryPoints: [join(root, 'src/game/levels/gantryPoint.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  // leave deps to node's own resolver — cannon-es's CJS build dynamic-
  // requires perf_hooks, which an esbuild ESM bundle can't satisfy
  external: ['cannon-es', 'three'],
  outfile: out,
  logLevel: 'silent',
});
const { gantryPoint } = await import(pathToFileURL(out).href);
await rm(out, { force: true });

const level = gantryPoint;
const race = level.mode.race;
const outline = level.coast.outline;
let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL  ${msg}`);
};

// ---- 1. coast outline integrity ----
console.log(`outline: ${outline.length} vertices`);
// duplicate / near-duplicate vertices would make degenerate skirt segments
for (let i = 0; i < outline.length; i++) {
  const a = outline[i];
  const b = outline[(i + 1) % outline.length];
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  if (d < 1) fail(`outline segment ${i} degenerate (${d.toFixed(2)} m) at (${a.x},${a.z})`);
}
// self-intersection: every non-adjacent segment pair
function segInt(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.z - p3.z) - (p2.z - p1.z) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.z - p3.z) - (p3.z - p1.z) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.z - p1.z) - (p3.z - p1.z) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}
const n = outline.length;
for (let i = 0; i < n; i++) {
  for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue; // adjacent over the seam
    if (segInt(outline[i], outline[(i + 1) % n], outline[j], outline[(j + 1) % n])) {
      fail(`outline self-intersection: segment ${i} (${outline[i].x},${outline[i].z}) x segment ${j} (${outline[j].x},${outline[j].z})`);
    }
  }
}
// winding (engine auto-detects via the same shoelace, so either passes;
// reported in the engine's frame: looking down -y at the xz plane, x right
// and z down-screen, NEGATIVE shoelace = counter-clockwise on screen)
let area2 = 0;
for (let i = 0; i < n; i++) {
  const a = outline[i];
  const b = outline[(i + 1) % n];
  area2 += a.x * b.z - b.x * a.z;
}
console.log(`outline winding: ${area2 < 0 ? 'CCW (viewed from +y)' : 'CW (viewed from +y)'} (shoelace 2A=${area2.toFixed(0)})`);
// edge-type runs (transitions are where skirt style changes — masked?)
let runs = [];
for (let i = 0; i < n; i++) {
  const e = outline[i].edge;
  if (!runs.length || runs[runs.length - 1].edge !== e) runs.push({ edge: e, from: i });
}
console.log('edge-type transitions (vertex where the NEW style starts):');
for (const r of runs) {
  const v = outline[r.from];
  console.log(`  v${r.from} (${v.x},${v.z}) -> ${r.edge}`);
}

// ---- 2. containment ----
function inside(px, pz) {
  let c = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (a.z > pz !== b.z > pz && px < ((b.x - a.x) * (pz - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
const floaters = [];
for (const p of level.props) {
  if (!inside(p.x, p.z)) floaters.push(`${p.url.split('/').pop()} (${p.x.toFixed(1)},${p.z.toFixed(1)})${p.collider && p.collider !== 'none' ? ' SOLID!' : ''}`);
}
for (const b of level.buildings ?? []) {
  if (!inside(b.x, b.z)) fail(`building outside outline at (${b.x},${b.z})`);
}
console.log(`\nprops outside the outline (deliberate floaters should all be decor):`);
for (const f of floaters) console.log(`  ${f}`);
for (const f of floaters) if (f.includes('SOLID!')) fail(`solid prop outside outline: ${f}`);

// ---- road containment: every resampled section centre + both ribbon edges ----
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function catmullFine(waypoints, closed) {
  const N = waypoints.length;
  const at = (i) => waypoints[closed ? ((i % N) + N) % N : clamp(i, 0, N - 1)];
  const fine = [];
  const segs = closed ? N : N - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < 20; s++) {
      const t = s / 20, t2 = t * t, t3 = t2 * t;
      fine.push([
        0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) fine.push([waypoints[N - 1][0], waypoints[N - 1][1]]);
  return fine;
}
const sections = race.sections;
for (let i = 0; i < sections.length; i++) {
  const s = sections[i];
  const half = race.width / 2;
  for (const off of [0, half, -half]) {
    const px = s.x - s.dirZ * off;
    const pz = s.z + s.dirX * off;
    if (!inside(px, pz)) fail(`main road escapes outline at section ${i} offset ${off} (${px.toFixed(1)},${pz.toFixed(1)})`);
  }
}
for (const sc of race.shortcuts) {
  const fine = catmullFine(sc.waypoints, false);
  for (const [x, z] of fine) {
    if (!inside(x, z)) fail(`${sc.name} centreline escapes outline at (${x.toFixed(1)},${z.toFixed(1)})`);
  }
}

// ---- 3. solid clearance ----
function distToChain(p, chain, closed) {
  let best = Infinity;
  const m = chain.length;
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const a = chain[i], b = chain[(i + 1) % m];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const l2 = abx * abx + abz * abz || 1;
    const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2, 0, 1);
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * abz)));
  }
  return best;
}
const mainFine = catmullFine(sections.map((s) => [s.x, s.z]), true);
const branches = race.shortcuts.map((sc) => ({ name: sc.name, halfW: sc.width / 2, fine: catmullFine(sc.waypoints, false) }));
console.log('\nsolid clearance audit (need halfW + halfDiag + 1.5):');
let tightest = { margin: Infinity };
for (const p of level.props) {
  if (!p.collider || p.collider === 'none') continue;
  const halfDiag = Math.hypot(p.collider.hx, p.collider.hz);
  const checks = [{ name: 'MAIN', halfW: race.width / 2, fine: mainFine, closed: true }, ...branches];
  for (const c of checks) {
    const d = distToChain([p.x, p.z], c.fine, c.closed ?? false);
    const need = c.halfW + halfDiag + 1.5;
    const margin = d - need;
    if (margin < tightest.margin) tightest = { margin, prop: p.url.split('/').pop(), at: `(${p.x},${p.z})`, chain: c.name, d, need };
    if (margin < 0) fail(`solid ${p.url.split('/').pop()} (${p.x},${p.z}) too close to ${c.name}: ${d.toFixed(1)} < ${need.toFixed(1)}`);
  }
}
for (const b of level.buildings ?? []) {
  // BuildingDef boxes are 14x14 plinths (see levels) — half-diagonal ~9.9
  const halfDiag = Math.hypot(7, 7);
  const checks = [{ name: 'MAIN', halfW: race.width / 2, fine: mainFine, closed: true }, ...branches];
  for (const c of checks) {
    const d = distToChain([b.x, b.z], c.fine, c.closed ?? false);
    const need = c.halfW + halfDiag + 1.5;
    if (d - need < 0) fail(`building (${b.x},${b.z}) too close to ${c.name}: ${d.toFixed(1)} < ${need.toFixed(1)}`);
  }
}
console.log(`  tightest: ${tightest.prop} ${tightest.at} vs ${tightest.chain}: ${tightest.d?.toFixed(1)} (need ${tightest.need?.toFixed(1)}, margin +${tightest.margin.toFixed(1)})`);

// ---- 4. ramp landing corridors ----
// each ramp ascends toward +z; landing corridor = ramp width + 2 m margin,
// from the wedge lip to lip + 4x height x ~5 (generous flat-out flight)
for (const r of level.ramps ?? []) {
  const zEnd = r.zStart + r.length;
  const zFar = zEnd + 40;
  for (const p of level.props) {
    if (!p.collider || p.collider === 'none') continue;
    const within =
      Math.abs(p.x - r.x) < r.width / 2 + Math.hypot(p.collider.hx, p.collider.hz) + 1 &&
      p.z > zEnd - 1 &&
      p.z - Math.hypot(p.collider.hx, p.collider.hz) < zFar;
    if (within) fail(`ramp at (${r.x},${r.zStart}) landing corridor blocked by ${p.url.split('/').pop()} (${p.x},${p.z})`);
  }
}

// ---- 5. resolved wall styles per segment (last wins) ----
const styleFor = (side, i) => {
  let st = 'race';
  for (const ws of race.wallStyles ?? []) {
    if (ws.side !== 'both' && (ws.side === 'left' ? 1 : -1) !== side) continue;
    const inRange = ws.from <= ws.to ? i >= ws.from && i <= ws.to : i >= ws.from || i <= ws.to;
    if (inRange) st = ws.style;
  }
  return st;
};
console.log('\nresolved wall-style runs (left | right):');
for (const side of [1, -1]) {
  let cur = null;
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const st = styleFor(side, i);
    if (st !== cur) {
      out.push(`${i}:${st}`);
      cur = st;
    }
  }
  console.log(`  ${side === 1 ? 'left ' : 'right'}: ${out.join('  ')}`);
}

// ---- 6. knockable furniture vs the live chains ----
// Design rule (gantryPoint.ts): knockables never sit ON a ribbon's driving
// line — mouth barrels stand outside their branch ribbon's edge in the fork
// wedges. The one documented exception is the ROADBLOCK cluster: the chicane
// is walled on both sides, so its run-off IS the corridor's outer band —
// those pieces may sit inside the main ribbon but must stay >= 8 m off the
// centreline (the outer ~3 m of the 11 m half-width) and inside the
// ROADBLOCK signature circle.
const roadblock = race.signatures.find((s) => s.name === 'ROADBLOCK');
const knockables = [
  ...level.barrels.map((b) => ({ ...b, kind: 'barrel' })),
  ...level.poles.map((p) => ({ ...p, kind: 'pole' })),
];
console.log('\nknockable band audit (off every driving line; ROADBLOCK outer band exempt):');
let tightestKnock = { margin: Infinity };
for (const k of knockables) {
  const inRoadblock = roadblock && Math.hypot(k.x - roadblock.x, k.z - roadblock.z) < roadblock.r;
  const dMain = distToChain([k.x, k.z], mainFine, true);
  if (inRoadblock) {
    // outer band: off the racing core, never further out than the wall line
    if (dMain < 8.0) fail(`ROADBLOCK ${k.kind} (${k.x},${k.z}) on the racing core: ${dMain.toFixed(1)} m off main centreline (< 8.0)`);
    continue;
  }
  const checks = [{ name: 'MAIN', halfW: race.width / 2, fine: mainFine, closed: true }, ...branches];
  for (const c of checks) {
    const d = distToChain([k.x, k.z], c.fine, c.closed ?? false);
    const margin = d - (c.halfW + 0.35); // 0.35 ~ barrel radius: not on the driven surface
    if (margin < tightestKnock.margin) tightestKnock = { margin, kind: k.kind, at: `(${k.x},${k.z})`, chain: c.name, d };
    if (margin < 0) fail(`${k.kind} (${k.x},${k.z}) inside ${c.name} ribbon: ${d.toFixed(1)} < ${(c.halfW + 0.35).toFixed(1)}`);
  }
}
console.log(`  tightest (non-ROADBLOCK): ${tightestKnock.kind} ${tightestKnock.at} vs ${tightestKnock.chain}: ${tightestKnock.d?.toFixed(1)} (margin +${tightestKnock.margin.toFixed(1)})`);

// ---- 7. signature circles cover their corners ----
// A takedown theatre that drifted off its corner scores nothing: the main
// chain must pass well inside each circle, not graze the rim.
console.log('\nsignature coverage (main centreline must run inside each circle):');
for (const s of race.signatures ?? []) {
  const d = distToChain([s.x, s.z], mainFine, true);
  console.log(`  ${s.name} (${s.x},${s.z}) r=${s.r}: centreline ${d.toFixed(1)} m from centre`);
  if (d > s.r - 4) fail(`${s.name} circle no longer covers its corner: centreline ${d.toFixed(1)} m out (need <= ${(s.r - 4).toFixed(1)})`);
}

// ---- 8. shortcut polylines touch their forks ----
// The wall-gap side inference and rejoin gates key off the endpoint
// sections — a mouth that floats off the main ribbon strands the branch.
console.log('\nshortcut fork attachment (endpoints must lie on the main ribbon):');
for (const sc of race.shortcuts ?? []) {
  for (const [wp, end] of [[sc.waypoints[0], 'entry'], [sc.waypoints[sc.waypoints.length - 1], 'exit']]) {
    const d = distToChain([wp[0], wp[1]], mainFine, true);
    if (d > race.width / 2) fail(`${sc.name} ${end} (${wp[0]},${wp[1]}) floats ${d.toFixed(1)} m off the main centreline (> ${race.width / 2})`);
  }
  console.log(`  ${sc.name}: ${sc.entry}->${sc.exit} attached`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASS');
process.exit(failures ? 1 : 0);
