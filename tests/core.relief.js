// The Relief view: the visible surface's height and which sheets are metal at
// each pixel, and the shadows and lit edges a directional light casts on them
// (core/render.js's stackHeights, sheetSolids, reliefShade).
//
// Predictions: a step of k sheets casts a shadow k·thickness / tan(elevation)
// long, on the side away from the light, whatever the light's angle; the edge
// facing the light is brightened; a flat stack is left as it is; and a thin
// bridge over a hole casts a thin shadow, offset by its height, not a wall's.

import { check, section, num, makeRGBA, plain } from './runner.js';
import { reliefShade } from '../src/core/render.js';
import { runPipeline } from '../src/pipeline.js';

const W = 100, H = 100, PX = 10;                // 10 mm square at 10 px/mm
const GRAY = 160;
const SHEETS = 3;

const gray = () => new Uint8ClampedArray(W * H * 4).fill(GRAY);
const value = (img, x, y) => img[4 * (y * W + x)];

/**
 * A stack of SHEETS sheets, each solid where solidFn(k, x, y) (k = 0 is the
 * top), as reliefShade reads it: the visible surface's height in sheets, and
 * the packed masks.
 */
function stack(solidFn) {
  const height = new Float32Array(W * H), data = new Uint8Array(SHEETS * W * H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i - x) / W;
    let top = 0;
    for (let k = SHEETS - 1; k >= 0; k--) {
      if (solidFn(k, x, y)) { data[k * W * H + i] = 1; top = SHEETS - k; }
    }
    height[i] = top;
  }
  return { height, solid: { n: SHEETS, data } };
}
/** A stack that is solid from the floor up to level(x, y) sheets: no overhangs. */
const levels = (level) => stack((k, x, y) => level(x, y) >= SHEETS - k);
const shade = (s, o) => reliefShade(gray(), s.height, s.solid, W, H, PX, o);

/** Run length of darkened pixels from (x, y) on, stepping (dx, dy). */
function shadowRun(img, x, y, dx, dy) {
  let n = 0;
  while (x >= 0 && y >= 0 && x < W && y < H && value(img, x, y) < GRAY - 2) { n++; x += dx; y += dy; }
  return n;
}

