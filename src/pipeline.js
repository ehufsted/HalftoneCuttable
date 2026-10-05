// The whole chain, DOM-free: settings + pixels -> holes, previews, scores.
// worker.js wraps it; the harness calls it directly.
//
// Every method hands back the same HOLE MODEL (see methods/index.js), so nothing
// below knows whether the holes came from a grid or a Voronoi web.
//
// The scores are the pen-plotter app's two, for the same reason (see its
// docs/architecture.md, "targetImage is part of the contract"):
//   fidelity -- mean |achieved - target| per cell: is the method doing its job?
//               "achieved" is from the exact area law, not a raster (core/render.js).
//   reach    -- mean |target - source|: can the sheet express this image at all?
// Both are in ENCODED units (what a screen shows), averaged over channels, so the
// numbers read like the other app's even though the arithmetic is linear.

import { DEFAULTS, applyTone } from './core/units.js';
import { rasterizeHoles, composite, outlineSteps, stackHeights, sheetSolids } from './core/render.js';
import { layerStats } from './core/structure.js';
import { alignmentHoles, dropBorder, dropNearAlignment } from './core/holes.js';
import { toEncoded, luminance, hexToLinear, fadedRGB } from './core/color.js';
import { physicalStack } from './core/stack.js';
import { byId } from './methods/index.js';
import { applyStyle } from './core/style.js';

/**
 * @param {{width,height,data}} rgba
 * @param {object} settings   units.DEFAULTS plus: sheet, backdrop (B&W display
 *                            colors), speed (mm/s), pierce (s)
 * @param {string} methodId
 * @param {object} params     the method's own
 * @param {{preview?:boolean, maxDim?:number, onProgress?:(stage:string)=>void}} opts
 *   preview:false skips the rasters; onProgress hears each stage as it starts
 *   ("styling", the method's own, "rendering previews")
 */
