// Convex polygon toolkit: the Voronoi web's geometry.
//
// PREDICTION. Insetting a rectangle by per-edge offsets gives exactly the smaller
// rectangle, labels intact. Growing a polygon by a disc of radius d has area
// A + P·d + π·d² (Steiner), and a raster of the grown-inside test must agree.

import { check, section, num, mkRand } from './runner.js';
import {
  rectPoly, polyArea, polyPerimeter, clipHalfPlane, insetConvex, minWidth, grownArea,
  insideGrown, polyDistance,
} from '../src/core/polygon.js';

function randomConvex(rand, n = 7) {
  // points on a jittered circle, in increasing angle: convex, positive area
  const ang = Array.from({ length: n }, (_, i) => (i + 0.2 + 0.6 * rand()) * (2 * Math.PI / n)).sort((a, b) => a - b);
  const r = 1 + rand();
  return { xs: ang.map((a) => 5 + r * Math.cos(a)), ys: ang.map((a) => 5 + r * Math.sin(a)), lab: ang.map((_, i) => i) };
}

export function run() {
  section('core.polygon', 'Clip, per-edge inset, width, Steiner area against a raster, distance.');
  const rand = mkRand(21);

  const R = rectPoly(0, 0, 4, 2);
  check('rectangle has positive area 8 and perimeter 12',
    Math.abs(polyArea(R) - 8) < 1e-12 && Math.abs(polyPerimeter(R) - 12) < 1e-12);

  const cut = clipHalfPlane(R, 1, 0, 3, 7);   // keep x <= 3
  check('clip keeps x ≤ 3 and labels the new edge', Math.abs(polyArea(cut) - 6) < 1e-12 && cut.lab.includes(7) &&
    cut.lab.filter((l) => l === -1).length === 3, `area ${num(polyArea(cut), 6)}, labels ${cut.lab.join(',')}`);

  // edges of rectPoly: top (y=0), right (x=4), bottom (y=2), left (x=0)
  const ins = insetConvex(R, [0.1, 0.2, 0.3, 0.4]);
  const xs = ins.xs.slice().sort((a, b) => a - b), ys = ins.ys.slice().sort((a, b) => a - b);
  check('per-edge inset moves each edge by its own offset',
    Math.abs(xs[0] - 0.4) < 1e-12 && Math.abs(xs[3] - 3.8) < 1e-12 && Math.abs(ys[0] - 0.1) < 1e-12 && Math.abs(ys[3] - 1.7) < 1e-12,
    `x ${num(xs[0], 3)}…${num(xs[3], 3)}, y ${num(ys[0], 3)}…${num(ys[3], 3)}`);
  check('an inset past the middle is empty', insetConvex(R, [1.1, 0, 1, 0]) === null);
  check('min width of a 4×2 rectangle is 2', Math.abs(minWidth(R) - 2) < 1e-12);

  let worst = 0, badLabel = 0;
  for (let t = 0; t < 30; t++) {
    const P = randomConvex(rand);
    const o = 0.05 + 0.2 * rand();
    const Q = insetConvex(P, P.xs.map(() => o));
    // an inset by o keeps every vertex at least o inside every original edge
    const n = P.xs.length;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      const ex = P.xs[j] - P.xs[k], ey = P.ys[j] - P.ys[k], L = Math.hypot(ex, ey);
      for (let i = 0; i < Q.xs.length; i++) {
        const dIn = (-ey * (Q.xs[i] - P.xs[k]) + ex * (Q.ys[i] - P.ys[k])) / L;
        worst = Math.max(worst, o - dIn);
      }
    }
    for (const l of Q.lab) if (!P.lab.includes(l)) badLabel++;
  }
  check('uniform inset of random convex polygons keeps its distance from every edge', worst < 1e-9,
    `worst shortfall ${worst.toExponential(2)}`);
  check('inset labels are the original edges’', badLabel === 0);

  worst = 0;
  for (let t = 0; t < 8; t++) {
    const P = randomConvex(rand);
    const d = 0.05 + 0.2 * rand();
    const n = 700, x0 = 2, s = 6 / n;
    let inside = 0;
    for (let j = 0; j < n; j++) {
      const y = x0 + (j + 0.5) * s + 0.31 * s;
      for (let i = 0; i < n; i++) if (insideGrown(P, d, x0 + (i + 0.5) * s + 0.27 * s, y)) inside++;
    }
    const e = Math.abs(inside * s * s - grownArea(P, d)) / grownArea(P, d);
    worst = Math.max(worst, e);
  }
  check('Steiner area of the grown polygon matches a 700×700 raster within 0.5%', worst < 0.005,
    `worst ${num(100 * worst, 3)}%`);

  const A = rectPoly(0, 0, 1, 1), B = rectPoly(1.5, 0.2, 2, 3);
  check('distance between two rectangles', Math.abs(polyDistance(A, B) - 0.5) < 1e-12, num(polyDistance(A, B), 6));
}
