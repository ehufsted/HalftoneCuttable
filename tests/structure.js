// Every cut sheet is one piece.
//
// This is the property the whole app exists to guarantee, and it is guaranteed by
// construction (core/units.js). This section does not trust the construction: it
// rasterises each sheet finely enough that the thinnest web spans four pixels and
// flood-fills the metal. One component, or it fails.
//
// And a NEGATIVE CONTROL, because a checker that can only say "one piece" proves
// nothing: circles as wide as the pitch touch their neighbors, which traps a
// diamond of metal between every four -- the checker must see those islands.

import { check, section, num, grayRamp, flatGray, noiseRGBA, plain } from './runner.js';
import { prepare } from '../src/core/units.js';
import { materialComponents, thinnestWeb } from '../src/core/structure.js';
import method from '../src/methods/squareGrid.js';

const WEB = 0.2;
const PX = 4 / WEB;   // four pixels across the thinnest web

export function run() {
  section('structure', `Flood fill of the metal at ${PX} px/mm (web = ${WEB} mm = 4 px); one piece per sheet, whatever the image.`);

  const images = {
    white: flatGray(200, 200, 255),
    ramp: grayRamp(200, 200),
    noise: noiseRGBA(200, 200, 11, false),
  };
  const shapes = [['circle', 0], ['square', 0], ['square', 0.5], ['diamond', 0]];

  const failures = [];
  let thinnest = Infinity, runs = 0;
  for (const [name, rgba] of Object.entries(images)) {
    for (const [shape, rounding] of shapes) {
      const ctx = { ...prepare(rgba, { ...plain, widthMm: 24, pitch: 1.6, web: WEB }),
        shape, rounding, range: 'squeeze', diffuse: true };
      const { sizes } = method.run(ctx);
      const { spec } = method.limits(ctx);
      const pieces = materialComponents(ctx, sizes[0], spec, PX);
      const web = thinnestWeb(ctx, sizes[0], spec);
      thinnest = Math.min(thinnest, web);
      runs++;
      if (pieces !== 1) failures.push(`${name}/${shape}${rounding ? ` r${rounding}` : ''}: ${pieces} pieces`);
    }
  }
  check('B&W: every sheet is one piece', failures.length === 0,
    failures.length ? failures.join('; ') : `${runs} sheets`);
  check('B&W: thinnest web never below the setting', thinnest >= WEB - 1e-9, `thinnest ${num(thinnest, 4)} mm`);

  {
    const ctx = { ...prepare(noiseRGBA(200, 200, 12), {
      ...plain, widthMm: 24, pitch: 1.6, web: WEB, mode: 'color',
      palette: ['#ffffff', '#ffcc00', '#cc0000', '#000000'], reg: 0.05,
    }), shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true };
    const { sizes } = method.run(ctx);
    const { spec } = method.limits(ctx);
    const pieces = sizes.map((s) => materialComponents(ctx, s, spec, PX));
    check('stack of 4: every cut sheet is one piece', pieces.every((p) => p === 1), `pieces per sheet: ${pieces.join(', ')}`);
  }

  {
    const ctx = { ...prepare(flatGray(100, 100, 255), { ...plain, widthMm: 24, pitch: 1.6, web: WEB }),
      shape: 'circle', rounding: 0 };
    const { spec } = method.limits(ctx);
    const sizes = new Float32Array(ctx.cols * ctx.rows).fill(ctx.pitch);   // illegal on purpose
    const pieces = materialComponents(ctx, sizes, spec, PX);
    const web = thinnestWeb(ctx, sizes, spec);
    check('negative control: pitch-wide circles are seen as islands', pieces > 1, `${pieces} pieces`);
    check('negative control: and as zero web', web <= 1e-9, `thinnest ${num(web, 4)} mm`);
  }
}
