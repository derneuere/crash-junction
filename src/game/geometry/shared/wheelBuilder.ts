import * as THREE from 'three';

// ────────────────────────────────────────────────────────────────────────────
// Parametric road wheel — the ONE builder behind both the generated cars'
// wheel templates (models/procgen/wheels.ts) and the shared generic wheel
// (wheelGeometry in ./wheels.ts, used by the garage for the baked roster and
// in-game by anything without a model).
//
// Contract: centred at the origin, axle along X, radius exactly `r` (the
// spec's wheelRadius, so the suspension seating is untouched), everything
// inside the tyre half-width so nothing pokes through an arch or the well
// liner. Vertex-coloured, presentation-only, never deformed. Pure function
// of (style, r, side) — no RNG, so templates are as deterministic as the
// recipe that asks for them.
//
// Construction: the tyre, rim lip, barrel, window floor, hub boss and cap
// are ONE revolved profile (a polyline walked from the inboard hub centre,
// over the tread, down the outboard face to the cap centre) with smooth
// normals around the circumference and along rounded runs, and split rings
// wherever a hard edge or a colour change belongs (bead, lip, barrel,
// grooves). Spokes and lug bolts are added as flat-shaded prisms on top.
// ────────────────────────────────────────────────────────────────────────────

export type WheelStyle = 'seven-spoke' | 'steelie' | 'five-spoke' | 'turbine' | 'deep-dish';
/** Which side of the car the wheel bolts to: the alloy face points outboard
 *  (-X for the left wheel, +X for the right). */
export type WheelSide = 'L' | 'R';

/** Tyre half-width as a fraction of the radius — the width the wheel wells,
 *  baked hub detail and garage seating were all sized against. */
export const TYRE_HALF_WIDTH = 0.38;

const SEGS = 24; // circumferential segments of every revolved ring

// colours (per-vertex; the material is a white MeshStandard with vertexColors)
const SIDEWALL = new THREE.Color(0x121416);
const TREAD = new THREE.Color(0x2b2d31);
const GROOVE = new THREE.Color(0x08090b);
const ALLOY = new THREE.Color(0xd9dee4);
const ALLOY_DK = new THREE.Color(0x8a9098);
const BARREL = new THREE.Color(0x60666e);
const WINDOW = new THREE.Color(0x0c0e11);
const CAP = new THREE.Color(0x2a2e33);
const CHROME = new THREE.Color(0xe9edf2);
const STEEL = new THREE.Color(0xa9aeb5);
const BOLT = new THREE.Color(0x9096a0);
const INNER = new THREE.Color(0x202329);
const INNER_HUB = new THREE.Color(0x35393f);

interface StyleParams {
  rimR: number; // bead-seat radius / r
  barrel: number; // barrel wall radius / rimR (the bright lip spans rimR → barrel·rimR)
  dish: number; // lip face → spoke top plane, in tyre half-widths (how sunk the face is)
  spokes: number;
  fill: number; // fraction of the sector the spoke fills at the barrel
  crown: number; // ridge height above the spoke top, in half-widths (0 = flat top)
  curve: number; // angular sweep boss → barrel in sectors (turbine); 0 = straight
  bossR: number; // hub boss radius / rimR
  capR: number; // centre cap radius / bossR
  capH: number; // cap dome height, in half-widths
  cap: THREE.Color;
  bolts: number;
  face: THREE.Color; // spoke / dish top colour
  /** Parallel-sided vent SLOTS between the sectors (pressed steel) instead
   *  of near-parallel SPOKES with wedge windows (alloys). */
  slots?: boolean;
}

