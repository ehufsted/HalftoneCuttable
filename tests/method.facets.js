// Facets: the cell-web engine over Delaunay triangles.
//
// PREDICTIONS. Everything the Voronoi web guarantees, since it is the same engine:
// tone from exact areas, one piece with every web at least the setting (checked
// by the method's own figure, by polygon distance, and by flood fill), edges as
// clean breaks (no facet straddles one) and as metal lines, solid color regions.
// Particular to triangles: the facets tile the piece's inset rectangle exactly,
// and the triangulation reports nothing dropped or malformed.

import { check, section, num, grayRamp, noiseRGBA, makeRGBA, plain } from './runner.js';
import method from '../src/methods/facets.js';
import { pieceCount } from '../src/core/structure.js';
import { rasterizeHoles } from '../src/core/render.js';
import { polyArea, polyDistance } from '../src/core/polygon.js';
import { holeFinishedArea } from '../src/core/holes.js';

const base = { ...plain, widthMm: 60, web: 0.4, minHole: 0.5, kerf: 0.15 };
const split = (l, r) => makeRGBA(300, 200, (x) => (x < 150 ? l : r));

function straddlers(b, x0, tol) {
  let n = 0;
  b.debug.cells.forEach((C) => {
    const cy = (C.ys[0] + C.ys[1] + C.ys[2]) / 3;
    if (cy < 5 || cy > b.heightMm - 5) return;
    if (Math.min(...C.xs) < x0 - tol && Math.max(...C.xs) > x0 + tol) n++;
  });
  return n;
}

function geometricWeb(b, j, kerf) {
  const { cells, cuts } = b.debug;
  let min = Infinity;
  cells.forEach((C, i) => {
    const A = cuts[j][i];
    if (!A) return;
    for (const q of C.lab) if (q > i && cuts[j][q]) min = Math.min(min, polyDistance(A, cuts[j][q]) - kerf);
    for (let k = 0; k < A.xs.length; k++) min = Math.min(min, Math.min(A.xs[k], A.ys[k], b.widthMm - A.xs[k], b.heightMm - A.ys[k]) - kerf / 2);
  });
  return min;
}

