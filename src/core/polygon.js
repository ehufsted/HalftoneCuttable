// Convex polygons: the Voronoi web's cells and holes.
//
// A polygon is {xs, ys, lab}: vertices in order with POSITIVE shoelace area (in
// these y-down piece coordinates that is clockwise on screen), and lab[k] the
// label of edge k (vertex k -> k+1). For a Voronoi cell the label is the
// neighboring seed across that edge, or -1 on the piece boundary, and it
// survives every clip and inset -- which is how a hole knows which of its edges
// face an image edge and so need a thicker web.
//
// With positive area the INWARD normal of edge a -> b is the left normal
// (-ey, ex)/|e|. Everything here depends on that orientation.
//
// Why convex polygons are enough: a Voronoi cell is an intersection of half-
// planes, and so is every inset of one (each edge moved inward by its own
// offset). So one operation -- clip by a half-plane -- builds the cells, insets
// them for the web, and insets again for the kerf, all exactly.

/** Axis-aligned rectangle, every edge labeled -1 (the piece boundary). */
export function rectPoly(x0, y0, x1, y1) {
  return { xs: [x0, x1, x1, x0], ys: [y0, y0, y1, y1], lab: [-1, -1, -1, -1] };
}

export function polyArea(P) {
  const { xs, ys } = P, n = xs.length;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return a / 2;
}

export function polyPerimeter(P) {
  const { xs, ys } = P, n = xs.length;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    L += Math.hypot(xs[j] - xs[i], ys[j] - ys[i]);
  }
  return L;
}

/**
 * Keep the part of P with nx*x + ny*y <= c. The new edge along the cut line gets
 * `label`; surviving parts of old edges keep theirs. Returns null if nothing
 * with area is left.
 */
export function clipHalfPlane(P, nx, ny, c, label) {
  const { xs, ys, lab } = P, n = xs.length;
  const ox = [], oy = [], ol = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const ax = xs[i], ay = ys[i], bx = xs[j], by = ys[j];
    const da = nx * ax + ny * ay - c, db = nx * bx + ny * by - c;
    const ain = da <= 0, bin = db <= 0;
    if (ain) { ox.push(ax); oy.push(ay); ol.push(lab[i]); }
    if (ain !== bin) {
      const t = da / (da - db);
      ox.push(ax + t * (bx - ax)); oy.push(ay + t * (by - ay));
      // leaving: the cut edge starts here; entering: the old edge resumes
      ol.push(ain ? label : lab[i]);
    }
  }
  return tidy(ox, oy, ol);
}

/**
 * Drop zero-length edges (a vertex exactly on a cut line produces one), keeping
 * the later vertex so the label of the edge that actually follows survives. A
 * zero-length edge has no normal, and inset would divide by its length.
 */
function tidy(xs, ys, lab) {
  let n = xs.length;
  if (n < 3) return null;
  const keep = [];
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    if (Math.abs(xs[j] - xs[i]) + Math.abs(ys[j] - ys[i]) > 1e-10) keep.push(i);
  }
  if (keep.length < 3) return null;
  const P = { xs: keep.map((i) => xs[i]), ys: keep.map((i) => ys[i]), lab: keep.map((i) => lab[i]) };
  // A duplicate removed at i means edge i-1 now runs to i+1, but the label that
  // belongs to that span is the one on the kept vertex before it -- which is
  // what keep[] preserved. Only area is left to check.
  return polyArea(P) > 1e-12 ? P : null;
}

/**
 * Move every edge k inward by offset[k] and return what is left: the
 * intersection of the shifted half-planes, which is exact for a convex polygon.
 * Edge labels carry over. null if the offsets meet in the middle.
 */
export function insetConvex(P, offsets) {
  const { xs, ys, lab } = P, n = xs.length;
  let Q = P;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    const ex = xs[j] - xs[k], ey = ys[j] - ys[k];
    const L = Math.hypot(ex, ey);
    if (L < 1e-12) continue;
    const nx = -ey / L, ny = ex / L;                 // inward
    // keep n·(p - a) >= o   <=>   (-n)·p <= -(n·a + o)
    Q = clipHalfPlane(Q, -nx, -ny, -(nx * xs[k] + ny * ys[k]) - offsets[k], lab[k]);
    if (!Q) return null;
  }
  return Q;
}

/**
 * The polygon's width: the least distance between two parallel lines that hold
 * it. For a convex polygon one of those lines lies along an edge, so it is the
 * minimum over edges of the farthest vertex from that edge. The smallest finished
 * hole is judged by this, since a long thin sliver can have a fair area and still
 * be too narrow to cut.
 */
export function minWidth(P) {
  const { xs, ys } = P, n = xs.length;
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    const ex = xs[j] - xs[k], ey = ys[j] - ys[k];
    const L = Math.hypot(ex, ey);
    if (L < 1e-12) continue;
    const nx = -ey / L, ny = ex / L;
    let far = 0;
    for (let i = 0; i < n; i++) far = Math.max(far, nx * (xs[i] - xs[k]) + ny * (ys[i] - ys[k]));
    best = Math.min(best, far);
  }
  return best;
}

/** Area of P grown by a disc of radius d (Steiner): what the beam leaves. */
export const grownArea = (P, d) => (P ? polyArea(P) + polyPerimeter(P) * d + Math.PI * d * d : 0);

function segDist2(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const L2 = ex * ex + ey * ey;
  let t = L2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + t * ex - px, dy = ay + t * ey - py;
  return dx * dx + dy * dy;
}

/** Is (x, y) inside P grown by d? */
export function insideGrown(P, d, x, y) {
  const { xs, ys } = P, n = xs.length;
  let out = -Infinity;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    const ex = xs[j] - xs[k], ey = ys[j] - ys[k];
    const L = Math.hypot(ex, ey);
    // outward distance from edge k's line
    const s = (ey * (x - xs[k]) - ex * (y - ys[k])) / L;
    if (s > out) out = s;
  }
  if (out <= 0) return true;
  if (out > d) return false;
  const d2 = d * d;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    if (segDist2(x, y, xs[k], ys[k], xs[j], ys[j]) <= d2) return true;
  }
  return false;
}

/** Distance from (x, y) to convex polygon P: 0 inside it, else to its nearest edge. */
export function pointPolyDistance(P, x, y) {
  if (insideGrown(P, 0, x, y)) return 0;
  const { xs, ys } = P, n = xs.length;
  let d2 = Infinity;
  for (let k = 0; k < n; k++) {
    const j = k + 1 === n ? 0 : k + 1;
    d2 = Math.min(d2, segDist2(x, y, xs[k], ys[k], xs[j], ys[j]));
  }
  return Math.sqrt(d2);
}

/** Distance between two disjoint convex polygons: the closest vertex-edge pair. */
export function polyDistance(A, B) {
  let d2 = Infinity;
  for (const [P, Q] of [[A, B], [B, A]]) {
    const n = Q.xs.length;
    for (let i = 0; i < P.xs.length; i++) {
      for (let k = 0; k < n; k++) {
        const j = k + 1 === n ? 0 : k + 1;
        d2 = Math.min(d2, segDist2(P.xs[i], P.ys[i], Q.xs[k], Q.ys[k], Q.xs[j], Q.ys[j]));
      }
    }
  }
  return Math.sqrt(d2);
}