const STYLES: Record<WheelStyle, StyleParams> = {
  // Astra-H style seven-spoke alloy: chunky crowned spokes, small dark cap, five lugs
  'seven-spoke': { rimR: 0.7, barrel: 0.92, dish: 0.18, spokes: 7, fill: 0.55, crown: 0.06, curve: 0, bossR: 0.37, capR: 0.55, capH: 0.06, cap: CAP, bolts: 5, face: ALLOY },
  // pressed-steel disc: wide dish sectors with vent slots between, big chrome hubcap, no visible lugs
  steelie: { rimR: 0.72, barrel: 0.93, dish: 0.12, spokes: 8, fill: 0.64, crown: 0, curve: 0, bossR: 0.6, capR: 0.7, capH: 0.22, cap: CHROME, bolts: 0, face: STEEL, slots: true },
  // wide five-spoke sports wheel, deeper face, larger open windows
  'five-spoke': { rimR: 0.7, barrel: 0.92, dish: 0.22, spokes: 5, fill: 0.46, crown: 0.07, curve: 0, bossR: 0.36, capR: 0.55, capH: 0.06, cap: CAP, bolts: 5, face: ALLOY },
  // nine swept blades
  turbine: { rimR: 0.7, barrel: 0.92, dish: 0.16, spokes: 9, fill: 0.42, crown: 0.05, curve: 0.45, bossR: 0.36, capR: 0.55, capH: 0.06, cap: CAP, bolts: 5, face: ALLOY },
  // deep barrel with the spokes set well back
  'deep-dish': { rimR: 0.68, barrel: 0.9, dish: 0.45, spokes: 6, fill: 0.44, crown: 0.06, curve: 0, bossR: 0.38, capR: 0.55, capH: 0.06, cap: CAP, bolts: 5, face: ALLOY },
};

type V3 = [number, number, number];

/** Indexed position/normal/colour accumulator. Revolved rings share vertices
 *  (smooth shading); prism faces get their own (flat facets). */
class WheelMesh {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(c.r, c.g, c.b);
    return this.pos.length / 3 - 1;
  }

  /** One ring of SEGS vertices at axial x / radius rho with the profile
   *  normal (nx, nrho) swept around the axle. Returns the first index. */
  ring(x: number, rho: number, nx: number, nrho: number, c: THREE.Color): number {
    const base = this.pos.length / 3;
    for (let k = 0; k < SEGS; k++) {
      const a = (k / SEGS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      this.vertex(x, rho * ca, rho * sa, nx, nrho * ca, nrho * sa, c);
    }
    return base;
  }

  /** Quad strip between two rings, wound so the faces agree with the
   *  vertex normals (checked on the first quad, applied to all). */
  band(a: number, b: number): void {
    const flip = this.faceDot(a, a + 1, b + 1) < 0;
    for (let k = 0; k < SEGS; k++) {
      const k1 = (k + 1) % SEGS;
      const i0 = a + k, i1 = a + k1, i2 = b + k1, i3 = b + k;
      if (flip) this.idx.push(i0, i2, i1, i0, i3, i2);
      else this.idx.push(i0, i1, i2, i0, i2, i3);
    }
  }

  /** Triangle fan from a centre vertex to a ring. */
  fan(centre: number, ring: number): void {
    const flip = this.faceDot(centre, ring, ring + 1) < 0;
    for (let k = 0; k < SEGS; k++) {
      const k1 = (k + 1) % SEGS;
      if (flip) this.idx.push(centre, ring + k1, ring + k);
      else this.idx.push(centre, ring + k, ring + k1);
    }
  }

  /** Flat-shaded triangle with its own vertices; winding fixed so the face
   *  normal points AWAY from `awayFrom`. */
  tri(a: V3, b: V3, c: V3, color: THREE.Color, awayFrom: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    let p1 = b, p2 = c;
    const mx = (a[0] + b[0] + c[0]) / 3 - awayFrom[0];
    const my = (a[1] + b[1] + c[1]) / 3 - awayFrom[1];
    const mz = (a[2] + b[2] + c[2]) / 3 - awayFrom[2];
    if (nx * mx + ny * my + nz * mz < 0) {
      p1 = c; p2 = b;
      nx = -nx; ny = -ny; nz = -nz;
    }
    const i = this.vertex(a[0], a[1], a[2], nx, ny, nz, color);
    this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, color);
    this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, color);
    this.idx.push(i, i + 1, i + 2);
  }

  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color, awayFrom: V3): void {
    this.tri(a, b, c, color, awayFrom);
    this.tri(a, c, d, color, awayFrom);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.idx);
    return geo;
  }

  private faceDot(i0: number, i1: number, i2: number): number {
    const p = this.pos, n = this.nrm;
    const ax = p[i0 * 3], ay = p[i0 * 3 + 1], az = p[i0 * 3 + 2];
    const ux = p[i1 * 3] - ax, uy = p[i1 * 3 + 1] - ay, uz = p[i1 * 3 + 2] - az;
    const vx = p[i2 * 3] - ax, vy = p[i2 * 3 + 1] - ay, vz = p[i2 * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    // average the three vertex normals — a centre vertex's normal is axial
    // while the ring's may be nearly radial, and the sum is what the face follows
    const sx = n[i0 * 3] + n[i1 * 3] + n[i2 * 3];
    const sy = n[i0 * 3 + 1] + n[i1 * 3 + 1] + n[i2 * 3 + 1];
    const sz = n[i0 * 3 + 2] + n[i1 * 3 + 2] + n[i2 * 3 + 2];
    return fx * sx + fy * sy + fz * sz;
  }
}

