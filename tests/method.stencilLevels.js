// Stencil brightness layers: N extra sheets per color, cut along isocontours of
// the luminance inside that color's region, stacked on top of that color's own
// sheet, brighter higher.
//
// The predictions: levels sit evenly across the range present in the region, in
// encoded or linear values as asked; each layer's metal edge lies on its
// isocontour; the layers nest (each one's metal inside the one below); a layer is
// cut wherever a deeper color shows and metal wherever a sheet above hides it;
// every layer is one piece, held by bridges or cut free; and turning the option
// off changes nothing.
//
// Geometry is read back from the traced contours on an independent raster at
// 20 px/mm (render.rasterizeHoles), as in method.stencil.

import { check, section, num, makeRGBA, plain, metalOf, thickPieces } from './runner.js';
import method from '../src/methods/stencil.js';
import { pieceCount } from '../src/core/structure.js';
import { toEncoded, toLinear, fadedRGB, hexToLinear, luminance } from '../src/core/color.js';
import { physicalStack } from '../src/core/stack.js';
import { levelFileName, sheetFileName } from '../src/core/names.js';

const base = { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15 };
const PX = 20;
const RAMP_TOP = 0.45;     // encoded value at the ramp's light end

/** 300×200 px (60×40 mm): a gray ramp, encoded 0 at the left to RAMP_TOP at
 * x = 40 mm -- all darker than the threshold, so all metal on the main sheet --
 * then white (cut) to the right. */
const ramp = () => makeRGBA(300, 200, (x) => {
  if (x >= 200) return [255, 255, 255];
  const v = Math.round(255 * RAMP_TOP * x / 199);
  return [v, v, v];
});
/** Where the ramp reaches encoded value e, in mm (pixel centers at (x+0.5)/5). */
const rampAt = (e) => ((e / RAMP_TOP) * 199 + 0.5) / 5;

/** A sheet's metal at PX px/mm, with this file's kerf (runner.metalOf). */
const metal = (b, holes) => metalOf(b, holes, base.kerf, PX);

/** First metal x (mm) along row y, scanning right from x0. */
function firstMetal(m, ymm, x0, x1) {
  const row = Math.floor(ymm * PX);
  for (let i = Math.floor(x0 * PX); i < Math.floor(x1 * PX); i++) if (m.M[row * m.w + i]) return (i + 0.5) / PX;
  return NaN;
}

const key = (holes) => holes.map((L) => `${L.xs.length}:${L.xs[0].toFixed(6)}:${L.ys[0].toFixed(6)}`).join(';');

