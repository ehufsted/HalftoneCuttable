// Stipple: fixed-size holes, tone by density.
//
// PREDICTIONS.
//  - The dot count is the integral of the asked density, so the piece's overall
//    open fraction matches the target's to within the few dots the spacing
//    repair removes.
//  - Locally, weighted Lloyd puts density where it is asked for: window columns
//    of a ramp track their targets.
//  - No two centers closer than sMin, none nearer the outline than web + d/2:
//    checked by brute force, not with the method's own lookup, and by flood fill.
//  - Every hole in a sheet is the same size.
//  - Relaxation turns the sample into blue noise: the spread of nearest-neighbor
//    distances on a flat field drops sharply.
//  - In color, each sheet gets the share of dots it is owed.

import { check, section, num, grayRamp, flatGray, noiseRGBA, makeRGBA, plain } from './runner.js';
import method from '../src/methods/stipple.js';
import { pieceCount } from '../src/core/structure.js';
import { mixColor } from '../src/core/separate.js';
import { hexToLinear, toEncoded } from '../src/core/color.js';

const base = { ...plain, widthMm: 60, web: 0.4, minHole: 0.5, kerf: 0.15 };

function nearestDistances(xs, ys) {
  const out = new Float64Array(xs.length).fill(Infinity);
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length; j++) {
      const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
      if (d < out[i]) out[i] = d;
      if (d < out[j]) out[j] = d;
    }
  }
  return out;
}

const openOf = (b) => b.layers[0].length * (Math.PI * b.debug.d * b.debug.d / 4) / (b.widthMm * b.heightMm);
const meanTargetOpen = (b) => {
  // B&W target is the open fraction itself (palette [[0],[1]])
  let t = 0, w = 0;
  for (let i = 0; i < b.N; i++) { t += b.target[i]; w++; }
  return t / w;
};