export function runPipeline(rgba, settings, methodId, params, opts = {}) {
  const s = { ...DEFAULTS, ...settings };
  const progress = opts.onProgress || (() => {});
  // Tone (gamma, brightness, saturation) first, then Style: both restyle the
  // image before the method (and the Source view, and the reach score) see it,
  // so a person can see exactly what a slider or a filter did to the image.
  progress('styling');
  const toned = applyTone(rgba, s.gamma, s.brightness, s.saturation);
  const styled = applyStyle(toned, s.style, s.widthMm);
  progress('cutting');
  const b = byId(methodId).build(styled, s, params, { progress });
  const { N, D, target, achieved, source } = b;

  let fid = 0, reach = 0;
  const diffCell = new Float32Array(N);
  const enc = (v) => toEncoded(v);
  for (let c = 0; c < N; c++) {
    for (let d = 0; d < D; d++) {
      const t = enc(target[c * D + d]);
      fid += Math.abs(enc(achieved[c * D + d]) - t);
      reach += Math.abs(t - enc(source[c * D + d]));
    }
    diffCell[c] = D === 1
      ? enc(achieved[c]) - enc(target[c])
      : enc(luminance(achieved[3 * c], achieved[3 * c + 1], achieved[3 * c + 2])) -
        enc(luminance(target[3 * c], target[3 * c + 1], target[3 * c + 2]));
  }

  const piece = {
    widthMm: b.widthMm, heightMm: b.heightMm, kerf: s.kerf, web: s.web,
    mode: b.mode, nCut: b.layers.length,
    // each sheet's color, top first -- for export names; the B&W sheet is the display color
    colors: b.mode === 'bw' ? [s.sheet || '#2b2b2b'] : s.palette.slice(0, b.layers.length + 1),
  };
  const machine = { speed: s.speed || 20, pierce: s.pierce ?? 0.3 };
  // The blank border: every pattern hole reaching into it is dropped, layer by
  // layer, before anything downstream (stats, preview, export) sees the layers.
  // Removing holes only ever adds metal, so it cannot break the one-piece
  // guarantee the method already made. This is a blunt, per-hole net for the
  // per-cell methods (squareGrid, hexGrid, the cellWeb family, stipple), whose
  // holes are each small and cell-bound; the stencil and the screen instead fold
  // the border straight into their own raster's structural rim (see their
  // build()), since one of their holes can be a loop spanning most of the sheet
  // and dropping it whole over a graze would take far more than the border.
  // Corner holes for registering the stack, the same on every sheet -- kept out
  // of `layers` (the pattern's own holes, what the stats below score) and added
  // in at export instead (app.js), the one place that also reaches the solid
  // base sheet, which has no entry of its own in `layers`. The border never
  // drops these: they are the one thing explicitly allowed inside it. Pattern
  // holes within a web of one are dropped instead, by the same per-hole net
  // (the stencil and the screen keep that metal on their raster, as the border).
  const align = s.alignHoles ? alignmentHoles(b.widthMm, b.heightMm, s.alignDist, s.alignDia, s.web, s.kerf) : [];
  const layers = b.layers.map((holes) => {
    const kept = s.border > 0 ? dropBorder(holes, b.widthMm, b.heightMm, s.border, s.kerf / 2) : holes;
    return dropNearAlignment(kept, align, s.web, s.kerf / 2);
  });
  // The Stencil's brightness layers: extra sheets, each cut whole (the border
  // is already in their raster's rim, as for the Stencil's own sheets). They are
  // not in `layers`, so the scores above never see them.
  const levels = b.levels || [];
  const out = {
    piece,
    layers,
    levels,
    align,
    note: b.note || '',
    stats: {
      cells: N, cellsLabel: b.cellsLabel, dropped: b.dropped, saturated: b.saturated,
      // The stats charge for the alignment holes too -- they are really cut --
      // but not for whatever the border dropped, which is really not.
      layers: layers.map((holes, j) => layerStats(piece, holes.concat(align), b.webs[j], machine)),
      levels: levels.map((lv) => layerStats(piece, lv.holes.concat(align), lv.web, machine)),
      fidelity: fid / (N * D), reach: reach / (N * D),
    },
  };
  if (opts.preview === false) return out;
  progress('rendering previews');

  // The Result/backlit composites are physical views -- "as the stacked sheets
  // look" -- and an alignment hole really is cut through every sheet, so it
  // shows here as a plain through-hole too, not as a marker drawn over the top.
  const bw = b.mode === 'bw';
  const display = bw
    ? [hexToLinear(s.sheet || '#2b2b2b'), hexToLinear(s.backdrop || '#ffffff')]
    : b.palette;
  // With brightness layers, the whole physical stack is drawn (so a layer's
  // bridge over a deeper color shows, as it would on the piece), and each
  // layer's visible edges are outlined in a faded version of its color --
  // seen straight on, a layer is the same color as the sheet under it, and
  // would not show at all. The solid base is the stack's floor, not a layer;
  // without brightness layers this is just `layers`.
  const stack = physicalStack(layers, levels, bw).filter((e) => !e.base);
  const cut = stack.map((e) => (align.length ? e.holes.concat(align) : e.holes));
  const pre = rasterizeHoles(piece, cut, { maxDim: opts.maxDim });
  const colors = stack.map((e) => display[e.color]).concat([display[layers.length]]);
  const result = composite(pre, colors);
  if (levels.length) {
    outlineSteps(result, pre, stack.map((e) => (e.level ? fadedRGB(display[e.color]) : null)).concat([null]));
  }
  out.preview = {
    w: pre.w, h: pre.h, pxPerMm: pre.pxPerMm,
    result,
    // the visible surface's height in sheets, and which sheets are metal at each
    // pixel, for the Relief view's shading (app.js)
    height: stackHeights(pre),
    solid: sheetSolids(piece, cut, pre),
    backlit: bw ? composite(pre, stack.map(() => [0.004, 0.004, 0.004]).concat([[1, 1, 1]])) : null,
    source: sourcePreview(styled, b.imageRect, pre, display[0]),
    diff: diffPreview(b.cellAt, pre, diffCell),
  };
  return out;
}

/** The source image laid over the area it maps to, the rest in the top sheet's color. */
function sourcePreview(rgba, R, pre, borderLinear) {
  const { w, h, pxPerMm } = pre;
  const out = new Uint8ClampedArray(w * h * 4);
  const border = borderLinear.map((v) => 255 * toEncoded(v));
  for (let py = 0; py < h; py++) {
    const ymm = (py + 0.5) / pxPerMm - R.y;
    for (let px = 0; px < w; px++) {
      const xmm = (px + 0.5) / pxPerMm - R.x;
      const q = 4 * (py * w + px);
      if (xmm < 0 || ymm < 0 || xmm >= R.w || ymm >= R.h) {
        out[q] = border[0]; out[q + 1] = border[1]; out[q + 2] = border[2];
      } else {
        const sx = Math.min(rgba.width - 1, Math.floor((xmm / R.w) * rgba.width));
        const sy = Math.min(rgba.height - 1, Math.floor((ymm / R.h) * rgba.height));
        const k = 4 * (sy * rgba.width + sx);
        out[q] = rgba.data[k]; out[q + 1] = rgba.data[k + 1]; out[q + 2] = rgba.data[k + 2];
      }
      out[q + 3] = 255;
    }
  }
  return out;
}

/** Signed per-cell error spread over the preview; NaN where no cell is. */
function diffPreview(cellAt, pre, diffCell) {
  const { w, h, pxPerMm } = pre;
  const out = new Float32Array(w * h).fill(NaN);
  for (let py = 0; py < h; py++) {
    const y = (py + 0.5) / pxPerMm;
    for (let px = 0; px < w; px++) {
      const c = cellAt((px + 0.5) / pxPerMm, y);
      if (c >= 0) out[py * w + px] = diffCell[c];
    }
  }
  return out;
}
