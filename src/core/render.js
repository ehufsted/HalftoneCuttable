// Rasterisers, for LOOKING AT. Scoring does not go through them.
//
// Unlike the pen-plotter app, where the renderer is the calibration, here the
// geometry is exact: every hole is a rounded square or a convex polygon grown by
// the kerf, with a closed-form area (core/holes.js), so the fidelity score uses
// that. A raster can only add error, and an axis-aligned one adds it
// systematically: a square hole's edges hold one phase against the sample grid
// for their whole length, so a fixed grid miscounts a whole row of samples on
// every hole of that size (the harness measured 2.6% on one square at 500×500).
// The rasters are checked against the area law instead.
//
//   rasterizeHoles -- the preview, for any hole kind: per-sheet sample COUNTS per
//                     pixel, so any palette (front-lit, backlit) composites from
//                     one pass.
//   holeTables / measureCells -- the square grid's cell-aligned instrument, which
//                     the harness uses to check the grid's holes against the
//                     area law.

import { finished } from './shapes.js';
import { holeBBox, insideFinished } from './holes.js';
import { edt } from './edt.js';
import { toEncoded } from './color.js';

const SQRT2 = Math.SQRT2;

/**
 * Finished geometry of every hole, flattened for the inner loop: per layer, the
 * half-straight `h = a/2 - r` and the radius `r`. h < 0 marks no hole.
 */
export function holeTables(ctx, sizes, spec) {
  const N = ctx.cols * ctx.rows;
  return sizes.map((sz) => {
    const H = new Float32Array(N).fill(-1), R = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const g = finished(spec, sz[i]);
      if (g) { H[i] = g.a / 2 - g.r; R[i] = g.r; }
    }
    return { H, R, rot: spec.shape === 'diamond' };
  });
}

/** Index of the visible sheet at local offset (x, y) from the centre of `cell`. */
function visibleIn(tables, cell, x, y) {
  for (let j = 0; j < tables.length; j++) {
    const t = tables[j];
    const h = t.H[cell];
    if (h < 0) return j;
    let u = x, v = y;
    if (t.rot) { u = (x + y) / SQRT2; v = (y - x) / SQRT2; }
    const qx = Math.abs(u) - h, qy = Math.abs(v) - h;
    const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
    const d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - t.R[cell];
    if (d >= 0) return j;              // material of sheet j here
  }
  return tables.length;                // through every hole: the base
}

/**
 * Per cell, the visible area of each sheet, from S×S samples at sample centres.
 * @returns {Float32Array} cols*rows*n, fractions summing to 1 per cell
 */
export function measureCells(ctx, tables, S = 16) {
  const n = tables.length + 1;
  const N = ctx.cols * ctx.rows;
  const out = new Float32Array(N * n);
  const p = ctx.pitch;
  const w = 1 / (S * S);
  for (let cell = 0; cell < N; cell++) {
    for (let sy = 0; sy < S; sy++) {
      const y = ((sy + 0.5) / S - 0.5) * p;
      for (let sx = 0; sx < S; sx++) {
        const x = ((sx + 0.5) / S - 0.5) * p;
        out[cell * n + visibleIn(tables, cell, x, y)] += w;
      }
    }
  }
  return out;
}

/** A cell's colour from its visible areas: D channels, linear. */
export function cellColours(ctx, fractions, palette) {
  const n = palette.length, D = palette[0].length, N = ctx.cols * ctx.rows;
  const out = new Float32Array(N * D);
  for (let c = 0; c < N; c++) {
    for (let j = 0; j < n; j++) {
      const f = fractions[c * n + j];
      if (f === 0) continue;
      for (let d = 0; d < D; d++) out[c * D + d] += f * palette[j][d];
    }
  }
  return out;
}

/**
 * Preview raster for ANY holes (core/holes.js): per-layer sample counts, n bytes
 * per pixel, n = layers + 1.
 *
 * Each hole is painted over its own bounding box, so the cost goes with the cut
 * area rather than the piece. A per-sample DEPTH (how many sheets from the top are
 * holed there) is all the stack needs: holes nest, so sheet j's hole only counts
 * where every sheet above it is already open, and the visible sheet is the depth.
 *
 * @param {{widthMm, heightMm, kerf}} piece
 * @param {Array<Array>} layers  holes per cut sheet, top first
 * @param {{maxDim?:number, pxPerMm?:number, superSample?:number}} opts
 */