export function run() {
  section('method.stipple', 'Count, local density, spacing by brute force, one size, blue noise, color shares.');

  // ---- overall tone on flat fields
  {
    const rows = [];
    let worst = 0;
    for (const v of [60, 128, 200, 255]) {
      const b = method.build(flatGray(120, 80, v), base, {});
      const t = meanTargetOpen(b), g = openOf(b);
      const e = t > 0 ? Math.abs(g - t) / t : 0;
      worst = Math.max(worst, e);
      rows.push(`${v}: target ${num(t, 4)} got ${num(g, 4)} (${b.debug.removed} removed)`);
    }
    check('flat fields: overall open fraction within 2% of the target', worst < 0.02, rows.join('; '));
  }

  // ---- local tone on a ramp
  {
    const b = method.build(grayRamp(300, 150), base, {});
    const cols = Math.round(b.widthMm / b.debug.win);
    const rowsN = b.N / cols;
    let worst = 0, mean = 0;
    for (let i = 0; i < cols; i++) {
      let t = 0, g = 0;
      for (let j = 0; j < rowsN; j++) { t += b.target[j * cols + i]; g += b.achieved[j * cols + i]; }
      const e = Math.abs(t - g) / rowsN;
      worst = Math.max(worst, e); mean += e / cols;
    }
    check('ramp: each window column averages to its target', mean < 0.02 && worst < 0.05,
      `mean |Δ| ${num(mean, 4)}, worst column ${num(worst, 4)} (open fraction), ${cols} columns`);
  }

  // ---- spacing and structure, B&W and a 3-sheet stack
  {
    const cases = [
      ['B&W noise', noiseRGBA(150, 100, 3, false), base],
      ['B&W white (densest)', flatGray(150, 100, 255), base],
      ['color noise, 3 sheets', noiseRGBA(150, 100, 4), { ...base, mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 }],
    ];
    const bad = [];
    let minGap = Infinity, minEdge = Infinity;
    for (const [name, rgba, s] of cases) {
      const b = method.build(rgba, s, {});
      const { xs, ys, sMin, dDeep } = b.debug;
      const nn = nearestDistances(xs, ys);
      const close = Math.min(...nn);
      let edge = Infinity;
      for (let i = 0; i < xs.length; i++) edge = Math.min(edge, xs[i], ys[i], b.widthMm - xs[i], b.heightMm - ys[i]);
      minGap = Math.min(minGap, close - dDeep);
      minEdge = Math.min(minEdge, edge - dDeep / 2);
      if (close < sMin - 1e-9) bad.push(`${name}: centers ${num(close, 4)} apart, need ${num(sMin, 4)}`);
      if (edge - dDeep / 2 < s.web - 1e-9) bad.push(`${name}: ${num(edge - dDeep / 2, 4)} mm to the outline`);
      b.layers.forEach((holes, j) => {
        const p = pieceCount({ ...b, kerf: s.kerf }, holes, 4 / s.web);
        if (p !== 1) bad.push(`${name} sheet ${j + 1}: ${p} pieces`);
        if (b.webs[j] < s.web - 1e-9) bad.push(`${name} sheet ${j + 1}: claims web ${num(b.webs[j], 4)}`);
        if (new Set(holes.map((h) => h.a.toFixed(9))).size > 1) bad.push(`${name} sheet ${j + 1}: more than one hole size`);
      });
    }
    check('no web below the setting (brute force), every sheet one piece, one hole size per sheet', bad.length === 0,
      bad.join('; ') || `thinnest gap between holes ${num(minGap, 4)} mm, to the outline ${num(minEdge, 4)} mm`);
  }

  // ---- blue noise
  {
    const cv = (b) => {
      const nn = nearestDistances(b.debug.xs, b.debug.ys);
      const m = nn.reduce((a, v) => a + v, 0) / nn.length;
      return Math.sqrt(nn.reduce((a, v) => a + (v - m) ** 2, 0) / nn.length) / m;
    };
    const rgba = flatGray(120, 80, 170);
    const raw = cv(method.build(rgba, base, { relax: 0 })), relaxed = cv(method.build(rgba, base, {}));
    // Uniform random points have a CV of about 0.52; the Hilbert-stratified start
    // is already far better than that (about 0.18), so the claim is on the
    // relaxed result, not on how much relaxation adds.
    check('relaxation evens the spacing (nearest-neighbor CV)', relaxed < 0.12 && relaxed < raw,
      `CV ${num(raw, 3)} unrelaxed, ${num(relaxed, 3)} relaxed (uniform random ≈ 0.52)`);
  }

  // ---- color: shares of dots, and the hidden deeper hole
  {
    const pal = ['#202020', '#d02020', '#2040d0'];
    const lin = pal.map(hexToLinear);
    const c = mixColor([0.8, 0.1, 0.1], lin).map((v) => Math.round(255 * toEncoded(v)));
    const s = { ...base, mode: 'color', palette: pal, reg: 0.3 };
    const b = method.build(makeRGBA(150, 100, () => c), s, {});
    const { lab, d } = b.debug;
    let red = 0, blue = 0;
    for (const l of lab) { if (l === 1) red++; else if (l === 2) blue++; }
    check('color: an even mix of two sheets gets an even split of dots', Math.abs(red - blue) / (red + blue) < 0.05,
      `${red} red, ${blue} blue`);
    const top = b.layers[0][0].a, under = b.layers[1][0].a;
    check('color: blue dots are holed through the red sheet, wider by the registration allowance all round',
      b.layers[1].length === blue && Math.abs(under - top - 2 * s.reg) < 1e-9,
      `cut diameters ${num(top, 3)} and ${num(under, 3)} mm (finished ${num(d, 3)} and ${num(d + 2 * s.reg, 3)})`);
  }

  // ---- determinism
  {
    const rgba = noiseRGBA(100, 70, 9, false);
    const key = (b) => Array.from(b.debug.xs.slice(0, 40), (x) => x.toFixed(6)).join(',');
    const a = method.build(rgba, base, { seed: 5 }), c = method.build(rgba, base, { seed: 5 }), e = method.build(rgba, base, { seed: 6 });
    check('same seed, same dots; another seed, other dots', key(a) === key(c) && key(a) !== key(e));
  }
}
