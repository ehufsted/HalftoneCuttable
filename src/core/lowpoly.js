// Low-poly: the image as flat triangular facets.
//
// Where the triangle corners go is what makes low-poly read as a picture rather
// than broken glass, so there are two layouts:
//
//   adaptive  corners scattered by detail -- dense where the image is busy,
//             sparse where it is flat (the Voronoi web's variable-spacing Poisson
//             fill, then a short Lloyd relaxation) -- and, with Follow edges, laid
//             ALONG the image's strong edges first, so triangle sides line up
//             with the outlines and a jaw or horizon is a crease between facets
//             rather than cutting through them. Points on an edge (not in pairs
//             across it, as the Voronoi web needs): Delaunay joins neighbors
//             along the line.
//   uniform   an equilateral triangle grid: every facet the same size.
//
// Both add the piece's corners and a ring along its border, so the facets tile
// the whole rectangle, and are triangulated by Delaunay (core/delaunay.js).
//
// A facet's color is the AVERAGE of its pixels, taken in linear light (so a
// facet keeps the tone the patterns downstream will reproduce), or their MEDIAN,
// channel by channel, which ignores specks and outliers and gives more contrast.
//
// Sizes are in mm on the metal, converted with the piece width.

import { makeImage } from '../shim/image.js';
import { mulberry32 } from '../shim/random.js';
import { toEncoded, LINEAR_LUT, luminance } from './color.js';
import { detailMap, edgePoints } from './features.js';
import { lloyd, Crowd, fillCandidates } from './seeds.js';
import { triangulate } from './delaunay.js';

const MAX_POINTS = 30000;

/** The facet mesh for an image: points (source pixels) and triangles. */
export function lowPolyMesh(rgba, p, widthMm) {
  const W = rgba.width, H = rgba.height;
  const k = W / widthMm;                          // source pixels per mm
  const size = Math.max(0.5, p.size) * k;         // facet size, px
  const xs = [], ys = [], pinned = [];
  const add = (x, y, pin) => { xs.push(x); ys.push(y); pinned.push(pin ? 1 : 0); };

  if (p.layout === 'uniform') {
    // equilateral lattice, rows √3/2 apart, alternate rows offset by half; each
    // row runs edge to edge so the border is covered
    const rowH = (size * Math.sqrt(3)) / 2;
    const rows = Math.max(1, Math.round(H / rowH));
    for (let r = 0; r <= rows; r++) {
      const y = (r * H) / rows;
      const off = r & 1 ? size / 2 : 0;
      const pin = r === 0 || r === rows;
      add(0, y, true);
      for (let x = off || size; x < W - size * 0.3; x += size) add(x, y, pin);
      add(W, y, true);
    }
  } else {
    // spacing from detail
    const lum = makeImage(W, H);
    for (let i = 0, q = 0; i < W * H; i++, q += 4) {
      lum.data[i] = luminance(rgba.data[q], rgba.data[q + 1], rgba.data[q + 2]) / 255;
    }
    const sMax = size, sMin = size * (1 - Math.min(0.9, p.detail));
    const detail = p.detail > 0 ? detailMap([lum], Math.max(0.7, sMin / 3)) : null;
    const spacingAt = (x, y) => {
      if (!detail) return sMax;
      const i = Math.min(W - 1, Math.max(0, x | 0)), j = Math.min(H - 1, Math.max(0, y | 0));
      return Math.max(sMin, sMax * (1 - p.detail * detail[j * W + i]));
    };
    // a bucket grid for "anything within r?"
    const crowd = new Crowd([0, 0, W, H], Math.max(1, sMin * 0.7));
    const put = (x, y, pin) => { crowd.add(x, y); add(x, y, pin); };
    const clear = (x, y, r) => crowd.clear(x, y, r);
    // border ring and corners, pinned
    for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, H]]) put(x, y, true);
    for (const [len, at] of [[W, (t) => [t, 0]], [W, (t) => [t, H]], [H, (t) => [0, t]], [H, (t) => [W, t]]]) {
      const n = Math.max(1, Math.round(len / (0.9 * sMax)));
      for (let i = 1; i < n; i++) { const [x, y] = at((i * len) / n); put(x, y, true); }
    }
    // along the edges, strongest first, about half a facet apart
    if (p.edges) {
      const pts = edgePoints([lum], Math.max(0.7, sMin / 4), p.edgeThreshold).sort((a, b) => b.s - a.s);
      for (const e of pts) {
        const s = spacingAt(e.x, e.y);
        if (clear(e.x, e.y, 0.5 * s)) put(e.x, e.y, true);
      }
    }
    // fill, in seeded random order
    for (const [x, y] of fillCandidates([0, 0, W, H], 0.4 * sMin, mulberry32(p.seed | 0))) {
      if (x < 0 || y < 0 || x > W || y > H) continue;
      if (clear(x, y, 0.85 * spacingAt(x, y))) put(x, y, false);
    }
    if (xs.length > MAX_POINTS) throw new Error(`${xs.length} facet corners is too many — raise the facet size`);
    // relax the free points a little, towards even facets at the local spacing
    const X = Float64Array.from(xs), Y = Float64Array.from(ys);
    lloyd(X, Y, [0, 0, W, H], (x, y) => (sMax / spacingAt(x, y)) ** 4, 2 / sMin, 2, pinned, 2 * sMax);
    for (let i = 0; i < xs.length; i++) { xs[i] = X[i]; ys[i] = Y[i]; }
  }
  if (xs.length > MAX_POINTS) throw new Error(`${xs.length} facet corners is too many — raise the facet size`);
  const mesh = triangulate(xs, ys);
  return { xs, ys, tris: mesh.tris, n: mesh.n, report: mesh };
}

