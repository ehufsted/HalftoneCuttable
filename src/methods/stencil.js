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
// FILL: VEINS, the other halftone style, keeps a branching vein network
// (core/sca.js) instead of circles -- the vein is the metal, everything else
// in the shape reverts to the background label (cut through every sheet).
// Unlike circles, this still needs steps 3-5 (thin veins can pinch), so it
// re-enters the normal pipeline once it has its own per-pixel label raster.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize } from '../shim/image.js';
import { toEncoded, encodeFast, luminance } from '../core/color.js';
import { blur } from '../core/features.js';
import { edt, dilate, invert, components } from '../core/edt.js';
import { sheetTools, scoreWindows, workRaster, borderFrame } from '../core/cutsheet.js';
import { mulberry32 } from '../shim/random.js';
import { placeWeightedPoints } from '../core/seeds.js';
import { growVeins, rasterizeVeins } from '../core/sca.js';

export const id = 'stencil';
export const label = 'Stencil';
export const blurb = 'The image as solid shapes, cut out whole. Loose metal is held in by bridges, or cut free to glue down. Best for logos, text and silhouettes.';

export const params = [
  { key: 'threshold', label: 'Threshold', type: 'range', min: 0.05, max: 0.95, step: 0.01, def: 0.5,
    when: (p, env) => env.mode !== 'color' },
  { key: 'smooth', label: 'Shape smoothing', type: 'range', min: 0, max: 3, step: 0.1, def: 0.5, unit: 'mm', dp: 1 },
  { key: 'halftone', label: 'Halftone inside shapes', type: 'checkbox', def: false },
  { key: 'fillStyle', label: 'Fill', type: 'select', def: 'circles',
    options: [['circles', 'Circles'], ['veins', 'Veins']], when: (p) => p.halftone },
  { key: 'pitch', label: 'Hole pitch', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1,
    when: (p) => p.halftone && p.fillStyle !== 'veins' },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']],
    when: (p) => p.halftone && p.fillStyle !== 'veins' },
  { key: 'veinPitch', label: 'Vein spacing', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1,
    when: (p) => p.halftone && p.fillStyle === 'veins' },
  { key: 'veinThickness', label: 'Max branch width', type: 'range', min: 0.5, max: 6, step: 0.1, def: 1.5, unit: 'mm', dp: 1,
    when: (p) => p.halftone && p.fillStyle === 'veins' },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1,
    when: (p) => p.halftone && p.fillStyle === 'veins' },
  { key: 'floating', label: 'Allow floating parts (glue them down)', type: 'checkbox', def: false,
    when: (p) => !p.halftone },
  { key: 'bridges', label: 'Bridges', type: 'select', def: 'auto',
    options: [['auto', 'Automatic'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical']],
    when: (p) => !p.halftone && !p.floating },
  { key: 'bridgeWidth', label: 'Bridge width', type: 'range', min: 0.3, max: 5, step: 0.1, def: 1.2, unit: 'mm', dp: 1,
    when: (p) => !p.halftone && !p.floating },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
const WORK_PIXELS = 2.5e6;
const WINDOW = 3;           // mm, scoring window
const MAX_VEIN_ATTRACTORS = 40000;

export function build(rgba, settings, params = {}) {
  const P = { ...DEF, ...params };
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } = prepareRaster(rgba, settings);

  // ---- the work raster
  const { ww, wh, k, ky, NP } = workRaster(W, H, web, WORK_PIXELS);
  let planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  if (P.smooth > 0) planes = planes.map((pl) => blur(pl, P.smooth * k));

  // ---- 1. posterize
  const src = new Float32Array(NP * D), lab = new Uint8Array(NP);
  // The blank border, if any, is added to the structural rim here, at the raster
  // stage, rather than dropped from the traced loops afterward -- a contour here
  // can span most of the sheet, and dropping one whole loop because it grazes
  // the border would take far more than the border with it.
  const e = web + kerf / 2 + (s.border || 0);
  const frame = borderFrame(ww, wh, k, ky, W, H, e);
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

  const pixOf = (x, y) => Math.min(wh - 1, Math.max(0, Math.floor(y * ky))) * ww +
    Math.min(ww - 1, Math.max(0, Math.floor(x * k)));

  const notes = [];
  const debug = { k, ww, wh, lab, bridges: [], fallback: 0, unresolved: 0, specks: 0, floating: 0 };
  const { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet } = sheetTools({
    ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth: P.bridgeWidth, bridgeStyle: P.bridges,
  });
  let layers, webs, cellsLabel, tgtPix;

  if (!P.halftone) {
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
  } else if (P.fillStyle === 'veins') {
    ({ layers, webs, tgtPix, cellsLabel } = veinShapes());
  } else {
    ({ layers, webs, tgtPix, cellsLabel } = halftoneShapes());
  }

  // ---- scoring windows, from the renderer (contours come from a raster anyway)
  const { target, source, achieved, cellAt, N: NW } = scoreWindows({
    W, H, ww, wh, k, ky, D, palette, kerf, window: WINDOW, src, layers, tgtPix,
  });

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N: NW, palette,
    target, achieved, source, layers, webs, cellAt,
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

  /** Distance from each shape pixel to the nearest pixel of another shape
   *  (or background), mm -- the margin both halftone fill styles cap against. */
  function shapeDistances() {
    const dOther = new Float32Array(NP);
    for (let l = 1; l < n; l++) {
      const other = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) other[q] = lab[q] !== l ? 1 : 0;
      const d = edt(other, ww, wh);
      for (let q = 0; q < NP; q++) if (lab[q] === l) dOther[q] = d[q] / k;
    }
    return dOther;
  }

  /** How dark/toned pixel q is, projected onto shape l's own color (0..1). */
  function tone(q, l) {
    if (bw) return src[q];
    const c0 = palette[0], cl = palette[l];
    let num = 0, den = 0;
    for (let d = 0; d < 3; d++) { num += (src[3 * q + d] - c0[d]) * (cl[d] - c0[d]); den += (cl[d] - c0[d]) ** 2; }
    return den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
  }

  /** Halftone inside shapes: a grid of round holes, each kept within its shape. */
  function halftoneShapes() {
    const p = P.pitch;
    const dmax = p - web - 2 * (nCut - 1) * reg;
    const fMax = dmax > 0 ? (Math.PI * dmax * dmax) / 4 / (p * p) : 0;
    const dOther = shapeDistances();
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

  /**
   * Vein fill: instead of circles, each shape keeps only a branching vein
   * network (core/sca.js), rooted at its own "spine" (the point farthest
   * from any other shape) and grown toward tone-weighted attractors, the
   * same placement Stipple uses (core/seeds.js's placeWeightedPoints).
   * Everything in the shape NOT covered by a vein reverts to the sentinel
   * "cut through everything" label, same as true background -- so the
   * shape ends up mostly open, laced by the vein's own metal.
   *
   * Unlike the circle grid (isolated convex holes, safe by construction),
   * thin veins near a shape's edge can pinch, so this re-enters Stencil's
   * own cleanSheet/bridgeSheet/finishSheet/traceSheet pipeline per sheet,
   * exactly as the non-halftone path already does.
   */
  function veinShapes() {
    const p = P.veinPitch;
    const dOther = shapeDistances();
    const rand = mulberry32(P.seed | 0);
    // DEFAULT (no vein) is the shape's own ordinary label l, unchanged --
    // exactly what it would be without halftone at all (cut out whole,
    // revealing l). VEIN overrides specific pixels to vlab=0: solid on every
    // sheet, the same default appearance (palette[0], the top sheet) Circles
    // always falls back to between its own holes. This mirrors Circles
    // exactly (default=solid(0)/feature=reveals l), just with the sparsity
    // inverted (default=open/reveals l, feature=solid(0)) -- and unlike an
    // earlier version that tried "vein=l, no-vein=a deeper sentinel", it
    // never needs a sentinel at all: 0 is always distinct from any real l>=1,
    // so there's no B&W (or deepest-color) collision to worry about.
    const vlab = Uint8Array.from(lab);
    let totalNodes = 0;

    for (let l = 1; l < n; l++) {
      const rho = new Float64Array(NP);
      let M = 0;
      for (let q = 0; q < NP; q++) {
        if (lab[q] !== l) continue;
        // tone(q,l) is the OPEN-area fraction the circle fill would cut (high
        // = brighter = wants more open area); a vein is the opposite -- it's
        // the METAL that survives -- so density runs on how much of the area
        // should NOT be open, 1 - tone.
        rho[q] = Math.min(1 - tone(q, l), 0.95) / (p * p);
        M += rho[q] / (k * ky);
      }
      if (Math.round(M) > MAX_VEIN_ATTRACTORS) {
        throw new Error(`${Math.round(M)} veins is too many for one shape — raise the vein spacing`);
      }
      const sMin = Math.max(0.3, p * 0.4);
      const placed = placeWeightedPoints(rho, ww, wh, k, ky, [0, 0, W, H], sMin, 4, rand);
      if (!placed.xs.length) continue;   // no attractors: this shape just keeps its default (fully open) look

      // one root per connected component of this shape's own label, at the
      // component's own "spine" (farthest point from any other shape) --
      // so a letter with two disjoint strokes gets a root in each.
      const compMask = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) compMask[q] = lab[q] === l ? 1 : 0;
      const { id: compId, sizes: compSizes } = components(compMask, ww, wh);
      const bestD = new Float64Array(compSizes.length).fill(-1), bestQ = new Int32Array(compSizes.length).fill(-1);
      for (let q = 0; q < NP; q++) {
        const c = compId[q];
        if (c >= 0 && dOther[q] > bestD[c]) { bestD[c] = dOther[q]; bestQ[c] = q; }
      }
      const roots = [];
      for (const q of bestQ) {
        if (q < 0) continue;
        const i = q % ww, j = (q - i) / ww;
        roots.push({ x: (i + 0.5) / k, y: (j + 0.5) / ky });
      }
      if (!roots.length) continue;

      const attractors = Array.from({ length: placed.xs.length }, (_, i) => ({ x: placed.xs[i], y: placed.ys[i] }));
      const stepSize = Math.max(0.2, p * 0.5);
      const tree = growVeins({
        roots, attractors, stepSize, killDistance: stepSize, influenceRadius: p * 4,
        maxIter: Math.min(2000, Math.ceil((2 * Math.hypot(W, H)) / stepSize)), rand,
      });
      let maxW = 0;
      for (let i = 0; i < tree.width.length; i++) maxW = Math.max(maxW, tree.width[i]);
      const widthAt = (i) => {
        const base = maxW > 0 ? 0.3 + (P.veinThickness - 0.3) * (tree.width[i] / maxW) : P.veinThickness;
        const q = pixOf(tree.xs[i], tree.ys[i]);
        // the same 1.25 px pixel-center margin the circle grid's own cap uses
        const cap = Math.max(0, 2 * (dOther[q] - 1.25 / k));
        return Math.min(base, cap, P.veinThickness);
      };
      const mask = rasterizeVeins(tree, ww, wh, k, ky, widthAt);
      for (let q = 0; q < NP; q++) if (lab[q] === l && mask[q]) vlab[q] = 0;
      totalNodes += tree.xs.length;
    }

    const cuts2 = [];
    for (let j = 0; j < nCut; j++) {
      const C = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) C[q] = vlab[q] > j ? 1 : 0;
      if (reg > 0 && j > 0) {
        const ext = dilate(C, ww, wh, j * reg * k);
        for (let q = 0; q < NP; q++) if (!C[q] && ext[q] && vlab[q] < j) C[q] = 1;
      }
      for (let q = 0; q < NP; q++) if (frame[q]) C[q] = 0;
      cuts2.push(C);
    }
    const lays = [], ws = [];
    let contours = 0;
    for (let j = 0; j < nCut; j++) {
      let C = cleanSheet(cuts2[j], debug);
      C = finishSheet(bridgeSheet(C, debug), debug);
      ws.push(measureWeb(C));
      const holes = traceSheet(C);
      contours += holes.length;
      lays.push(holes);
    }
    const tp = (q, out) => { for (let d = 0; d < D; d++) out[d] = palette[vlab[q]][d]; };
    return { layers: lays, webs: ws, tgtPix: tp, cellsLabel: `${totalNodes.toLocaleString()} branch points` };
  }
}

export default { id, label, blurb, params, build };
