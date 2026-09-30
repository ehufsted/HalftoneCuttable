// Hole shapes.
//
// EVERY SHAPE IS A ROUNDED SQUARE: side `a`, corner radius `r`, and either axis-
// aligned or turned 45 degrees. A circle is the case r = a/2, a diamond is a square
// turned 45 degrees. One family means one area law, one inside test, one kerf
// offset and one SVG writer, so the tone model, the renderer and the export cannot
// disagree about what a hole is.
//
// A hole is named by its NOMINAL SIZE `s`, its extent along the grid axis: the
// diameter of a circle, the side of a square, the tip-to-tip diagonal of a
// diamond. That is the quantity the web constraint is about (two neighbours along
// an axis leave `pitch - s` of metal between them), so `sMax = pitch - web` holds
// for all three shapes. Rounding only ever shrinks the true extent below `s`, so
// the constraint stays conservative.
//
// THE BEAM ROUNDS EVERY CORNER. A laser of kerf `k` cannot cut an inside corner
// sharper than radius k/2, so the FINISHED hole has r >= k/2 whatever was asked
// for. That is folded into `finished()` rather than left as a surprise at the
// cutter: the area law, and therefore the tone, is computed on the hole the
// machine will actually leave. The CUT PATH is that hole offset inward by k/2 --
// side a - k, radius r - k/2 -- which is exact for this family (the inward offset
// of a rounded square is a rounded square).

const SQRT2 = Math.SQRT2;

/**
 * @typedef {{shape:'circle'|'square'|'diamond', rounding:number, kerf:number}} ShapeSpec
 * `rounding` in [0,1] is the corner radius as a fraction of the half-side;
 * ignored for circles. `kerf` in mm.
 *
 * @typedef {{a:number, r:number, rot:boolean}} Geom  side, corner radius, turned 45°
 */

/** The finished hole for nominal size `s`, including the beam's corner rounding. */
export function finished(spec, s) {
  if (!(s > 0)) return null;
  if (spec.shape === 'circle') return { a: s, r: s / 2, rot: false };
  const rot = spec.shape === 'diamond';
  const a = rot ? s / SQRT2 : s;
  const r = Math.min(a / 2, Math.max((spec.rounding || 0) * a / 2, spec.kerf / 2));
  return { a, r, rot };
}

/** The path the beam centre follows: the finished hole offset inward by kerf/2. */
export function cutPath(spec, s) {
  const g = finished(spec, s);
  if (!g) return null;
  const a = g.a - spec.kerf;
  if (!(a > 0)) return null;
  return { a, r: Math.max(0, Math.min(a / 2, g.r - spec.kerf / 2)), rot: g.rot };
}

export const areaOf = (g) => (g ? g.a * g.a - (4 - Math.PI) * g.r * g.r : 0);
export const perimeterOf = (g) => (g ? 4 * (g.a - 2 * g.r) + 2 * Math.PI * g.r : 0);

/** Extent along a grid axis -- what neighbouring holes and the web see. */
export function extentOf(g) {
  if (!g) return 0;
  return g.rot ? g.a * SQRT2 - 2 * g.r * (SQRT2 - 1) : g.a;
}

/** Finished open area of nominal size `s`, as a fraction of a pitch-p cell. */
export const openFraction = (spec, s, p) => areaOf(finished(spec, s)) / (p * p);

/** Largest nominal size a cell can hold and still leave `web` to each neighbour. */
export const maxSize = (p, web) => Math.max(0, p - web);

/**
 * Smallest nominal size worth cutting: the user's floor, raised if the kerf
 * would leave the beam no path. The cut path must keep at least half a kerf of
 * side, or the "hole" is a pierce that burns out to an unpredictable size.
 */
export function floorSize(spec, hMin) {
  const kerfFloor = 1.5 * spec.kerf * (spec.shape === 'diamond' ? SQRT2 : 1);
  return Math.max(hMin, kerfFloor);
}

/**
 * Inverse of openFraction: the nominal size whose open fraction is `f`, within
 * [0, sMax]. Bisection, because with the kerf's corner floor the law is piecewise
 * (r = k/2 below one size, proportional above it) and a closed form per piece is
 * more code than it is worth. It is monotone in s, which is all bisection needs.
 */
export function sizeFor(spec, f, p, sMax) {
  if (!(f > 0)) return 0;
  if (f >= openFraction(spec, sMax, p)) return sMax;
  let lo = 0, hi = sMax;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (openFraction(spec, mid, p) < f) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * The rounded square's cut path as 8 key points, in LOCAL coordinates centred
 * on the hole (before rotation and translation): straight edge, corner, straight
 * edge, corner..., clockwise from the top edge. A point that starts an arc (to
 * the next point, wrapping at the end) carries that arc's centre as `cx`/`cy`;
 * a point without one is reached by a straight line. cutpaths.js (SVG) and
 * dxf.js (DXF) each rotate, translate and format these the same way for a
 * diamond; this is the one place the layout itself lives.
 * Only meaningful for r < h -- callers draw a circle instead when r >= h.
 * @returns {Array<{x:number, y:number, cx?:number, cy?:number}>}
 */
export function rsqCorners(g) {
  const h = g.a / 2, r = g.r, q = h - r;
  const P = [[-q, -h], [q, -h], [h, -q], [h, q], [q, h], [-q, h], [-h, q], [-h, -q]];
  const C = [[q, -q], [q, q], [-q, q], [-q, -q]];
  return P.map(([x, y], i) => {
    if (i % 2 === 0) return { x, y };
    const [cx, cy] = C[(i - 1) / 2];
    return { x, y, cx, cy };
  });
}

/**
 * Signed distance from (x, y), relative to the hole centre, to the boundary of
 * geometry g. Negative inside. The standard rounded-box distance.
 */
export function sdf(g, x, y) {
  if (g.rot) {
    const u = (x + y) / SQRT2, v = (y - x) / SQRT2;
    x = u; y = v;
  }
  const h = g.a / 2 - g.r;
  const qx = Math.abs(x) - h, qy = Math.abs(y) - h;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - g.r;
}
