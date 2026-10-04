// Contours of a scalar field: marching squares, joined into closed, consistently
// oriented loops, then simplified.
//
// The field is sampled at pixel centers (i + 0.5, j + 0.5). Everything outside
// the raster counts as far OUTSIDE, so every loop closes. "Inside" is
// field < level, and every loop keeps inside on the same side, so outer
// boundaries and the boundaries of islands within them come out with opposite
// signed areas -- which is what lets area and even-odd filling work without
// knowing which loop encloses which.

import { polyArea } from './polygon.js';

const BIG = 1e9;

/**
 * @param {Float32Array} field  w*h
 * @returns {Array<{xs:number[], ys:number[]}>} loops in pixel coordinates
 */
export function traceLoops(field, w, h, level) {
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? BIG : field[j * w + i]);
  const W2 = w + 2;
  const hKey = (i, j) => ((j + 1) * W2 + (i + 1)) * 2;       // edge (i,j)-(i+1,j)
  const vKey = (i, j) => ((j + 1) * W2 + (i + 1)) * 2 + 1;   // edge (i,j)-(i,j+1)
  const segStart = new Map();   // start edge key -> [endKey, ax, ay, bx, by]
  const pt = new Map();         // edge key -> [x, y]

  const cross = (key, xa, ya, va, xb, yb, vb) => {
    let p = pt.get(key);
    if (!p) {
      const t = (level - va) / (vb - va);
      p = [xa + t * (xb - xa), ya + t * (yb - ya)];
      pt.set(key, p);
    }
    return p;
  };

  for (let j = -1; j < h; j++) {
    for (let i = -1; i < w; i++) {
      const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];   // tl tr br bl
      const inn = v.map((x) => x < level);
      const n = inn.filter(Boolean).length;
      if (n === 0 || n === 4) continue;
      const cx = [i + 0.5, i + 1.5, i + 1.5, i + 0.5], cy = [j + 0.5, j + 0.5, j + 1.5, j + 1.5];
      // edge e runs corner e -> corner e+1: top, right, bottom, left
      const keys = [hKey(i, j), vKey(i + 1, j), hKey(i, j + 1), vKey(i, j)];
      const edgePt = (e) => {
        const a = e, b = (e + 1) & 3;
        return cross(keys[e], cx[a], cy[a], v[a], cx[b], cy[b], v[b]);
      };
      const crossed = [0, 1, 2, 3].filter((e) => inn[e] !== inn[(e + 1) & 3]);
      let pairs;
      if (crossed.length === 2) {
        pairs = [[crossed[0], crossed[1]]];
      } else {
        // saddle: the center decides which diagonal is connected; the other
        // two corners are each cut off by their own segment
        const centerIn = (v[0] + v[1] + v[2] + v[3]) / 4 < level;
        const isolate = [0, 1, 2, 3].filter((c) => inn[c] !== centerIn);
        pairs = isolate.map((c) => [(c + 3) & 3, c]);   // corner c touches edges c-1 and c
      }
      for (const [e1, e2] of pairs) {
        let A = edgePt(e1), B = edgePt(e2), ka = keys[e1], kb = keys[e2];
        // orient so inside is on the left of A -> B (cross > 0), judged by the
        // corner farthest from the segment's line
        let best = 0, sgn = 0;
        for (let c = 0; c < 4; c++) {
          const s = (B[0] - A[0]) * (cy[c] - A[1]) - (B[1] - A[1]) * (cx[c] - A[0]);
          if (Math.abs(s) > best) { best = Math.abs(s); sgn = (s > 0) === inn[c] ? 1 : -1; }
        }
        if (sgn < 0) { [A, B] = [B, A]; [ka, kb] = [kb, ka]; }
        segStart.set(ka, [kb, A[0], A[1]]);
      }
    }
  }

  const loops = [];
  for (const [start] of segStart) {
    if (!segStart.has(start)) continue;
    const xs = [], ys = [];
    let k = start;
    for (let guard = 0; guard < 1e8; guard++) {
      const s = segStart.get(k);
      if (!s) break;
      segStart.delete(k);
      xs.push(s[1]); ys.push(s[2]);
      k = s[0];
      if (k === start) break;
    }
    if (xs.length >= 3) loops.push({ xs, ys });
  }
  return loops;
}

/**
 * Douglas–Peucker on a closed loop: split at the vertex farthest from vertex 0,
 * simplify both halves to within `tol`. Marching squares on a thresholded raster
 * leaves a half-pixel staircase on every diagonal; a tolerance of about half a
 * pixel straightens it without moving a real edge.
 */
export function simplifyLoop(xs, ys, tol) {
  const n = xs.length;
  if (n <= 4) return { xs: xs.slice(), ys: ys.slice() };
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const t2 = tol * tol;
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const bi = b % n;
    const ax = xs[a], ay = ys[a], ex = xs[bi] - ax, ey = ys[bi] - ay;
    const L2 = ex * ex + ey * ey;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      let t = L2 > 0 ? ((xs[i] - ax) * ex + (ys[i] - ay) * ey) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = (ax + t * ex - xs[i]) ** 2 + (ay + t * ey - ys[i]) ** 2;
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > t2) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const ox = [], oy = [];
  for (let i = 0; i < n; i++) if (keep[i]) { ox.push(xs[i]); oy.push(ys[i]); }
  return { xs: ox, ys: oy };
}

/**
 * Move every vertex of a closed loop by distance `d` along its outward bisector,
 * outward meaning away from the loop's own interior; negative d moves inward.
 * The miter is clamped (a vertex never moves more than 2|d|), so a sharp spike
 * does not shoot off; for the small offsets this is used for -- half a kerf on
 * loops whose features are several kerfs wide -- that is a good approximation of
 * the true offset curve.
 */
export function offsetLoop(xs, ys, d) {
  const n = xs.length;
  const s = Math.sign(polyArea({ xs, ys })) || 1;
  const ox = new Float64Array(n), oy = new Float64Array(n);
  const normal = (a, b) => {            // outward unit normal of edge a -> b
    const ex = xs[b] - xs[a], ey = ys[b] - ys[a], L = Math.hypot(ex, ey) || 1;
    return [(s * ey) / L, (-s * ex) / L];
  };
  for (let i = 0; i < n; i++) {
    const [ax, ay] = normal((i - 1 + n) % n, i), [bx, by] = normal(i, (i + 1) % n);
    let mx = ax + bx, my = ay + by;
    const L = Math.hypot(mx, my);
    if (L < 1e-9) { mx = ax; my = ay; } else { mx /= L; my /= L; }
    const cosHalf = Math.max(0.5, mx * ax + my * ay);
    ox[i] = xs[i] + (mx * d) / cosHalf;
    oy[i] = ys[i] + (my * d) / cosHalf;
  }
  return { xs: ox, ys: oy };
}
