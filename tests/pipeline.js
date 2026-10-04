// End to end: the worker's whole job, run directly.

import { check, section, num, grayRamp, noiseRGBA, flatGray, plain, makeRGBA } from './runner.js';
import { runPipeline } from '../src/pipeline.js';
import { rasterizeHoles } from '../src/core/render.js';
import { pieceCount } from '../src/core/structure.js';
import { fadedRGB, hexToLinear } from '../src/core/color.js';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i] || (Number.isNaN(v) && Number.isNaN(b[i])));

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

  // ---- Stencil brightness layers: outlined in Result only, in a faded version
  // of their sheet's color, and only where they can be seen
  {
    const st = { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15, sheet: '#2b2b2b', backdrop: '#ffffff' };
    // a gray ramp, encoded 0 to 0.45 over the left 40 mm, white beyond
    const img = makeRGBA(300, 200, (x) => {
      if (x >= 200) return [255, 255, 255];
      const v = Math.round(255 * 0.45 * x / 199);
      return [v, v, v];
    });
    const off = runPipeline(img, st, 'stencil', {});
    const zero = runPipeline(img, st, 'stencil', { levels: 0 });
    check('stencil, layers off: no layers, and the previews are byte-for-byte the same as without the option',
      off.levels.length === 0 && off.stats.levels.length === 0 &&
      sameBytes(off.preview.result, zero.preview.result) && sameBytes(off.preview.backlit, zero.preview.backlit));

    const on = runPipeline(img, st, 'stencil', { levels: 3 });
    const pv = on.preview;
    check('stencil, 3 layers: one stat row per layer, each with its outline and cuts',
      on.levels.length === 3 && on.stats.levels.length === 3 && on.stats.levels.every((s) => s.holes > 0 && s.length > 0),
      on.stats.levels.map((s) => `${s.holes} contours, ${Math.round(s.length)} mm`).join('; '));
    check('the layers leave the Source and Diff views and the scores alone',
      sameBytes(pv.source, off.preview.source) && sameBytes(pv.diff, off.preview.diff) &&
      on.stats.fidelity === off.stats.fidelity && on.stats.reach === off.stats.reach);

    const fade = fadedRGB(hexToLinear(st.sheet));
    const isFade = (buf, i) => buf[4 * i] === fade[0] && buf[4 * i + 1] === fade[1] && buf[4 * i + 2] === fade[2];
    let faded = 0, fadedOff = 0;
    for (let i = 0; i < pv.w * pv.h; i++) { if (isFade(pv.result, i)) faded++; if (isFade(off.preview.result, i)) fadedOff++; }
    check('Result shows outlines in the faded sheet color; without layers there are none', faded > 0 && fadedOff === 0,
      `${faded} outline pixels, rgb(${fade.join(',')})`);
    // each layer's edge on the row y = 20 mm: where its metal starts, at the
    // preview's own resolution, should be outlined (within a pixel)
    const row = Math.round(20 * pv.pxPerMm);
    const hits = on.levels.map((c) => {
      const r = rasterizeHoles({ ...on.piece }, [c.holes], { pxPerMm: pv.pxPerMm, superSample: 3 });
      let x0 = -1;
      for (let x = Math.round(3 * pv.pxPerMm); x < pv.w; x++) if (r.counts[2 * (row * r.w + x)] >= 5) { x0 = x; break; }
      return x0 >= 0 && [-1, 0, 1].some((d) => isFade(pv.result, row * pv.w + x0 + d));
    });
    check('each layer’s visible edge is outlined', hits.every(Boolean), hits.join(', '));

    // color: a red block with a ramp in it; the red layers run on under the dark
    // top sheet, which hides them -- no outline there
    const pal = ['#202020', '#d02020', '#2040d0'];
    const cimg = makeRGBA(300, 200, (x, y) => (x >= 40 && x < 260 && y >= 50 && y < 150
      ? [Math.round(150 + 105 * (x - 40) / 219), 32, 32] : [32, 32, 32]));
    const col = runPipeline(cimg, { ...st, mode: 'color', palette: pal, reg: 0.3 }, 'stencil', { levels: 2 });
    const cf = fadedRGB(hexToLinear(pal[1]));
    const cpv = col.preview;
    let inBlock = 0, hidden = 0;
    for (let py = 0; py < cpv.h; py++) {
      for (let px = 0; px < cpv.w; px++) {
        const i = py * cpv.w + px, p = 4 * i;
        if (cpv.result[p] !== cf[0] || cpv.result[p + 1] !== cf[1] || cpv.result[p + 2] !== cf[2]) continue;
        const xmm = px / cpv.pxPerMm, ymm = py / cpv.pxPerMm;
        if (xmm > 8.5 && xmm < 51.5 && ymm > 10.5 && ymm < 29.5) inBlock++;
        else if (ymm < 9 || ymm > 31) hidden++;
      }
    }
    check('color: the red layers are outlined in faded red inside the red region, never where the top sheet hides them',
      col.levels.length === 2 && inBlock > 0 && hidden === 0, `${inBlock} outline pixels in the red block, ${hidden} under the top sheet · ${col.note}`);
  }
}
