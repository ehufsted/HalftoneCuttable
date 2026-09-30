// Voronoi cells by clipping, and the nearest-seed lookup.
//
// PREDICTION. The cells tile the clip rectangle exactly (areas sum to it), each
// seed lies in its own cell, neighbor labels are mutual, and every point of a
// cell is at least as close to its own seed as to any other -- checked by brute
// force, so the early stop in the ring search cannot hide a missed neighbor.

import { check, section, num, mkRand } from './runner.js';
import { SeedHash, voronoiCells } from '../src/core/voronoi.js';
import { polyArea } from '../src/core/polygon.js';

export function run() {
  section('core.voronoi', 'Tiling, ownership, mutual neighbors and nearest-seed, against brute force.');
  const rand = mkRand(33);
  const rect = [0.5, 0.5, 29.5, 19.5];
  const N = 400;
  // clustered as well as uniform, so bucket rings of very different occupancy are exercised
  const xs = new Float64Array(N), ys = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const c = i < 150;
    xs[i] = c ? 5 + rand() * 4 : rect[0] + rand() * (rect[2] - rect[0]);
    ys[i] = c ? 5 + rand() * 4 : rect[1] + rand() * (rect[3] - rect[1]);
  }
  const hash = new SeedHash(xs, ys, 0, 0, 30, 20, 2);
  const cells = voronoiCells(xs, ys, rect, hash);

  const total = cells.reduce((a, C) => a + (C ? polyArea(C) : 0), 0);
  const want = (rect[2] - rect[0]) * (rect[3] - rect[1]);
  check('cells tile the rectangle', Math.abs(total - want) / want < 1e-9, `Σ area ${num(total, 6)} of ${num(want, 6)}`);

  const brute = (x, y) => {
    let b = -1, bd = Infinity;
    for (let j = 0; j < N; j++) {
      const d = (xs[j] - x) ** 2 + (ys[j] - y) ** 2;
      if (d < bd) { bd = d; b = j; }
    }
    return [b, bd];
  };

  let notMutual = 0, wrongOwner = 0, samples = 0;
  for (let i = 0; i < N; i++) {
    const C = cells[i];
    for (const q of C.lab) if (q >= 0 && !cells[q].lab.includes(i)) notMutual++;
    // vertices pulled a little towards the seed, and edge midpoints likewise
    for (let k = 0; k < C.xs.length; k++) {
      const k2 = (k + 1) % C.xs.length;
      for (const [px, py] of [[C.xs[k], C.ys[k]], [(C.xs[k] + C.xs[k2]) / 2, (C.ys[k] + C.ys[k2]) / 2]]) {
        const x = px + 1e-6 * (xs[i] - px), y = py + 1e-6 * (ys[i] - py);
        const [, bd] = brute(x, y);
        const own = (xs[i] - x) ** 2 + (ys[i] - y) ** 2;
        samples++;
        if (own > bd + 1e-9) wrongOwner++;
      }
    }
  }
  check('neighbor labels are mutual', notMutual === 0, `${notMutual} one-sided`);
  check('every cell point is nearest its own seed (brute force)', wrongOwner === 0, `${wrongOwner} of ${samples} samples`);

  let wrong = 0;
  for (let t = 0; t < 2000; t++) {
    const x = rand() * 30, y = rand() * 20;
    const [b, bd] = brute(x, y);
    const h = hash.nearest(x, y);
    if (h !== b && (xs[h] - x) ** 2 + (ys[h] - y) ** 2 > bd + 1e-12) wrong++;
  }
  check('nearest() agrees with brute force, including outside the rectangle', wrong === 0, `${wrong} of 2000`);
}
