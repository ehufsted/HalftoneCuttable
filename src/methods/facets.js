// Facets: the low-poly triangles cut as holes, leaving a triangular web of metal.
//
// The same engine as the Voronoi web (methods/cellWeb.js) -- per-facet tone by
// the inset margin, edges as clean breaks or metal lines, mixed or solid color
// regions, error diffusion, the web guarantee -- with a different LAYOUT: Delaunay
// triangles over corners placed like the low-poly style's (core/lowpoly.js):
//
//   - the four corners and a ring along the border, so the facets tile the piece
//   - corners ON the image's edges (and color-region boundaries), pinned, so the
//     triangle sides follow them: an edge is a crease between facets. (The
//     Voronoi web pins seeds in PAIRS ACROSS an edge, to put a wall between them;
//     for triangles the wall is the side joining two corners on the edge.)
//   - a variable-spacing fill by detail, then Lloyd relaxation of the free corners
//
// A side is an EDGE WALL -- it gets the extra metal of Metal lines -- when both its
// corners are on an edge, their edge normals agree, and the side runs along the
// edge rather than across it.
//
// Triangles hold less hole than Voronoi cells of the same size: a triangle's
// inscribed circle is about 0.29 × its side, a hexagon's 0.43. So the facet size
// defaults larger than the Voronoi web's cell size, and small facets in detailed
// areas go without a hole sooner (they are metal: dark).

import { mulberry32 } from '../shim/random.js';
import { lloyd } from '../core/seeds.js';
import { triangulate } from '../core/delaunay.js';
import { buildCellWeb } from './cellWeb.js';
import { params as voronoiParams } from './voronoiWeb.js';

export const id = 'facets';
export const label = 'Facets';
export const blurb = 'Low-poly triangles cut as holes, leaving a faceted web of metal. Facets shrink where the image is busy, and their sides follow its edges. Facet size is the size where the image is flat.';

/** The Voronoi web's controls, with the size relabeled and defaulting larger. */
export const params = voronoiParams.map((p) => (p.key === 'pitch' ? { ...p, label: 'Facet size', def: 6 } : p));
const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
const MAX_CORNERS = 15000;          // Delaunay here is quadratic: ~3 s at the cap

