// The exported file: one closed contour per hole plus the outline, true size, the
// kerf already applied.

import { check, section, num, noiseRGBA, plain } from './runner.js';
import { prepare } from '../src/core/units.js';
import { cutPath } from '../src/core/shapes.js';
import { layerSVG } from '../src/core/svg.js';
import { gridHoles } from '../src/core/holes.js';
import method from '../src/methods/squareGrid.js';

export function run() {
  section('core.svg', 'Element counts, closure, document size, and the kerf offset as written.');

  for (const shape of ['circle', 'square', 'diamond']) {
    const kerf = 0.2;
    const ctx = { ...prepare(noiseRGBA(100, 100, 4, false), { ...plain, kerf, minHole: 0.6 }),
      shape, rounding: shape === 'square' ? 0.4 : 0, range: 'squeeze', diffuse: true };
    const { sizes } = method.run(ctx);
    const { spec } = method.limits(ctx);
    const { text, holes } = layerSVG(ctx, gridHoles(ctx, sizes[0], spec), { name: `test ${shape}` });

    const circles = (text.match(/<circle /g) || []).length;
    const paths = [...text.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
    const expected = sizes[0].filter((s) => cutPath(spec, s)).length;
    check(`${shape}: one contour per hole`, circles + paths.length === expected && holes === expected,
      `${circles} circles + ${paths.length} paths, ${expected} holes`);
    check(`${shape}: every path is closed`, paths.every((d) => d.endsWith('Z')));
    check(`${shape}: no non-finite coordinates`, !/NaN|Infinity/.test(text));

    const w = parseFloat(/width="([\d.]+)mm"/.exec(text)[1]);
    check(`${shape}: document is the piece plus one kerf wide`, Math.abs(w - (ctx.widthMm + kerf)) < 1e-3,
      `${num(w, 3)} mm for a ${ctx.widthMm} mm piece`);

    if (shape === 'circle') {
      const i = sizes[0].findIndex((s) => s > 0);
      const r = parseFloat(/<circle [^>]*r="([\d.]+)"/.exec(text)[1]);
      check('circle: written radius is (size − kerf)/2', Math.abs(r - (sizes[0][i] - kerf) / 2) < 1e-3,
        `size ${num(sizes[0][i], 3)} → r ${num(r, 3)}`);
    }
  }

  const ctx = { ...prepare(noiseRGBA(20, 20, 1), plain), shape: 'circle', rounding: 0 };
  const base = layerSVG(ctx, [], { name: 'base' });
  check('the solid base is its outline alone', base.holes === 0 && (base.text.match(/<rect /g) || []).length === 1);
}
