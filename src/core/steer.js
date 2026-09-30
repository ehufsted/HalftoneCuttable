// Direction fields, and blurs steered along them.
//
// orientationField: which way the image runs at each point, and how sure we are.
//   The structure tensor (gradient outer product, smoothed), as in the pen-plotter
//   app's spine/field.js structureTensorField. Directions are handled as DOUBLED
//   angles throughout: a line has no front or back, so averaging raw directions
//   would cancel opposite ones (that app found this bug six times in its sources).
//   Coherence alone is scale-free -- a nearly flat patch with a faint bias reads
//   as fully coherent -- so strength is also gated on the tensor's energy, relative
//   to the image's own 90th percentile: nothing below 2% of it, full strength from
//   a fifth of it up. (Gated on the median, a smooth ramp -- every pixel AT the
//   median -- got half strength everywhere, and the worms barely leaned.)
//
// steerBlur: a Gaussian blur stretched along a per-pixel direction, as two 1-D
//   passes that each follow the local line (across it, then along it), sampled
//   bilinearly. Exact for a constant direction and a good approximation for one
//   that turns slowly over the kernel, which the smoothed field does. A full 2-D
//   kernel per pixel would be about a hundred times slower; a bank of blurs at
//   fixed angles several times slower than this at the lengths the Turing screen
//   needs.

import { makeImage, resize } from '../shim/image.js';
import { blur } from './features.js';

/**
 * @param {{w,h,data}} im   encoded luminance
 * @param {number} sigmaT    smoothing of the tensor, px: the scale directions are judged at
 * @param {'edges'|'gradient'} along  run along the edges (across the gradient) or along it
 * @returns {{ux:Float32Array, uy:Float32Array, strength:Float32Array}} unit direction and [0,1] strength
 */
export function orientationField(im, sigmaT, along = 'edges') {
  const { w, h } = im;
  const g = blur(im, 1).data;
  const j11 = makeImage(w, h), j12 = makeImage(w, h), j22 = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : 0, yd = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      const gx = (g[y * w + xr] - g[y * w + xl]) / 2, gy = (g[yd * w + x] - g[yu * w + x]) / 2;
      const i = y * w + x;
      j11.data[i] = gx * gx; j12.data[i] = gx * gy; j22.data[i] = gy * gy;
    }
  }
  const a = blur(j11, sigmaT).data, b = blur(j12, sigmaT).data, c = blur(j22, sigmaT).data;
  const n = w * h;
  const energy = new Float32Array(n);
  for (let i = 0; i < n; i++) energy[i] = a[i] + c[i];
  const sorted = Float32Array.from(energy).sort();
  const ref = sorted[Math.floor(0.9 * (n - 1))] || 1e-12;
  const ux = new Float32Array(n), uy = new Float32Array(n), strength = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // doubled-angle vector (t11 - t22, 2 t12) points along the gradient
    const dx = a[i] - c[i], dy = 2 * b[i];
    const mag = Math.hypot(dx, dy);
    let th = 0.5 * Math.atan2(dy, dx);                  // gradient direction
    if (along === 'edges') th += Math.PI / 2;           // along the edge instead
    ux[i] = Math.cos(th); uy[i] = Math.sin(th);
    const coherence = energy[i] > 0 ? mag / energy[i] : 0;
    const gate = Math.max(0, Math.min(1, (energy[i] / ref - 0.02) / 0.18));
    strength[i] = coherence * gate;
  }
  return { ux, uy, strength };
}

function kernel(sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let t = -r; t <= r; t++) { k[t + r] = Math.exp(-(t * t) / (2 * sigma * sigma)); s += k[t + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

function lineBlur(src, w, h, dx, dy, kernels, pick) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const k = kernels[pick(i)], r = (k.length - 1) / 2;
      const ex = dx[i], ey = dy[i];
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        let sx = x + t * ex, sy = y + t * ey;
        sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
        sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
        const x0 = sx | 0, y0 = sy | 0, x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
        const fx = sx - x0, fy = sy - y0;
        const v = (src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx) * (1 - fy) +
          (src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx) * fy;
        acc += k[t + r] * v;
      }
      out[i] = acc;
    }
  }
  return out;
}

/**
 * Prepare a steered blur: across the direction at sigma, along it at
 * sigma · (1 + stretch · strength), strength quantised to a few levels so the
 * kernels can be built once.
 * @returns {(data:Float32Array) => Float32Array}
 */
export function steerBlur(field, w, h, sigma, stretch) {
  const LEVELS = 8;
  const across = [kernel(sigma)];
  const along = Array.from({ length: LEVELS + 1 }, (_, l) => kernel(sigma * (1 + (stretch * l) / LEVELS)));
  const level = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) level[i] = Math.round(Math.max(0, Math.min(1, field.strength[i])) * LEVELS);
  const vx = new Float32Array(w * h), vy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { vx[i] = -field.uy[i]; vy[i] = field.ux[i]; }
  return (data) => lineBlur(lineBlur(data, w, h, vx, vy, across, () => 0), w, h, field.ux, field.uy, along, (i) => level[i]);
}

/**
 * A direction field resampled to another raster size. Directions are
 * interpolated as strength-weighted DOUBLED angles (cos 2θ, sin 2θ) · strength, so
 * opposite arrows average to the same line instead of cancelling, and a weak
 * direction does not pull a strong neighbour round.
 */
export function resampleField(f, w, h, W2, H2) {
  const n = w * h, c = makeImage(w, h), s = makeImage(w, h);
  for (let i = 0; i < n; i++) {
    const cs = f.ux[i] * f.ux[i] - f.uy[i] * f.uy[i], sn = 2 * f.ux[i] * f.uy[i];
    c.data[i] = cs * f.strength[i]; s.data[i] = sn * f.strength[i];
  }
  const C = resize(c, W2, H2).data, S = resize(s, W2, H2).data;
  const N = W2 * H2;
  const ux = new Float32Array(N), uy = new Float32Array(N), strength = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const th = 0.5 * Math.atan2(S[i], C[i]);
    ux[i] = Math.cos(th); uy[i] = Math.sin(th);
    strength[i] = Math.min(1, Math.hypot(C[i], S[i]));
  }
  return { ux, uy, strength };
}
