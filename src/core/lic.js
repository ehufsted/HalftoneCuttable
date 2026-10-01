// A stripe pattern synthesized the fingerprint-formation way: iterated Line
// Integral Convolution (LIC) along a direction field, an oriented band-pass
// across it to pick out the local wavelength, and a soft nonlinearity to
// sharpen and stabilize the result -- ported from a MATLAB fingerprint-
// synthesis reference implementation. Full bug/fix history: docs/architecture.md.
//
// WHY LOCAL, NOT A GLOBAL POTENTIAL SOLVE. The direction field T is used only
// LOCALLY here -- each pixel's own short streamline -- never assembled into
// one field covering the whole piece at once. So it tolerates a "T winds
// around a point" disclination that assembling one global field cannot:
// `tangentAt` interpolates the DOUBLED angle (cos 2T, sin 2T) and sign-aligns
// the reconstructed tangent with the step it is continuing, so a streamline
// can pass through a disclination without ever needing a single consistent
// vector field to exist everywhere.
//
// T is the ACROSS-stripe (normal) direction, as in the MATLAB reference:
// tangent = (-sin T, cos T), normal = (cos T, sin T).
//
// SIMPLIFIED from the reference for a browser-weight port:
//   - a tanh soft clip in place of the coherence-enhancing shock filter, an
//     alternative the reference itself offers.
//   - LIC's streamline window is a hard cutoff at `s <= ell` (ell =
//     licLength*L, exactly the reference's own bound), with a decay check
//     inside the loop as a redundant safety net that never fires first
//     (sig = ell/2 puts the weight at s = ell at exp(-2) ~ 0.135, above the
//     decay floor of ~1e-2).
//
// Both fixed operators' rows split each fractional sample bilinearly across
// its 4 neighbors (`bilinearPush`), not round to the nearest pixel -- exact
// along an axis-aligned normal but staircases off it otherwise. Rows are
// built by appending straight onto growable arrays rather than allocating a
// throwaway array per sample (tens of millions of samples for a piece of any
// real size); the coarse grid also gets its own, tighter pixel cap for this
// screen (methods/screen.js), since these rows cost the same order as its
// own pixel count squared in practice, not the plain color-mix solve's linear.

import { blur } from './features.js';

const bilerp = (F, w, h, x, y) => {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return F[y0 * w + x0] * (1 - fx) * (1 - fy) + F[y0 * w + x1] * fx * (1 - fy) +
    F[y1 * w + x0] * (1 - fx) * fy + F[y1 * w + x1] * fx * fy;
};

/**
 * A fractional (x, y) sample of weight `wgt`, split across its 4 bilinear
 * neighbors and appended directly onto the growable `idx`/`weight` arrays --
 * no intermediate array or spread, since this runs tens of millions of times
 * for a piece of any real size (each of a coarse grid's pixels samples its
 * own streamline and band-pass window, several samples long) and allocating
 * a throwaway array per sample was the difference between this finishing and
 * not, in practice.
 */
function bilinearPush(idx, weight, x, y, wgt, w, h) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const f00 = (1 - fx) * (1 - fy), f10 = fx * (1 - fy), f01 = (1 - fx) * fy, f11 = fx * fy;
  if (f00 > 1e-9) { idx.push(y0 * w + x0); weight.push(f00 * wgt); }
  if (f10 > 1e-9) { idx.push(y0 * w + x1); weight.push(f10 * wgt); }
  if (f01 > 1e-9) { idx.push(y1 * w + x0); weight.push(f01 * wgt); }
  if (f11 > 1e-9) { idx.push(y1 * w + x1); weight.push(f11 * wgt); }
}

/** out = M · u, for an operator built by buildLicRows/buildBandpassRows. */
export function applyRows(rows, u) {
  const out = new Float64Array(rows.N);
  for (let i = 0; i < rows.N; i++) {
    let s = 0;
    for (let p = rows.starts[i]; p < rows.starts[i + 1]; p++) s += rows.weight[p] * u[rows.idx[p]];
    out[i] = s;
  }
  return out;
}

