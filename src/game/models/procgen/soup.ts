import * as THREE from 'three';

/** A flat triangle soup a part builder writes into: non-indexed positions +
 *  face normals + per-vertex colors, in the flat-shaded style of the baked
 *  GLBs (every corner duplicated — the crumple weld handles coincidence).
 *  One soup per material ROLE; the assembler concatenates soups and records
 *  the vertex ranges (paint/glass/head/tail) off the soup sizes. */
export type V3 = [number, number, number];

const EPS_AREA = 1e-6;

export class Soup {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Push one triangle. If `awayFrom` is given, the winding is fixed so the
   *  face normal points AWAY from that reference point — how the loft keeps
   *  outward shells outward and well liners facing the wheel. Degenerate
   *  (near-zero-area) triangles are dropped, which is what lets collapsed
   *  loft ring points (hood stations with no greenhouse) just vanish. */
  tri(a: V3, b: V3, c: V3, color: THREE.Color, awayFrom?: V3): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < EPS_AREA) return;
    nx /= len; ny /= len; nz /= len;
    let p1 = b, p2 = c;
    if (awayFrom) {
      const mx = (a[0] + b[0] + c[0]) / 3 - awayFrom[0];
      const my = (a[1] + b[1] + c[1]) / 3 - awayFrom[1];
      const mz = (a[2] + b[2] + c[2]) / 3 - awayFrom[2];
      if (nx * mx + ny * my + nz * mz < 0) {
        p1 = c; p2 = b;
        nx = -nx; ny = -ny; nz = -nz;
      }
    }
    this.pos.push(a[0], a[1], a[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    for (let i = 0; i < 3; i++) {
      this.nrm.push(nx, ny, nz);
      this.col.push(color.r, color.g, color.b);
    }
  }

  /** Quad a→b→c→d as two tris (each resolves its own winding against
   *  `awayFrom`; a sliver half simply drops via the area check). */
  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color, awayFrom?: V3): void {
    this.tri(a, b, c, color, awayFrom);
    this.tri(a, c, d, color, awayFrom);
  }

  /** Axis-aligned box, outward-wound. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color): void {
    const x0 = cx - sx / 2, x1 = cx + sx / 2;
    const y0 = cy - sy / 2, y1 = cy + sy / 2;
    const z0 = cz - sz / 2, z1 = cz + sz / 2;
    const ctr: V3 = [cx, cy, cz];
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], color, ctr);
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], color, ctr);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], color, ctr);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color, ctr);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color, ctr);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], color, ctr);
  }

  /** Append this soup's arrays onto the merge accumulators. */
  appendTo(pos: number[], nrm: number[], col: number[]): void {
    pos.push(...this.pos);
    nrm.push(...this.nrm);
    col.push(...this.col);
  }
}

/** Concatenate soups in order into one non-indexed BufferGeometry, returning
 *  the [start, end) VERTEX range each soup landed in (the VehicleModel
 *  paint/glass/head/tail range convention). */
export function mergeSoups(soups: Soup[]): { geo: THREE.BufferGeometry; ranges: [number, number][] } {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const ranges: [number, number][] = [];
  for (const s of soups) {
    const start = pos.length / 3;
    s.appendTo(pos, nrm, col);
    ranges.push([start, pos.length / 3]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return { geo, ranges };
}
