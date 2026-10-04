// The hole model every method hands to the renderer, the stats and the SVG.
//
// A hole is described by its CUT PATH -- what the beam center follows -- and the
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
import { cellCenter } from './units.js';
import { rsqPathData } from './cutpaths.js';
import { insideGrown, polyArea, polyPerimeter, pointPolyDistance } from './polygon.js';

/** The square grid's sizes as holes. */
export function gridHoles(ctx, sizes, spec) {
  const out = [];
  for (let j = 0; j < ctx.rows; j++) {
    for (let i = 0; i < ctx.cols; i++) {
      const g = cutPath(spec, sizes[j * ctx.cols + i]);
      if (!g) continue;
      const [cx, cy] = cellCenter(ctx, i, j);
      out.push({ kind: 'rsq', cx, cy, a: g.a, r: g.r, rot: g.rot });
    }
  }
  return out;
}

/**
 * Four fixed corner holes for registering stacked sheets: the same positions on
 * every exported sheet (cut layers and the solid base alike), so a pin through
 * each one after cutting holds every sheet in register. `dia` is the FINISHED
 * diameter (the cut path is a kerf smaller, as every hole's). `dist`, from each
 * edge to a center, is clamped so each hole keeps at least `web` of metal to the
 * outline and never crosses the center; a piece too small for that gets none.
 */
export function alignmentHoles(widthMm, heightMm, dist, dia, web = 0, kerf = 0) {
  const r = dia / 2, a = dia - kerf;
  if (!(r > 0) || !(a > 0)) return [];
  const dMin = r + web, dMax = Math.min(widthMm, heightMm) / 2 - r;
  if (!(dMax >= dMin)) return [];
  const d = Math.max(dMin, Math.min(dist, dMax));
  const out = [];
  for (const cx of [d, widthMm - d]) {
    for (const cy of [d, heightMm - d]) out.push({ kind: 'rsq', cx, cy, a, r: a / 2, rot: false });
  }
  return out;
}

/**
 * A pattern's holes without any whose finished outline comes within `web` of an
 * alignment hole's (both are cut paths grown by `d` = kerf/2). The pattern never
 * knew where the alignment holes would go, so this is what keeps the web, and
 * the one-piece guarantee, round them; removing holes only ever adds metal.
 * Loops are left alone: one can span most of a sheet, so the stencil and the
 * screen keep the alignment holes' surroundings metal on their own raster
 * instead (cutsheet.keepOutHoles), as they do the border.
 */
export function dropNearAlignment(holes, align, web, d) {
  if (!align.length) return holes;
  return holes.filter((h) => h.kind === 'loop' ||
    align.every((al) => finishedDistance(h, d, al.cx, al.cy) - (al.a / 2 + d) >= web - 1e-9));
}

/** Distance from (x, y) to the finished hole (cut path grown by d); negative inside. */
function finishedDistance(h, d, x, y) {
  return (h.kind === 'rsq' ? sdf(h, x - h.cx, y - h.cy) : pointPolyDistance(h, x, y)) - d;
}

/**
 * A pattern's holes with every one touching the border band removed -- a plain
 * margin `border` mm deep, kept blank all round the piece. Conservative: a hole
 * is kept only when its own FINISHED extent (holeBBox, grown by `d` = kerf/2)
 * lies entirely inside the inset rectangle, so nothing the beam actually cuts
 * ever reaches into the border, even a hole whose nominal center is just inside
 * it. `border <= 0` is a no-op (the common case, checked by the caller too).
 */
export function dropBorder(holes, widthMm, heightMm, border, d) {
  if (!(border > 0)) return holes;
  const eps = 1e-6;
  const x0 = border, y0 = border, x1 = widthMm - border, y1 = heightMm - border;
  return holes.filter((h) => {
    const [a, b, c, e] = holeBBox(h, d);
    return a >= x0 - eps && b >= y0 - eps && c <= x1 + eps && e <= y1 + eps;
  });
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
