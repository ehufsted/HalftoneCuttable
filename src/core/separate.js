// Color separation for stacked sheets.
//
// THE STACK. Sheets c0 (top) ... c(n-1) (solid base). Cut layer j has one hole per
// cell with open fraction f_j, and the holes nest: f0 >= f1 >= ... >= f(n-2). Seen
// from the front, a cell shows
//
//     c0 over 1 - f0,   c_j over f(j-1) - f_j,   c(n-1) over f(n-2)
//
// so a cell's color is a CONVEX MIX of the sheet colors, with weights m_j that
// are those visible areas. Any mix m on the simplex maps back to a unique nested
// stack by f_j = m(j+1) + ... + m(n-1). Separation is therefore "find the mix of
// the palette closest to the target color", in linear light, where area mixing
// is actually linear.
//
// B&W is the n = 2, one-channel case of the same thing: palette [[0], [1]], sheet
// dark and hole light, and m1 = f0 = the target brightness.

import { mulberry32 } from '../shim/random.js';
import { openFraction } from './shapes.js';

/**
 * Every cell's color from the holes actually chosen, by the exact area law.
 * This is what the fidelity score compares with the target (see render.js for
 * why not a raster).
 * @returns {Float64Array} cols*rows*D, linear
 */
export const stackColors = (ctx, sizes, spec) =>
  stackColorsBy(sizes, ctx.palette, ctx.cols * ctx.rows, ctx.D, (s) => openFraction(spec, s, ctx.pitch));

/** The same for any hole family: `fOf(size)` is its open fraction of a cell. */
export function stackColorsBy(sizes, palette, N, D, fOf) {
  const out = new Float64Array(N * D);
  const f = new Float64Array(sizes.length);
  const vis = new Float64Array(sizes.length + 1);
  const col = new Float64Array(D);
  for (let c = 0; c < N; c++) {
    for (let j = 0; j < sizes.length; j++) f[j] = fOf(sizes[j][c]);
    mixColor(visibleMix(f, vis), palette, col);
    for (let d = 0; d < D; d++) out[c * D + d] = col[d];
  }
  return out;
}

/**
 * Closest convex mix of `palette` to `x`: argmin ||sum m_i c_i - x|| over the
 * simplex. n <= 4, so every face of the simplex is tried (at most 15) and the best
 * feasible one kept -- exact, no iteration, no tolerance to tune.
 *
 * @param {ArrayLike<number>} x         target, length D
 * @param {number[][]} palette           n colors, each length D
 * @param {Float64Array} [out]           length n, reused to avoid allocation
 * @returns {Float64Array} the weights m
 */
export function solveMix(x, palette, out = new Float64Array(palette.length)) {
  const n = palette.length, D = x.length;
  let best = Infinity;
  const m = new Float64Array(n);
  const idx = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    idx.length = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    if (!faceSolve(x, palette, idx, m, D)) continue;
    let ok = true;
    for (const i of idx) if (m[i] < -1e-9) { ok = false; break; }
    if (!ok) continue;
    let err = 0;
    for (let d = 0; d < D; d++) {
      let v = -x[d];
      for (const i of idx) v += m[i] * palette[i][d];
      err += v * v;
    }
    if (err < best - 1e-15) {
      best = err;
      out.fill(0);
      for (const i of idx) out[i] = Math.max(0, m[i]);
    }
  }
  // Renormalize away the clamp of tiny negatives.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i];
  if (sum > 0) for (let i = 0; i < n; i++) out[i] /= sum;
  else out[0] = 1;
  return out;
}

/**
 * Least squares on the affine hull of palette[idx]: m_b = 1 - sum(others).
 * Writes m[idx]; returns false if the face is degenerate (colors affinely
 * dependent), in which case a smaller face covers the same answer.
 */
function faceSolve(x, palette, idx, m, D) {
  const k = idx.length;
  const b = palette[idx[0]];
  if (k === 1) { m[idx[0]] = 1; return true; }
  const u = k - 1;
  // Normal equations (A^T A) y = A^T (x - b), A's columns are c_i - b.
  const M = [];
  for (let r = 0; r < u; r++) {
    const cr = palette[idx[r + 1]];
    const row = new Float64Array(u + 1);
    for (let c = 0; c < u; c++) {
      const cc = palette[idx[c + 1]];
      let s = 0;
      for (let d = 0; d < D; d++) s += (cr[d] - b[d]) * (cc[d] - b[d]);
      row[c] = s;
    }
    let s = 0;
    for (let d = 0; d < D; d++) s += (cr[d] - b[d]) * (x[d] - b[d]);
    row[u] = s;
    M.push(row);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < u; c++) {
    let piv = c;
    for (let r = c + 1; r < u; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-10) return false;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < u; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let q = c; q <= u; q++) M[r][q] -= f * M[c][q];
    }
  }
  let rest = 1;
  for (let r = 0; r < u; r++) {
    const y = M[r][u] / M[r][r];
    m[idx[r + 1]] = y;
    rest -= y;
  }
  m[idx[0]] = rest;
  return true;
}

/**
 * Bring a mix into the reachable band: the top sheet must cover at least
 * 1 - fMax. Written on the MIX rather than the color, so B&W and a stack are one
 * rule: in B&W it is exactly t -> fMax * t (squeeze) or min(t, fMax) (clip).
 */
