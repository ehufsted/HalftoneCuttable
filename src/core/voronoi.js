// Voronoi cells, by clipping.
//
// Each cell starts as the clip rectangle and is cut by the perpendicular bisector
// towards each nearby seed. That is slower than Fortune's sweep or a Delaunay
// dual, but it is short, exact for this purpose, labels every edge with the
// neighbor across it for free, and has no degenerate cases to get wrong beyond
// coincident seeds (skipped: the placer never makes them).
//
// Nearby seeds come from a bucket grid, visited in square rings. A seed in ring
// r+1 is at least r·h away, and it can only cut the cell if it is closer than
// twice the cell's current radius -- so once r·h passes that, the cell is final.

import { rectPoly, clipHalfPlane } from './polygon.js';

/** Seeds bucketed on a square grid of side h over [x0, x1] × [y0, y1]. */
export class SeedHash {
  constructor(xs, ys, x0, y0, x1, y1, h) {
    this.xs = xs; this.ys = ys;
    this.x0 = x0; this.y0 = y0; this.h = h;
    this.gw = Math.max(1, Math.ceil((x1 - x0) / h));
    this.gh = Math.max(1, Math.ceil((y1 - y0) / h));
    const nb = this.gw * this.gh;
    const count = new Int32Array(nb + 1);
    const cellOf = new Int32Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      const [ix, iy] = this.bucketOf(xs[i], ys[i]);
      cellOf[i] = iy * this.gw + ix;
      count[cellOf[i] + 1]++;
    }
    for (let b = 0; b < nb; b++) count[b + 1] += count[b];
    this.start = count;
    this.items = new Int32Array(xs.length);
    const fill = count.slice(0, nb);
    for (let i = 0; i < xs.length; i++) this.items[fill[cellOf[i]]++] = i;
  }

  bucketOf(x, y) {
    const ix = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.x0) / this.h)));
    const iy = Math.min(this.gh - 1, Math.max(0, Math.floor((y - this.y0) / this.h)));
    return [ix, iy];
  }

  /** Call fn(seed) for every seed in the buckets at Chebyshev ring r; false if the ring is off the grid. */
  ring(ix, iy, r, fn) {
    let any = false;
    for (let by = iy - r; by <= iy + r; by++) {
      if (by < 0 || by >= this.gh) continue;
      const edgeRow = by === iy - r || by === iy + r;
      for (let bx = ix - r; bx <= ix + r; bx += edgeRow ? 1 : 2 * r) {
        if (bx >= 0 && bx < this.gw) {
          any = true;
          const b = by * this.gw + bx;
          for (let k = this.start[b]; k < this.start[b + 1]; k++) fn(this.items[k]);
        }
        if (r === 0) break;
      }
    }
    return any || r === 0;
  }

  /** Index of the nearest seed to (x, y). */
  nearest(x, y) {
    const [ix, iy] = this.bucketOf(x, y);
    let best = -1, bd = Infinity;
    const { xs, ys } = this;
    for (let r = 0; ; r++) {
      const inside = this.ring(ix, iy, r, (j) => {
        const d = (xs[j] - x) ** 2 + (ys[j] - y) ** 2;
        if (d < bd || (d === bd && j < best)) { bd = d; best = j; }
      });
      if (best >= 0 && Math.sqrt(bd) <= r * this.h) break;
      if (!inside && r > this.gw + this.gh) break;
    }
    return best;
  }
}

/**
 * @param {ArrayLike<number>} xs, ys  seeds, all inside `rect`
 * @param {[number,number,number,number]} rect  x0, y0, x1, y1
 * @param {SeedHash} hash  over the same seeds
 * @returns {Array<{xs:number[], ys:number[], lab:number[]}|null>}
 *   cell i, edges labeled with the neighboring seed or -1 on the rectangle
 */
export function voronoiCells(xs, ys, rect, hash) {
  const cells = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const sx = xs[i], sy = ys[i];
    let P = rectPoly(rect[0], rect[1], rect[2], rect[3]);
    const [ix, iy] = hash.bucketOf(sx, sy);
    for (let r = 0; P; r++) {
      const inside = hash.ring(ix, iy, r, (j) => {
        if (j === i || !P) return;
        const dx = xs[j] - sx, dy = ys[j] - sy;
        if (dx * dx + dy * dy < 1e-18) return;
        const mx = (xs[j] + sx) / 2, my = (ys[j] + sy) / 2;
        P = clipHalfPlane(P, dx, dy, dx * mx + dy * my, j);
      });
      if (!P) break;
      let R2 = 0;
      for (let k = 0; k < P.xs.length; k++) R2 = Math.max(R2, (P.xs[k] - sx) ** 2 + (P.ys[k] - sy) ** 2);
      if (r * hash.h > 2 * Math.sqrt(R2)) break;
      if (!inside && r > hash.gw + hash.gh) break;
    }
    cells[i] = P;
  }
  return cells;
}
