// End to end: the worker's whole job, run directly.

import { check, section, num, grayRamp, noiseRGBA, flatGray, plain } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { pieceCount } from '../src/core/structure.js';

export function run() {
  section('pipeline', 'The chain the worker runs, both modes, previews included.');

  const bw = runPipeline(grayRamp(300, 100), { ...plain, minHole: 0.6, kerf: 0.15 }, 'squareGrid',
    { shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true });
  const pv = bw.preview;
  check('B&W: previews are the right size',
    pv.result.length === pv.w * pv.h * 4 && pv.backlit.length === pv.result.length &&
    pv.source.length === pv.result.length && pv.diff.length === pv.w * pv.h,
    `${pv.w}×${pv.h} px`);
  check('B&W: one cut layer', bw.layers.length === 1 && bw.stats.layers.length === 1);
  check('B&W: fidelity is small', bw.stats.fidelity < 0.03, `fidelity ${num(bw.stats.fidelity, 4)}, reach ${num(bw.stats.reach, 4)}`);
  check('B&W: thinnest web respects the setting', bw.stats.layers[0].thinnestWeb >= plain.web - 1e-9,
    `${num(bw.stats.layers[0].thinnestWeb, 3)} mm`);

  const col = runPipeline(noiseRGBA(120, 120, 2), {
    ...plain, mode: 'color', palette: ['#ffffff', '#d02020', '#101010'], reg: 0.2, minHole: 0.5,
  }, 'squareGrid', { shape: 'square', rounding: 0.2, range: 'squeeze', diffuse: true });
  check('color, 3 sheets: two cut layers and no backlit view',
    col.layers.length === 2 && col.preview.backlit === null);
  check('color: scores are finite', isFinite(col.stats.fidelity) && isFinite(col.stats.reach),
    `fidelity ${num(col.stats.fidelity, 4)}, reach ${num(col.stats.reach, 4)}`);

  // ---- alignment holes: a real through-hole in the Result composite, but not
  // counted among the pattern's own holes
  {
    const solid = runPipeline(flatGray(300, 200, 0), { ...plain, alignHoles: true, alignDist: 5, alignDia: 3 },
      'squareGrid', { shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true });
    const { w, pxPerMm } = solid.preview;
    const at = (xmm, ymm) => {
      const p = 4 * (Math.round(ymm * pxPerMm) * w + Math.round(xmm * pxPerMm));
      return solid.preview.result[p];
    };
    check('a corner alignment hole reads as open in the Result composite',
      at(5, 5) > 200 && at(30, 20) < 80, `corner ${at(5, 5)}, center ${at(30, 20)}`);
    check('alignment holes are not counted among the pattern layer’s own holes',
      solid.layers[0].length === 0 && solid.stats.layers[0].holes === 4);
  }

  // ---- alignment holes keep the web: to the outline, and to the pattern
  // (dropped per hole, or kept metal on the stencil's raster)
  {
    const st = { ...plain, web: 0.6, minHole: 0.6, kerf: 0.15 };
    const white = flatGray(300, 200, 255);
    const gapTo = (out) => {
      // finished edge to finished edge, the closest any pattern hole comes
      let min = Infinity;
      for (const al of out.align) {
        const R = al.a / 2 + st.kerf / 2;
        for (const h of out.layers[0]) min = Math.min(min, Math.hypot(h.cx - al.cx, h.cy - al.cy) - R - (h.a / 2 + st.kerf / 2));
      }
      return min;
    };
    for (const dist of [8, 1]) {
      const out = runPipeline(white, { ...st, alignHoles: true, alignDist: dist, alignDia: 3 }, 'squareGrid',
        { pitch: 3, shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true }, { preview: false });
      const al = out.align[0], toEdge = Math.min(al.cx, al.cy) - (al.a / 2 + st.kerf / 2);
      const pieces = pieceCount(out.piece, out.layers[0].concat(out.align), 20);
      check(`square grid, alignment ${dist} mm in: one piece, a web to the outline and to every pattern hole`,
        pieces === 1 && toEdge >= st.web - 1e-9 && gapTo(out) >= st.web - 1e-6,
        `${pieces} piece(s), ${num(toEdge, 3)} mm to the outline, ${num(gapTo(out), 3)} mm to the nearest pattern hole`);
    }
    // the stencil cuts the whole white field as one loop: the alignment holes
    // must sit in metal kept a web wide round them
    const sten = runPipeline(white, { ...st, alignHoles: true, alignDist: 8, alignDia: 3 }, 'stencil', {}, { preview: false });
    let worst = Infinity;
    for (const al of sten.align) {
      const R = al.a / 2 + st.kerf / 2;
      for (const L of sten.layers[0]) for (let i = 0; i < L.fx.length; i++) worst = Math.min(worst, Math.hypot(L.fx[i] - al.cx, L.fy[i] - al.cy) - R);
    }
    const sp = pieceCount(sten.piece, sten.layers[0].concat(sten.align), 20);
    check('stencil: metal at least a web wide round each alignment hole, the sheet one piece',
      worst >= st.web - 0.05 && sp === 1, `${num(worst, 3)} mm from an alignment hole to the cut, ${sp} piece(s)`);
  }
}