export function fitMix(m, fMax, range) {
  const floor0 = 1 - fMax;
  if (range === 'clip') {
    if (m[0] >= floor0) return m;
    const rest = 1 - m[0];
    for (let i = 1; i < m.length; i++) m[i] *= fMax / rest;
    m[0] = floor0;
    return m;
  }
  for (let i = 1; i < m.length; i++) m[i] *= fMax;
  m[0] = floor0 + fMax * m[0];
  return m;
}

/** The color a mix produces. */
export function mixColor(m, palette, out = new Float64Array(palette[0].length)) {
  out.fill(0);
  for (let i = 0; i < palette.length; i++) {
    for (let d = 0; d < out.length; d++) out[d] += m[i] * palette[i][d];
  }
  return out;
}

/**
 * Mix -> cumulative open fractions f_j = m(j+1) + ... + m(n-1), one per cut layer.
 * Nested by construction.
 */
export function cumulativeOpen(m, out = new Float64Array(m.length - 1)) {
  let acc = 0;
  for (let j = m.length - 1; j >= 1; j--) { acc += m[j]; out[j - 1] = acc; }
  return out;
}

/** Inverse of cumulativeOpen: visible areas from open fractions. */
export function visibleMix(f, out = new Float64Array(f.length + 1)) {
  const n = f.length + 1;
  out[0] = 1 - (f[0] || 0);
  for (let j = 1; j < n - 1; j++) out[j] = f[j - 1] - f[j];
  if (n > 1) out[n - 1] = f[n - 2];
  return out;
}

/**
 * Seeded k-means++ clustering of an image's pixels into `n` clusters, in
 * whatever point space `toPoint(r, g, b)` maps a pixel into -- ordinary
 * Euclidean distance in THAT space is the metric, so the space decides what
 * "close" means. Samples down to a fixed budget first, for speed on a big photo.
 * Shared by `suggestPalette` (encoded RGB, then pushed for gamut) and Posterize's
 * palette extraction (a perceptual space, used as-is).
 * @param {(r:number, g:number, b:number) => number[]} toPoint  encoded [0,1] in
 * @returns {{centers:number[][], mass:number[], mean:number[]}}
 */
export function kmeansPoints(rgba, n, seed, toPoint) {
  const total = rgba.width * rgba.height;
  const stride = Math.max(1, Math.floor(total / 20000));
  const pts = [];
  const mean = [];
  for (let i = 0; i < total; i += stride) {
    const q = 4 * i;
    const p = toPoint(rgba.data[q] / 255, rgba.data[q + 1] / 255, rgba.data[q + 2] / 255);
    pts.push(p);
    for (let d = 0; d < p.length; d++) mean[d] = (mean[d] || 0) + p[d];
  }
  const N = pts.length, D = pts[0].length;
  for (let d = 0; d < D; d++) mean[d] /= N;
  const rand = mulberry32(seed);
  const d2 = (a, b) => { let s = 0; for (let d = 0; d < D; d++) s += (a[d] - b[d]) ** 2; return s; };

  // k-means++ seeding
  const centers = [pts[Math.floor(rand() * N)].slice()];
  const dist = new Float64Array(N).fill(Infinity);
  while (centers.length < n) {
    const c = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < N; i++) { dist[i] = Math.min(dist[i], d2(pts[i], c)); sum += dist[i]; }
    let t = rand() * sum, pick = N - 1;
    for (let i = 0; i < N; i++) { t -= dist[i]; if (t <= 0) { pick = i; break; } }
    centers.push(pts[pick].slice());
  }

  const label = new Int32Array(N);
  const mass = new Float64Array(n);
  for (let it = 0; it < 25; it++) {
    const acc = centers.map(() => new Array(D).fill(0));
    mass.fill(0);
    for (let i = 0; i < N; i++) {
      let bi = 0, bd = Infinity;
      for (let k = 0; k < n; k++) { const dd = d2(pts[i], centers[k]); if (dd < bd) { bd = dd; bi = k; } }
      label[i] = bi; mass[bi]++;
      for (let d = 0; d < D; d++) acc[bi][d] += pts[i][d];
    }
    for (let k = 0; k < n; k++) {
      if (mass[k] > 0) centers[k] = acc[k].map((v) => v / mass[k]);
    }
  }
  return { centers, mass: Array.from(mass), mean };
}

/**
 * Suggest `n` sheet colors for an image: k-means in ENCODED sRGB (closer to
 * perceptual than linear, and this is a starting point for a person to edit),
 * seeded so the same image always suggests the same palette.
 *
 * Cluster centers sit inside the image's color hull, and the stack can only
 * reach mixes inside the PALETTE's hull, so the centers are pushed 25% away from
 * the image's mean color before being returned. Ordered by cluster size, largest
 * on top: the base shows only through every hole in the stack, so the color
 * the image needs least is the one that should live there.
 *
 * @returns {string[]} '#rrggbb', top sheet first
 */
export function suggestPalette(rgba, n, seed = 1) {
  const { centers, mass, mean } = kmeansPoints(rgba, n, seed, (r, g, b) => [r, g, b]);
  const out = centers.map((c, k) => ({
    mass: mass[k],
    rgb: c.map((v, d) => Math.max(0, Math.min(1, mean[d] + 1.25 * (v - mean[d])))),
  }));
  out.sort((a, b) => b.mass - a.mass);
  return out.map(({ rgb }) => '#' + rgb
    .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''));
}