export function run() {
  section('core.relief', 'Relief shading: shadow length k·thickness / tan(elevation) per k-sheet step, on the side away from the light, at any angle; lit edges; flat stays flat; a bridge over a hole casts a bridge’s shadow.');

  const light = (o) => ({ thickness: 1, elevation: 45, azimuth: 0, ...o });
  // k sheets higher above row 50, light from the top: a k mm shadow (10k px) below the step
  const step = (k) => levels((x, y) => (y < 50 ? k : 0));
  {
    const out = shade(step(1), light());
    const len = shadowRun(out, 50, 50, 0, 1);
    check('one sheet at 45°: a shadow one thickness long, below the step', Math.abs(len - 10) <= 0.5,
      `${len} px (want 10)`);
    const two = shadowRun(shade(step(2), light()), 50, 50, 0, 1);
    const thick = shadowRun(shade(step(1), light({ thickness: 1.5 })), 50, 50, 0, 1);
    const low = shadowRun(shade(step(1), light({ elevation: Math.atan(0.5) * 180 / Math.PI })), 50, 50, 0, 1);
    check('the shadow scales with the sheets of drop, the thickness, and 1/tan(elevation)',
      Math.abs(two - 20) <= 0.5 && Math.abs(thick - 15) <= 0.5 && Math.abs(low - 20) <= 0.5,
      `2 sheets ${two} px (want 20), 1.5 mm ${thick} (want 15), tan 0.5 ${low} (want 20)`);
    check('nothing above the step is shaded or lit (its edge faces away from the light)',
      value(out, 50, 20) === GRAY && value(out, 50, 49) === GRAY, `row 49: ${value(out, 50, 49)}`);
  }
  {
    // light from below: the high side's edge faces it -- lit, and nothing in shadow
    const out = shade(step(1), light({ azimuth: 180 }));
    let dark = 0;
    for (let i = 0; i < W * H; i++) if (out[4 * i] < GRAY - 2) dark++;
    check('light from the far side: no shadow, and the edge facing it is lit',
      dark === 0 && value(out, 50, 49) > GRAY + 10, `${dark} shaded pixels, edge ${value(out, 50, 49)} (flat ${GRAY})`);
  }
  {
    // a raised square, light from the right: the shadow falls to the left of it
    const sq = levels((x, y) => (x >= 40 && x < 60 && y >= 40 && y < 60 ? 1 : 0));
    const out = shade(sq, light({ azimuth: 90 }));
    const left = shadowRun(out, 39, 50, -1, 0);
    check('light from the right: the shadow falls to the left, one thickness long, none on the right',
      Math.abs(left - 10) <= 0.5 && value(out, 61, 50) === GRAY, `${left} px left, right side ${value(out, 61, 50)}`);
    // the slider is centered on light from the top: negative angles come from the left
    const fromLeft = shade(sq, light({ azimuth: -90 }));
    const right = shadowRun(fromLeft, 60, 50, 1, 0);
    check('light from the left (−90°): the shadow falls to the right, one thickness long',
      Math.abs(right - 10) <= 0.5 && value(fromLeft, 38, 50) === GRAY, `${right} px right`);
    // light from the top right (45°): the shadow runs down and to the left, along the diagonal
    const diag = shade(sq, light({ azimuth: 45 }));
    const run = shadowRun(diag, 39, 60, -1, 1);
    check('light from the top right: the shadow runs down-left, a thickness long along the light',
      Math.abs(run - 10 / Math.SQRT2) <= 1.5 && value(diag, 61, 38) === GRAY,
      `${run} px diagonally (want ${num(10 / Math.SQRT2, 1)}), opposite corner ${value(diag, 61, 38)}`);
  }
  {
    const flat = shade(levels(() => 2), light({ azimuth: 200, elevation: 20 }));
    let changed = 0;
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) if (flat[4 * i + c] !== GRAY) changed++;
    check('a flat stack is left as it is', changed === 0, `${changed} channel values changed`);
  }
  {
    // a bridge: the top sheet (2-3 mm up, of 3) solid only in rows 40-44, over
    // air -- the middle sheet is cut away everywhere. Light from the top at 45°:
    // the ray from the bottom sheet's surface (1 mm up) is inside the bridge's
    // slab 1-2 mm along, i.e. 10-20 px back, so it meets the bar from rows
    // 50-64 (the bar's 5 px plus its 10 px of thickness), and rows 45-49, right
    // under and just past it, stay lit: a wall there would shade them.
    const bridge = stack((k, x, y) => k === 2 || (k === 0 && y >= 40 && y < 45));
    const out = shade(bridge, light());
    const band = shadowRun(out, 50, 50, 0, 1);
    const under = [45, 47, 49].map((y) => value(out, 50, y));
    check('a bridge over a hole casts a bridge’s shadow, offset by its height, not a wall’s',
      Math.abs(band - 15) <= 0.5 && under.every((v) => v >= GRAY) && value(out, 50, 65) === GRAY,
      `${band} px of shadow from row 50 (want 15), rows 45/47/49 ${under.join('/')}, row 65 ${value(out, 50, 65)}`);
    const wall = shadowRun(shade(levels((x, y) => (y >= 40 && y < 45 ? 3 : 1)), light()), 50, 45, 0, 1);
    check('the same bar standing on solid sheets casts a wall’s shadow from its foot', Math.abs(wall - 20) <= 0.5,
      `${wall} px (want 20)`);
  }

  // ---- the pipeline's height map and sheet masks: the stencil's brightness layers stack up
  {
    // a gray ramp, encoded 0 to 0.45 over the left 40 mm, white (cut through) beyond
    const img = makeRGBA(300, 200, (x) => {
      if (x >= 200) return [255, 255, 255];
      const v = Math.round(255 * 0.45 * x / 199);
      return [v, v, v];
    });
    const out = runPipeline(img, { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15 }, 'stencil', { levels: 3 });
    const pv = out.preview;
    const idx = (xmm, ymm) => Math.floor(ymm * pv.pxPerMm) * pv.w + Math.floor(xmm * pv.pxPerMm);
    // B&W: backdrop 0, the sheet 1, its three layers 2..4 from dark to light
    const hs = [idx(50, 20), idx(5, 20), idx(38, 20)].map((i) => pv.height[i]);
    check('height map: the backdrop 0, the sheet 1, all three layers 4 at the light end',
      pv.height.length === pv.w * pv.h && hs[0] === 0 && hs[1] === 1 && hs[2] === 4, hs.map((v) => num(v, 2)).join(', '));
    // the masks agree: at the light end all 4 sheets are metal, at the dark end only the bottom one
    const N = pv.w * pv.h, sheets = (i) => Array.from({ length: pv.solid.n }, (_, k) => pv.solid.data[k * N + i]).join('');
    check('sheet masks: one per sheet of the stack, top first, agreeing with the heights',
      pv.solid.n === 4 && sheets(idx(38, 20)) === '1111' && sheets(idx(5, 20)) === '0001' && sheets(idx(50, 20)) === '0000',
      `light end ${sheets(idx(38, 20))}, dark end ${sheets(idx(5, 20))}, white ${sheets(idx(50, 20))}`);
  }
}
