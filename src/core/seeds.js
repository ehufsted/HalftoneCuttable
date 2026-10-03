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
import { hilbertIndex, pow2At } from './hilbert.js';

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
  const rand = mulberry32(o.seed | 0);
  const step = 0.4 * sMin;
  const cand = [];
  for (let y = rect[1] + step / 2; y < rect[3]; y += step) {
    for (let x = rect[0] + step / 2; x < rect[2]; x += step) {
      cand.push([Math.min(rect[2], x + (rand() - 0.5) * step), Math.min(rect[3], y + (rand() - 0.5) * step)]);
    }
  }
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  for (const [x, y] of cand) {
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

/**
 * Tone-weighted point placement, shared by Stipple and anything else that
 * wants "N points distributed like a density field, never closer than a
 * minimum spacing": a stratified sample along a Hilbert curve (right count
 * per region, well spread to start), weighted Lloyd relaxation at density
 * `rho` (weight rho², since Lloyd settles at weight^(1/2)), then a spacing
 * repair that pushes apart and, failing that, drops whatever is still too
 * close. Extracted from `methods/stipple.js` verbatim -- behavior-preserving,
 * checked against `tests/method.stipple.js`.
 *
 * @param {Float64Array|Float32Array} rho  density per work-pixel (row-major, ww×wh)
 * @param {number} ww, wh    work-raster size
 * @param {number} kx, ky    work-pixels per mm (so x_mm * kx = x_px)
 * @param {number[]} rect    x0,y0,x1,y1 in mm: points stay inside
 * @param {number} sMin      minimum center-to-center spacing, mm
 * @param {number} relaxIters
 * @param {() => number} rand  seeded RNG (mulberry32); call order matters
 * @param {number} [maxPoints] throws if the exact count exceeds this
 * @returns {{xs:Float64Array, ys:Float64Array, removed:number, N0:number, pixOf:(x,y)=>number}}
 */
export function placeWeightedPoints(rho, ww, wh, kx, ky, rect, sMin, relaxIters, rand, maxPoints = Infinity) {
  const NP = ww * wh, pixA = 1 / (kx * ky);
  const pixOf = (x, y) => Math.min(wh - 1, Math.max(0, Math.floor(y * ky))) * ww +
    Math.min(ww - 1, Math.max(0, Math.floor(x * kx)));

  let M = 0;
  for (let q = 0; q < NP; q++) M += rho[q] * pixA;
  const N0 = Math.round(M);
  if (N0 > maxPoints) throw new Error(`${N0} points is too many`);
  const n2 = pow2At(Math.max(ww, wh));
  const key = new Float64Array(NP);
  for (let j = 0; j < wh; j++) for (let i = 0; i < ww; i++) key[j * ww + i] = hilbertIndex(n2, i, j);
  const order = Array.from({ length: NP }, (_, q) => q).sort((a, b) => key[a] - key[b]);
  let xs = new Float64Array(N0), ys = new Float64Array(N0);
  {
    let acc = 0, k = 0, next = N0 > 0 ? (rand() * M) / N0 : Infinity;
    for (const q of order) {
      acc += rho[q] * pixA;
      while (k < N0 && next <= acc) {
        const i = q % ww, j = (q - i) / ww;
        xs[k] = Math.min(rect[2], Math.max(rect[0], (i + rand()) / kx));
        ys[k] = Math.min(rect[3], Math.max(rect[1], (j + rand()) / ky));
        k++;
        next = ((k + rand()) * M) / N0;
      }
    }
    for (; k < N0; k++) { xs[k] = (rect[0] + rect[2]) / 2; ys[k] = (rect[1] + rect[3]) / 2; }   // rounding stragglers
  }

  lloyd(xs, ys, rect, (x, y) => rho[pixOf(x, y)] ** 2, 6 / sMin, relaxIters, null, 2 * sMin);

  const spaced = enforceSpacing(xs, ys, rect, sMin, rand);
  return { xs: spaced.xs, ys: spaced.ys, removed: spaced.removed, N0, pixOf };
}

/**
 * Push apart every pair of points closer than sMin, then drop what still will
 * not separate. Greedy in index order: pairs are visited as (i, j > i) with i
 * ascending, so drop[i] is final by the time i's pairs come up, and a kept i
 * drops every j that crowds it. No two survivors end up closer than sMin.
 * @returns {{xs:Float64Array, ys:Float64Array, removed:number}}
 */
export function enforceSpacing(xs, ys, rect, sMin, rand) {
  const tooClose = (fn) => {
    const hash = new SeedHash(xs, ys, rect[0], rect[1], rect[2], rect[3], sMin);
    for (let i = 0; i < xs.length; i++) {
      const [ix, iy] = hash.bucketOf(xs[i], ys[i]);
      for (let r = 0; r <= 1; r++) {
        hash.ring(ix, iy, r, (j) => {
          if (j <= i) return;
          const dx = xs[j] - xs[i], dy = ys[j] - ys[i];
          const dist = Math.hypot(dx, dy);
          if (dist < sMin - 1e-9) fn(i, j, dx, dy, dist);
        });
      }
    }
  };
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    tooClose((i, j, dx, dy, dist) => {
      moved = true;
      if (dist < 1e-12) { const a = rand() * 2 * Math.PI; dx = Math.cos(a); dy = Math.sin(a); dist = 1; }
      const push = (sMin - Math.hypot(xs[j] - xs[i], ys[j] - ys[i])) / 2 + 1e-6;
      if (push <= 0) return;
      const ux = dx / dist, uy = dy / dist;
      xs[i] = Math.min(rect[2], Math.max(rect[0], xs[i] - ux * push));
      ys[i] = Math.min(rect[3], Math.max(rect[1], ys[i] - uy * push));
      xs[j] = Math.min(rect[2], Math.max(rect[0], xs[j] + ux * push));
      ys[j] = Math.min(rect[3], Math.max(rect[1], ys[j] + uy * push));
    });
    if (!moved) break;
  }
  const drop = new Uint8Array(xs.length);
  tooClose((i, j) => { if (!drop[i]) drop[j] = 1; });
  const keep = [];
  for (let i = 0; i < xs.length; i++) if (!drop[i]) keep.push(i);
  return {
    xs: Float64Array.from(keep, (i) => xs[i]),
    ys: Float64Array.from(keep, (i) => ys[i]),
    removed: xs.length - keep.length,
  };
}

