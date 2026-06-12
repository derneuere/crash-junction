// One-off placement audit for the GANTRY POINT knockable-dressing pass
// (barrels at the four shortcut mouths + the ROADBLOCK barrel/pole cluster).
// Replicates the catmullFine/resampleEvery math from src/game/race.ts on the
// level's waypoint tables, then reports each candidate's distance to the
// fine-sampled main chain, every branch chain, the wall band and the solid
// props. Run: fnm exec --using=22 -- node tools/audit-gantry-dressing.mjs
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function catmullFine(waypoints, closed) {
  const n = waypoints.length;
  const at = (i) => waypoints[closed ? ((i % n) + n) % n : clamp(i, 0, n - 1)];
  const fine = [];
  const segs = closed ? n : n - 1;
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
  if (!closed) fine.push([waypoints[n - 1][0], waypoints[n - 1][1]]);
  return fine;
}

function resampleEvery(fine, spacing, closed) {
  const pts = [];
  let acc = 0, prev = fine[0];
  pts.push(prev);
  const last = closed ? fine.length : fine.length - 1;
  for (let i = 1; i <= last; i++) {
    const cur = fine[closed ? i % fine.length : i];
    acc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
    if (acc >= spacing) { pts.push(cur); acc = 0; }
  }
  if (closed) {
    if (pts.length > 2 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < spacing * 0.6) pts.pop();
  } else {
    const end = fine[fine.length - 1], tail = pts[pts.length - 1];
    const d = Math.hypot(end[0] - tail[0], end[1] - tail[1]);
    if (d < spacing * 0.5 && pts.length > 1) pts[pts.length - 1] = end;
    else if (d > 1e-6) pts.push(end);
  }
  return pts;
}

// distance from p to a polyline (segment-accurate)
function distToChain(p, chain, closed) {
  let best = Infinity;
  const n = chain.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = chain[i], b = chain[(i + 1) % n];
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const l2 = abx * abx + abz * abz || 1;
    const t = clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / l2, 0, 1);
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * abz)));
  }
  return best;
}

// ---- gantryPoint.ts inputs (keep in sync by hand; this is a one-off) ----
const WAYPOINTS = [
  [0, -228], [148, -220], [202, -212], [242, -194], [256, -156], [234, -120],
  [226, -95], [230, -62], [196, -46], [150, -34], [106, -26], [88, 4],
  [104, 34], [174, 62], [198, 82], [228, 100], [248, 136], [256, 168],
  [262, 196], [242, 224], [204, 240], [144, 250], [30, 244], [10, 218],
  [-20, 216], [-40, 240], [-156, 236], [-198, 210], [-228, 170], [-242, 124],
  [-214, 82], [-244, 40], [-218, 2], [-246, -40], [-250, -86], [-202, -100],
  [-154, -114], [-140, -156], [-168, -180], [-164, -198], [-134, -214], [-78, -226],
];
const SHORTCUTS = {
  HARBOR: { halfW: 5.5, wps: [[230, -58], [222, -24], [226, 6], [226, 44], [226, 72], [228, 96]] },
  FLYOVER: { halfW: 6, wps: [[170, -217], [200, -180], [216, -148], [224, -108]] },
  LEDGE: { halfW: 5, wps: [[28, 243], [-4, 248], [-36, 239]] },
  BEACH: { halfW: 6, wps: [[-250, -90], [-234, -136], [-202, -178], [-172, -224], [-108, -242], [-80, -228]] },
};
// solid props near any candidate, as centre + bounding circle (hypot of half extents)
const SOLIDS = [
  ['lighthouse', 280, -158, Math.hypot(4, 4)],
  ['craneA', 210, -88, Math.hypot(1.5, 1.5)], ['craneB', 247, -70, Math.hypot(1.5, 1.5)],
  ['harborCrane', 262, -96, Math.hypot(7, 7)],
  ['cont250', 250, -104, Math.hypot(2.9, 1.3)], ['cont251', 251, -96, Math.hypot(2.9, 1.3)],
  ['train253', 253, -52, Math.hypot(4.7, 1.05)],
  ['cont211', 211, -30, Math.hypot(2.9, 1.3)], ['cont212', 212, -6, Math.hypot(2.9, 1.3)],
  ['cont242', 242, -32, Math.hypot(2.9, 1.3)], ['struct243', 243, -8, Math.hypot(4, 2.3)],
  ['rockTallB', 12, 258, Math.hypot(1.35, 1.35)], ['rockTallA', -29, 253, Math.hypot(1.7, 1.2)],
];
// decor positions (no collider — visual overlap check only)
const DECOR = [
  ['fence214', 214, -38], ['fence242', 242, -49], ['warn214', 214, -33], ['warn239', 239, -45],
  ['pyl217', 217, -40], ['pyl236', 236, -42],
  ['banner164', 164, -203],
  ['sign3', 3, 236], ['tower-6', -6, 235], ['radar-14', -14, 235], ['stone-12', -12, 259],
  ['warn-260', -260, -104], ['pyl-228', -228, -112],
  ['bwall-258', -258, 46], ['bred-260', -260, 38], ['bwhite-256', -256, 28], ['warn-254', -254, 52],
  ['bwall-203', -203, 6], ['bred-202', -202, -6], ['warn-205', -205, 14], ['pyl-206', -206, -14], ['pyl-252', -252, 60],
];

