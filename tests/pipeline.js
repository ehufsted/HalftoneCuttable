// End to end: the worker's whole job, run directly.

import { check, section, num, greyRamp, noiseRGBA, plain } from './runner.js';
import { runPipeline } from '../src/pipeline.js';

export function run() {
  section('pipeline', 'The chain the worker runs, both modes, previews included.');

  const bw = runPipeline(greyRamp(300, 100), { ...plain, minHole: 0.6, kerf: 0.15 }, 'squareGrid',
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
  check('colour, 3 sheets: two cut layers and no backlit view',
    col.layers.length === 2 && col.preview.backlit === null);
  check('colour: scores are finite', isFinite(col.stats.fidelity) && isFinite(col.stats.reach),
    `fidelity ${num(col.stats.fidelity, 4)}, reach ${num(col.stats.reach, 4)}`);
}
