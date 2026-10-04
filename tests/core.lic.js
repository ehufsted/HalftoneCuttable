// core/lic.js: the LIC + oriented band-pass primitives behind the Flow lines
// (LIC) screen.

import { check, section, num } from './runner.js';
import { buildLicRows, buildBandpassRows, applyRows, quadraturePhase } from '../src/core/lic.js';
import { centralGradient } from '../src/core/features.js';

export function run() {
  section('core.lic', 'LIC rows are row-normalized; the band-pass passes its own wavelength at unit gain and rejects a flat field; the gradient and quadrature recover a known sinusoid’s phase.');

  const w = 40, h = 30;
  const T = new Float64Array(w * h);       // T = 0 everywhere: normal = (1, 0), tangent = (0, 1)
  const L = new Float64Array(w * h).fill(8);

  {
    const rows = buildLicRows(T, L, w, h, 1);
    let worst = 0;
    for (let i = 0; i < rows.N; i += 37) {   // sample, not every row -- it's exact either way
      let s = 0;
      for (let p = rows.starts[i]; p < rows.starts[i + 1]; p++) s += rows.weight[p];
      worst = Math.max(worst, Math.abs(s - 1));
    }
    check('LIC rows are row-normalized (weights sum to 1)', worst < 1e-6, `worst row sum off by ${num(worst, 8)}`);
  }

  {
    // A pure cosine at the target wavelength, running along the NORMAL (x,
    // since T = 0): the band-pass is built to pass this at unit gain.
    const bp = buildBandpassRows(T, L, w, h);
    const u = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) u[y * w + x] = Math.cos((2 * Math.PI * x) / 8);
    const out = applyRows(bp, u);
    let worst = 0;
    for (let x = 10; x < w - 10; x++) worst = Math.max(worst, Math.abs(out[15 * w + x] - u[15 * w + x]));
    check('the band-pass passes its own wavelength through near unchanged', worst < 0.05,
      `worst deviation ${num(worst, 4)} away from the edges`);

    const flat = new Float64Array(w * h).fill(1);
    const outFlat = applyRows(bp, flat);
    let maxFlat = 0;
    for (let x = 10; x < w - 10; x++) maxFlat = Math.max(maxFlat, Math.abs(outFlat[15 * w + x]));
    check('the band-pass rejects a flat (zero-frequency) field', maxFlat < 1e-6, `max response ${num(maxFlat, 8)}`);
  }

  {
    // The same check at a DIAGONAL direction (T = 45deg): rounding a
    // fractional sample to its nearest pixel is exact along an axis-aligned
    // normal (the T = 0 case above) but staircases non-uniformly off it --
    // consecutive unit steps can round to the same pixel, then skip one --
    // which the axis-aligned case cannot catch.
    const Td = new Float64Array(w * h).fill(Math.PI / 4);
    const bp = buildBandpassRows(Td, L, w, h);
    const cT = Math.cos(Math.PI / 4), sT = Math.sin(Math.PI / 4);
    const u = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) u[y * w + x] = Math.cos((2 * Math.PI * (x * cT + y * sT)) / 8);
    const out = applyRows(bp, u);
    let worst = 0, n = 0;
    for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) { worst = Math.max(worst, Math.abs(out[y * w + x] - u[y * w + x])); n++; }
    check('the band-pass passes its own wavelength at a diagonal angle too', worst < 0.1,
      `worst deviation ${num(worst, 4)} over ${n} interior pixels`);
  }

  {
    // grad(a*x + b*y) = (a, b) everywhere, away from the clamped edges.
    const a = 0.3, b = -0.7;
    const u = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) u[y * w + x] = a * x + b * y;
    const { ux, uy } = centralGradient(u, w, h);
    let worst = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      worst = Math.max(worst, Math.abs(ux[y * w + x] - a), Math.abs(uy[y * w + x] - b));
    }
    check('centralGradient recovers a linear field’s exact gradient', worst < 1e-9, `worst error ${num(worst, 10)}`);
  }

  {
    // u = cos(2*pi*x/L): quadraturePhase should read back x/L, mod 1 -- T = 0
    // makes the normal the x axis, matching the wave's own direction.
    const Lc = 8;
    const Lf = new Float64Array(w * h).fill(Lc);
    const u = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) u[y * w + x] = Math.cos((2 * Math.PI * x) / Lc);
    const phase = quadraturePhase(u, T, Lf, w, h);
    const frac = (v) => v - Math.floor(v);
    let worst = 0;
    for (let x = 2; x < w - 2; x++) {
      const want = frac(x / Lc), got = frac(phase[15 * w + x]);
      worst = Math.max(worst, Math.min(Math.abs(want - got), 1 - Math.abs(want - got)));
    }
    check('quadraturePhase recovers a known sinusoid’s phase', worst < 0.03, `worst phase error ${num(worst, 4)} periods`);
  }
}
