// Square grid: tone, the dither gap, the stack invariants, determinism.
//
// Tone is checked against the ANALYTIC open area of the holes the method chose,
// not a raster, so a sampling bias cannot pass for a method error or hide one.
// The raster instrument (render.measureCells, what the app's fidelity score uses)
// is checked separately, against the same analytic numbers.

import { check, section, num, grayRamp, flatGray, noiseRGBA, plain } from './runner.js';
import { prepare } from '../src/core/units.js';
import { stackColors } from '../src/core/separate.js';
import { holeTables, measureCells, cellColors } from '../src/core/render.js';
import { toEncoded } from '../src/core/color.js';
import method from '../src/methods/squareGrid.js';

function setup(rgba, settings, params = {}) {
  const ctx = { ...prepare(rgba, { ...plain, ...settings }), shape: 'circle', rounding: 0,
    range: 'squeeze', diffuse: true, ...params };
  const res = method.run(ctx);
  return { ctx, res, lim: method.limits(ctx), target: method.targetImage(ctx) };
}

// Sizes are stored as Float32: a hole cut exactly at a limit reads back a few
// 1e-7 mm either side of it.
const F32 = 1e-5;

export function run() {
  section('method.squareGrid', 'Tone against the analytic hole areas; the dither gap below the smallest hole; stack nesting; determinism.');

  // ---- B&W ramp, no floor: every cell can be exact, so columns must track.
  {
    const { ctx, res, lim, target } = setup(grayRamp(380, 120), {});
    const got = stackColors(ctx, res.sizes, lim.spec);
    let worst = 0;
    for (let i = 0; i < ctx.cols; i++) {
      let t = 0, g = 0;
      for (let j = 0; j < ctx.rows; j++) { t += target[j * ctx.cols + i]; g += got[j * ctx.cols + i]; }
      worst = Math.max(worst, Math.abs(t - g) / ctx.rows);
    }
    check('B&W ramp: every column averages to its target', worst < 1e-3, `worst |Δ| ${num(worst, 5)} (linear), ${ctx.cols}×${ctx.rows} cells`);

    const white = setup(flatGray(40, 40, 255), {}).target;
    const black = setup(flatGray(40, 40, 0), {}).target;
    const top = Math.min(...white), bottom = Math.max(...black);
    check('B&W squeeze: white maps to fMax, black to 0',
      Math.abs(top - lim.fMax) < 1e-6 && bottom < 1e-9,
      `white → ${num(top, 5)}, black → ${num(bottom, 5)}, fMax ${num(lim.fMax, 5)}`);

    const fr = measureCells(ctx, holeTables(ctx, res.sizes, lim.spec));
    const meas = cellColors(ctx, fr, ctx.palette);
    let mean = 0;
    for (let c = 0; c < meas.length; c++) mean += Math.abs(meas[c] - got[c]) / meas.length;
    check('raster instrument (16×16 per cell) agrees with the analytic areas', mean < 0.012, `mean |Δ| ${num(mean, 4)}`);
  }

  // ---- The dither gap: a flat tone whose hole would be below the floor.
  {
    const probe = setup(flatGray(4, 4, 128), { widthMm: 150, minHole: 1.2 });
    const want = 0.4 * probe.lim.fFloor;                      // well inside the gap
    const v = Math.round(255 * toEncoded(want / probe.lim.fMax));
    const { ctx, res, lim, target } = setup(flatGray(300, 300, v), { widthMm: 150, minHole: 1.2 });
    const sz = res.sizes[0];
    let illegal = 0, holes = 0;
    for (const s of sz) {
      if (s > 0) holes++;
      if (s > 0 && s < lim.sFloor - F32) illegal++;
    }
    const got = stackColors(ctx, res.sizes, lim.spec);
    const tMean = target.reduce((a, b) => a + b, 0) / target.length;
    const gMean = got.reduce((a, b) => a + b, 0) / got.length;
    check('dither gap: no hole below the floor size', illegal === 0, `${illegal} illegal of ${holes} holes, floor ${num(lim.sFloor, 2)} mm`);
    check('dither gap: the mean tone survives (within 5%)', Math.abs(gMean - tMean) / tMean < 0.05,
      `target ${num(tMean, 4)}, got ${num(gMean, 4)} with ${Math.round((100 * holes) / sz.length)}% of cells holed`);

    const off = setup(flatGray(300, 300, v), { widthMm: 150, minHole: 1.2 }, { diffuse: false });
    const uniq = new Set(off.res.sizes[0]);
    check('diffusion off: a flat tone gives one hole size everywhere', uniq.size === 1, `${uniq.size} distinct sizes`);
  }

  // ---- Stack invariants on color noise, with every limit switched on.
  {
    const settings = { mode: 'color', palette: ['#f0f0f0', '#e0b000', '#c01020', '#101010'],
      widthMm: 90, minHole: 0.5, kerf: 0.1, reg: 0.3 };
    const { res, lim } = setup(noiseRGBA(200, 200, 3), settings, { shape: 'square', rounding: 0.3 });
    let nest = 0, over = 0, under = 0, total = 0;
    const [s0, s1, s2] = res.sizes;
    for (let c = 0; c < s0.length; c++) {
      for (const [a, b] of [[s0, s1], [s1, s2]]) {
        if (b[c] > 0 && b[c] > a[c] - 2 * 0.3 + F32) nest++;
      }
      for (const s of [s0[c], s1[c], s2[c]]) {
        if (s > 0) total++;
        if (s > lim.sMax + F32) over++;
        if (s > 0 && s < lim.sFloor - F32) under++;
      }
    }
    check('stack: each hole sits inside the one above, less the registration allowance', nest === 0, `${nest} violations, ${total} holes`);
    check('stack: no hole above sMax or below the floor', over + under === 0, `${over} over, ${under} under`);
  }

  // ---- Color fidelity where nothing constrains the stack: exact.
  {
    const settings = { mode: 'color', palette: ['#e8e0c0', '#3060c0', '#200810'] };
    const { ctx, res, lim, target } = setup(noiseRGBA(200, 200, 5), settings);
    const got = stackColors(ctx, res.sizes, lim.spec);
    let worst = 0;
    for (let c = 0; c < got.length; c++) worst = Math.max(worst, Math.abs(got[c] - target[c]));
    check('color, no floor/kerf/registration: every cell hits its target', worst < 1e-4, `worst |Δ| ${worst.toExponential(2)}`);
  }

  // ---- Determinism.
  {
    const a = setup(noiseRGBA(120, 120, 9), { mode: 'color', palette: ['#ffffff', '#ff0000', '#000000'], minHole: 0.8 });
    const b = setup(noiseRGBA(120, 120, 9), { mode: 'color', palette: ['#ffffff', '#ff0000', '#000000'], minHole: 0.8 });
    const same = a.res.sizes.every((s, j) => s.every((v, i) => v === b.res.sizes[j][i]));
    check('two runs on the same input are identical', same);
  }
}