/** One station of the revolved profile: axial x, radius rho. `hard` splits
 *  the ring so the two adjoining runs keep their own normals. */
interface ProfilePoint {
  x: number;
  rho: number;
  hard?: boolean;
}

/** Revolve a profile walked with the SOLID ON ITS RIGHT (so the outward
 *  normal is the walk direction turned left: (-dρ, dx)). Colours are per
 *  segment; a colour change splits the ring like a hard corner. Points on
 *  the axle (rho = 0) become fan centres. */
function revolve(m: WheelMesh, pts: ProfilePoint[], colors: THREE.Color[]): void {
  const n = pts.length - 1; // segments
  const sn: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const dx = pts[i + 1].x - pts[i].x, dr = pts[i + 1].rho - pts[i].rho;
    const len = Math.hypot(dx, dr) || 1;
    sn.push([-dr / len, dx / len]);
  }
  // per-point normal for the incoming and outgoing segment; a smooth point
  // (same colour both sides, not hard) averages them and shares one ring
  const nIn: [number, number][] = [], nOut: [number, number][] = [];
  const smooth: boolean[] = [];
  for (let i = 0; i <= n; i++) {
    const prev = i > 0 ? sn[i - 1] : null, next = i < n ? sn[i] : null;
    const split = !prev || !next || pts[i].hard || colors[i - 1] !== colors[i];
    smooth.push(!split);
    if (split) {
      nIn.push(prev ?? next!);
      nOut.push(next ?? prev!);
    } else {
      let ax = prev![0] + next![0], ar = prev![1] + next![1];
      const len = Math.hypot(ax, ar) || 1;
      ax /= len; ar /= len;
      nIn.push([ax, ar]);
      nOut.push([ax, ar]);
    }
  }
  let ringOut = -1; // ring emitted for pts[i] by the previous segment
  for (let i = 0; i < n; i++) {
    const c = colors[i];
    const a = pts[i], b = pts[i + 1];
    const shared = ringOut >= 0 && smooth[i];
    const ra = a.rho === 0 ? m.vertex(a.x, 0, 0, Math.sign(nOut[i][0]) || 1, 0, 0, c)
      : shared ? ringOut : m.ring(a.x, a.rho, nOut[i][0], nOut[i][1], c);
    const rb = b.rho === 0 ? m.vertex(b.x, 0, 0, Math.sign(nIn[i + 1][0]) || 1, 0, 0, c)
      : m.ring(b.x, b.rho, nIn[i + 1][0], nIn[i + 1][1], c);
    if (a.rho === 0) m.fan(ra, rb);
    else if (b.rho === 0) m.fan(rb, ra);
    else m.band(ra, rb);
    ringOut = b.rho === 0 ? -1 : rb;
  }
}

