// The hole model every method hands to the renderer, the stats and the SVG.
//
// A hole is described by its CUT PATH -- what the beam centre follows -- and the
// finished hole is that path grown by kerf/2 (the beam's radius). Three kinds:
//
//   {kind:'rsq', cx, cy, a, r, rot}  rounded square (circle when r = a/2;
//                                     diamond when rot), the square grid's
//   {kind:'poly', xs, ys}             convex polygon, sharp corners, the
//                                     Voronoi web's
//   {kind:'loop', xs, ys, sign, fx, fy}  any closed outline, the stencil's; fx/fy
//                                     is the finished outline, carried along. A
//                                     sheet's loops are read TOGETHER, even-odd:
//                                     an island inside a cut region is a loop of
//                                     opposite orientation. sign * signed area is
//                                     positive for the outside of a cut region,
//                                     negative for an island inside one.
//
// Growing by a disc is exact for the first two: a rounded square grows into a rounded
// square, and a convex polygon grows into one with arcs of radius kerf/2 at its
// corners, whose area is area + perimeter·d + π·d² (Steiner). So the area the
// tone model counted, the pixels the preview paints and the path the SVG writes
// all describe the same hole. For a general loop Steiner is exact only where it
// turns one way; its concave corners make it an approximation of order d², and
// the stencil scores from a raster instead (methods/stencil.js).

import { cutPath, sdf, areaOf, perimeterOf } from './shapes.js';
import { cellCentre } from './units.js';
import { rsqPathData } from './cutpaths.js';
import { insideGrown, polyArea, polyPerimeter } from './polygon.js';

/** The square grid's sizes as holes. */
export function gridHoles(ctx, sizes, spec) {
  const out = [];
  for (let j = 0; j < ctx.rows; j++) {
    for (let i = 0; i < ctx.cols; i++) {
      const g = cutPath(spec, sizes[j * ctx.cols + i]);
      if (!g) continue;
      const [cx, cy] = cellCentre(ctx, i, j);
      out.push({ kind: 'rsq', cx, cy, a: g.a, r: g.r, rot: g.rot });
    }
  }
  return out;
}

/** A polygon (from polygon.js) as a hole. */
export const polyHole = (P) => ({ kind: 'poly', xs: Float64Array.from(P.xs), ys: Float64Array.from(P.ys) });

/** Bounding box of the finished hole. */
export function holeBBox(h, d) {
  if (h.kind === 'rsq') {
    const e = (h.rot ? (h.a / 2 - h.r) * Math.SQRT2 + h.r : h.a / 2) + d;
    return [h.cx - e, h.cy - e, h.cx + e, h.cy + e];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < h.xs.length; i++) {
    x0 = Math.min(x0, h.xs[i]); x1 = Math.max(x1, h.xs[i]);
    y0 = Math.min(y0, h.ys[i]); y1 = Math.max(y1, h.ys[i]);
  }
  return [x0 - d, y0 - d, x1 + d, y1 + d];
}

/** Is (x, y) inside the finished hole (cut path grown by d)? */
export function insideFinished(h, d, x, y) {
  if (h.kind === 'rsq') return sdf(h, x - h.cx, y - h.cy) <= d;
  if (h.kind === 'loop') throw new Error('loops are filled per sheet, even-odd (render.rasterizeHoles)');
  return insideGrown(h, d, x, y);
}

export const holePerimeter = (h) => (h.kind === 'rsq' ? perimeterOf(h) : polyPerimeter(h));

/**
 * Finished area: the cut path grown by d. A loop contributes signed: an island's
 * loop takes area away, and growing the cut SHRINKS the island, hence P·d added
 * either way and π·d² with the loop's own sign.
 */
export function holeFinishedArea(h, d) {
  if (h.kind === 'loop') {
    if (h.fx) return h.sign * polyArea({ xs: h.fx, ys: h.fy });
    const a = h.sign * polyArea(h);
    return a + holePerimeter(h) * d + Math.sign(a) * Math.PI * d * d;
  }
  const A = h.kind === 'rsq' ? areaOf(h) : polyArea(h);
  return A + holePerimeter(h) * d + Math.PI * d * d;
}

/** SVG path data for the cut path, shifted by (ox, oy). */
export function holePathData(h, fmt, ox = 0, oy = 0) {
  if (h.kind === 'rsq') return rsqPathData(h.cx + ox, h.cy + oy, h, fmt);
  let d = '';
  for (let i = 0; i < h.xs.length; i++) d += `${i ? 'L' : 'M'}${fmt(h.xs[i] + ox)},${fmt(h.ys[i] + oy)}`;
  return d + 'Z';
}

/** Is this hole a circle (so the SVG can say <circle>)? */
export const isCircle = (h) => h.kind === 'rsq' && h.r >= h.a / 2 - 1e-9;
