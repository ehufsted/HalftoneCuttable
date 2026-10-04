// Stencil: the image as solid shapes, cut out whole, with bridges holding in any
// metal that would otherwise fall out (the middle of an O).
//
// PIPELINE, per cut sheet, all on a raster fine enough that the min web spans
// about five pixels, and all morphology done with an exact Euclidean distance
// transform (core/edt.js), so "wider than w" means a true disc of diameter w:
//
//   1. POSTERIZE. B&W: cut where the (smoothed) image is lighter than the
//      threshold -- removed metal reads white. Color: each pixel takes the
//      nearest sheet color; sheet j is cut wherever the pixel's sheet lies deeper
//      than j. A frame of web + kerf/2 (plus the border setting, if any) round
//      the piece is always metal.
//   2. REGISTRATION (color). A deeper sheet's cut is extended by j·reg into areas
//      where a sheet above it is solid, so it hides under that sheet and a small
//      misalignment when stacking shows nothing -- the same rule as the other
//      patterns' solid color.
//   3. CLEAN UP. Cut slots narrower than the smallest hole are filled (an
//      opening of the cut). Metal narrower than the web is THICKENED, not removed:
//      the thin parts are grown by web/2, so a thin line survives as a line.
//      Metal specks too small to be worth bridging are cut away.
//   4. BRIDGES, unless floating parts are allowed. The units to join are the
//      components of the metal's CORE (the metal shrunk by just under web/2), not
//      of the metal itself: a neck thinner than the web separates cores, so it
//      gets bridged too instead of passing as "connected". Each unit gets two
//      straight bridges, in directions at least 90° apart (or opposite, for the
//      horizontal and vertical styles), to whatever other metal is nearest; then
//      any cluster still not joined to the frame gets one more, until all are.
//   5. TRACE. The cut's signed distance is contoured at -kerf/2 -- the cut path,
//      offset for the kerf with sub-pixel accuracy -- and simplified.
//
// HALFTONE INSIDE SHAPES (checkbox) replaces 3-5: each shape is filled with a
// grid of round holes sized by the tone inside it, each kept within its shape.
// Separate convex holes cannot enclose metal, so no bridges are needed.
//
// BRIGHTNESS LAYERS (levels > 0, not with halftone): N extra sheets per color,
// stacked directly on top of that color's own sheet, so brighter parts of each
// color's region stand higher, like a topographic map. For color l and level i
// of N, the level is lo + (hi - lo)·i/(N+1), spaced evenly in encoded or
// linear values. [lo, hi] is the luminance range of color l's region, all of
// it together: the 1st to 99th percentile over its CORE, the region less a rim
// along its edge, where the brightness is smoothed within the region on its
// own (regionField) so a neighbor's edge cannot leak in. The sheet is METAL in
// region l where the luminance is at least the level, and also wherever a
// sheet above hides it (label < l: solid, which keeps it strong). It is CUT in
// the rest of region l and wherever a deeper color shows (exactly sheet l's
// own raw cut, registration extension included). Then steps 3-5 as for any
// sheet. Returned as `levels`, in stack order (color by color, top level
// first); `layers` is unchanged, so the scores are too -- seen from above, a
// brightness layer is its own sheet's color. A color whose region is empty or
// flat gets no brightness layers, and says so.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize } from '../shim/image.js';
import { toEncoded, encodeFast, luminance } from '../core/color.js';
import { blur, quantile } from '../core/features.js';
import { edt, dilate, erode, invert, components } from '../core/edt.js';
import { sheetTools, scoreWindows, workRaster, sheetFrame } from '../core/cutsheet.js';

export const id = 'stencil';
export const label = 'Stencil';
export const blurb = 'The image as solid shapes, cut out whole. Loose metal is held in by bridges, or cut free to glue down. Best for logos, text and silhouettes.';