const mainFine = catmullFine(WAYPOINTS, true);
const SECTIONS = resampleEvery(mainFine, 8, true);
const chains = Object.fromEntries(
  Object.entries(SHORTCUTS).map(([k, sc]) => [k, { ...sc, fine: catmullFine(sc.wps, false) }]),
);

function nearestSection(x, z) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < SECTIONS.length; i++) {
    const d = Math.hypot(SECTIONS[i][0] - x, SECTIONS[i][1] - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// wall gap spans (entry/exit section +-1, branch side) — report whether a
// candidate sits beside a gapped wall segment (i.e. reachable from the main road)
const gapped = new Set();
for (const [k, sc] of Object.entries(SHORTCUTS)) {
  for (const [secIdx, wp] of [[nearestSection(...sc.wps[0]), sc.wps[0]], [nearestSection(...sc.wps[sc.wps.length - 1]), sc.wps[sc.wps.length - 1]]]) {
    const N = SECTIONS.length;
    const s = SECTIONS[secIdx], sn = SECTIONS[(secIdx + 1) % N];
    const dx = sn[0] - s[0], dz = sn[1] - s[1], l = Math.hypot(dx, dz) || 1;
    const cross = (dx / l) * (wp[1] - s[1]) - (dz / l) * (wp[0] - s[0]);
    const side = cross >= 0 ? 1 : -1;
    for (let k2 = -1; k2 <= 1; k2++) gapped.add(`${side}:${(secIdx + k2 + N) % N}`);
  }
}
function inGap(p) {
  // beside a gapped segment = nearest main section (or neighbour) is gapped on p's side
  const N = SECTIONS.length;
  const i = nearestSection(p[0], p[1]);
  for (const j of [(i - 1 + N) % N, i, (i + 1) % N]) {
    const s = SECTIONS[j], sn = SECTIONS[(j + 1) % N];
    const dx = sn[0] - s[0], dz = sn[1] - s[1], l = Math.hypot(dx, dz) || 1;
    const cross = (dx / l) * (p[1] - s[1]) - (dz / l) * (p[0] - s[0]);
    if (gapped.has(`${cross >= 0 ? 1 : -1}:${j}`)) return true;
  }
  return false;
}

// ---- candidates: [group, kind, x, z] ----
const CANDIDATES = [
  ['HARBOR', 'barrel', 216, -34], ['HARBOR', 'barrel', 216.5, -37],
  ['HARBOR', 'barrel', 234, -44], ['HARBOR', 'barrel', 236, -48],
  ['FLYOVER', 'barrel', 169, -204], ['FLYOVER', 'barrel', 192, -202], ['FLYOVER', 'barrel', 196, -197],
  ['LEDGE', 'barrel', 16, 252], ['LEDGE', 'barrel', 10, 253],
  ['BEACH', 'barrel', -233, -115], ['BEACH', 'barrel', -231, -125],
  ['BEACH', 'barrel', -251, -116], ['BEACH', 'barrel', -253.5, -107.5],
  ['ROADBLOCK', 'barrel', -252, 32], ['ROADBLOCK', 'barrel', -250, 29], ['ROADBLOCK', 'barrel', -249, 26],
  ['ROADBLOCK', 'pole', -247, 23],
  ['ROADBLOCK', 'barrel', -210.5, 12.5], ['ROADBLOCK', 'barrel', -209, 8],
  ['ROADBLOCK', 'pole', -209, 6],
];

const ZONE = { x: -230, z: 20, r: 26 };

// grid probes: print cells satisfying a band, to find valid pockets
function probe(label, x0, x1, z0, z1, test) {
  const rows = [];
  for (let z = z1; z >= z0; z -= 1) {
    let row = '';
    for (let x = x0; x <= x1; x += 1) {
      const p = [x, z];
      const dMain = distToChain(p, mainFine, true);
      row += test(p, dMain) ? 'O' : '.';
    }
    rows.push(`${String(z).padStart(5)} ${row}`);
  }
  console.log(`\n${label}  x ${x0}..${x1}`);
  console.log(rows.join('\n'));
}
if (process.argv.includes('--probe')) {
  probe('HARBOR-W (dMain>=12, edge 1..3)', 212, 224, -48, -30, (p, dM) => {
    const e = distToChain(p, chains.HARBOR.fine, false) - 5.5;
    return dM >= 12 && e >= 1 && e <= 3;
  });
  probe('HARBOR-E (dMain>=12, edge 1..3)', 229, 240, -52, -34, (p, dM) => {
    const e = distToChain(p, chains.HARBOR.fine, false) - 5.5;
    return dM >= 12 && e >= 1 && e <= 3;
  });
  probe('FLYOVER wedge (dMain>=12, edge 1..3)', 186, 202, -206, -192, (p, dM) => {
    const e = distToChain(p, chains.FLYOVER.fine, false) - 6;
    return dM >= 12 && e >= 1 && e <= 3;
  });
  probe('LEDGE rim (dMain>=12, edge 1..2.5)', 4, 24, 248, 256, (p, dM) => {
    const e = distToChain(p, chains.LEDGE.fine, false) - 5;
    return dM >= 12 && e >= 1 && e <= 2.5;
  });
  probe('ROADBLOCK-W (dMain 8.7..10.6, zone<25.5)', -256, -244, 22, 40, (p, dM) => {
    return dM >= 8.7 && dM <= 10.6 && Math.hypot(p[0] - ZONE.x, p[1] - ZONE.z) < 25.5;
  });
  probe('ROADBLOCK-E (dMain 8.7..10.6, zone<25.5)', -214, -202, -2, 16, (p, dM) => {
    return dM >= 8.7 && dM <= 10.6 && Math.hypot(p[0] - ZONE.x, p[1] - ZONE.z) < 25.5;
  });
}

console.log(`sections N=${SECTIONS.length}`);
for (const [grp, kind, x, z] of CANDIDATES) {
  const p = [x, z];
  const dMain = distToChain(p, mainFine, true);
  const parts = [`dMain=${dMain.toFixed(1)}`];
  for (const [k, c] of Object.entries(chains)) {
    const d = distToChain(p, c.fine, false);
    if (d < 25) parts.push(`d${k}=${d.toFixed(1)} (edge${(d - c.halfW).toFixed(1)})`);
  }
  parts.push(inGap(p) ? 'IN-GAP' : 'no-gap');
  if (grp === 'ROADBLOCK') parts.push(`zone=${Math.hypot(x - ZONE.x, z - ZONE.z).toFixed(1)}/${ZONE.r}`);
  for (const [n, sx, sz, r] of SOLIDS) {
    const d = Math.hypot(x - sx, z - sz) - r;
    if (d < 3) parts.push(`SOLID:${n}=${d.toFixed(1)}`);
  }
  for (const [n, sx, sz] of DECOR) {
    const d = Math.hypot(x - sx, z - sz);
    if (d < 2.5) parts.push(`decor:${n}=${d.toFixed(1)}`);
  }
  console.log(`${grp.padEnd(9)} ${kind.padEnd(6)} (${x}, ${z})  ${parts.join('  ')}`);
}
