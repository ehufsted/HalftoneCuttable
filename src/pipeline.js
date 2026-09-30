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
import { rasterizeHoles, composite } from './core/render.js';
import { layerStats } from './core/structure.js';
import { toEncoded, luminance, hexToLinear } from './core/color.js';
import { byId } from './methods/index.js';
import { applyStyle } from './core/style.js';

/**
 * @param {{width,height,data}} rgba
 * @param {object} settings   units.DEFAULTS plus: sheet, backdrop (B&W display
 *                            colours), speed (mm/s), pierce (s)
 * @param {string} methodId
 * @param {object} params     the method's own
 * @param {{preview?:boolean, maxDim?:number}} opts  preview:false skips the rasters
 */
export function runPipeline(rgba, settings, methodId, params, opts = {}) {
  const s = { ...DEFAULTS, ...settings };
  // Tone (gamma, brightness, saturation) first, then Style: both restyle the
  // image before the method (and the Source view, and the reach score) see it,
  // so a person can see exactly what a slider or a filter did to the image.
  const toned = applyTone(rgba, s.gamma, s.brightness, s.saturation);
  const styled = applyStyle(toned, s.style, s.widthMm);
  const b = byId(methodId).build(styled, s, params);
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
    // each sheet's colour, top first -- for export names; the B&W sheet is the display colour
    colours: b.mode === 'bw' ? [s.sheet || '#2b2b2b'] : s.palette.slice(0, b.layers.length + 1),
  };
  const machine = { speed: s.speed || 20, pierce: s.pierce ?? 0.3 };
  const out = {
    piece,
    layers: b.layers,
    note: b.note || '',
    stats: {
      cells: N, cellsLabel: b.cellsLabel, dropped: b.dropped, saturated: b.saturated,
      layers: b.layers.map((holes, j) => layerStats(piece, holes, b.webs[j], machine)),
      fidelity: fid / (N * D), reach: reach / (N * D),
    },
  };
  if (opts.preview === false) return out;

  const pre = rasterizeHoles(piece, b.layers, { maxDim: opts.maxDim });
  const bw = b.mode === 'bw';
  const display = bw
    ? [hexToLinear(s.sheet || '#2b2b2b'), hexToLinear(s.backdrop || '#ffffff')]
    : b.palette;
  out.preview = {
    w: pre.w, h: pre.h, pxPerMm: pre.pxPerMm,
    result: composite(pre, display),
    backlit: bw ? composite(pre, [[0.004, 0.004, 0.004], [1, 1, 1]]) : null,
    source: sourcePreview(styled, b.imageRect, pre, display[0]),
    diff: diffPreview(b.cellAt, pre, diffCell),
  };
  return out;
}

/** The source image laid over the area it maps to, the rest in the top sheet's colour. */
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