export function run() {
  section('method.stencilLevels', 'Brightness layers: evenly spaced levels, edges on the isocontours, nesting, stacking by color, one piece, off changes nothing.');

  // ---- off changes nothing
  {
    const img = ramp();
    const a = method.build(img, base, {}), b = method.build(img, base, { levels: 0 });
    check('off: no brightness layers, and the sheets are exactly as without the option',
      a.levels.length === 0 && b.levels.length === 0 && key(a.layers[0]) === key(b.layers[0]) && a.note === b.note);
    const h = method.build(img, base, { halftone: true, levels: 3 });
    check('halftone inside shapes ignores the option', h.levels.length === 0);
  }

  // ---- B&W ramp, encoded spacing
  const N = 3;
  const enc = method.build(ramp(), base, { levels: N, smooth: 0 });
  {
    const C = enc.levels;
    check('B&W: N layers, all on the metal sheet, top level first',
      C.length === N && C.every((c) => c.color === 0 && c.of === N) && C.map((c) => c.level).join() === '3,2,1',
      `levels ${C.map((c) => c.level).join(', ')}`);
    const [lo, hi] = C[0].range;
    check('encoded: the range is the one present in the region (1st to 99th percentile)', lo < 0.02 && hi > RAMP_TOP - 0.01 && hi <= 0.51,
      `${num(lo, 4)} to ${num(hi, 4)} encoded (the ramp runs 0 to ${RAMP_TOP}, the threshold is 0.5)`);
    const vals = C.map((c) => c.value).reverse();
    const stepWant = (hi - lo) / (N + 1);
    const steps = vals.map((v, i) => v - (i ? vals[i - 1] : lo));
    check('encoded: levels evenly spaced across that range, none at its ends',
      steps.every((s) => Math.abs(s - stepWant) < 1e-6) && vals[N - 1] < hi - stepWant / 2,
      `levels ${vals.map((v) => num(v, 3)).join(', ')}, step ${num(stepWant, 4)}`);

    const errs = C.map((c) => firstMetal(metal(enc, c.holes), 20, 3, 39.5) - rampAt(c.value));
    check('encoded: each layer’s metal starts on its isocontour', errs.every((e) => Math.abs(e) < 0.3),
      `edge − isocontour ${errs.map((e) => num(e, 3)).join(', ')} mm`);

    const ms = C.map((c) => metal(enc, c.holes));
    const area = ms.map((m) => m.M.reduce((a, v) => a + v, 0));
    let outside = 0, upper = 0;
    for (let i = 0; i + 1 < N; i++) {
      const hiM = ms[i].M, loM = ms[i + 1].M;
      for (let q = 0; q < hiM.length; q++) if (hiM[q]) { upper++; if (!loM[q]) outside++; }
    }
    check('brighter is higher: each layer’s metal lies inside the one below it, and is smaller',
      area[0] < area[1] && area[1] < area[2] && outside / upper < 0.005,
      `metal areas top to bottom ${area.map((a) => num(a / (PX * PX), 1)).join(', ')} mm², ${num(100 * outside / upper, 3)}% outside the layer below`);
    check('the white (cut) area is cut on every layer; the frame is metal',
      ms.every((m) => !m.at(50, 20) && m.at(0.2, 20) && m.at(30, 0.2)));
    const pieces = C.map((c) => pieceCount({ ...enc, kerf: base.kerf }, c.holes, PX));
    check('every layer is one piece, at least the web wide', pieces.every((p) => p === 1) && C.every((c) => c.web >= base.web - 1e-5),
      `${pieces.join(', ')} piece(s), webs ${C.map((c) => num(c.web, 3)).join(', ')} mm`);
    check('the main sheet is the same as without layers', key(enc.layers[0]) === key(method.build(ramp(), base, { smooth: 0 }).layers[0]));
  }

  // ---- linear spacing
  {
    const lin = method.build(ramp(), base, { levels: N, smooth: 0, levelSpace: 'linear' });
    const C = lin.levels;
    const [lo, hi] = C[0].range, [elo, ehi] = enc.levels[0].range;
    check('linear: the range is the same region, in linear values',
      Math.abs(lo - toLinear(elo)) < 0.002 && Math.abs(hi - toLinear(ehi)) < 0.002,
      `${num(lo, 4)} to ${num(hi, 4)} linear`);
    const vals = C.map((c) => c.value).reverse();
    const stepWant = (hi - lo) / (N + 1);
    check('linear: levels evenly spaced in linear light',
      vals.every((v, i) => Math.abs(v - (i ? vals[i - 1] : lo) - stepWant) < 1e-6), `levels ${vals.map((v) => num(v, 4)).join(', ')}`);
    const edges = C.map((c) => firstMetal(metal(lin, c.holes), 20, 3, 39.5));
    const errs = C.map((c, i) => edges[i] - rampAt(toEncoded(c.value)));
    check('linear: each layer’s metal starts on its isocontour', errs.every((e) => Math.abs(e) < 0.3),
      `edge − isocontour ${errs.map((e) => num(e, 3)).join(', ')} mm`);
    const lowEnc = firstMetal(metal(enc, enc.levels[N - 1].holes), 20, 3, 39.5);
    check('linear spacing puts the lowest level higher up the ramp than encoded does', edges[N - 1] - lowEnc > 3,
      `lowest edge at ${num(edges[N - 1], 2)} mm linear, ${num(lowEnc, 2)} mm encoded`);
  }

  // ---- islands: bridges, or floating parts
  {
    // dark (encoded 0.1) with three brighter discs (0.4), no white: one level
    // between them leaves each disc as an island of metal in a cut field
    const cs = [[75, 100], [150, 100], [225, 100]];
    const img = makeRGBA(300, 200, (x, y) => (cs.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= 20) ? [102, 102, 102] : [26, 26, 26]));
    const b = method.build(img, base, { levels: 1 });
    const holes = b.levels[0].holes;
    const m = metal(b, holes);
    const pieces = pieceCount({ ...b, kerf: base.kerf }, holes, PX);
    const thick = thickPieces(m.M, m.w, m.h, base.web);
    check('bridges: a layer with islands is one piece, still one piece shrunk by just under web/2',
      pieces === 1 && thick === 1 && b.debug.levels.unresolved === 0 && b.debug.levels.bridges.length >= 6,
      `${pieces} piece(s), ${thick} when shrunk, ${b.debug.levels.bridges.length} bridges for 3 islands`);
    check('the layers’ bridges are kept apart from the main sheet’s', b.debug.bridges.length === 0 && /brightness layer \(\d+ bridges\)/.test(b.note),
      b.note);
    const f = method.build(img, base, { levels: 1, floating: true });
    const fp = pieceCount({ ...f, kerf: base.kerf }, f.levels[0].holes, PX);
    check('floating parts: no bridges, each island its own piece', fp === 4 && f.debug.levels.floating === 3 && f.debug.levels.bridges.length === 0,
      `${fp} pieces, ${f.debug.levels.floating} reported floating`);
  }

  // ---- the core: a region's rim (convex corners included) takes its
  // brightness from the core, not from the neighbor blended into it; a part
  // too thin to have a core stands in for itself
  {
    // on white: a dark block 10..50 × 8..26 mm, encoded 0.1 at its left to 0.3
    // at its right, and a black bar 2 mm tall across 10..50 mm at y 32..34 mm
    const img = makeRGBA(300, 200, (x, y) => {
      if (x >= 50 && x < 250 && y >= 40 && y < 130) { const v = Math.round(255 * (0.1 + 0.2 * (x - 50) / 199)); return [v, v, v]; }
      if (x >= 50 && x < 250 && y >= 160 && y < 170) return [0, 0, 0];
      return [255, 255, 255];
    });
    const coreAt = (smooth) => {
      const b = method.build(img, base, { levels: 1, smooth });
      const { lab, k, ww } = b.debug, core = b.debug.levels.cores[0];
      // the block's top-left corner: its region pixel nearest (10, 8) mm
      let corner = -1, best = Infinity;
      for (let j = Math.floor(7 * k); j < Math.floor(10 * k); j++) {
        for (let i = Math.floor(9 * k); i < Math.floor(12 * k); i++) {
          const q = j * ww + i;
          const d = Math.hypot(i / k - 10, j / k - 8);
          if (lab[q] === 0 && d < best) { best = d; corner = q; }
        }
      }
      const barMid = Math.floor(33 * k) * ww + Math.floor(30 * k);
      return { corner: core[corner], bar: lab[barMid] === 0 && core[barMid] };
    };
    const sharp = coreAt(0), soft = coreAt(0.5);
    check('core: a region’s convex corner is rim, not core, with smoothing off and on',
      !sharp.corner && !soft.corner, `corner in the core: ${!!sharp.corner} unsmoothed, ${!!soft.corner} smoothed`);
    check('core: a part too thin to have a core of its own is its own core', soft.bar === 1 || soft.bar === true,
      `bar ${soft.bar ? 'is' : 'is not'} core`);
  }

  // ---- color: per color, stacked on that color's own sheet
  {
    const pal = ['#202020', '#d02020', '#2040d0'];
    const s = { ...base, mode: 'color', palette: pal, reg: 0.3 };
    // red block 8..28 × 10..30 mm, brighter to the right; blue block 34..54 ×
    // 10..30 mm, brighter downward; the dark background is flat
    const img = makeRGBA(300, 200, (x, y) => {
      if (x >= 40 && x < 140 && y >= 50 && y < 150) return [Math.round(150 + 105 * (x - 40) / 99), 32, 32];
      if (x >= 170 && x < 270 && y >= 50 && y < 150) return [32, 64, Math.round(160 + 95 * (y - 50) / 99)];
      return [32, 32, 32];
    });
    const b = method.build(img, s, { levels: 2 });
    const C = b.levels;
    check('color: two layers each for red and blue, top level first; none for the flat dark sheet, and it says so',
      C.map((c) => `${c.color}.${c.level}`).join() === '1.2,1.1,2.2,2.1' && /no brightness layers for sheet 1/.test(b.note),
      `${C.map((c) => `${c.color}.${c.level}`).join(', ')} · ${b.note}`);
    const red = C.filter((c) => c.color === 1).map((c) => metal(b, c.holes));
    const blue = C.filter((c) => c.color === 2).map((c) => metal(b, c.holes));
    check('red layers: metal at the bright end, cut at the dark end',
      red.every((m) => m.at(27, 20) && !m.at(9, 20)));
    check('red layers: cut where the deeper blue shows, metal where the top sheet hides them',
      red.every((m) => !m.at(44, 20) && m.at(31, 5)));
    check('blue layers (on the solid base): metal at the bright end, cut at the dark end',
      blue.every((m) => m.at(44, 29) && !m.at(44, 11)));
    check('blue layers: metal under the red and the top sheet, both above them',
      blue.every((m) => m.at(18, 20) && m.at(31, 5)));
    const pieces = C.map((c) => pieceCount({ ...b, kerf: s.kerf }, c.holes, PX));
    check('color: every layer is one piece', pieces.every((p) => p === 1), pieces.join(', '));
    const plainB = method.build(img, s, {});
    let same = plainB.achieved.length === b.achieved.length;
    for (let i = 0; same && i < b.achieved.length; i++) same = b.achieved[i] === plainB.achieved[i] && b.target[i] === plainB.target[i];
    check('color: the scores are untouched (seen from above, a layer is its sheet’s color)', same);
  }

  // ---- stack order, names, outline color
  {
    const lvs = [{ color: 1, holes: ['a'] }, { color: 1, holes: ['b'] }, { color: 2, holes: ['c'] }];
    const tag = (e) => (e.level ? `L${e.holes[0]}` : `S${e.sheet}${e.base ? '(base)' : ''}`);
    const txt = physicalStack([['x'], ['y']], lvs).map(tag).join(' ');
    check('stack: each color’s layers sit directly on that color’s sheet, the solid base last',
      txt === 'S0 La Lb S1 Lc S2(base)', txt);
    const bwTxt = physicalStack([['x']], [{ color: 0, holes: ['a'] }], true).map(tag).join(' ');
    check('stack, B&W: the layers sit on the one sheet; the backdrop is not a sheet', bwTxt === 'La S0', bwTxt);
    const bw = { mode: 'bw', nCut: 1, colors: ['#2b2b2b'] };
    const col = { mode: 'color', nCut: 2, colors: ['#EAE8E7', '#439dde', '#9d3400'] };
    const got = [levelFileName('rhino', 0, 1, bw, 'svg'), levelFileName('rhino', 0, 2, bw, 'dxf', true),
      levelFileName('rhino', 1, 1, col, 'svg'), levelFileName('rhino', 2, 3, col, 'dxf', true), sheetFileName('rhino', 1, col, 'svg')];
    const want = ['rhino-level1.svg', 'rhino-level2-2b2b2b.dxf', 'rhino-2-sheet2-level1.svg', 'rhino-3-base-level3-9d3400.dxf', 'rhino-2-sheet2.svg'];
    check('file names: one per layer, its sheet’s name plus the level; sheet names unchanged', got.join() === want.join(), got.join(', '));
    const lum = (c) => luminance(...c.map((v) => toLinear(v / 255)));
    const cases = ['#1a1a1a', '#f2f2f2', '#808080', '#c8102e'].map((hex) => {
      const lin = hexToLinear(hex), f = fadedRGB(lin), e = lin.map((v) => Math.round(255 * toEncoded(v)));
      return { hex, f, d: Math.abs(lum(f) - lum(e)) };
    });
    check('outline color: a faded version of the sheet’s color that stands out from it, even for mid gray',
      cases.every((c) => c.d > 0.05) && cases[0].f[0] > 26 && cases[1].f[0] < 242,
      cases.map((c) => `${c.hex} → rgb(${c.f.join(',')})`).join(', '));
  }

  // ---- determinism
  {
    const a = method.build(ramp(), base, { levels: 2 }), c = method.build(ramp(), base, { levels: 2 });
    check('two runs on the same input give identical layers', a.levels.map((x) => key(x.holes)).join('|') === c.levels.map((x) => key(x.holes)).join('|'));
  }
}