export function run() {
  section('method.facets', 'Tiling and a clean triangulation; tone; one piece, three ways; clean breaks and metal lines; solid color; determinism.');

  // ---- tiling, tone
  {
    const b = method.build(grayRamp(300, 200), base, { edges: 'off', pitch: 5 });
    const [x0, y0, x1, y1] = b.debug.rect;
    const tiled = b.debug.cells.reduce((a, C) => a + polyArea(C), 0);
    check('the facets tile the inset rectangle exactly; the triangulation is clean',
      Math.abs(tiled - (x1 - x0) * (y1 - y0)) < 1e-6 * tiled && b.debug.triReport.dropped === 0 && b.debug.triReport.malformed === 0,
      `${b.N} facets covering ${num(100 * tiled / ((x1 - x0) * (y1 - y0)), 5)}%`);
    let t = 0, g = 0;
    for (let i = 0; i < b.N; i++) { t += b.target[i]; g += b.achieved[i]; }
    check('B&W ramp: mean tone matches the target within 1%', Math.abs(g - t) / t < 0.01,
      `target ${num(t / b.N, 4)}, achieved ${num(g / b.N, 4)}`);
    const pre = rasterizeHoles({ ...b, kerf: base.kerf }, b.layers, { maxDim: 1200 });
    let open = 0;
    for (let i = 0; i < pre.w * pre.h; i++) open += pre.counts[2 * i + 1];
    const got = open / (pre.ss * pre.ss * pre.w * pre.h);
    const exact = b.layers[0].reduce((a, h) => a + holeFinishedArea(h, base.kerf / 2), 0) / (b.widthMm * b.heightMm);
    check('preview raster agrees with the exact areas', Math.abs(got - exact) / exact < 0.01,
      `raster ${num(got, 4)}, exact ${num(exact, 4)}`);
  }

  // ---- one piece, three ways
  {
    const cases = [
      ['B&W noise, edges off', noiseRGBA(200, 150, 5, false), {}, { edges: 'off' }],
      ['B&W split, metal lines', split([110, 110, 110], [230, 230, 230]), {}, { edges: 'lines', lineWidth: 1 }],
      ['color noise, mixed, 4 sheets', noiseRGBA(200, 150, 6),
        { mode: 'color', palette: ['#f0f0f0', '#e0b000', '#c01020', '#101010'], reg: 0.3 }, { regions: 'mixed' }],
      ['color split, solid, 3 sheets', split([200, 30, 30], [30, 60, 200]),
        { mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 }, { regions: 'solid', edges: 'lines' }],
    ];
    const fails = [];
    let claimed = Infinity, measured = Infinity;
    for (const [name, rgba, extra, params] of cases) {
      const s = { ...base, ...extra };
      const b = method.build(rgba, s, { pitch: 5, ...params });
      b.layers.forEach((holes, j) => {
        const pieces = pieceCount({ ...b, kerf: s.kerf }, holes, 4 / s.web);
        const g = geometricWeb(b, j, s.kerf);
        claimed = Math.min(claimed, b.webs[j]); measured = Math.min(measured, g);
        if (pieces !== 1) fails.push(`${name} sheet ${j + 1}: ${pieces} pieces`);
        if (b.webs[j] < s.web - 1e-9 || g < s.web - 1e-6) fails.push(`${name} sheet ${j + 1}: web ${num(b.webs[j], 4)} / ${num(g, 4)}`);
      });
    }
    check('every cut sheet is one piece, and no web below the setting (claimed and measured)', fails.length === 0,
      fails.join('; ') || `thinnest claimed ${num(claimed, 4)}, measured ${num(measured, 4)} mm`);
  }

  // ---- edges
  {
    const rgba = split([110, 110, 110], [230, 230, 230]);
    const off = method.build(rgba, base, { edges: 'off', pitch: 5 });
    const brk = method.build(rgba, base, { edges: 'breaks', pitch: 5 });
    const a = straddlers(off, 30, 0.15), c = straddlers(brk, 30, 0.15);
    check('clean breaks: no facet straddles the edge', c === 0 && a > 0, `${c} straddling with breaks, ${a} with edges off`);
    const lines = method.build(rgba, base, { edges: 'lines', lineWidth: 1, pitch: 5 });
    const strip = (b) => {
      const pre = rasterizeHoles({ ...b, kerf: base.kerf }, b.layers, { pxPerMm: 20, superSample: 1 });
      let metal = 0, total = 0;
      for (let py = 100; py < pre.h - 100; py++) for (let px = Math.round(29.65 * 20); px <= Math.round(30.35 * 20); px++) {
        total++; if (pre.counts[2 * (py * pre.w + px)]) metal++;
      }
      return metal / total;
    };
    const fl = strip(lines), fb = strip(brk);
    check('metal lines: a solid strip of metal runs along the edge, and the tone band is the breaks one',
      fl === 1 && fb < 1 && lines.debug.fMaxG === brk.debug.fMaxG,
      `metal within ±0.35 mm: ${num(100 * fl, 1)}% with lines, ${num(100 * fb, 1)}% with breaks`);
  }

  // ---- solid color regions
  {
    const s = { ...base, mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 };
    const b = method.build(split([200, 30, 30], [30, 60, 200]), s, { regions: 'solid', edges: 'breaks', pitch: 5 });
    let wrong = 0;
    b.debug.cells.forEach((C, i) => {
      const cx = (C.xs[0] + C.xs[1] + C.xs[2]) / 3;
      if ((cx < 28 && b.debug.labels[i] !== 1) || (cx > 32 && b.debug.labels[i] !== 2)) wrong++;
    });
    const st = straddlers(b, 30, 0.15);
    check('solid: each side of the color boundary gets its own sheet, and no facet straddles it', wrong === 0 && st === 0,
      `${wrong} facets on the wrong side, ${st} straddling`);
  }

  // ---- determinism
  {
    const rgba = noiseRGBA(150, 100, 9, false);
    const key = (b) => b.layers[0].slice(0, 40).map((h) => `${h.xs[0].toFixed(6)},${h.ys[0].toFixed(6)}`).join(';');
    // edges off: on pure noise the edge detector fires everywhere, nearly every
    // corner is a pinned edge corner, and those do not depend on the seed at all
    const o = { edges: 'off', pitch: 5 };
    const a = method.build(rgba, base, { ...o, seed: 3 }), c = method.build(rgba, base, { ...o, seed: 3 }), d = method.build(rgba, base, { ...o, seed: 4 });
    check('same seed, same facets; another seed, other facets', key(a) === key(c) && key(a) !== key(d),
      `same seed identical: ${key(a) === key(c)}; other seed differs: ${key(a) !== key(d)}`);
  }
}
