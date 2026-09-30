// Voronoi web: tone, one piece per sheet, the web it claims, edges as clean
// breaks and as lines, solid and mixed color regions, determinism.
//
// Tone is checked against the method's own exact areas (`achieved`, from
// polygon.grownArea); the preview raster is checked against those areas
// separately. Structure is checked THREE ways that do not share code: the
// method's own web figure, polygon distances between neighboring holes, and a
// flood fill of a raster of the sheet.

import { check, section, num, grayRamp, noiseRGBA, makeRGBA, plain } from './runner.js';
import method from '../src/methods/voronoiWeb.js';
import { pieceCount } from '../src/core/structure.js';
import { rasterizeHoles } from '../src/core/render.js';
import { holeFinishedArea } from '../src/core/holes.js';
import { polyDistance } from '../src/core/polygon.js';

const base = { ...plain, widthMm: 60, pitch: 3, web: 0.4, minHole: 0.5, kerf: 0.15 };

/** Split image: left half one color, right half another; edge at x = W/2. */
const split = (l, r) => makeRGBA(300, 200, (x) => (x < 150 ? l : r));

function straddlers(b, x0, tol) {
  // cells in the middle band that reach past the edge by more than tol on both sides
  const { cells, seeds } = b.debug;
  let n = 0;
  cells.forEach((C, i) => {
    if (!C || seeds.ys[i] < 5 || seeds.ys[i] > b.heightMm - 5) return;
    const lo = Math.min(...C.xs), hi = Math.max(...C.xs);
    if (lo < x0 - tol && hi > x0 + tol) n++;
  });
  return n;
}

/** Independent web check: distances between finished holes, and to the outline. */
function geometricWeb(b, j, kerf) {
  const { cells, cuts } = b.debug;
  let min = Infinity;
  cells.forEach((C, i) => {
    const A = cuts[j][i];
    if (!A) return;
    for (const q of C.lab) {
      if (q > i && cuts[j][q]) min = Math.min(min, polyDistance(A, cuts[j][q]) - kerf);
    }
    for (let k = 0; k < A.xs.length; k++) {
      const edge = Math.min(A.xs[k], A.ys[k], b.widthMm - A.xs[k], b.heightMm - A.ys[k]) - kerf / 2;
      min = Math.min(min, edge);
    }
  });
  return min;
}