/**
 * The LIC operator: each pixel's row averages a short streamline of the
 * stripe TANGENT (-sin T, cos T), Gaussian-weighted by arc length, in both
 * directions, row-normalized. Fixed (depends only on T, L), so built once
 * and reapplied every iteration.
 * @param {Float64Array} T  the across-stripe direction, radians, w*h
 * @param {Float64Array} L  wavelength, PIXELS (this grid's own units), w*h
 * @param {number} licLength  streamline half-length, in wavelengths
 */
export function buildLicRows(T, L, w, h, licLength = 1) {
  const N = w * h;
  const C2 = new Float64Array(N), S2 = new Float64Array(N);
  for (let i = 0; i < N; i++) { C2[i] = Math.cos(2 * T[i]); S2[i] = Math.sin(2 * T[i]); }
  const tangentAt = (x, y, txPrev, tyPrev) => {
    const Tq = Math.atan2(bilerp(S2, w, h, x, y), bilerp(C2, w, h, x, y)) / 2;
    let tx = -Math.sin(Tq), ty = Math.cos(Tq);
    if (tx * txPrev + ty * tyPrev < 0) { tx = -tx; ty = -ty; }
    return [tx, ty];
  };
  const starts = new Int32Array(N + 1);
  const idx = [], weight = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const i = y0 * w + x0;
      const rowStart = idx.length;
      idx.push(i); weight.push(1);   // the pixel's own sample, as in the reference
      const ell = licLength * L[i], sig = Math.max(1e-6, ell / 2);
      for (const dirSign of [1, -1]) {
        let x = x0, y = y0;
        let tx = -Math.sin(T[i]) * dirSign, ty = Math.cos(T[i]) * dirSign;
        for (let s = 1; s <= ell; s++) {
          const wgt = Math.exp(-(s * s) / (2 * sig * sig));
          if (wgt < 1e-2) break;
          // midpoint RK2: step with the tangent re-evaluated (and sign-aligned)
          // at the midpoint, then again at the landing point for next time
          const [mtx, mty] = tangentAt(x + 0.5 * tx, y + 0.5 * ty, tx, ty);
          const xn = x + mtx, yn = y + mty;
          [tx, ty] = tangentAt(xn, yn, mtx, mty);
          x = xn; y = yn;
          bilinearPush(idx, weight, x, y, wgt, w, h);
        }
      }
      let sum = 0;
      for (let p = rowStart; p < idx.length; p++) sum += weight[p];
      if (sum) { const inv = 1 / sum; for (let p = rowStart; p < idx.length; p++) weight[p] *= inv; }
      starts[i] = rowStart;
    }
  }
  starts[N] = idx.length;
  return { starts, idx: Int32Array.from(idx), weight: Float32Array.from(weight), N };
}

/**
 * The oriented band-pass operator: each pixel's row samples straight along
 * the fixed NORMAL (cos T, sin T), weighted by a Gaussian-windowed cosine at
 * the local wavelength, made zero-mean and unit-gain -- so a pure cos(k0·s)
 * wave passes through unchanged and a flat (or off-wavelength) field is
 * suppressed. Fixed the same way LIC's rows are.
 */
