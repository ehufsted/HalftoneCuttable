// Hex grid: one piece by construction (flood fill), for both hole shapes; tone
// accuracy; the stack invariants; determinism.
//
// The tiling and hole-area law are hand-derived (no existing squareGrid/cellWeb
// code to lean on), so the flood fill here is the primary safety net, not a
// formality: it is what actually catches a margin or spacing mistake.

import { check, section, num, greyRamp, flatGrey, noiseRGBA, plain } from './runner.js';
import { pieceCount } from '../src/core/structure.js';
import method from '../src/methods/hexGrid.js';

function build(rgba, settings, params = {}) {
  const s = { ...plain, ...settings };
  const b = method.build(rgba, s, { pitch: 4, shape: 'hex', range: 'squeeze', diffuse: true, ...params });
  return { s, b };
}

export function run() {
  section('method.hexGrid', 'One piece by flood fill, hex and circle holes alike; the thinnest web; tone accuracy; the stack invariants; determinism.');

  // ---- one piece, both hole shapes, several images
  {
    const images = { white: flatGrey(200, 200, 255), ramp: greyRamp(200, 200), noise: noiseRGBA(200, 200, 11, false) };
    const failures = [];
    let runs = 0;
    for (const [name, rgba] of Object.entries(images)) {
      for (const shape of ['hex', 'circle']) {
        const { s, b } = build(rgba, { widthMm: 60, web: 0.5 }, { pitch: 3, shape });
        for (let j = 0; j < b.layers.length; j++) {
          const pieces = pieceCount({ widthMm: b.widthMm, heightMm: b.heightMm, kerf: s.kerf }, b.layers[j], 12);
          runs++;
          if (pieces !== 1) failures.push(`${name}/${shape} layer ${j}: ${pieces} pieces`);
        }
      }
    }
    check('every sheet is one piece, hex and circle holes alike', failures.length === 0,
      failures.length ? failures.join('; ') : `${runs} sheets checked`);
  }

  // ---- the thinnest web never reads below the setting
  {
    let worst = Infinity;
    for (const shape of ['hex', 'circle']) {
      const { b } = build(noiseRGBA(200, 200, 5, false), { widthMm: 60, web: 0.5 }, { pitch: 3, shape });
      for (const w of b.webs) if (isFinite(w)) worst = Math.min(worst, w);
    }
    check('thinnest web never below the setting', worst >= 0.5 - 1e-6, `thinnest ${num(worst, 4)} mm`);
  }

  // ---- tone: unconstrained (generous web/kerf/floor), achieved matches target closely
  {
    const { b } = build(noiseRGBA(150, 150, 7), { widthMm: 80, web: 0.3, minHole: 0.2, kerf: 0.05 }, { pitch: 3 });
    let worst = 0;
    for (let c = 0; c < b.N; c++) worst = Math.max(worst, Math.abs(b.achieved[c] - b.target[c]));
    check('B&W, lightly constrained: every cell hits its target closely', worst < 0.05, `worst |Δ| ${num(worst, 4)}`);
  }

  // ---- circle vs hex: both are bounded by the same sMax (the cell's own
  // inradius sets it, not the hole's shape), but a hexagon of flat-to-flat
  // width s has area (sqrt(3)/2)*s^2 against a circle's pi/4*s^2 at the same s
  // -- the hexagon fills more of its cell, so a bright flat image (unconstrained
  // by anything but the cell itself) should read brighter with hexagon holes.
  {
    const white = flatGrey(4, 4, 255);
    const { b: hex } = build(white, { widthMm: 60, web: 0.4 }, { pitch: 4, shape: 'hex' });
    const { b: circ } = build(white, { widthMm: 60, web: 0.4 }, { pitch: 4, shape: 'circle' });
    check('hexagon holes reach a higher open fraction than circles at the same pitch',
      hex.achieved[0] > circ.achieved[0],
      `white achieves ${num(hex.achieved[0], 4)} (hex) vs ${num(circ.achieved[0], 4)} (circle)`);
  }

  // ---- both hole shapes, stacked colour: every layer produces holes, nested
  for (const shape of ['hex', 'circle']) {
    const settings = { mode: 'color', palette: ['#f0f0f0', '#e0b000', '#101010'], widthMm: 80, minHole: 0.4, kerf: 0.1, reg: 0.25, web: 0.5 };
    const { b } = build(noiseRGBA(180, 180, 3), settings, { pitch: 3.5, shape });
    check(`${shape}: colour build produces holes on every cut layer`,
      b.layers.length === 2 && b.layers.every((l) => l.length > 0),
      `${b.layers.map((l) => l.length).join(', ')} holes per layer`);
  }

  // ---- determinism
  {
    const a = build(noiseRGBA(120, 120, 9, false), { widthMm: 60 }, { pitch: 3 }).b;
    const c = build(noiseRGBA(120, 120, 9, false), { widthMm: 60 }, { pitch: 3 }).b;
    let same = a.achieved.length === c.achieved.length;
    if (same) for (let i = 0; i < a.achieved.length; i++) if (a.achieved[i] !== c.achieved[i]) { same = false; break; }
    check('two runs on the same input are identical', same);
  }
}
