// Cut geometry shared by every hole kind: the piece outline, and the path of a
// rounded square.
//
// Holes are offset INWARD by kerf/2 so the finished hole is the size the tone
// model asked for (see shapes.js and polygon.js). The piece outline is offset
// OUTWARD by kerf/2 so the finished piece is the size the user set.

import { rsqCorners } from './shapes.js';

/** The outline's cut path: the piece rectangle grown by kerf/2. */
export function outline(piece) {
  const o = piece.kerf / 2;
  return { x: -o, y: -o, w: piece.widthMm + 2 * o, h: piece.heightMm + 2 * o };
}

/**
 * A rounded square's cut path as SVG path data, clockwise from the top edge.
 * Straight edges, then quarter-arcs; a sharp corner (r = 0) omits its arc.
 * Turned 45° for a diamond by rotating the key points -- arcs are circular, so a
 * rotated arc is the same arc with rotated endpoints.
 */
export function rsqPathData(cx, cy, g, fmt) {
  const h = g.a / 2, r = g.r;
  const c = g.rot ? Math.SQRT1_2 : 1, s = g.rot ? Math.SQRT1_2 : 0;
  const P = (x, y) => `${fmt(cx + c * x - s * y)},${fmt(cy + s * x + c * y)}`;
  if (r >= h - 1e-9) {
    // a circle: two half-arcs
    return `M${P(-h, 0)}A${fmt(h)},${fmt(h)} 0 1 1 ${P(h, 0)}A${fmt(h)},${fmt(h)} 0 1 1 ${P(-h, 0)}Z`;
  }
  const pts = rsqCorners(g);
  let d = `M${P(pts[0].x, pts[0].y)}`;
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    d += pts[i].cx !== undefined
      ? (r > 0 ? `A${fmt(r)},${fmt(r)} 0 0 1 ${P(next.x, next.y)}` : '')
      : `L${P(next.x, next.y)}`;
  }
  return d + 'Z';
}
