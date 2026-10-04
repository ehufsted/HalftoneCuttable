// Anisotropic Kuwahara filter (Kyprianidis, Kang & Döllner, "Image and video
// abstraction by anisotropic Kuwahara filtering", 2009): painterly flattening.
//
// Around each pixel, an ELLIPSE stretched along the image's local direction (the
// structure tensor, core/steer.js) is split into 8 soft sectors. Each sector's
// weighted mean color and spread are measured, and the output is the sector
// means blended with weight 1 / (1 + spread^q): the sectors lying across an edge
// have a large spread and drop out, the ones on one side of it win. So flat areas
// smooth into even patches while edges stay sharp -- and, with the ellipse
// following the image, the patches read as brush strokes along the form.
//
//   size        brush diameter, mm on the metal (radius r = size / 2)
//   anisotropy  how far the ellipse stretches where the image has a clear
//               direction: semi-axes r·(1 + A) and r / (1 + A), A = anisotropy ×
//               the local strength. 0 gives the round (generalized) Kuwahara.
//   sharpness   q: higher keeps edges crisper and patches flatter
//
// SPEED. Done directly this is a few hundred samples per pixel, tens of seconds on
// a full photo. It runs instead at the resolution where the brush radius is
// R_PX pixels, and is scaled back up: the flattened patches it produces carry no
// detail finer than the brush anyway.
//
// Sector weights are max(0, cos(θ - θ_k))^4 times a radial Gaussian: smooth,
// overlapping neighbors (half-width about 46°), the role Papari's smoothed sector
// functions play in the original, without their precomputed kernels.

import { makeImage, resize } from '../shim/image.js';
import { orientationField } from './steer.js';
import { luminance } from './color.js';

const SECTORS = 8;
const R_PX = 4;
const COS = Array.from({ length: SECTORS }, (_, k) => Math.cos((2 * Math.PI * k) / SECTORS));
const SIN = Array.from({ length: SECTORS }, (_, k) => Math.sin((2 * Math.PI * k) / SECTORS));

/**
 * @param {{width, height, data}} rgba
 * @param {{size:number, anisotropy:number, sharpness:number}} p
 * @param {number} widthMm  the piece width the image spans
 * @returns {{width, height, data}}
 */
export function kuwahara(rgba, p, widthMm) {
  const W = rgba.width, H = rgba.height;
  const rSrc = ((p.size / 2) * W) / widthMm;              // brush radius, source pixels
  const scale = Math.min(1, R_PX / Math.max(rSrc, 1e-6));
  const w = Math.max(4, Math.round(W * scale)), h = Math.max(4, Math.round(H * scale));
  const r = Math.max(1, rSrc * (w / W));

  // color planes (encoded, 0..1), at the working size
  const src = [0, 1, 2].map(() => makeImage(W, H));
  for (let i = 0, q = 0; i < W * H; i++, q += 4) {
    src[0].data[i] = rgba.data[q] / 255; src[1].data[i] = rgba.data[q + 1] / 255; src[2].data[i] = rgba.data[q + 2] / 255;
  }
  const pl = src.map((im) => resize(im, w, h).data);
  const lum = makeImage(w, h);
  for (let i = 0; i < w * h; i++) lum.data[i] = luminance(pl[0][i], pl[1][i], pl[2][i]);
  const field = orientationField(lum, r, 'edges');        // major axis along the edges

  const q = p.sharpness;
  const out = [0, 1, 2].map(() => makeImage(w, h));
  const S = new Float64Array(SECTORS), M = new Float64Array(SECTORS * 3), Q = new Float64Array(SECTORS * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const A = p.anisotropy * Math.min(1, field.strength[i]);
      const a = r * (1 + A), b = r / (1 + A);
      const ux = field.ux[i], uy = field.uy[i];
      const ex = Math.ceil(Math.sqrt((a * ux) ** 2 + (b * uy) ** 2));
      const ey = Math.ceil(Math.sqrt((a * uy) ** 2 + (b * ux) ** 2));
      S.fill(0); M.fill(0); Q.fill(0);
      for (let dy = -ey; dy <= ey; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -ex; dx <= ex; dx++) {
          const u = (dx * ux + dy * uy) / a, v = (-dx * uy + dy * ux) / b;
          const rho2 = u * u + v * v;
          if (rho2 > 1) continue;
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const j = yy * w + xx;
          const c0 = pl[0][j], c1 = pl[1][j], c2 = pl[2][j];
          const g = Math.exp(-2 * rho2);
          const rho = Math.sqrt(rho2);
          for (let k = 0; k < SECTORS; k++) {
            let wk;
            if (rho < 1e-9) wk = g / SECTORS;               // the center belongs to every sector
            else {
              const c = (u * COS[k] + v * SIN[k]) / rho;
              if (c <= 0) continue;
              const c2x = c * c;
              wk = g * c2x * c2x;
            }
            S[k] += wk;
            M[3 * k] += wk * c0; M[3 * k + 1] += wk * c1; M[3 * k + 2] += wk * c2;
            Q[3 * k] += wk * c0 * c0; Q[3 * k + 1] += wk * c1 * c1; Q[3 * k + 2] += wk * c2 * c2;
          }
        }
      }
      let wsum = 0, o0 = 0, o1 = 0, o2 = 0;
      for (let k = 0; k < SECTORS; k++) {
        if (!(S[k] > 0)) continue;
        const m0 = M[3 * k] / S[k], m1 = M[3 * k + 1] / S[k], m2 = M[3 * k + 2] / S[k];
        const v = Math.max(0, Q[3 * k] / S[k] - m0 * m0) + Math.max(0, Q[3 * k + 1] / S[k] - m1 * m1) +
          Math.max(0, Q[3 * k + 2] / S[k] - m2 * m2);
        const alpha = 1 / (1 + Math.pow(255 * Math.sqrt(v), q));   // spread in 8-bit steps, as the paper
        wsum += alpha; o0 += alpha * m0; o1 += alpha * m1; o2 += alpha * m2;
      }
      out[0].data[i] = o0 / wsum; out[1].data[i] = o1 / wsum; out[2].data[i] = o2 / wsum;
    }
  }

  const big = out.map((im) => (w === W && h === H ? im.data : resize(im, W, H).data));
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    data[j] = 255 * big[0][i]; data[j + 1] = 255 * big[1][i]; data[j + 2] = 255 * big[2][i]; data[j + 3] = 255;
  }
  return { width: W, height: H, data };
}
