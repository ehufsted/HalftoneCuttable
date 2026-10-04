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
//   outlineSteps    -- lines along the visible edges of marked sheets (the
//                     Stencil's brightness layers), drawn over a composite.
//   stackHeights / sheetSolids / reliefShade -- the Relief view: the visible
//                     surface's height and which sheets are metal, per pixel,
//                     and the shadows and lit edges a light casts on them.
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

/** Index of the visible sheet at local offset (x, y) from the center of `cell`. */
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
 * Per cell, the visible area of each sheet, from S×S samples at sample centers.
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

/** A cell's color from its visible areas: D channels, linear. */
export function cellColors(ctx, fractions, palette) {
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
 * Fill a set of closed loops even-odd at sample centers: a sample is inside if a
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
      // rows whose center y = r + 0.5 lies in [lo, hi)
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
 * Outline the steps up onto marked sheets, in place on an RGBA composite. Each
 * pixel's visible sheet is the one most of its samples show. Where two
 * neighboring pixels show different sheets and the HIGHER one (nearer the top)
 * is marked, the pixel on the higher side is painted that sheet's outline
 * color -- so the line runs along the raised sheet's own visible edge, and a
 * marked sheet hidden under another one draws nothing.
 * @param {Uint8ClampedArray} rgba  composite(pre, ...)'s output, w*h*4
 * @param {Array<number[]|null>} colors  per sheet (n entries): encoded 0-255
 *                                       [r, g, b], or null for an unmarked sheet
 * @returns {number} pixels painted
 */
export function outlineSteps(rgba, pre, colors) {
  const { w, h, n, counts } = pre;
  const vis = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let best = 0, bc = -1;
    for (let j = 0; j < n; j++) if (counts[i * n + j] > bc) { bc = counts[i * n + j]; best = j; }
    vis[i] = best;
  }
  const mark = new Int16Array(w * h).fill(-1);
  const step = (a, b) => {
    const va = vis[a], vb = vis[b];
    if (va === vb) return;
    const hi = va < vb ? a : b;
    if (colors[vis[hi]]) mark[hi] = vis[hi];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) step(i, i + 1);
      if (y + 1 < h) step(i, i + w);
    }
  }
  let painted = 0;
  for (let i = 0; i < w * h; i++) {
    if (mark[i] < 0) continue;
    const c = colors[mark[i]];
    rgba[4 * i] = c[0]; rgba[4 * i + 1] = c[1]; rgba[4 * i + 2] = c[2];
    painted++;
  }
  return painted;
}

/**
 * The height of the stack's visible surface per preview pixel, in SHEETS above
 * the floor (the solid base or the backdrop), averaged over the pixel's samples
 * so a step lands between pixels. Only differences matter to the shading.
 * @returns {Float32Array} w*h
 */
export function stackHeights(pre) {
  const { w, h, n, ss, counts } = pre;
  const out = new Float32Array(w * h);
  const k = 1 / (ss * ss);
  for (let i = 0; i < w * h; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += counts[i * n + j] * (n - 1 - j);
    out[i] = s * k;
  }
  return out;
}

/**
 * Which sheets are metal at each preview pixel: one 0/1 mask per cut sheet of
 * the stack, top first, packed. The floor (solid base or backdrop) is not one.
 * The Relief view needs this beyond the visible surface: a bridge over a hole in
 * the sheet beneath has air under it, and a height map alone would stand it on
 * a solid column down to the floor.
 * @param {Array<Array>} layers  holes per cut sheet, top first (the stack)
 * @returns {{n:number, data:Uint8Array}} n*w*h
 */
export function sheetSolids(piece, layers, pre) {
  const N = pre.w * pre.h, data = new Uint8Array(layers.length * N);
  layers.forEach((holes, k) => {
    const r = rasterizeHoles(piece, [holes], { pxPerMm: pre.pxPerMm, superSample: 1 });
    for (let i = 0; i < N; i++) data[k * N + i] = r.counts[2 * i] ? 1 : 0;
  });
  return { n: layers.length, data };
}

const SHADOW = 0.55;      // how much a full shadow darkens
const HIGHLIGHT = 0.35;   // how far a lit edge brightens toward white
const FAR = 1e9;          // "no metal that way"