export function facetLayout(c) {
  const { rect, spacingAt, sMin, sMax, feats, P, ww, wh, kx, ky } = c;
  const [x0, y0, x1, y1] = rect;
  const xs = [], ys = [], pinned = [], onEdge = [], nxs = [], nys = [];
  const cs = Math.max(1e-3, 0.7 * sMin);
  const gw = Math.ceil((x1 - x0) / cs) + 1, gh = Math.ceil((y1 - y0) / cs) + 1;
  const buckets = Array.from({ length: gw * gh }, () => []);
  const bx = (x) => Math.min(gw - 1, Math.max(0, Math.floor((x - x0) / cs)));
  const by = (y) => Math.min(gh - 1, Math.max(0, Math.floor((y - y0) / cs)));
  const put = (x, y, pin, edge = 0, nx = 0, ny = 0) => {
    buckets[by(y) * gw + bx(x)].push(xs.length);
    xs.push(x); ys.push(y); pinned.push(pin); onEdge.push(edge); nxs.push(nx); nys.push(ny);
  };
  const clear = (x, y, r) => {
    const k = Math.ceil(r / cs), cx = bx(x), cy = by(y);
    for (let j = Math.max(0, cy - k); j <= Math.min(gh - 1, cy + k); j++) {
      for (let i = Math.max(0, cx - k); i <= Math.min(gw - 1, cx + k); i++) {
        for (const q of buckets[j * gw + i]) if ((xs[q] - x) ** 2 + (ys[q] - y) ** 2 < r * r) return false;
      }
    }
    return true;
  };

  // corners, and a ring along each side at the local spacing
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) put(x, y, 1);
  const side = (ax, ay, bx2, by2) => {
    const len = Math.hypot(bx2 - ax, by2 - ay);
    let t = 0;
    for (;;) {
      const x = ax + ((bx2 - ax) * t) / len, y = ay + ((by2 - ay) * t) / len;
      t += 0.9 * spacingAt(x, y);
      if (t > len - 0.45 * spacingAt(x, y)) break;
      put(ax + ((bx2 - ax) * t) / len, ay + ((by2 - ay) * t) / len, 1);
    }
  };
  side(x0, y0, x1, y0); side(x1, y0, x1, y1); side(x1, y1, x0, y1); side(x0, y1, x0, y0);

  // corners on the edges, strongest first (region boundaries come first: s = Infinity)
  let edgeCorners = 0;
  const order = feats.map((_, i) => i).sort((a, b) => feats[b].s - feats[a].s);
  for (const i of order) {
    const e = feats[i];
    const s = spacingAt(e.x, e.y);
    if (e.x < x0 + 0.3 * s || e.x > x1 - 0.3 * s || e.y < y0 + 0.3 * s || e.y > y1 - 0.3 * s) continue;
    if (!clear(e.x, e.y, 0.6 * s)) continue;
    put(e.x, e.y, 1, 1, e.nx, e.ny);
    edgeCorners++;
  }

  // the fill, in seeded random order
  const rand = mulberry32(P.seed | 0);
  const step = 0.4 * sMin, cand = [];
  for (let y = y0 + step / 2; y < y1; y += step) {
    for (let x = x0 + step / 2; x < x1; x += step) cand.push([x + (rand() - 0.5) * step, y + (rand() - 0.5) * step]);
  }
  for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  for (const [x, y] of cand) {
    if (x <= x0 || y <= y0 || x >= x1 || y >= y1) continue;
    if (clear(x, y, 0.85 * spacingAt(x, y))) put(x, y, 0);
  }
  if (xs.length > MAX_CORNERS) throw new Error(`${xs.length} facet corners is too many — raise the facet size or lower Detail refine`);
  const X = Float64Array.from(xs), Y = Float64Array.from(ys);
  lloyd(X, Y, rect, (x, y) => (sMax / spacingAt(x, y)) ** 4, 3 / sMin, P.relax, pinned, sMax);

  // the facets
  const { tris, nbr, n, dropped, malformed } = triangulate(X, Y);
  const cells = [], sx = new Float64Array(n), sy = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], cc = tris[3 * t + 2];
    // edge k runs vertex k -> k+1; its neighbor is the triangle opposite vertex k+2
    cells.push({ xs: [X[a], X[b], X[cc]], ys: [Y[a], Y[b], Y[cc]], lab: [nbr[3 * t + 2], nbr[3 * t], nbr[3 * t + 1]] });
    sx[t] = (X[a] + X[b] + X[cc]) / 3; sy[t] = (Y[a] + Y[b] + Y[cc]) / 3;
  }

  // which facet owns each work pixel (pixels in the border band take the facet at
  // the nearest point of the rectangle, whose ring of corners it touches)
  const owner = new Int32Array(ww * wh).fill(-1);
  for (let t = 0; t < n; t++) {
    const C = cells[t];
    const ax = C.xs[0] * kx, ay = C.ys[0] * ky, bxp = C.xs[1] * kx, byp = C.ys[1] * ky, cx = C.xs[2] * kx, cy = C.ys[2] * ky;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bxp, cx) - 0.5)), i1 = Math.min(ww - 1, Math.ceil(Math.max(ax, bxp, cx)));
    const j0 = Math.max(0, Math.floor(Math.min(ay, byp, cy) - 0.5)), j1 = Math.min(wh - 1, Math.ceil(Math.max(ay, byp, cy)));
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const pxx = i + 0.5;
        if ((bxp - ax) * (py - ay) - (byp - ay) * (pxx - ax) >= -1e-9 &&
          (cx - bxp) * (py - byp) - (cy - byp) * (pxx - bxp) >= -1e-9 &&
          (ax - cx) * (py - cy) - (ay - cy) * (pxx - cx) >= -1e-9) owner[j * ww + i] = t;
      }
    }
  }
  const ownerAt = (xm, ym) => {
    const x = Math.min(x1, Math.max(x0, xm)), y = Math.min(y1, Math.max(y0, ym));
    const i = Math.min(ww - 1, Math.max(0, Math.floor(x * kx))), j = Math.min(wh - 1, Math.max(0, Math.floor(y * ky)));
    if (owner[j * ww + i] >= 0) return owner[j * ww + i];
    for (let r = 1; r < 4; r++) {                      // a pixel on a seam: a neighbor's facet
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const q = Math.min(wh - 1, Math.max(0, j + dj)) * ww + Math.min(ww - 1, Math.max(0, i + di));
        if (owner[q] >= 0) return owner[q];
      }
    }
    return 0;
  };

  const isLine = (t, q, k) => {
    const va = tris[3 * t + k], vb = tris[3 * t + ((k + 1) % 3)];
    if (!onEdge[va] || !onEdge[vb]) return false;
    const agree = nxs[va] * nxs[vb] + nys[va] * nys[vb];
    if (Math.abs(agree) < 0.7) return false;
    const dx = X[vb] - X[va], dy = Y[vb] - Y[va], L = Math.hypot(dx, dy);
    if (L > 1.6 * Math.max(spacingAt(X[va], Y[va]), spacingAt(X[vb], Y[vb]))) return false;
    return Math.abs((dx * nxs[va] + dy * nys[va]) / L) < 0.5;      // runs along the edge
  };

  const notes = [];
  if (edgeCorners) notes.push(`${edgeCorners} facet corners on edges`);
  if (dropped || malformed) notes.push(`triangulation: ${dropped} dropped, ${malformed} malformed`);
  return {
    N: n, cells, sites: { xs: sx, ys: sy },
    cellOfPixel: (i, j) => ownerAt((i + 0.5) / kx, (j + 0.5) / ky),
    cellAt: ownerAt,
    isLine, notes, unit: 'facets',
    debug: { corners: { xs: X, ys: Y, onEdge, pinned }, tris, triReport: { dropped, malformed } },
  };
}

export const build = (rgba, settings, params = {}) => buildCellWeb(rgba, settings, params, DEF, facetLayout);

export default { id, label, blurb, params, build };
