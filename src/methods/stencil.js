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
//      KEEP BRIDGES ON THE SHEET BELOW (checkbox): a bridge may only cross the
//      cut where the sheet directly beneath is metal, so every bridge can be
//      glued down and none spans a hole. Sheets are finished from the bottom
//      of the stack up, so that metal is known; a part with no such route is
//      cut free to glue down instead, and the note says how many.
//   5. TRACE. The cut's signed distance is contoured at -kerf/2 -- the cut path,
//      offset for the kerf with sub-pixel accuracy -- and simplified.
//
// HALFTONE INSIDE SHAPES (checkbox) replaces 3-5: each shape is filled with a
// grid of round holes sized by the tone inside it, each kept within its shape.
// Separate convex holes cannot enclose metal, so no bridges are needed.
//
// BRIGHTNESS LAYERS (levels > 0, not with halftone): N extra sheets per color,
// cut along brightness contours and stacked on that color's own sheet. Planned
// in methods/brightnessLayers.js, whose header explains them; finished here
// with the main sheets (steps 3-5) and returned as `levels`, in stack order.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize } from '../shim/image.js';
import { toEncoded, encodeFast, luminance } from '../core/color.js';
import { blur } from '../core/features.js';
import { edt, dilate, erode, invert, components } from '../core/edt.js';
import { sheetTools, scoreWindows, workRaster, sheetFrame } from '../core/cutsheet.js';
import { planLevels, levelNotes } from './brightnessLayers.js';

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
  // only where a sheet lies beneath: color sheets, and brightness layers
  { key: 'supported', label: 'Keep bridges on the sheet below', type: 'checkbox', def: false,
    when: (p, env) => !p.halftone && !p.floating && (env.mode === 'color' || p.levels > 0) },
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
  const debug = { k, ww, wh, lab, bridges: [], fallback: 0, unresolved: 0, unsupported: 0, specks: 0, floating: 0 };
  const { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet } = sheetTools({
    ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth: P.bridgeWidth, bridgeStyle: P.bridges,
  });
  let layers, webs, cellsLabel, tgtPix, levels = [];

  if (!P.halftone) {
    // the brightness layers (methods/brightnessLayers.js) start from each
    // sheet's RAW cut, before cleanup; their counts are kept apart from the
    // main sheets', so those notes do not change
    const ldbg = { bridges: [], fallback: 0, unresolved: 0, unsupported: 0, specks: 0, floating: 0 };
    const plan = P.levels > 0
      ? planLevels({ ww, wh, k, lab, frame, unsmoothed, bw, n, nCut }, P, cuts)
      : null;
    if (plan) { ldbg.cores = plan.cores; debug.levels = ldbg; }
    // ---- 3-5, per sheet, from the bottom of the stack up, so that with
    // "keep bridges on the sheet below" each sheet's bridges can be confined to
    // the finished metal of the sheet beneath it (the solid base in color; in
    // B&W nothing lies under the sheet but the backdrop). Each sheet is
    // otherwise finished on its own, so the order changes nothing else.
    const bridgeR = (Math.max(P.bridgeWidth, web) / 2) * k;
    const finish = (C0, dbg, below) => {
      let C = cleanSheet(C0, dbg);
      if (P.floating) {
        dbg.floating += Math.max(0, components(invert(C), ww, wh).sizes.length - 1);
        return { C, web };          // every feature is at least the web wide by step 3
      }
      // the centerline over the metal below shrunk by the bridge's half-width:
      // the whole width then rests on it
      const allow = P.supported && below ? erode(below, ww, wh, bridgeR) : null;
      const before = dbg.unsupported;
      const bridged = bridgeSheet(C, dbg, allow);
      const freed = dbg.unsupported > before;
      C = finishSheet(bridged, dbg, freed);                // slivers the bridges left
      // parts cut free to glue down are not connections: the web is the cleanup's
      return { C, web: freed ? web : measureWeb(C) };
    };
    const main = new Array(nCut), lv = plan ? new Array(plan.sheets.length) : [];
    let below = bw ? null : new Uint8Array(NP).fill(1);
    for (let l = bw ? 0 : nCut; l >= 0; l--) {
      if (l < nCut) { main[l] = finish(cuts[l], debug, below); below = invert(main[l].C); }
      if (!plan) continue;
      // this color's layers, lowest level first (the plan is top level first)
      for (let i = plan.sheets.length - 1; i >= 0; i--) {
        if (plan.sheets[i].color !== l) continue;
        lv[i] = finish(plan.sheets[i].C, ldbg, below);
        below = invert(lv[i].C);
      }
    }
    layers = []; webs = [];
    let contours = 0;
    for (let j = 0; j < nCut; j++) {
      cuts[j] = main[j].C;
      const holes = traceSheet(main[j].C);
      contours += holes.length;
      layers.push(holes);
      webs.push(main[j].web);
    }
    cellsLabel = `${contours.toLocaleString()} contours`;
    tgtPix = (q, out) => { for (let d = 0; d < D; d++) out[d] = palette[lab[q]][d]; };
    if (debug.bridges.length) notes.push(`${debug.bridges.length} bridges`);
    if (debug.fallback) notes.push(`${debug.fallback} parts could not be bridged ${P.bridges} and were bridged at an angle`);
    if (debug.unresolved) notes.push(`${debug.unresolved} parts could NOT be bridged — they will fall out`);
    if (debug.unsupported) notes.push(`${debug.unsupported} parts could not be bridged over the sheet below — cut free to glue down`);
    if (debug.floating) notes.push(`${debug.floating} floating parts to glue down`);
    if (debug.specks) notes.push(`${debug.specks} metal specks too small to hold were cut away`);
    if (plan) {
      levels = plan.sheets.map((p, i) => ({
        color: p.color, level: p.level, of: p.of, value: p.value, range: p.range, holes: traceSheet(lv[i].C), web: lv[i].web,
      }));
      notes.push(...levelNotes(levels, plan.flat, ldbg, bw, P.bridges));
    }
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
