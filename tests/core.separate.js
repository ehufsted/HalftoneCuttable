// Color separation: the mix solver, the stack bookkeeping, the palette suggester.
//
// PREDICTION. A color built as a known convex mix of an affinely independent
// palette is recovered exactly. A color outside the palette's hull gets a valid
// mix (non-negative, summing to 1) that is no worse than any other point of the
// hull -- checked against a few thousand random ones, which would catch a solver
// that returned a feasible but sub-optimal face.

import { check, section, mkRand, makeRGBA } from './runner.js';
import { solveMix, mixColor, cumulativeOpen, visibleMix, suggestPalette } from '../src/core/separate.js';

function randomPalette(rand, n) {
  return Array.from({ length: n }, () => [rand(), rand(), rand()]);
}

function randomSimplex(rand, n) {
  const e = Array.from({ length: n }, () => -Math.log(rand() + 1e-12));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

const dist2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

export function run() {
  section('core.separate', 'Mix solver on known mixes and on colors outside the hull; stack bookkeeping; palette suggestion.');
  const rand = mkRand(7);

  let worst = 0;
  for (const n of [2, 3, 4]) {
    for (let t = 0; t < 200; t++) {
      const pal = randomPalette(rand, n);
      const m = randomSimplex(rand, n);
      const x = Array.from(mixColor(m, pal));
      const got = solveMix(x, pal);
      // compare colors, not weights: for n = 2 in 3-D, weights are unique too,
      // but a near-degenerate random palette can make weights ill-conditioned
      worst = Math.max(worst, Math.sqrt(dist2(Array.from(mixColor(got, pal)), x)));
    }
  }
  check('a color inside the hull is reproduced exactly', worst < 1e-7, `worst color error ${worst.toExponential(2)}`);

  worst = 0;
  let wm = 0;
  for (let t = 0; t < 300; t++) {
    const pal = randomPalette(rand, 4);
    const m = randomSimplex(rand, 4);
    const got = solveMix(Array.from(mixColor(m, pal)), pal);
    for (let i = 0; i < 4; i++) wm = Math.max(wm, Math.abs(got[i] - m[i]));
  }
  check('4 sheets in 3-D: the weights themselves are recovered', wm < 1e-6, `worst weight error ${wm.toExponential(2)}`);

  let invalid = 0, beaten = 0;
  for (let t = 0; t < 200; t++) {
    const n = 2 + (t % 3);
    const pal = randomPalette(rand, n);
    const x = [rand() * 1.4 - 0.2, rand() * 1.4 - 0.2, rand() * 1.4 - 0.2];
    const m = solveMix(x, pal);
    const sum = m.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9 || m.some((v) => v < 0)) invalid++;
    const best = dist2(Array.from(mixColor(m, pal)), x);
    for (let k = 0; k < 200; k++) {
      const c = Array.from(mixColor(randomSimplex(rand, n), pal));
      if (dist2(c, x) < best - 1e-12) { beaten++; break; }
    }
  }
  check('outside the hull: the mix is valid', invalid === 0, `${invalid} of 200 invalid`);
  check('outside the hull: no random point of the hull is closer', beaten === 0, `${beaten} of 200 beaten`);

  worst = 0;
  for (let t = 0; t < 100; t++) {
    const m = randomSimplex(rand, 4);
    const f = cumulativeOpen(Float64Array.from(m));
    const back = visibleMix(f);
    for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.abs(back[i] - m[i]));
    if (!(f[0] >= f[1] && f[1] >= f[2])) worst = Infinity;
  }
  check('cumulativeOpen nests, and visibleMix undoes it', worst < 1e-12, `worst ${worst.toExponential(2)}`);

  // Half red, half blue: the suggester must find both, and the push away from the
  // mean must clamp back to exactly red and blue rather than overshoot.
  const img = makeRGBA(80, 40, (x) => (x < 40 ? [255, 0, 0] : [0, 0, 255]));
  const a = suggestPalette(img, 2), b = suggestPalette(img, 2);
  check('suggestion is deterministic', a.join() === b.join(), a.join(' '));
  check('suggestion finds the two colors of a two-color image',
    a.slice().sort().join() === ['#0000ff', '#ff0000'].join(), a.join(' '));
}