export function buildBandpassRows(T, L, w, h, bpSigma = 0.5) {
  const N = w * h;
  const starts = new Int32Array(N + 1);
  const idx = [], weight = [];
  // scratch, reused every pixel: this pixel's own (k, g, cos) triples
  const kBuf = [], gBuf = [], csBuf = [];
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const i = y0 * w + x0;
      const rowStart = idx.length;
      const cT = Math.cos(T[i]), sT = Math.sin(T[i]);
      const k0 = (2 * Math.PI) / L[i], sig = Math.max(1e-6, bpSigma * L[i]);
      // The reference's own window, exactly: 3 sigma. This is the filter's
      // FREQUENCY SELECTIVITY, not just a sample-count knob -- a shorter
      // window is measurably worse at separating the fundamental from its
      // harmonics (an uncertainty-principle tradeoff), and tanh's sharpening
      // gives u real harmonic content to separate. See docs/architecture.md
      // for why a narrower window was tried and reverted.
      const K = Math.max(1, Math.ceil(3 * sig));
      kBuf.length = gBuf.length = csBuf.length = 0;
      let Sg = 0, Sgc = 0, Sgcc = 0;
      for (let k = -K; k <= K; k++) {
        const g = Math.exp(-(k * k) / (2 * sig * sig));
        const cs = Math.cos(k0 * k);
        Sg += g; Sgc += g * cs; Sgcc += g * cs * cs;
        kBuf.push(k); gBuf.push(g); csBuf.push(cs);
      }
      const alpha = Sgc / (Sg || 1);
      const gain = Sgcc - alpha * Sgc || 1;
      for (let q = 0; q < kBuf.length; q++) {
        const k = kBuf[q];
        bilinearPush(idx, weight, x0 + k * cT, y0 + k * sT, (gBuf[q] * (csBuf[q] - alpha)) / gain, w, h);
      }
      starts[i] = rowStart;
    }
  }
  starts[N] = idx.length;
  return { starts, idx: Int32Array.from(idx), weight: Float32Array.from(weight), N };
}

/** Divide by the local RMS (over ~one wavelength), so a sinusoid has unit amplitude. */
export function localNormalize(u, w, h, sigma) {
  const u2 = new Float32Array(u.length);
  for (let i = 0; i < u.length; i++) u2[i] = u[i] * u[i];
  const A = blur({ w, h, data: u2 }, sigma).data;
  const out = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = u[i] / Math.max(Math.sqrt(2 * Math.max(0, A[i])), 1e-6);
  return out;
}

/** Central-difference gradient, clamped (Neumann) edges. */
export function centralGradient(u, w, h) {
  const at = (x, y) => u[(y < 0 ? 0 : y > h - 1 ? h - 1 : y) * w + (x < 0 ? 0 : x > w - 1 ? w - 1 : x)];
  const ux = new Float64Array(w * h), uy = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ux[y * w + x] = (at(x + 1, y) - at(x - 1, y)) / 2;
      uy[y * w + x] = (at(x, y + 1) - at(x, y - 1)) / 2;
    }
  }
  return { ux, uy };
}

/**
 * The phase, recovered by quadrature: for a near-sinusoidal u = cos(phi),
 * grad(phi) = k·n (k = 2*pi/L), so n·grad(u) = -k·sin(phi) and
 * phi = atan2(-(n·grad u)·L, u·2*pi) -- in PERIODS (divide by 2*pi), the same
 * convention `phase` has everywhere else in methods/screen.js.
 *
 * u is lightly re-blurred first (well under the wavelength, so the stripe
 * itself barely narrows). Right at u's own peak -- the WIDEST point of the
 * stripe the achieved duty asks for, since that is where `tri(phase)` sits at
 * its extreme -- n·grad(u) is naturally near zero, an extremum, so atan2's
 * two arguments are both small there and any grid-scale noise in the
 * un-smoothed field can flip which one dominates, drawing a spurious second
 * crossing right down the stripe's own center (seen as a "bisected" stripe).
 * A wavelength's worth of LIC and band-pass filtering already made u smooth
 * at the SCALE that matters; this only cleans up what a discrete central
 * difference is sensitive to that the stripe pattern itself is not.
 */
export function quadraturePhase(u, T, L, w, h) {
  const us = blur({ w, h, data: Float32Array.from(u) }, 0.75).data;
  const { ux, uy } = centralGradient(us, w, h);
  const phase = new Float64Array(u.length);
  for (let i = 0; i < u.length; i++) {
    const un = Math.cos(T[i]) * ux[i] + Math.sin(T[i]) * uy[i];
    phase[i] = Math.atan2(-un * L[i], us[i] * (2 * Math.PI)) / (2 * Math.PI);
  }
  return phase;
}