export function rasterizeHoles(piece, layers, opts = {}) {
  const W = piece.widthMm, H = piece.heightMm, d = piece.kerf / 2;
  const pxPerMm = opts.pxPerMm || (opts.maxDim || 1200) / Math.max(W, H);
  const w = Math.max(1, Math.round(W * pxPerMm)), h = Math.max(1, Math.round(H * pxPerMm));
  const ss = opts.superSample || 3;
  const sw = w * ss, sh = h * ss, k = pxPerMm * ss;
  const depth = new Uint8Array(sw * sh);
  layers.forEach((holes, j) => {
    const loops = holes.filter((hl) => hl.kind === 'loop');
    if (loops.length) {
      // loops that carry their finished outline are filled by it; any that do not
      // are filled by the cut path and grown by the beam radius on the raster
      const carried = loops.every((hl) => hl.fx);
      const open = fillEvenOdd(carried ? loops.map((hl) => ({ xs: hl.fx, ys: hl.fy })) : loops, sw, sh, k);
      const r = d * k;
      const grown = !carried && r >= 0.25 ? edt(open, sw, sh) : null;
      for (let q = 0; q < sw * sh; q++) {
        if (depth[q] === j && (grown ? grown[q] <= r : open[q])) depth[q] = j + 1;
      }
    }
    for (const hole of holes) {
      if (hole.kind === 'loop') continue;
      const [x0, y0, x1, y1] = holeBBox(hole, d);
      const i0 = Math.max(0, Math.floor(x0 * k - 0.5)), i1 = Math.min(sw - 1, Math.ceil(x1 * k - 0.5));
      const r0 = Math.max(0, Math.floor(y0 * k - 0.5)), r1 = Math.min(sh - 1, Math.ceil(y1 * k - 0.5));
      for (let sy = r0; sy <= r1; sy++) {
        const y = (sy + 0.5) / k;
        for (let sx = i0; sx <= i1; sx++) {
          const q = sy * sw + sx;
          if (depth[q] !== j) continue;
          if (insideFinished(hole, d, (sx + 0.5) / k, y)) depth[q] = j + 1;
        }
      }
    }
  });
  const n = layers.length + 1;
  const counts = new Uint8Array(w * h * n);
  for (let sy = 0; sy < sh; sy++) {
    const py = (sy / ss) | 0;
    for (let sx = 0; sx < sw; sx++) counts[(py * w + ((sx / ss) | 0)) * n + depth[sy * sw + sx]]++;
  }
  return { w, h, n, ss, pxPerMm, counts };
}

/**
 * Fill a set of closed loops even-odd at sample centres: a sample is inside if a
 * ray from it crosses the loops an odd number of times, so an island loop inside
 * an outer loop reads as a hole in it, whichever way either runs.
 */
function fillEvenOdd(loops, sw, sh, k) {
  const rows = Array.from({ length: sh }, () => []);
  for (const L of loops) {
    const n = L.xs.length;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const x0 = L.xs[i] * k, y0 = L.ys[i] * k, x1 = L.xs[j] * k, y1 = L.ys[j] * k;
      if (y0 === y1) continue;
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      // rows whose centre y = r + 0.5 lies in [lo, hi)
      for (let r = Math.max(0, Math.ceil(lo - 0.5)); r < sh && r + 0.5 < hi; r++) {
        const t = (r + 0.5 - y0) / (y1 - y0);
        rows[r].push(x0 + t * (x1 - x0));
      }
    }
  }
  const out = new Uint8Array(sw * sh);
  for (let r = 0; r < sh; r++) {
    const xs = rows[r].sort((a, b) => a - b);
    for (let p = 0; p + 1 < xs.length; p += 2) {
      const a = Math.max(0, Math.ceil(xs[p] - 0.5)), b = Math.min(sw - 1, Math.ceil(xs[p + 1] - 0.5) - 1);
      for (let c = a; c <= b; c++) out[r * sw + c] = 1;
    }
  }
  return out;
}

/**
 * Composite a preview in a palette of linear RGB colours (one per sheet), mixing
 * in linear light. Samples outside the piece show `background`.
 * @returns {Uint8ClampedArray} RGBA
 */
export function composite(pre, paletteRGB, background = [0.2, 0.2, 0.2]) {
  const { w, h, n, ss, counts } = pre;
  const out = new Uint8ClampedArray(w * h * 4);
  const k = 1 / (ss * ss);
  for (let i = 0; i < w * h; i++) {
    let r = 0, g = 0, b = 0, seen = 0;
    for (let j = 0; j < n; j++) {
      const c = counts[i * n + j];
      if (!c) continue;
      seen += c;
      r += c * paletteRGB[j][0]; g += c * paletteRGB[j][1]; b += c * paletteRGB[j][2];
    }
    const rest = ss * ss - seen;
    r += rest * background[0]; g += rest * background[1]; b += rest * background[2];
    out[4 * i] = 255 * toEncoded(r * k);
    out[4 * i + 1] = 255 * toEncoded(g * k);
    out[4 * i + 2] = 255 * toEncoded(b * k);
    out[4 * i + 3] = 255;
  }
  return out;
}
