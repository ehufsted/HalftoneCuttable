// Square grid: one hole per cell, per cut layer, sized by the local tone.
//
// TONE MODEL. A cell's color is the area-weighted mix of the sheets visible in it
// (core/separate.js), and the open fraction of a hole is its finished area over
// the cell area (core/shapes.js). The hole cannot exceed sMax = pitch - web, so
// the top sheet always shows over at least 1 - fMax of every cell: pure white (in
// B&W) or a pure base color (in a stack) is unreachable by specification, not by
// error. `targetImage` says so, and the app scores against it.
//
// Two ways into that band, the `range` param:
//   squeeze -- the whole image is mapped affinely into it (the pen-plotter app's
//              affineTarget). Every tone keeps its relation to every other.
//   clip    -- tones inside the band are kept as they are, only brighter ones
//              saturate. More contrast, lost highlights.
//
// REALIZATION, per cell, in serpentine error-diffusion order:
//   1. solve the target (plus carried error) for the closest palette mix;
//   2. turn the mix into cumulative open fractions, one per cut layer;
//   3. cut layer by layer from the top, each hole capped by the one above it less
//      twice the registration allowance, and each one below the floor size
//      rounded to nothing or to the floor, whichever is nearer;
//   4. hand what could not be matched to the neighbors.
// Step 3 is greedy -- a deeper layer does not renegotiate the one above it -- and
// diffusion is what keeps the average right when greed costs something.

import { diffuseCells } from '../core/diffuse.js';
import { stackColors } from '../core/separate.js';
import { maxSize, floorSize, openFraction, sizeFor } from '../core/shapes.js';
import { prepare } from '../core/units.js';
import { gridHoles } from '../core/holes.js';
import { thinnestWeb } from '../core/structure.js';
import { fitTargets, realizeCells, topStats, kerfNote } from './gridTone.js';

export const id = 'squareGrid';
export const label = 'Square grid';
export const blurb = 'One hole per cell, sized to the local tone. Every hole stays inside its own cell, so the sheet is always one piece.';

export const params = [
  { key: 'pitch', label: 'Cell pitch', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1 },
  { key: 'shape', label: 'Hole shape', type: 'select', def: 'square',
    options: [['circle', 'Circle'], ['square', 'Square'], ['diamond', 'Diamond']] },
  { key: 'rounding', label: 'Corner round', type: 'range', min: 0, max: 1, step: 0.05, def: 0,
    when: (p) => p.shape !== 'circle' },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']] },
  { key: 'diffuse', label: 'Error diffusion', type: 'checkbox', def: true },
];

/** The shape spec and the size limits every function here shares. */
export function limits(ctx) {
  const spec = { shape: ctx.shape || 'square', rounding: ctx.rounding || 0, kerf: ctx.kerf };
  const sMax = maxSize(ctx.pitch, ctx.web);
  const sFloor = floorSize(spec, ctx.minHole);
  return {
    spec, sMax, sFloor,
    fMax: openFraction(spec, sMax, ctx.pitch),
    fFloor: openFraction(spec, sFloor, ctx.pitch),
  };
}

/** What the method aims at, per cell, in the same D channels as ctx.target. */
export const targetImage = (ctx) =>
  fitTargets(ctx.target, ctx.cols * ctx.rows, ctx.D, ctx.palette, limits(ctx).fMax, ctx.range);

/**
 * @returns {{sizes: Float32Array[], note: string, target: Float32Array}}
 *   sizes[j][cell] = nominal hole size in mm for cut layer j (0 = no hole);
 *   target is what targetImage(ctx) computed, handed back so build() need not redo it
 */
export function run(ctx) {
  const { spec, sMax, sFloor, fFloor } = limits(ctx);
  const { cols, rows, D, palette, pitch: p, nCut } = ctx;
  const target = targetImage(ctx);
  const sizes = realizeCells({
    N: cols * rows, palette, nCut, reg: ctx.mode === 'color' ? ctx.reg : 0, sMax, sFloor, fFloor,
    fOf: (s) => openFraction(spec, s, p),
    sizeOf: (f, cap) => sizeFor(spec, f, p, cap),
    diffuse: (visit) => diffuseCells(cols, rows, D, target, visit, ctx.diffuse !== false),
  });
  const note = sFloor > sMax ? 'no hole fits: the min hole (or 1.5× kerf) exceeds pitch − web' : kerfNote(sFloor, ctx.minHole);
  return { sizes, note, target };
}

/** The method end to end, as the hole model pipeline.js expects. */
export function build(rgba, settings, params) {
  // the pitch is a pattern param; settings.pitch is the fallback for callers (tests) that set it there
  const ctx = { ...prepare(rgba, { ...settings, pitch: params.pitch ?? settings.pitch }), ...params };
  const res = run(ctx);
  const { spec, sMax, sFloor, fMax, fFloor } = limits(ctx);
  const target = res.target;
  const achieved = stackColors(ctx, res.sizes, spec);
  const N = ctx.cols * ctx.rows, D = ctx.D;
  const { dropped, saturated } = topStats(target, res.sizes[0], N, D, ctx.palette, sMax);

  return {
    widthMm: ctx.widthMm, heightMm: ctx.heightMm, mode: ctx.mode, D, N, palette: ctx.palette,
    target, achieved, source: ctx.target,
    layers: res.sizes.map((sz) => gridHoles(ctx, sz, spec)),
    webs: res.sizes.map((sz) => thinnestWeb(ctx, sz, spec)),
    cellAt: (px, py) => {
      const i = Math.floor((px - ctx.margin) / ctx.pitch), j = Math.floor((py - ctx.margin) / ctx.pitch);
      return i < 0 || j < 0 || i >= ctx.cols || j >= ctx.rows ? -1 : j * ctx.cols + i;
    },
    imageRect: { x: ctx.margin, y: ctx.margin, w: ctx.cols * ctx.pitch, h: ctx.rows * ctx.pitch },
    cellsLabel: `${ctx.cols}×${ctx.rows} cells`,
    dropped, saturated, note: res.note,
    debug: { spec, sMax, sFloor, fMax, fFloor },
  };
}

export default { id, label, blurb, params, run, targetImage, limits, build };