/**
 * Which sheet each of N discrete points (dots, vein nodes, ...) shows in color
 * mode: walk them in Hilbert order and pay each sheet the share of it (its own
 * target mix fraction at that point) it is owed, via 1-D error diffusion along
 * the curve -- spreads each color evenly instead of clumping. Extracted from
 * `methods/stipple.js`'s original `assignSheets`, which now calls this.
 *
 * @param {number} N
 * @param {number} n  palette size (sheet 0 is the base/no-color point)
 * @param {(i:number, out:Float64Array) => void} mixAt  fills out[0..n-1] with point i's target mix
 * @param {(i:number) => number} hilbertKeyOf
 * @returns {Uint8Array} lab[i] = sheet index point i shows (>= 1)
 */
export function assignSheetsByMix(N, n, mixAt, hilbertKeyOf) {
  const lab = new Uint8Array(N).fill(1);
  if (n <= 2) return lab;    // only one non-base sheet: nothing to choose between
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => hilbertKeyOf(a) - hilbertKeyOf(b));
  const debt = new Float64Array(n), m = new Float64Array(n);
  for (const i of order) {
    mixAt(i, m);
    let tot = 0;
    for (let l = 1; l < n; l++) tot += m[l];
    if (tot > 0) for (let l = 1; l < n; l++) debt[l] += m[l] / tot;
    let best = 1;
    for (let l = 2; l < n; l++) if (debt[l] > debt[best]) best = l;
    lab[i] = best;
    debt[best] -= 1;
  }
  return lab;
}
