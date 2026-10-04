// Seed placement for the Voronoi web.
//
// THREE STAGES, in this order:
//
// 1. PINNED PAIRS across edges. A Voronoi boundary lies exactly halfway between
//    two seeds, so a pair placed symmetrically across an edge point puts a cell
//    wall ON the edge. A row of such pairs along an edge makes the wall run the
//    length of it, and no cell straddles it. Strongest edges first; a pair is
//    skipped if either seed would crowd one already placed, which is also what
//    stops two nearly parallel edges from fighting over the same cells.
// 2. FILL with a variable-radius Poisson disc: candidates in seeded random order,
//    each accepted if it keeps its local spacing from everything so far.
// 3. RELAX the free seeds (Lloyd) a few times, pinned ones held still. Plain
//    Lloyd pulls towards uniform spacing, which would undo the detail
//    refinement, so centroids are weighted by (sMax/s)^4: in 2-D, Lloyd settles
//    on a point density of weight^(1/2), and density should go as 1/s^2.

import { mulberry32 } from '../shim/random.js';
import { SeedHash } from './voronoi.js';

/** A growable bucket grid for "is anything within r of here?". */
export class Crowd {
  constructor(rect, cs) {
    this.x0 = rect[0]; this.y0 = rect[1]; this.cs = cs;
    this.gw = Math.max(1, Math.ceil((rect[2] - rect[0]) / cs));
    this.gh = Math.max(1, Math.ceil((rect[3] - rect[1]) / cs));
    this.b = Array.from({ length: this.gw * this.gh }, () => []);
    this.xs = []; this.ys = [];
  }
  add(x, y) {
    const i = this.xs.length;
    this.xs.push(x); this.ys.push(y);
    const bx = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.x0) / this.cs)));
    const by = Math.min(this.gh - 1, Math.max(0, Math.floor((y - this.y0) / this.cs)));
    this.b[by * this.gw + bx].push(i);
  }
  clear(x, y, r) {
    const k = Math.ceil(r / this.cs);
    const bx = Math.floor((x - this.x0) / this.cs), by = Math.floor((y - this.y0) / this.cs);
    const r2 = r * r;
    for (let yy = Math.max(0, by - k); yy <= Math.min(this.gh - 1, by + k); yy++) {
      for (let xx = Math.max(0, bx - k); xx <= Math.min(this.gw - 1, bx + k); xx++) {
        for (const i of this.b[yy * this.gw + xx]) {
          if ((this.xs[i] - x) ** 2 + (this.ys[i] - y) ** 2 < r2) return false;
        }
      }
    }
    return true;
  }
}

/**
 * @param {object} o
 * @param {number[]} o.rect         x0, y0, x1, y1: seeds stay inside
 * @param {(x,y)=>number} o.spacingAt  local spacing, mm
 * @param {number} o.sMin, o.sMax   its bounds
 * @param {Array<{x,y,nx,ny,s}>} o.edges  edge points in mm, unit normals
 * @param {number} o.seed           RNG seed
 * @param {number} o.iters          Lloyd iterations
 * @returns {{xs:Float64Array, ys:Float64Array, pinned:Uint8Array, side:Int8Array,
 *            nx:Float64Array, ny:Float64Array, pairs:number}}
 *   side/nx/ny: for pinned seeds, which side of its edge (±1) and that edge's normal
 */