/**
 * Which triangle owns each pixel of a w×h raster, by pixel center; -1 where none
 * does. Points are scaled by (sx, sy) into pixels first. Shared edges are
 * inclusive, so nothing falls through a crack between two triangles (a pixel on
 * an edge goes to the later one). Triangles are counter-clockwise, as
 * core/delaunay.js returns them. Shared with the Facets pattern.
 */
export function triangleOwners(xs, ys, tris, n, w, h, sx = 1, sy = 1) {
  const owner = new Int32Array(w * h).fill(-1);
  const eps = -1e-9;
  for (let t = 0; t < n; t++) {
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ax = xs[a] * sx, ay = ys[a] * sy, bx = xs[b] * sx, by = ys[b] * sy, cx = xs[c] * sx, cy = ys[c] * sy;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) >= eps &&
          (cx - bx) * (py - by) - (cy - by) * (px - bx) >= eps &&
          (ax - cx) * (py - cy) - (ay - cy) * (px - cx) >= eps) owner[y * w + x] = t;
      }
    }
  }
  return owner;
}

/**
 * The low-poly image: every pixel takes its facet's color.
 * @param {{layout, size, detail, edges, edgeThreshold, color, seed}} p
 */
export function lowPoly(rgba, p, widthMm) {
  const W = rgba.width, H = rgba.height, src = rgba.data;
  const { xs, ys, tris, n } = lowPolyMesh(rgba, p, widthMm);
  const owner = triangleOwners(xs, ys, tris, n, W, H);
  // any pixel still unowned (only possible at the outermost rim) takes a neighbor's facet
  for (let i = 0; i < W * H; i++) if (owner[i] < 0) owner[i] = owner[i > 0 ? i - 1 : i + 1] >= 0 ? owner[i > 0 ? i - 1 : i + 1] : 0;

  const cols = new Uint8ClampedArray(n * 3);
  if (p.color === 'median') {
    // group the pixels by facet (a counting sort), then one reused 256-bin
    // histogram per channel per facet -- a histogram per facet at once would be
    // hundreds of megabytes at the point cap
    const start = new Int32Array(n + 1);
    for (let i = 0; i < W * H; i++) start[owner[i] + 1]++;
    for (let t = 0; t < n; t++) start[t + 1] += start[t];
    const fill = start.slice(0, n), order = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) order[fill[owner[i]]++] = i;
    const hist = new Uint32Array(256);
    for (let t = 0; t < n; t++) {
      const cnt = start[t + 1] - start[t];
      if (!cnt) continue;
      for (let ch = 0; ch < 3; ch++) {
        hist.fill(0);
        for (let m = start[t]; m < start[t + 1]; m++) hist[src[4 * order[m] + ch]]++;
        let acc = 0, v = 0;
        for (; v < 255; v++) { acc += hist[v]; if (acc >= cnt / 2) break; }
        cols[3 * t + ch] = v;
      }
    }
  } else {
    // average in linear light, so the facet keeps its tone
    const sum = new Float64Array(n * 3), counts = new Float64Array(n);
    for (let i = 0; i < W * H; i++) {
      const t = owner[i];
      counts[t]++;
      sum[3 * t] += LINEAR_LUT[src[4 * i]]; sum[3 * t + 1] += LINEAR_LUT[src[4 * i + 1]]; sum[3 * t + 2] += LINEAR_LUT[src[4 * i + 2]];
    }
    for (let t = 0; t < n; t++) {
      for (let ch = 0; ch < 3; ch++) cols[3 * t + ch] = Math.round(255 * toEncoded(counts[t] ? sum[3 * t + ch] / counts[t] : 0));
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const t = owner[i];
    data[4 * i] = cols[3 * t]; data[4 * i + 1] = cols[3 * t + 1]; data[4 * i + 2] = cols[3 * t + 2]; data[4 * i + 3] = 255;
  }
  return { width: W, height: H, data };
}
