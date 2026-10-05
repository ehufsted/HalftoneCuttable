// The Stencil's brightness layers (levels > 0, not with halftone): N extra
// sheets per color, stacked directly on top of that color's own sheet, so
// brighter parts of each color's region stand higher, like a topographic map.
//
// For color l and level i of N, the level is lo + (hi - lo)·i/(N+1), spaced
// evenly in encoded or linear values. [lo, hi] is the luminance range of color
// l's region, all of it together: the 1st to 99th percentile over its CORE, the
// region less a rim along its edge, where the brightness is smoothed within the
// region on its own (regionField) so a neighbor's edge cannot leak in. The
// sheet is METAL in region l where the luminance is at least the level, and
// also wherever a sheet above hides it (label < l: solid, which keeps it
// strong). It is CUT in the rest of region l and wherever a deeper color shows
// (exactly sheet l's own raw cut, registration extension included).
//
// This module plans each layer's raw cut; the Stencil finishes them with its
// own sheets (cleanup, bridges, trace), from the bottom of the stack up. They
// are returned apart from its `layers`, so the scores are unchanged -- seen
// from above, a brightness layer is its own sheet's color. A color whose region
// is empty or flat gets no brightness layers, and says so.

import { luminance, encodeFast } from '../core/color.js';
import { blur, quantile } from '../core/features.js';
import { edt, erode } from '../core/edt.js';

/**
 * Every brightness layer's raw cut.
 * @param {object} r  the stencil's work raster: {ww, wh, k, lab, frame,
 *   unsmoothed (its linear planes before smoothing), bw, n, nCut}
 * @param {{levels:number, levelSpace:string, smooth:number}} P
 * @param {Uint8Array[]} rawCuts  each main sheet's raw cut, before cleanup
 * @returns {{sheets: Array<{color, level, of, value, range, C}>, flat: number[], cores: Uint8Array[]}}
 *   sheets in stack order (color by color, top level first); flat: the colors
 *   whose region is empty or flat; cores: each color's region core
 */
export function planLevels(r, P, rawCuts) {
  const { lab, frame, unsmoothed, bw, n, nCut } = r;
  const NP = r.ww * r.wh;
  const N = Math.round(P.levels);
  const enc = P.levelSpace !== 'linear';
  const val0 = new Float32Array(NP);
  const [pr, pg, pb] = unsmoothed.map((pl) => pl.data);
  for (let q = 0; q < NP; q++) {
    const c = Math.max(0, Math.min(1, luminance(pr[q], pg[q], pb[q])));
    val0[q] = enc ? encodeFast(c) : c;
  }
  const sheets = [], flat = [], cores = [];
  // B&W: only the metal sheet is a material; the "white" is the backdrop
  for (let l = 0; l < (bw ? 1 : n); l++) {
    const { val, core } = regionField(r, P.smooth, val0, l);
    cores[l] = core;
    // 1st to 99th percentile, so a few stray pixels of grain cannot set it
    const lo = quantile(val, 0.01, core), hi = quantile(val, 0.99, core);
    if (!(hi - lo > 1e-3)) { flat.push(l); continue; }
    const own = l < nCut ? rawCuts[l] : null;
    // top level first: the smallest, brightest sheet sits highest
    for (let i = N; i >= 1; i--) {
      const t = lo + ((hi - lo) * i) / (N + 1);
      const C = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) {
        C[q] = !frame[q] && ((own && own[q]) || (lab[q] === l && val[q] < t)) ? 1 : 0;
      }
      sheets.push({ color: l, level: i, of: N, value: t, range: [lo, hi], C });
    }
  }
  return { sheets, flat, cores };
}

/**
 * Color l's brightness, smoothed WITHIN its own region: a normalized
 * convolution (blur of value × mask over blur of mask) of the UNSMOOTHED
 * brightness over the region's CORE, the region less a rim as wide as the
 * smoothing reaches (2σ) plus 1.5 px for the resize's own blending. Taking the
 * smoothed image's brightness as it stands gave each region a rim of its
 * neighbors' values: on a flat region that rim alone set the range, and on any
 * region a rim brighter than a level became a sliver of metal that the cleanup
 * thickened into a raised strip along the neighbor. The rim is also where the
 * labels (from the smoothed image) disagree with the unsmoothed pixels. Rim
 * pixels take their value from the core nearby; pixels farther than the rim
 * from any core stand in for themselves. That is by distance, not per
 * connected part, so a thin tail on a thick part keeps its own values instead
 * of taking the far-off core's. A convex corner's rim is no farther than that:
 * the labels come from the smoothed image, so their corners are rounded at the
 * scale of R (checked by the harness).
 */
function regionField(r, smooth, val0, l) {
  const { ww, wh, k, lab, frame } = r;
  const NP = ww * wh;
  const mask = new Uint8Array(NP);
  for (let q = 0; q < NP; q++) mask[q] = lab[q] === l && !frame[q] ? 1 : 0;
  const R = 1.5 + 2 * smooth * k;
  const core = erode(mask, ww, wh, R);
  const dCore = edt(core, ww, wh);
  for (let q = 0; q < NP; q++) if (mask[q] && dCore[q] > R + 1) core[q] = 1;
  const num = new Float32Array(NP), den = new Float32Array(NP);
  for (let q = 0; q < NP; q++) if (core[q]) { num[q] = val0[q]; den[q] = 1; }
  const sig = Math.max(smooth * k, 1.5);
  const bn = blur({ w: ww, h: wh, data: num }, sig).data, bd = blur({ w: ww, h: wh, data: den }, sig).data;
  const val = new Float32Array(NP);
  for (let q = 0; q < NP; q++) if (mask[q]) val[q] = bd[q] > 1e-6 ? bn[q] / bd[q] : val0[q];
  return { val, core };
}

/**
 * The brightness layers' notes: their count, the colors that got none, and the
 * main sheets' warnings, said of the layers.
 * @param {Array} levels  the finished layers
 * @param {object} dbg    their bridging counts (cutsheet.sheetTools)
 * @param {string} bridgeStyle  the Bridges param, for the fallback note
 * @returns {string[]}
 */
export function levelNotes(levels, flat, dbg, bw, bridgeStyle) {
  const notes = [];
  if (levels.length) {
    const what = `${levels.length} brightness layer${levels.length === 1 ? '' : 's'}`;
    notes.push(dbg.bridges.length ? `${what} (${dbg.bridges.length} bridges)` : what);
  }
  if (flat.length) {
    const which = flat.map((l) => (bw ? 'the sheet' : `sheet ${l + 1}`)).join(', ');
    const why = bw ? 'flat' : 'empty or flat';
    notes.push(`no brightness layers for ${which}: ${flat.length > 1 ? 'their regions are' : 'its region is'} ${why}`);
  }
  if (dbg.fallback) notes.push(`${dbg.fallback} parts of the brightness layers could not be bridged ${bridgeStyle} and were bridged at an angle`);
  if (dbg.unresolved) notes.push(`${dbg.unresolved} parts of the brightness layers could NOT be bridged — they will fall out`);
  if (dbg.unsupported) notes.push(`${dbg.unsupported} parts of the brightness layers could not be bridged over the sheet below — cut free to glue down`);
  if (dbg.floating) notes.push(`${dbg.floating} floating parts in the brightness layers to glue down`);
  if (dbg.specks) notes.push(`${dbg.specks} metal specks in the brightness layers too small to hold were cut away`);
  return notes;
}