export function placeSeeds(o) {
  const { rect, spacingAt, sMin, sMax } = o;
  const crowd = new Crowd(rect, sMin);
  const pinned = [], side = [], nxs = [], nys = [];
  const inRect = (x, y, pad) => x >= rect[0] + pad && x <= rect[2] - pad && y >= rect[1] + pad && y <= rect[3] - pad;

  // 1. pinned pairs, strongest edges first (a stable sort keeps ties in scan order)
  const order = o.edges.map((_, i) => i).sort((a, b) => o.edges[b].s - o.edges[a].s);
  let pairs = 0;
  for (const k of order) {
    const e = o.edges[k];
    const s = spacingAt(e.x, e.y);
    const h = s / 2;
    const ax = e.x + e.nx * h, ay = e.y + e.ny * h, bx = e.x - e.nx * h, by = e.y - e.ny * h;
    if (!inRect(ax, ay, 0.25 * s) || !inRect(bx, by, 0.25 * s)) continue;
    if (!crowd.clear(ax, ay, 0.7 * s) || !crowd.clear(bx, by, 0.7 * s)) continue;
    crowd.add(ax, ay); pinned.push(1); side.push(1); nxs.push(e.nx); nys.push(e.ny);
    crowd.add(bx, by); pinned.push(1); side.push(-1); nxs.push(e.nx); nys.push(e.ny);
    pairs++;
  }

  // 2. fill
  for (const [cx, cy] of fillCandidates(rect, 0.4 * sMin, mulberry32(o.seed | 0))) {
    const x = Math.min(rect[2], cx), y = Math.min(rect[3], cy);
    if (crowd.clear(x, y, 0.85 * spacingAt(x, y))) {
      crowd.add(x, y); pinned.push(0); side.push(0); nxs.push(0); nys.push(0);
    }
  }
  const xs = Float64Array.from(crowd.xs), ys = Float64Array.from(crowd.ys);

  // 3. weighted Lloyd on a raster of the rectangle, a few samples per smallest cell
  lloyd(xs, ys, rect, (x, y) => (sMax / spacingAt(x, y)) ** 4, 3 / sMin, o.iters, pinned, sMax);

  return {
    xs, ys, pairs,
    pinned: Uint8Array.from(pinned), side: Int8Array.from(side),
    nx: Float64Array.from(nxs), ny: Float64Array.from(nys),
  };
}

/**
 * The candidates of a variable-radius Poisson-disc fill: a grid `step` apart
 * over rect, each jittered by up to step/2 (so possibly just outside rect; the
 * caller clamps or skips), in seeded random order. The caller accepts each one
 * that keeps its local spacing from everything placed so far (Crowd.clear).
 * Shared by the Voronoi seeds, the facet corners and the low-poly style.
 */
export function fillCandidates(rect, step, rand) {
  const cand = [];
  for (let y = rect[1] + step / 2; y < rect[3]; y += step) {
    for (let x = rect[0] + step / 2; x < rect[2]; x += step) cand.push([x + (rand() - 0.5) * step, y + (rand() - 0.5) * step]);
  }
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  return cand;
}

/**
 * Weighted Lloyd relaxation on a raster of `rect` at `res` samples per mm: each
 * free point moves to the weighted centroid of its Voronoi cell. In 2-D the
 * points settle at a density of weight^(1/2) (Gersho), so a caller wanting
 * density rho passes rho^2. Points whose cell carries no weight stay put.
 *
 * @param {Float64Array} xs, ys  moved in place
 * @param {ArrayLike<number>|null} pinned  truthy = hold still
 * @param {number} h  bucket size for the nearest-point lookup, about the spacing
 */
export function lloyd(xs, ys, rect, weightAt, res, iters, pinned, h) {
  const W = rect[2] - rect[0], H = rect[3] - rect[1];
  const nw = Math.max(1, Math.round(W * res)), nh = Math.max(1, Math.round(H * res));
  for (let it = 0; it < (iters | 0); it++) {
    const hash = new SeedHash(xs, ys, rect[0], rect[1], rect[2], rect[3], h);
    const sx = new Float64Array(xs.length), sy = new Float64Array(xs.length), sw = new Float64Array(xs.length);
    for (let j = 0; j < nh; j++) {
      const y = rect[1] + ((j + 0.5) / nh) * H;
      for (let i = 0; i < nw; i++) {
        const x = rect[0] + ((i + 0.5) / nw) * W;
        const c = hash.nearest(x, y);
        const wgt = weightAt(x, y);
        sx[c] += wgt * x; sy[c] += wgt * y; sw[c] += wgt;
      }
    }
    for (let c = 0; c < xs.length; c++) {
      if ((pinned && pinned[c]) || !(sw[c] > 0)) continue;
      xs[c] = Math.min(rect[2], Math.max(rect[0], sx[c] / sw[c]));
      ys[c] = Math.min(rect[3], Math.max(rect[1], sy[c] / sw[c]));
    }
  }
}
