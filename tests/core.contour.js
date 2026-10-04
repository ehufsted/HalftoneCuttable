// core/contour.js: marching-squares loops. The prediction: read even-odd, the
// traced loops enclose exactly the samples below the level, and every loop is
// closed (no edge longer than a cell's diagonal) -- on any field: noise, where
// saddle cells (two diagonal corners inside) are everywhere, and integer
// fields contoured at an integer, where samples lie exactly on the level (as
// the stencil's signed distance does at -kerf/2 when that is half a pixel).

import { check, section, mkRand } from './runner.js';
import { traceLoops } from '../src/core/contour.js';
import { polyArea } from '../src/core/polygon.js';

/** Even-odd: is (x, y) inside the loops? */
function inside(loops, x, y) {
  let c = false;
  for (const L of loops) {
    for (let i = 0, n = L.xs.length, j = n - 1; i < n; j = i++) {
      const yi = L.ys[i], yj = L.ys[j];
      if ((yi > y) !== (yj > y) && x < ((L.xs[j] - L.xs[i]) * (y - yi)) / (yj - yi) + L.xs[i]) c = !c;
    }
  }
  return c;
}

/** The longest edge of any loop, closing edges included. */
const longestEdge = (loops) => Math.max(0, ...loops.map((L) => {
  let m = 0;
  for (let i = 0, n = L.xs.length; i < n; i++) {
    const j = (i + 1) % n;
    m = Math.max(m, Math.hypot(L.xs[j] - L.xs[i], L.ys[j] - L.ys[i]));
  }
  return m;
}));

export function run() {
  section('core.contour', 'Marching squares: the loops, read even-odd, enclose exactly the samples below the level, and every loop closes -- saddles and samples exactly at the level included.');

  for (const [name, w, h, fn, level] of [
    ['noise', 40, 30, (() => { const r = mkRand(7); return () => r(); })(), 0.5],
    ['checkerboard (all saddles)', 12, 12, (x, y) => ((x + y) & 1 ? 0.9 : 0.1), 0.5],
    ['integers at an integer level (samples on the level)', 40, 30, (x, y) => (x * 7 + y * 13 + ((x * y) % 5)) % 3, 1],
  ]) {
    const field = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) field[y * w + x] = fn(x, y);
    const loops = traceLoops(field, w, h, level);
    let wrong = 0, below = 0, on = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = field[y * w + x];
        if (f === level) { on++; continue; }            // on the contour: neither inside nor out
        below += f < level;
        if (inside(loops, x + 0.5, y + 0.5) !== (f < level)) wrong++;
      }
    }
    const longest = longestEdge(loops);
    check(`${name}: every loop closes, and the loops enclose exactly the samples below the level`,
      wrong === 0 && longest <= Math.SQRT2 + 1e-9,
      `${wrong} of ${w * h - on} samples wrong${on ? ` (${on} on the level)` : ''}, ${loops.length} loops, longest edge ${longest.toFixed(2)} px`);
    // inside on one side of every loop: the signed areas, summed, are the
    // inside's area -- about a unit per inside sample (the contour runs between
    // samples). Broken loops left 0.14 and 0.35 of it on the first two.
    const net = loops.reduce((a, L) => a + polyArea(L), 0);
    check(`${name}: the loops are oriented consistently (signed areas sum to the inside’s)`,
      Math.abs(net / below - 1) < 0.3, `net signed area ${net.toFixed(1)} for ${below} samples inside`);
  }
}