const yz = (a: number, rad: number): [number, number] => [Math.cos(a) * rad, Math.sin(a) * rad];

/** Build one wheel. The alloy face points +X; 'L' turns it to face -X. */
export function buildWheelGeometry(style: WheelStyle, r: number, side: WheelSide): THREE.BufferGeometry {
  const p = STYLES[style];
  const m = new WheelMesh();
  const hw = r * TYRE_HALF_WIDTH;
  const rimR = r * p.rimR;
  const barrelR = rimR * p.barrel;
  const tw = hw * 0.74; // tread half-width (the shoulders round off beyond it)
  const xBead = hw * 0.92;
  const xLip = hw * 0.9; // bright lip face, just behind the bead so the rubber overlaps it
  const xTop = xLip - hw * p.dish; // spoke / dish top plane
  const xFloor = xTop - hw * 0.1; // dark window floor behind the spokes
  const xRidge = xTop + hw * p.crown; // spoke crown ridge = hub boss top
  const bossR = rimR * p.bossR;
  const capR = bossR * p.capR;
  const capH = hw * p.capH;
  const xIn = hw * 0.7; // inboard dish → hub
  const hubInR = r * 0.3;
  const hubInH = hw * 0.15;
  const g = tw / 3, gw = hw * 0.05; // two circumferential grooves, V-notched

  // ── the revolved body: inboard hub → tread → outboard face → cap ──
  const pts: ProfilePoint[] = [];
  const cols: THREE.Color[] = [];
  const seg = (x: number, rho: number, color: THREE.Color, hard = false) => {
    if (pts.length) cols.push(color); // colour of the segment ENDING at this point
    pts.push({ x, rho, hard });
  };
  seg(-(xIn + hubInH), 0, INNER_HUB);
  seg(-(xIn + hubInH), hubInR, INNER_HUB, true);
  seg(-xIn, hubInR, INNER_HUB, true);
  seg(-xBead, rimR, INNER, true); // inboard dish, flat and dark
  seg(-hw, r * 0.8, SIDEWALL); // inboard sidewall bulge
  seg(-tw, r, SIDEWALL); // rounded inboard shoulder
  seg(-g - gw, r, TREAD);
  seg(-g, r * 0.985, GROOVE);
  seg(-g + gw, r, GROOVE);
  seg(g - gw, r, TREAD);
  seg(g, r * 0.985, GROOVE);
  seg(g + gw, r, GROOVE);
  seg(tw, r, TREAD);
  seg(hw * 0.93, r * 0.925, SIDEWALL); // shoulder
  seg(hw, r * 0.8, SIDEWALL); // sidewall bulge (widest point)
  seg(hw * 0.985, r * 0.74, SIDEWALL);
  seg(xBead, rimR, SIDEWALL, true); // bead — rubber meets metal
  seg(xLip, barrelR, ALLOY, true); // rim lip (bright, slightly conical)
  seg(xFloor, barrelR, BARREL, true); // barrel wall, facing the axle
  seg(xFloor, bossR, WINDOW, true); // window floor
  seg(xRidge, bossR, ALLOY_DK, true); // hub boss wall
  seg(xRidge, capR, p.face, true); // boss top (lug ring)
  seg(xRidge + capH * 0.7, capR * 0.72, p.cap, true); // cap dome
  seg(xRidge + capH, 0, p.cap);
  revolve(m, pts, cols);

  // ── spokes / dish sectors ──
  const N = p.spokes;
  const sector = (Math.PI * 2) / N;
  const ho = (p.fill * sector) / 2; // half-angle at the barrel
  const rOut = (barrelR * 1.02) / Math.cos(ho); // outer corners sit inside the barrel wall
  const rIn = bossR * 0.9; // roots buried in the boss
  // alloys: roots widen toward the hub (near-parallel spokes), capped so
  // neighbours don't overlap at the boss. Steel: the GAP keeps its width
  // instead, so the vents read as parallel slots.
  const hi = p.slots
    ? Math.max(ho * 0.5, sector / 2 - ((sector / 2 - ho) * rOut) / rIn)
    : Math.min(sector * 0.45, ((ho * rOut) / rIn) * 0.72);
  const deep: V3 = [-r, 0, 0];
  const steps = p.curve ? 2 : 1;
  for (let i = 0; i < N; i++) {
    const am = i * sector + Math.PI / 2;
    const st: { ang: number; rho: number; half: number }[] = [];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      st.push({ ang: am + p.curve * sector * t, rho: rIn + (rOut - rIn) * t, half: hi + (ho - hi) * t });
    }
    for (let j = 0; j < steps; j++) {
      const s0 = st[j], s1 = st[j + 1];
      const [ly0, lz0] = yz(s0.ang - s0.half, s0.rho), [ry0, rz0] = yz(s0.ang + s0.half, s0.rho);
      const [ly1, lz1] = yz(s1.ang - s1.half, s1.rho), [ry1, rz1] = yz(s1.ang + s1.half, s1.rho);
      const [cy0, cz0] = yz(s0.ang, s0.rho), [cy1, cz1] = yz(s1.ang, s1.rho);
      if (p.crown > 0) {
        // two facets meeting at a raised ridge so the light picks one side
        m.quad([xTop, ly0, lz0], [xTop, ly1, lz1], [xRidge, cy1, cz1], [xRidge, cy0, cz0], p.face, deep);
        m.quad([xTop, ry0, rz0], [xTop, ry1, rz1], [xRidge, cy1, cz1], [xRidge, cy0, cz0], p.face, deep);
      } else {
        m.quad([xTop, ly0, lz0], [xTop, ly1, lz1], [xTop, ry1, rz1], [xTop, ry0, rz0], p.face, deep);
      }
      // side walls down to the window floor, facing away from the spoke's own centreline
      const mid: V3 = [(xTop + xFloor) / 2, (cy0 + cy1) / 2, (cz0 + cz1) / 2];
      m.quad([xTop, ly0, lz0], [xTop, ly1, lz1], [xFloor, ly1, lz1], [xFloor, ly0, lz0], ALLOY_DK, mid);
      m.quad([xTop, ry0, rz0], [xTop, ry1, rz1], [xFloor, ry1, rz1], [xFloor, ry0, rz0], ALLOY_DK, mid);
    }
  }

  // ── lug bolts on the boss top, between the cap and the boss edge ──
  if (p.bolts > 0) {
    const rb = (capR + bossR) / 2;
    const s = r * 0.028; // half-size
    const h = hw * 0.035;
    for (let i = 0; i < p.bolts; i++) {
      const a = (i / p.bolts) * Math.PI * 2 + Math.PI / 2 + sector / 2;
      const [cy, cz] = yz(a, rb);
      const uy = Math.cos(a), uz = Math.sin(a); // radial
      const vy = -uz, vz = uy; // tangential
      const corner = (du: number, dv: number, x: number): V3 => [x, cy + uy * du + vy * dv, cz + uz * du + vz * dv];
      const ctr: V3 = [xRidge + h / 2, cy, cz];
      const top = [corner(-s, -s, xRidge + h), corner(s, -s, xRidge + h), corner(s, s, xRidge + h), corner(-s, s, xRidge + h)];
      const bot = [corner(-s, -s, xRidge - h * 0.2), corner(s, -s, xRidge - h * 0.2), corner(s, s, xRidge - h * 0.2), corner(-s, s, xRidge - h * 0.2)];
      m.quad(top[0], top[1], top[2], top[3], BOLT, ctr);
      for (let k = 0; k < 4; k++) {
        const k1 = (k + 1) % 4;
        m.quad(top[k], top[k1], bot[k1], bot[k], BOLT, ctr);
      }
    }
  }

  const geo = m.build();
  if (side === 'L') geo.rotateY(Math.PI); // face outboard on the left of the car
  return geo;
}
