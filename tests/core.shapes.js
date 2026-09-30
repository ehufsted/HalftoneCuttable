// The hole family: area law, its inverse, the kerf offset, the axis extent.
//
// PREDICTION. For a rounded square of side a and radius r, area = a² − (4−π)r²,
// and a raster of the signed-distance test must agree to sampling error. The cut
// path grown back by kerf/2 (a Minkowski sum with a disc) must give back the
// finished hole exactly: area(cut) + perimeter(cut)·k/2 + π(k/2)² = area(finished).

import { check, section, num } from './runner.js';
import {
  finished, cutPath, areaOf, perimeterOf, extentOf, openFraction, sizeFor, maxSize, sdf,
} from '../src/core/shapes.js';

const SPECS = [];
for (const shape of ['circle', 'square', 'diamond']) {
  for (const rounding of shape === 'circle' ? [0] : [0, 0.5]) {
    for (const kerf of [0, 0.2]) SPECS.push({ shape, rounding, kerf });
  }
}
const tag = (s) => `${s.shape}${s.shape === 'circle' ? '' : ` r${s.rounding}`} k${s.kerf}`;

/**
 * Area by raster, over the hole's own bounding box (so resolution scales with the
 * hole) and at an irrational phase: an axis-aligned edge held at one phase against
 * the sample grid miscounts a whole row every time -- 2.6% on a small square
 * sampled over the whole cell, before this was changed.
 */
function rasterArea(g, s, n = 600) {
  const half = 0.6 * s;
  const step = (2 * half) / n;
  const phase = 0.3183 * step;
  let inside = 0;
  for (let j = 0; j < n; j++) {
    const y = -half + (j + 0.5) * step + phase;
    for (let i = 0; i < n; i++) {
      if (sdf(g, -half + (i + 0.5) * step + phase, y) < 0) inside++;
    }
  }
  return inside * step * step;
}

export function run() {
  section('core.shapes', 'Area law against a raster of the inside test; size inverse; kerf offset; extent.');
  const p = 4;

  let worst = 0, worstAt = '';
  for (const spec of SPECS) {
    for (const s of [0.6, 1.7, 3.2]) {
      const g = finished(spec, s);
      const a = areaOf(g), r = rasterArea(g, s);
      const e = Math.abs(r - a) / a;
      if (e > worst) { worst = e; worstAt = `${tag(spec)} s=${s}`; }
    }
  }
  check('area law matches a 600×600 raster of the hole within 0.5%', worst < 0.005, `worst ${num(100 * worst, 3)}% at ${worstAt}`);

  worst = 0;
  for (const spec of SPECS) {
    const sMax = maxSize(p, 0.5);
    for (const f of [0.02, 0.1, 0.3, 0.5]) {
      if (f > openFraction(spec, sMax, p)) continue;
      const s = sizeFor(spec, f, p, sMax);
      worst = Math.max(worst, Math.abs(openFraction(spec, s, p) - f));
    }
  }
  check('sizeFor inverts openFraction', worst < 1e-6, `worst |Δf| ${worst.toExponential(2)}`);

  worst = 0; worstAt = '';
  for (const spec of SPECS) {
    if (spec.kerf === 0) continue;
    for (const s of [0.6, 1.7, 3.2]) {
      const g = finished(spec, s), c = cutPath(spec, s);
      const k = spec.kerf / 2;
      const grown = areaOf(c) + perimeterOf(c) * k + Math.PI * k * k;
      const e = Math.abs(grown - areaOf(g)) / areaOf(g);
      if (e > worst) { worst = e; worstAt = `${tag(spec)} s=${s}`; }
    }
  }
  check('cut path + kerf/2 = finished hole (Minkowski area)', worst < 1e-9, `worst ${worst.toExponential(2)} at ${worstAt}`);

  let bad = '';
  for (const spec of SPECS) {
    if (spec.kerf === 0) continue;
    const g = finished(spec, 3);
    if (g.r < spec.kerf / 2 - 1e-12) bad = tag(spec);
  }
  check('every finished corner is at least kerf/2 round (the beam cannot do better)', !bad, bad || 'all shapes');

  worst = 0; worstAt = '';
  for (const spec of SPECS) {
    const g = finished(spec, 3);
    // walk out along +x until outside
    let x = 0;
    while (sdf(g, x, 0) < 0) x += 1e-4;
    const e = Math.abs(2 * x - extentOf(g));
    if (e > worst) { worst = e; worstAt = tag(spec); }
  }
  check('extentOf matches the inside test along the axis', worst < 1e-3, `worst ${num(worst, 5)} mm at ${worstAt}`);

  bad = '';
  for (const spec of SPECS) {
    const g = finished(spec, 3);
    if (extentOf(g) > 3 + 1e-9) bad = tag(spec);
  }
  check('extent never exceeds the nominal size (so sMax = pitch − web is conservative)', !bad, bad || 'all shapes');
}