/**
 * Relief shading, for seeing which sheet lies on which: the shadows the sheets
 * cast, and a highlight along the edges that face the light, over an RGBA image
 * (the Result view). A directional light: `azimuth` is the direction it comes
 * FROM in the image plane, degrees clockwise from the top of the image (negative:
 * from the left); `elevation` its height above the sheets, degrees.
 *
 * Sheet k of n (top first) is a slab from (n-k-1)·t to (n-k)·t above the floor.
 * A pixel whose visible surface is at height Hs is in shadow if its ray toward
 * the light passes through some sheet above it where that sheet is metal: the
 * ray is inside slab k between distances (bottom - Hs)/tan(elevation) and
 * (top - Hs)/tan(elevation). So per sheet, one sweep away from the light gives
 * each pixel's distance to the nearest metal toward the light,
 *   D(p) = 0 on metal,  else D(q) + 1,   q = p + one step to the light
 * (q falls between two pixels of the line already swept, so it is
 * interpolated), and each pixel reads D where its ray enters the slab. A thin
 * bridge over a hole thus casts a thin shadow, offset by its height, not a
 * wall's. A k-sheet step casts a shadow k·t / tan(elevation) long.
 *
 * @param {Uint8ClampedArray} rgba  w*h*4, not modified
 * @param {Float32Array} height     stackHeights(), in sheets: the visible surface
 * @param {{n:number, data:Uint8Array}} solid  sheetSolids()
 * @param {{thickness:number, elevation:number, azimuth:number}} o  mm, degrees, degrees
 * @returns {Uint8ClampedArray} the shaded copy
 */
export function reliefShade(rgba, height, solid, w, h, pxPerMm, o) {
  const N = w * h, t = o.thickness;
  const az = (o.azimuth * Math.PI) / 180;
  const lx = Math.sin(az), ly = -Math.cos(az);             // toward the light, y down
  const m = Math.max(Math.abs(lx), Math.abs(ly));
  const ux = lx / m, uy = ly / m;                           // one pixel along the major axis
  const stepMm = Math.hypot(ux, uy) / pxPerMm;
  const perMm = 1 / (Math.tan((o.elevation * Math.PI) / 180) * stepMm);   // steps per mm of rise
  const rows = Math.abs(ly) >= Math.abs(lx);
  const nLines = rows ? h : w, nAlong = rows ? w : h;
  const major = rows ? uy : ux, minor = rows ? ux : uy;
  const at = (line, pos) => (rows ? line * w + pos : pos * w + line);

  // per sheet, steps to the nearest metal toward the light
  const dist = [];
  for (let k = 0; k < solid.n; k++) {
    const S = solid.data.subarray(k * N, (k + 1) * N), D = new Float32Array(N);
    for (let s = 0; s < nLines; s++) {
      const line = major < 0 ? s : nLines - 1 - s;
      const from = line + major;                            // the line toward the light
      const inLine = from >= 0 && from < nLines;
      for (let pos = 0; pos < nAlong; pos++) {
        const i = at(line, pos);
        if (S[i]) { D[i] = 0; continue; }
        const p = pos + minor;
        if (!inLine || p < 0 || p > nAlong - 1) { D[i] = FAR; continue; }
        const p0 = Math.floor(p), f = p - p0, p1 = Math.min(nAlong - 1, p0 + 1);
        D[i] = D[at(from, p0)] * (1 - f) + D[at(from, p1)] * f + 1;
      }
    }
    dist.push(D);
  }
  // a field sampled at (x, y) in pixel-index coordinates; off the image there is nothing
  const sample = (F, x, y, off) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return off;
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return (F[y0 * w + x0] * (1 - fx) + F[y0 * w + x1] * fx) * (1 - fy) + (F[y1 * w + x0] * (1 - fx) + F[y1 * w + x1] * fx) * fy;
  };

  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i - x) / w, Hs = height[i] * t;
    let shade = 0;
    for (let k = 0; k < solid.n; k++) {
      const top = (solid.n - k) * t;
      if (top <= Hs + 1e-9) break;                         // this sheet and all below it: under the surface
      const a = Math.max(0, top - t - Hs) * perMm, b = (top - Hs) * perMm;   // the ray's steps inside the slab
      const d = sample(dist[k], x + a * ux, y + a * uy, FAR);
      // metal within the window: its wall stands half a step nearer than its
      // center, and the edge is anti-aliased as the pixel's coverage (+-half a step)
      shade = Math.max(shade, Math.min(1, Math.max(0, b - a - d + 1)));
      if (shade >= 1) break;
    }
    // a lit edge: higher than the surface one step toward the light
    const Hq = sample(height, x + ux, y + uy, height[i]) * t;
    const lit = Math.max(0, Math.min(1, (Hs - Hq) / Math.max(t, 1e-6)));
    for (let c = 0; c < 3; c++) {
      let v = rgba[4 * i + c] * (1 - SHADOW * shade);
      v += (255 - v) * HIGHLIGHT * lit;
      out[4 * i + c] = v;
    }
    out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * Composite a preview in a palette of linear RGB colors (one per sheet), mixing
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