export function run() {
  section('method.voronoiWeb', 'Tone from exact areas; one piece, checked three ways; edges as breaks and as lines; solid and mixed color regions.');

  // ---- tone on a ramp
  {
    const b = method.build(grayRamp(300, 200), base, { edges: 'off' });
    let tSum = 0, gSum = 0, abs = 0;
    for (let i = 0; i < b.N; i++) {
      tSum += b.target[i]; gSum += b.achieved[i];
      abs += Math.abs(b.target[i] - b.achieved[i]);
    }
    check('B&W ramp: mean tone matches the target within 1%', Math.abs(gSum - tSum) / tSum < 0.01,
      `target ${num(tSum / b.N, 4)}, achieved ${num(gSum / b.N, 4)}, ${b.N} cells`);
    check('B&W ramp: per-cell error is small', abs / b.N < 0.02, `mean |Δ| ${num(abs / b.N, 4)} (linear)`);

    const pre = rasterizeHoles({ ...b, kerf: base.kerf }, b.layers, { maxDim: 1200 });
    let open = 0;
    for (let i = 0; i < pre.w * pre.h; i++) open += pre.counts[2 * i + 1];
    const rasterOpen = open / (pre.ss * pre.ss * pre.w * pre.h);
    const exact = b.layers[0].reduce((a, h) => a + holeFinishedArea(h, base.kerf / 2), 0) / (b.widthMm * b.heightMm);
    check('preview raster agrees with the exact areas', Math.abs(rasterOpen - exact) / exact < 0.01,
      `raster ${num(rasterOpen, 4)}, exact ${num(exact, 4)}`);
  }

  // ---- one piece, three ways, across the settings that change the geometry
  {
    const cases = [
      ['B&W noise, edges off', noiseRGBA(200, 150, 5, false), {}, { edges: 'off' }],
      ['B&W split, metal lines', split([110, 110, 110], [230, 230, 230]), {}, { edges: 'lines', lineWidth: 1 }],
      ['color noise, mixed, 4 sheets', noiseRGBA(200, 150, 6),
        { mode: 'color', palette: ['#f0f0f0', '#e0b000', '#c01020', '#101010'], reg: 0.3 }, { regions: 'mixed' }],
      ['color split, solid, 3 sheets, lines', split([200, 30, 30], [30, 60, 200]),
        { mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 }, { regions: 'solid', edges: 'lines' }],
    ];
    const fails = [], webFails = [];
    let claimed = Infinity, measured = Infinity;
    for (const [name, rgba, extra, params] of cases) {
      const s = { ...base, ...extra };
      const b = method.build(rgba, s, params);
      b.layers.forEach((holes, j) => {
        const pieces = pieceCount({ ...b, kerf: s.kerf }, holes, 4 / s.web);
        if (pieces !== 1) fails.push(`${name} sheet ${j + 1}: ${pieces} pieces`);
        claimed = Math.min(claimed, b.webs[j]);
        const g = geometricWeb(b, j, s.kerf);
        measured = Math.min(measured, g);
        if (b.webs[j] < s.web - 1e-9 || g < s.web - 1e-6) webFails.push(`${name} sheet ${j + 1}: claimed ${num(b.webs[j], 4)}, measured ${num(g, 4)}`);
      });
    }
    check('every cut sheet is one piece (flood fill at 4 px per web)', fails.length === 0, fails.join('; ') || `${cases.length} configurations`);
    check('no web below the setting, by the method’s account and by polygon distance', webFails.length === 0,
      webFails.join('; ') || `thinnest claimed ${num(claimed, 4)}, measured ${num(measured, 4)} mm`);
  }

  // ---- edges: clean breaks put a wall on the edge; off does not
  {
    const rgba = split([110, 110, 110], [230, 230, 230]);
    const off = method.build(rgba, base, { edges: 'off' });
    const brk = method.build(rgba, base, { edges: 'breaks' });
    const tol = 0.15;
    const a = straddlers(off, 30, tol), c = straddlers(brk, 30, tol);
    check('clean breaks: no cell straddles the edge', c === 0 && a > 0,
      `${c} straddling with breaks, ${a} with edges off`);

    // metal along the edge: fully solid within ±0.35 mm of it for lines, not for breaks
    const stripMetal = (b) => {
      const pre = rasterizeHoles({ ...b, kerf: base.kerf }, b.layers, { pxPerMm: 20, superSample: 1 });
      let metal = 0, total = 0;
      for (let py = Math.round(5 * 20); py < pre.h - 5 * 20; py++) {
        for (let px = Math.round((30 - 0.35) * 20); px <= Math.round((30 + 0.35) * 20); px++) {
          total++;
          if (pre.counts[2 * (py * pre.w + px)]) metal++;
        }
      }
      return metal / total;
    };
    const lines = method.build(rgba, base, { edges: 'lines', lineWidth: 1 });
    const fl = stripMetal(lines), fb = stripMetal(brk);
    check('metal lines: a solid strip of metal runs along the edge', fl === 1 && fb < 1,
      `metal within ±0.35 mm: ${num(100 * fl, 1)}% with lines, ${num(100 * fb, 1)}% with breaks`);
    // The line is extra metal at the edge only: the tone band everywhere else must
    // not shrink to pay for it (it did once -- a third of the cells in a busy
    // photo carry a line, and they were setting the band for the whole piece).
    const gb = brk.debug.fMaxG, gl = lines.debug.fMaxG;
    check('metal lines: the tone band is the one clean breaks get (same seeds, same cells)', gl === gb,
      `band ${num(gb, 4)} with breaks, ${num(gl, 4)} with lines`);
  }

  // ---- solid color regions
  {
    const s = { ...base, mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 };
    const b = method.build(split([200, 30, 30], [30, 60, 200]), s, { regions: 'solid', edges: 'breaks' });
    const { labels, cuts, margins, seeds } = b.debug;
    let wrongSide = 0, redCut = 0, blueMismatch = 0, notHidden = 0, blueCells = 0;
    for (let i = 0; i < b.N; i++) {
      const x = seeds.xs[i];
      if ((x < 28 && labels[i] !== 1) || (x > 32 && labels[i] !== 2)) wrongSide++;
      if (labels[i] === 1 && cuts[1][i]) redCut++;
      if (labels[i] === 2) {
        blueCells++;
        if (!!cuts[0][i] !== !!cuts[1][i]) blueMismatch++;
        if (cuts[0][i] && Math.abs(margins[0][i] - margins[1][i] - s.reg) > 1e-9) notHidden++;
      }
    }
    check('solid: each side of the color boundary gets its own sheet', wrongSide === 0, `${wrongSide} cells on the wrong side`);
    check('solid: red cells cut only the top sheet', redCut === 0, `${redCut} red cells cut through the red sheet`);
    check('solid: blue cells cut both sheets above the base, or neither', blueMismatch === 0, `${blueMismatch} of ${blueCells}`);
    check('solid: the hidden hole is exactly the registration allowance wider all round', notHidden === 0, `${notHidden} of ${blueCells}`);
    check('solid: no cell straddles the color boundary', straddlers(b, 30, 0.15) === 0, `${straddlers(b, 30, 0.15)} straddling`);
    let worst = 0, wi = 0;
    for (let k = 0; k < b.N * 3; k++) {
      const e = Math.abs(b.achieved[k] - b.target[k]);
      if (e > worst) { worst = e; wi = (k / 3) | 0; }
    }
    const wc = `cell at (${num(seeds.xs[wi], 1)}, ${num(seeds.ys[wi], 1)}), sheet ${labels[wi] + 1}, ${cuts[0][wi] ? 'holed' : 'no hole'}`;
    const mean = Array.from(b.achieved).reduce((a, v, k) => a + Math.abs(v - b.target[k]), 0) / (b.N * 3);
    check('solid: cells hit their color', mean < 0.01, `mean |Δ| ${num(mean, 4)}, worst ${num(worst, 3)} (linear) at the ${wc}`);
  }

  // ---- mixed color regions nest smaller, by the registration allowance
  {
    const s = { ...base, mode: 'color', palette: ['#f0f0f0', '#c01020', '#101010'], reg: 0.3 };
    const b = method.build(noiseRGBA(200, 150, 8), s, { regions: 'mixed' });
    const { cuts, margins } = b.debug;
    let bad = 0, deep = 0;
    for (let i = 0; i < b.N; i++) {
      if (!cuts[1][i]) continue;
      deep++;
      if (!cuts[0][i] || margins[1][i] < margins[0][i] + s.reg - 1e-9) bad++;
    }
    check('mixed: every deeper hole sits inside the one above, less the allowance', bad === 0, `${bad} of ${deep}`);
  }

  // ---- determinism, and the seed does something
  {
    const rgba = noiseRGBA(150, 100, 9, false);
    const key = (b) => b.layers[0].slice(0, 50).map((h) => `${h.xs[0].toFixed(6)},${h.ys[0].toFixed(6)}`).join(';');
    const a = method.build(rgba, base, { seed: 3 }), c = method.build(rgba, base, { seed: 3 }), d = method.build(rgba, base, { seed: 4 });
    check('same seed, same holes; another seed, other holes', key(a) === key(c) && key(a) !== key(d));
  }
}