export const params = [
  { key: 'threshold', label: 'Threshold', type: 'range', min: 0.05, max: 0.95, step: 0.01, def: 0.5,
    when: (p, env) => env.mode !== 'color' },
  { key: 'smooth', label: 'Shape smoothing', type: 'range', min: 0, max: 3, step: 0.1, def: 0.5, unit: 'mm', dp: 1 },
  { key: 'halftone', label: 'Halftone inside shapes', type: 'checkbox', def: false },
  { key: 'pitch', label: 'Hole pitch', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1,
    when: (p) => p.halftone },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']], when: (p) => p.halftone },
  { key: 'floating', label: 'Allow floating parts (glue them down)', type: 'checkbox', def: false,
    when: (p) => !p.halftone },
  { key: 'bridges', label: 'Bridges', type: 'select', def: 'auto',
    options: [['auto', 'Automatic'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']],
    when: (p) => !p.halftone && !p.floating },
  { key: 'bridgeWidth', label: 'Bridge width', type: 'range', min: 0.3, max: 5, step: 0.1, def: 1.2, unit: 'mm', dp: 1,
    when: (p) => !p.halftone && !p.floating },
  { key: 'levels', label: 'Brightness layers per color', type: 'range', min: 0, max: 8, step: 1, def: 0,
    when: (p) => !p.halftone },
  { key: 'levelSpace', label: 'Level spacing', type: 'select', def: 'encoded',
    options: [['encoded', 'Even as seen (encoded)'], ['linear', 'Even in linear light']],
    when: (p) => !p.halftone && p.levels > 0 },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
const WORK_PIXELS = 2.5e6;
const WINDOW = 3;           // mm, scoring window

export function build(rgba, settings, params = {}) {
  const P = { ...DEF, ...params };
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } = prepareRaster(rgba, settings);

  // ---- the work raster
  const { ww, wh, k, ky, NP } = workRaster(W, H, web, WORK_PIXELS);
  let planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  const unsmoothed = planes;     // the brightness layers smooth per region instead
  if (P.smooth > 0) planes = planes.map((pl) => blur(pl, P.smooth * k));

  // ---- 1. posterize
  const src = new Float32Array(NP * D), lab = new Uint8Array(NP);
  // The blank border, if any, and a web round each alignment hole are added to
  // the structural rim here, at the raster stage, rather than dropped from the
  // traced loops afterward -- a contour here can span most of the sheet, and
  // dropping one whole loop because it grazes either would take far more.
  const e = web + kerf / 2 + (s.border || 0);
  const frame = sheetFrame(ww, wh, k, ky, W, H, s, e, web + kerf / 2);
  const encPal = palette.map((c) => c.map((v) => toEncoded(v)));
  for (let q = 0; q < NP; q++) {
    const r = planes[0].data[q], g = planes[1].data[q], b = planes[2].data[q];
    if (bw) {
      const Y = Math.max(0, Math.min(1, luminance(r, g, b)));
      src[q] = Y;
      lab[q] = encodeFast(Y) > P.threshold ? 1 : 0;
    } else {
      src[3 * q] = r; src[3 * q + 1] = g; src[3 * q + 2] = b;
      const er = encodeFast(r), eg = encodeFast(g), eb = encodeFast(b);
      let best = 0, bd = Infinity;
      for (let l = 0; l < n; l++) {
        const d2 = (encPal[l][0] - er) ** 2 + (encPal[l][1] - eg) ** 2 + (encPal[l][2] - eb) ** 2;
        if (d2 < bd) { bd = d2; best = l; }
      }
      lab[q] = best;
    }
    if (frame[q]) lab[q] = 0;
  }

  // ---- 2. each sheet's raw cut, with the registration extension
  const cuts = [];
  for (let j = 0; j < nCut; j++) {
    const C = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) C[q] = lab[q] > j ? 1 : 0;
    if (reg > 0 && j > 0) {
      const ext = dilate(C, ww, wh, j * reg * k);
      for (let q = 0; q < NP; q++) if (!C[q] && ext[q] && lab[q] < j) C[q] = 1;
    }
    for (let q = 0; q < NP; q++) if (frame[q]) C[q] = 0;
    cuts.push(C);
  }

  const notes = [];
  const debug = { k, ww, wh, lab, bridges: [], fallback: 0, unresolved: 0, specks: 0, floating: 0 };
  const { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet } = sheetTools({
    ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth: P.bridgeWidth, bridgeStyle: P.bridges,
  });
  let layers, webs, cellsLabel, tgtPix, levels = [];

  if (!P.halftone) {
    // the brightness layers start from each sheet's RAW cut, before cleanup;
    // cleanSheet makes a new raster, so keeping the old references is enough
    const rawCuts = P.levels > 0 ? cuts.slice() : null;
    // ---- 3-5, per sheet
    layers = []; webs = [];
    let contours = 0;
    for (let j = 0; j < nCut; j++) {
      let C = cleanSheet(cuts[j], debug);
      if (!P.floating) {
        C = finishSheet(bridgeSheet(C, debug), debug);   // slivers the bridges left
        webs.push(measureWeb(C));
      } else {
        const M = invert(C);
        debug.floating += Math.max(0, components(M, ww, wh).sizes.length - 1);
        webs.push(web);      // every feature is at least the web wide by step 3
      }
      cuts[j] = C;
      const holes = traceSheet(C);
      contours += holes.length;
      layers.push(holes);
    }
    cellsLabel = `${contours.toLocaleString()} contours`;
    tgtPix = (q, out) => { for (let d = 0; d < D; d++) out[d] = palette[lab[q]][d]; };
    if (debug.bridges.length) notes.push(`${debug.bridges.length} bridges`);
    if (debug.fallback) notes.push(`${debug.fallback} parts could not be bridged ${P.bridges} and were bridged at an angle`);
    if (debug.unresolved) notes.push(`${debug.unresolved} parts could NOT be bridged — they will fall out`);
    if (debug.floating) notes.push(`${debug.floating} floating parts to glue down`);
    if (debug.specks) notes.push(`${debug.specks} metal specks too small to hold were cut away`);
    if (rawCuts) levels = brightnessLayers(rawCuts);
  } else {
    ({ layers, webs, tgtPix, cellsLabel } = halftoneShapes());
  }

  // ---- scoring windows, from the renderer (contours come from a raster anyway)
  const { target, source, achieved, cellAt, N: NW } = scoreWindows({
    W, H, ww, wh, k, ky, D, palette, kerf, window: WINDOW, src, layers, tgtPix,
  });

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N: NW, palette,
    target, achieved, source, layers, webs, cellAt, levels,
    imageRect: { x: 0, y: 0, w: W, h: H },
    // dropped/saturated are honestly 0, not just unset: a plain cutout has no
    // per-cell hole size to pin at a floor or a ceiling. Halftone mode DOES have
    // one (per shape, like squareGrid's), so it could report real numbers here;
    // left at 0 for now because the definition needs deciding, not because it
    // was overlooked.
    cellsLabel, dropped: 0, saturated: 0, note: notes.join(' · '),
    debug: { ...debug, cuts, frame },
  };

  // ======================================================================
  // helpers (closures over the raster)

  /**
   * The brightness layers: per color, N sheets cut along isocontours of the
   * luminance inside that color's region (see the header). Their bridges and
   * counts are kept apart from the main sheets', so those notes do not change.
   * @returns {Array<{color, level, of, value, range, holes, web}>} stack order
   */
  function brightnessLayers(rawCuts) {
    const N = Math.round(P.levels);
    const enc = P.levelSpace !== 'linear';
    const val0 = new Float32Array(NP);
    const [pr, pg, pb] = unsmoothed.map((pl) => pl.data);
    for (let q = 0; q < NP; q++) {
      const c = Math.max(0, Math.min(1, luminance(pr[q], pg[q], pb[q])));
      val0[q] = enc ? encodeFast(c) : c;
    }
    const dbg = { bridges: [], fallback: 0, unresolved: 0, specks: 0, floating: 0, cores: [] };
    const out = [], flat = [];
    // B&W: only the metal sheet is a material; the "white" is the backdrop
    for (let l = 0; l < (bw ? 1 : n); l++) {
      const { val, core } = regionField(val0, l);
      dbg.cores[l] = core;
      // 1st to 99th percentile, so a few stray pixels of grain cannot set it
      const lo = quantile(val, 0.01, core), hi = quantile(val, 0.99, core);
      if (!(hi - lo > 1e-3)) { flat.push(l); continue; }
      const own = l < nCut ? rawCuts[l] : null;
      // top level first: the smallest, brightest sheet sits highest
      for (let i = N; i >= 1; i--) {
        const t = lo + ((hi - lo) * i) / (N + 1);
        let C = new Uint8Array(NP);
        for (let q = 0; q < NP; q++) {
          C[q] = !frame[q] && ((own && own[q]) || (lab[q] === l && val[q] < t)) ? 1 : 0;
        }
        C = cleanSheet(C, dbg);
        let w = web;
        if (!P.floating) {
          C = finishSheet(bridgeSheet(C, dbg), dbg);
          w = measureWeb(C);
        } else {
          dbg.floating += Math.max(0, components(invert(C), ww, wh).sizes.length - 1);
        }
        out.push({ color: l, level: i, of: N, value: t, range: [lo, hi], holes: traceSheet(C), web: w });
      }
    }
    if (out.length) {
      const what = `${out.length} brightness layer${out.length === 1 ? '' : 's'}`;
      notes.push(dbg.bridges.length ? `${what} (${dbg.bridges.length} bridges)` : what);
    }
    if (flat.length) {
      const which = flat.map((l) => (bw ? 'the sheet' : `sheet ${l + 1}`)).join(', ');
      const why = bw ? 'flat' : 'empty or flat';
      notes.push(`no brightness layers for ${which}: ${flat.length > 1 ? 'their regions are' : 'its region is'} ${why}`);
    }
    // the same warnings as the main sheets', said of the layers
    if (dbg.fallback) notes.push(`${dbg.fallback} parts of the brightness layers could not be bridged ${P.bridges} and were bridged at an angle`);
    if (dbg.unresolved) notes.push(`${dbg.unresolved} parts of the brightness layers could NOT be bridged — they will fall out`);
    if (dbg.floating) notes.push(`${dbg.floating} floating parts in the brightness layers to glue down`);
    if (dbg.specks) notes.push(`${dbg.specks} metal specks in the brightness layers too small to hold were cut away`);
    debug.levels = dbg;
    return out;
  }

  /**
   * Color l's brightness, smoothed WITHIN its own region: a normalized
   * convolution (blur of value × mask over blur of mask) of the UNSMOOTHED
   * brightness over the region's CORE, the region less a rim as wide as the
   * smoothing reaches (2σ) plus 1.5 px for the resize's own blending. Taking
   * the smoothed image's brightness as it stands gave each region a rim of its
   * neighbors' values: on a flat region that rim alone set the range, and on
   * any region a rim brighter than a level became a sliver of metal that the
   * cleanup thickened into a raised strip along the neighbor. The rim is also
   * where the labels (from the smoothed image) disagree with the unsmoothed
   * pixels. Rim pixels take their value from the core nearby; pixels farther
   * than the rim from any core stand in for themselves. That is by distance,
   * not per connected part, so a thin tail on a thick part keeps its own
   * values instead of taking the far-off core's. A convex corner's rim is no
   * farther than that: the labels come from the smoothed image, so their
   * corners are rounded at the scale of R (checked by the harness).
   */
  function regionField(val0, l) {
    const mask = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) mask[q] = lab[q] === l && !frame[q] ? 1 : 0;
    const R = 1.5 + 2 * P.smooth * k;
    const core = erode(mask, ww, wh, R);
    const dCore = edt(core, ww, wh);
    for (let q = 0; q < NP; q++) if (mask[q] && dCore[q] > R + 1) core[q] = 1;
    const num = new Float32Array(NP), den = new Float32Array(NP);
    for (let q = 0; q < NP; q++) if (core[q]) { num[q] = val0[q]; den[q] = 1; }
    const sig = Math.max(P.smooth * k, 1.5);
    const bn = blur({ w: ww, h: wh, data: num }, sig).data, bd = blur({ w: ww, h: wh, data: den }, sig).data;
    const val = new Float32Array(NP);
    for (let q = 0; q < NP; q++) if (mask[q]) val[q] = bd[q] > 1e-6 ? bn[q] / bd[q] : val0[q];
    return { val, core };
  }

  /** Halftone inside shapes: a grid of round holes, each kept within its shape. */
  function halftoneShapes() {
    const p = P.pitch;
    const dmax = p - web - 2 * (nCut - 1) * reg;
    const fMax = dmax > 0 ? (Math.PI * dmax * dmax) / 4 / (p * p) : 0;
    // distance from each pixel to the nearest pixel of another shape
    const dOther = new Float32Array(NP);
    for (let l = 1; l < n; l++) {
      const other = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) other[q] = lab[q] !== l ? 1 : 0;
      const d = edt(other, ww, wh);
      for (let q = 0; q < NP; q++) if (lab[q] === l) dOther[q] = d[q] / k;
    }
    const tone = (q, l) => {
      if (bw) return src[q];
      const c0 = palette[0], cl = palette[l];
      let num = 0, den = 0;
      for (let d = 0; d < 3; d++) { num += (src[3 * q + d] - c0[d]) * (cl[d] - c0[d]); den += (cl[d] - c0[d]) ** 2; }
      return den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
    };
    const fit = (t) => (P.range === 'clip' ? Math.min(t, fMax) : t * fMax);
    const eg = web + kerf / 2 + dmax / 2 + (nCut - 1) * reg;
    const gc = W >= 2 * eg ? Math.floor((W - 2 * eg) / p) + 1 : 0;
    const gr = H >= 2 * eg ? Math.floor((H - 2 * eg) / p) + 1 : 0;
    const ox = (W - (gc - 1) * p) / 2, oy = (H - (gr - 1) * p) / 2;
    const dots = [];
    const dAt = new Float64Array(gc * gr), lAt = new Uint8Array(gc * gr);
    for (let gj = 0; gj < gr; gj++) {
      for (let gi = 0; gi < gc; gi++) {
        const x = ox + gi * p, y = oy + gj * p;
        const q = Math.min(wh - 1, Math.floor(y * ky)) * ww + Math.min(ww - 1, Math.floor(x * k));
        const l = lab[q];
        if (l === 0 || dmax <= 0) continue;
        const F = fit(tone(q, l));
        // dOther is measured between pixel CENTERS: the shape's edge lies half a
        // pixel nearer, and the hole's center can sit up to 0.71 px from its
        // pixel's center -- without this margin, holes poked out by up to a pixel
        const cap = Math.min(dmax, 2 * Math.max(0, dOther[q] - 1.25 / k));
        let d = Math.min(Math.sqrt((4 * F * p * p) / Math.PI), cap);
        if (d < hFloor) d = hFloor <= cap && F * p * p >= (Math.PI * hFloor * hFloor) / 8 ? hFloor : 0;
        if (d <= 0) continue;
        dAt[gj * gc + gi] = d; lAt[gj * gc + gi] = l;
        dots.push({ x, y, l, d });
      }
    }
    const lays = [], ws = [];
    for (let j = 0; j < nCut; j++) {
      const holes = [];
      for (const t of dots) {
        if (t.l <= j) continue;
        const c = t.d + 2 * j * reg - kerf;
        holes.push({ kind: 'rsq', cx: t.x, cy: t.y, a: c, r: c / 2, rot: false });
      }
      lays.push(holes);
      let wmin = Infinity;
      for (let gj = 0; gj < gr; gj++) {
        for (let gi = 0; gi < gc; gi++) {
          const a = gj * gc + gi;
          if (!(lAt[a] > j)) continue;
          const da = dAt[a] + 2 * j * reg;
          const x = ox + gi * p, y = oy + gj * p;
          wmin = Math.min(wmin, Math.min(x, y, W - x, H - y) - da / 2);
          for (const b of [gi + 1 < gc ? a + 1 : -1, gj + 1 < gr ? a + gc : -1]) {
            if (b >= 0 && lAt[b] > j) wmin = Math.min(wmin, p - (da + dAt[b] + 2 * j * reg) / 2);
          }
        }
      }
      ws.push(wmin);
    }
    const tp = (q, out) => {
      const l = lab[q];
      const F = l === 0 ? 0 : fit(tone(q, l));
      for (let d = 0; d < D; d++) out[d] = (1 - F) * palette[0][d] + F * palette[l][d];
    };
    return { layers: lays, webs: ws, tgtPix: tp, cellsLabel: `${dots.length.toLocaleString()} holes` };
  }
}

export default { id, label, blurb, params, build };
