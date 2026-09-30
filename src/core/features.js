// Image features the Voronoi web adapts to: where the detail is, where the edges
// are, and (for solid-color stacks) which sheet each region belongs to.
//
// All work on the method's work raster, in pixels. Inputs are ENCODED values (as a
// screen shows them): an edge is a change a person sees, and in linear light the
// shadows are compressed to almost nothing.

import { makeImage, blurGaussian } from '../shim/image.js';

export function blur(im, sigma) {
  if (!(sigma > 0.3)) return im;
  return blurGaussian(im, 2 * Math.ceil(2.5 * sigma) + 1, sigma);
}

/** Summed gradient over channels, plus the direction of the strongest channel. */
function gradient(chans) {
  const { w, h } = chans[0];
  const mag = new Float32Array(w * h), gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const yu = y > 0 ? y - 1 : 0, yd = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      let sum = 0, best = -1;
      for (const c of chans) {
        const d = c.data;
        const ax = (d[y * w + xr] - d[y * w + xl]) / 2, ay = (d[yd * w + x] - d[yu * w + x]) / 2;
        const m2 = ax * ax + ay * ay;
        sum += m2;
        if (m2 > best) { best = m2; gx[y * w + x] = ax; gy[y * w + x] = ay; }
      }
      mag[y * w + x] = Math.sqrt(sum);
    }
  }
  return { mag, gx, gy, w, h };
}

/** The value below which fraction q of `arr` lies, by a 2048-bin histogram. */
function quantile(arr, q) {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max === 0) return 0;
  const bins = new Uint32Array(2048);
  for (let i = 0; i < arr.length; i++) bins[Math.min(2047, Math.floor((arr[i] / max) * 2048))]++;
  const want = q * arr.length;
  let acc = 0;
  for (let b = 0; b < 2048; b++) { acc += bins[b]; if (acc >= want) return ((b + 1) / 2048) * max; }
  return max;
}

/**
 * How much detail each pixel is in, [0, 1]: gradient magnitude at scale sigma,
 * normalized to its own 95th percentile (so it means the same for a soft image
 * and a hard one), then spread by a second blur so cells shrink a little ahead of
 * an edge rather than only on it.
 */
export function detailMap(chans, sigma) {
  const g = gradient(chans.map((c) => blur(c, sigma)));
  const ref = quantile(g.mag, 0.95) || 1;
  const im = makeImage(g.w, g.h);
  for (let i = 0; i < im.data.length; i++) im.data[i] = Math.min(1, g.mag[i] / ref);
  return blur(im, 2 * sigma).data;
}

/**
 * Edge points: a thin (non-maximum-suppressed) gradient ridge at scale sigma,
 * above `threshold` × the 99th-percentile magnitude, located to sub-pixel by a
 * parabola across the ridge.
 * @returns {Array<{x,y,nx,ny,s}>} pixel coordinates (pixel centers at +0.5),
 *   unit normal across the edge, strength
 */
export function edgePoints(chans, sigma, threshold) {
  const g = gradient(chans.map((c) => blur(c, sigma)));
  const { w, h, mag } = g;
  const ref = quantile(mag, 0.99);
  if (!(ref > 0)) return [];
  const thr = threshold * ref;
  const at = (x, y) => mag[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const out = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i];
      if (m <= thr) continue;
      const L = Math.hypot(g.gx[i], g.gy[i]);
      if (!(L > 0)) continue;
      const nx = g.gx[i] / L, ny = g.gy[i] / L;
      const ahead = at(Math.round(x + nx), Math.round(y + ny));
      const behind = at(Math.round(x - nx), Math.round(y - ny));
      if (!(m >= ahead && m > behind)) continue;
      const den = behind - 2 * m + ahead;
      const t = den < 0 ? Math.max(-0.5, Math.min(0.5, (behind - ahead) / (2 * den))) : 0;
      out.push({ x: x + 0.5 + t * nx, y: y + 0.5 + t * ny, nx, ny, s: m });
    }
  }
  return out;
}

/**
 * Solid-color regions: which sheet each pixel belongs to. A pixel is assigned
 * the sheet j >= 1 whose mix with the top sheet (the line c0 -> cj) comes
 * closest to it, since in solid mode a cell can only show the top sheet and one
 * other. The assignment is then smoothed (blur each one-hot mask, take the
 * largest) so regions follow shapes rather than noise.
 *
 * @param {Array<{data:Float32Array}>} planes  linear RGB, one image each
 * @param {number[][]} paletteEnc  sheet colors, ENCODED rgb
 * @param {(v:number)=>number} encode  linear -> encoded
 * @returns {{labels:Uint8Array, soft:Array<{w,h,data}>}} labels in 1..n-1;
 *   soft[j-1] is sheet j's smoothed mask
 */
export function regionLabels(planes, paletteEnc, encode, sigma) {
  const { w, h } = planes[0];
  const n = paletteEnc.length;
  const c0 = paletteEnc[0];
  const masks = [];
  for (let j = 1; j < n; j++) masks.push(makeImage(w, h));
  for (let i = 0; i < w * h; i++) {
    const r = encode(planes[0].data[i]), g = encode(planes[1].data[i]), b = encode(planes[2].data[i]);
    let best = 1, bd = Infinity;
    for (let j = 1; j < n; j++) {
      const cj = paletteEnc[j];
      const dx = cj[0] - c0[0], dy = cj[1] - c0[1], dz = cj[2] - c0[2];
      const L2 = dx * dx + dy * dy + dz * dz;
      let t = L2 > 0 ? ((r - c0[0]) * dx + (g - c0[1]) * dy + (b - c0[2]) * dz) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = (c0[0] + t * dx - r) ** 2 + (c0[1] + t * dy - g) ** 2 + (c0[2] + t * dz - b) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    masks[best - 1].data[i] = 1;
  }
  const soft = masks.map((m) => blur(m, sigma));
  const labels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let best = 0, bv = -1;
    for (let j = 0; j < soft.length; j++) if (soft[j].data[i] > bv) { bv = soft[j].data[i]; best = j; }
    labels[i] = best + 1;
  }
  return { labels, soft };
}

/**
 * Points on the boundaries between regions, one per pair of differing
 * neighbors, with the normal taken from the smoothed mask (so it follows the
 * shape, not the pixel staircase).
 */
export function boundaryPoints(labels, soft, w, h) {
  const out = [];
  const normal = (x, y, a, fx, fy) => {
    const d = soft[a - 1].data;
    const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1);
    const yu = Math.max(0, y - 1), yd = Math.min(h - 1, y + 1);
    let gx = (d[y * w + xr] - d[y * w + xl]) / 2, gy = (d[yd * w + x] - d[yu * w + x]) / 2;
    const L = Math.hypot(gx, gy);
    if (L < 1e-6) { gx = -fx; gy = -fy; } else { gx /= L; gy /= L; }
    return [-gx, -gy];     // out of region a
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = labels[y * w + x];
      if (x + 1 < w && labels[y * w + x + 1] !== a) {
        const [nx, ny] = normal(x, y, a, 1, 0);
        out.push({ x: x + 1, y: y + 0.5, nx, ny, s: Infinity });
      }
      if (y + 1 < h && labels[(y + 1) * w + x] !== a) {
        const [nx, ny] = normal(x, y, a, 0, 1);
        out.push({ x: x + 0.5, y: y + 1, nx, ny, s: Infinity });
      }
    }
  }
  return out;
}
