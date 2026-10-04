// The shared engine of the cell webs (Voronoi web, Facets, Rectangles): a web of
// convex cells, each cut as a hole inset from its walls, its margin solved per
// cell for tone.
//
// Everything but WHERE the cells are: reading the image, the detail and edge
// features, color regions, the per-cell tone law, targets, error diffusion over
// the cell graph, the stacked-color modes, the web figures. The reasoning for all
// of it is in voronoiWeb.js's header.
//
// A LAYOUT places the cells. It is called with
//   {rect, spacingAt, sMin, sMax, feats, P, W, H, ww, wh, kx, ky, enc, web}
// (enc: the image's encoded channels on the work raster, for a layout that cuts by
// the image itself) and returns
//   {N, cells, sites, cellOfPixel(i, j), cellAt(x, y), isLine(i, q, k), notes, unit, debug}
// cells[i] is a convex polygon (core/polygon.js) whose edge k is labeled with the
// neighboring cell (-1 on the rectangle); sites a representative point per cell
// (for the diffusion order and the empty-cell fallback); isLine says whether the
// wall between i and q (i's edge k) lies along an image edge, for Metal lines.
// Optionally also wallExtra(i, q, k): the extra metal, per side, on cell i's edge
// k (q = -1 on the rectangle), in place of the one Metal-lines width -- a layout
// whose walls differ in weight (Rectangles' tapering cuts) says so here.
//
// `opts` (optional): {minPxPerMm} -- a floor on the work raster's resolution, for a
// layout whose cells are large but whose cut positions need to be fine.
//
// P.fill === 'flat' (a method may offer it) opens every cell as far as IT can onto
// its color instead of sizing its hole by tone -- each to its own web limit, not
// to the shared tone band, so a large cell is not held back by the small ones:
// solid regions become flat blocks of their sheet, and a mixed cell shows its
// color at full saturation. Nothing is left over to diffuse.
//
// Any convex cells work: the one-piece argument only needs every hole inset at
// least web/2 from each wall of a convex cell, and the cells clipped to the piece
// inset by web/2.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize, makeImage } from '../shim/image.js';
import { toEncoded, encodeFast, luminance } from '../core/color.js';
import { solveMix, fitMix, mixColor, cumulativeOpen, visibleMix } from '../core/separate.js';
import { insetConvex, minWidth, grownArea, polyArea } from '../core/polygon.js';
import { detailMap, edgePoints, regionLabels, boundaryPoints } from '../core/features.js';
import { diffuseGraph } from '../core/diffuse.js';
import { polyHole } from '../core/holes.js';

const MAX_CELLS = 60000;
const WORK_PIXELS = 2e6;

/**
 * A web of cells, end to end: everything but WHERE the cells are.
 * @param {object} DEF       the method's param defaults
 * @param {(c) => object} layout  places the cells; see voronoiWeb.js and facets.js
 * @returns the hole model (see pipeline.js) plus `debug`, which only the harness reads
 */
export function buildCellWeb(rgba, settings, params, DEF, layout, opts = {}) {
  const P = { ...DEF, ...params };
  // the cell size is a pattern param; settings.pitch is the fallback for callers (tests) that set it there
  const pitch = params.pitch ?? settings.pitch ?? DEF.pitch;
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } =
    prepareRaster(rgba, { ...settings, pitch });
  const kd = kerf / 2;
  const solid = !bw && P.regions === 'solid';

  // The smallest cell worth having can hold the smallest hole with a web round it.
  const sFit = web + hFloor + kerf;
  const sMax = Math.max(s.pitch, sFit);
  const sMin = Math.max(sMax * (1 - P.refine), sFit);
  if (!(W > 2 * sMax && H > 2 * sMax)) throw new Error('the piece is smaller than two cells');
  if ((W * H) / (sMin * sMin) > MAX_CELLS) throw new Error('too many cells — raise the cell size or lower Detail refine');

  // ---- the work raster: a few pixels across the smallest cell
  const px = Math.min(Math.max(6 / sMin, opts.minPxPerMm || 0), Math.sqrt(WORK_PIXELS / (W * H)));
  const ww = Math.max(8, Math.round(W * px)), wh = Math.max(8, Math.round(H * px));
  const kx = ww / W, ky = wh / H;
  const planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  const lum = new Float32Array(ww * wh);
  for (let i = 0; i < ww * wh; i++) lum[i] = luminance(planes[0].data[i], planes[1].data[i], planes[2].data[i]);
  const encImage = (src) => {
    const im = makeImage(ww, wh);
    for (let i = 0; i < ww * wh; i++) im.data[i] = encodeFast(src[i]);
    return im;
  };
  const enc = bw ? [encImage(lum)] : planes.map((pl) => encImage(pl.data));

  // ---- where the detail and the edges are
  const sigma = 0.5 * sMin * kx;
  const detail = P.refine > 0 ? detailMap(enc, sigma) : null;
  const spacingAt = (x, y) => {
    if (!detail) return sMax;
    const i = Math.min(ww - 1, Math.max(0, Math.floor(x * kx)));
    const j = Math.min(wh - 1, Math.max(0, Math.floor(y * ky)));
    return Math.max(sMin, sMax * (1 - P.refine * detail[j * ww + i]));
  };
  const feats = [];
  if (P.edges !== 'off') {
    for (const e of edgePoints(enc, sigma, P.edgeThreshold)) {
      feats.push({ x: e.x / kx, y: e.y / ky, nx: e.nx, ny: e.ny, s: e.s });
    }
  }
  let pixLabel = null;
  if (solid) {
    const encPal = palette.map((c) => c.map((v) => toEncoded(v)));
    const rl = regionLabels(planes, encPal, encodeFast, sigma);
    pixLabel = rl.labels;
    if (n > 2) {
      for (const b of boundaryPoints(rl.labels, rl.soft, ww, wh)) {
        feats.push({ x: b.x / kx, y: b.y / ky, nx: b.nx, ny: b.ny, s: b.s });
      }
    }
  }

  // ---- the cells: the layout's job
  const rect = [web / 2, web / 2, W - web / 2, H - web / 2];
  const L = layout({ rect, spacingAt, sMin, sMax, feats, P, W, H, ww, wh, kx, ky, enc, web });
  const { N, cells, sites } = L;

  // ---- what each cell is asked for: the mean of its pixels
  const src = new Float64Array(N * D), cnt = new Float64Array(N);
  const votes = solid ? new Float64Array(N * n) : null;
  const addPixel = (c, q) => {
    cnt[c]++;
    if (bw) src[c] += lum[q];
    else for (let d = 0; d < 3; d++) src[c * 3 + d] += planes[d].data[q];
    if (votes) votes[c * n + pixLabel[q]]++;
  };
  for (let j = 0; j < wh; j++) {
    for (let i = 0; i < ww; i++) addPixel(L.cellOfPixel(i, j), j * ww + i);
  }
  for (let c = 0; c < N; c++) {
    if (cnt[c] === 0) {           // a sliver no pixel center fell in: use the pixel under its site
      const i = Math.min(ww - 1, Math.floor(sites.xs[c] * kx)), j = Math.min(wh - 1, Math.floor(sites.ys[c] * ky));
      addPixel(c, j * ww + i);
    }
    for (let d = 0; d < D; d++) src[c * D + d] = Math.max(0, Math.min(1, src[c * D + d] / cnt[c]));
  }
  const lab = new Uint8Array(N).fill(1);
  if (votes) {
    for (let c = 0; c < N; c++) {
      let best = 1;
      for (let j = 2; j < n; j++) if (votes[c * n + j] > votes[c * n + best]) best = j;
      lab[c] = best;
    }
  }

  // ---- the walls that carry an edge line
  const lineHalf = P.edges === 'lines' ? P.lineWidth / 2 : 0;
  const extra = cells.map((C, i) => (C ? C.lab.map((q, k) => (L.wallExtra ? L.wallExtra(i, q, k)
    : lineHalf > 0 && q >= 0 && L.isLine(i, q, k) ? lineHalf : 0)) : []));

  // ---- the tone law per cell: margin m -> finished open fraction
  const area = cells.map((C) => (C ? polyArea(C) : 0));
  const mMin = web / 2;
  const cutAt = (i, m, lines = true) => insetConvex(cells[i], extra[i].map((e) => m + (lines ? e : 0) + kd));
  const fAt = (i, m, lines = true) => {
    const C = cells[i] && cutAt(i, m, lines);
    if (!C || minWidth(C) + kerf < hFloor - 1e-12) return 0;
    return grownArea(C, kd) / area[i];
  };
  const mFloor = new Float64Array(N).fill(-1), fMaxCell = new Float64Array(N), fFloorCell = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    fMaxCell[i] = cells[i] ? fAt(i, mMin) : 0;
    if (!(fMaxCell[i] > 0)) continue;
    let lo = mMin, hi = mMin + Math.sqrt(area[i]) + sMax;
    for (let it = 0; it < 30; it++) {
      const mid = 0.5 * (lo + hi);
      if (fAt(i, mid) > 0) lo = mid; else hi = mid;
    }
    mFloor[i] = lo;
    fFloorCell[i] = fAt(i, lo);
  }
  const marginFor = (i, F, mLo) => {
    if (fAt(i, mLo) <= F) return mLo;
    if (F <= fFloorCell[i]) return mFloor[i];
    let lo = mLo, hi = mFloor[i];
    for (let it = 0; it < 30; it++) {
      const mid = 0.5 * (lo + hi);
      if (fAt(i, mid) > F) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  };

  // The band every cell can reach. Small cells have less room for a hole than
  // large ones, so a per-cell band would print detailed areas darker; one band
  // for all, set where 90% of cells can reach it, and diffusion for the rest.
  //
  // Measured as if no wall carried an edge line: the line is metal on purpose,
  // and counting it would thicken every web in the piece to pay for it (a third
  // of the cells in a busy photo carry one). Nor may the line cells simply be
  // left out -- they are the small ones, beside the detail, and the band would
  // rise. Cells a line leaves short saturate and diffuse.
  const band = (m) => {
    const r = cells.map((C, i) => (C ? fAt(i, m, false) : 0)).filter((f) => f > 0).sort((a, b) => a - b);
    return r.length ? r[Math.floor(0.1 * (r.length - 1))] : 0;
  };
  const fMaxG = band(mMin);
  // Solid mode: a region on sheet l needs its top hole reg·(l-1) inside the web
  // limit, to leave room for the wider hidden holes below it -- so each sheet
  // has its own, smaller, band.
  const fMaxSheet = [0, fMaxG];
  const flat = P.fill === 'flat';
  if (solid) {
    for (let l = 2; l < n; l++) {
      fMaxSheet[l] = band(mMin + (l - 1) * reg);
    }
  }

  // ---- targets
  const target = new Float64Array(N * D);
  const scal = new Float64Array(N);          // solid mode: open fraction of the region's sheet
  {
    const m = new Float64Array(n), x = new Float64Array(D), col = new Float64Array(D);
    for (let i = 0; i < N; i++) {
      for (let d = 0; d < D; d++) x[d] = src[i * D + d];
      if (!solid) {
        solveMix(x, palette, m);
        if (flat) {
          // the color at full strength: the top sheet only where the web forces it
          const rest = 1 - m[0], fm = fMaxCell[i];
          if (rest > 1e-6) { for (let k = 1; k < n; k++) m[k] *= fm / rest; m[0] = 1 - fm; }
        } else {
          fitMix(m, fMaxG, P.range);
        }
        mixColor(m, palette, col);
        for (let d = 0; d < D; d++) target[i * D + d] = col[d];
        continue;
      }
      const c0 = palette[0], cl = palette[lab[i]];
      let num = 0, den = 0;
      for (let d = 0; d < D; d++) { num += (x[d] - c0[d]) * (cl[d] - c0[d]); den += (cl[d] - c0[d]) ** 2; }
      const t = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0;
      const fl = fMaxSheet[lab[i]];
      const F = flat ? (cells[i] ? fAt(i, mMin + (lab[i] - 1) * reg) : 0) : P.range === 'clip' ? Math.min(t, fl) : t * fl;
      scal[i] = F;
      for (let d = 0; d < D; d++) target[i * D + d] = (1 - F) * c0[d] + F * cl[d];
    }
  }

  // ---- realize, cell by cell, in serpentine bands
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => {
    const ba = Math.floor(sites.ys[a] / sMax), bb = Math.floor(sites.ys[b] / sMax);
    if (ba !== bb) return ba - bb;
    return (ba & 1) ? sites.xs[b] - sites.xs[a] : sites.xs[a] - sites.xs[b];
  });
  const nbrs = cells.map((C) => {
    if (!C) return [];
    const out = [];
    for (let k = 0; k < C.xs.length; k++) {
      const q = C.lab[k];
      if (q < 0) continue;
      const k2 = k + 1 === C.xs.length ? 0 : k + 1;
      out.push([q, Math.hypot(C.xs[k2] - C.xs[k], C.ys[k2] - C.ys[k])]);
    }
    return out;
  });

  const margins = Array.from({ length: nCut }, () => new Float64Array(N).fill(NaN));
  const cuts = Array.from({ length: nCut }, () => new Array(N).fill(null));
  const achieved = new Float64Array(N * D);
  const m = new Float64Array(n), F = new Float64Array(nCut), got = new Float64Array(nCut);
  const vis = new Float64Array(n), col = new Float64Array(D);
  const setHole = (j, i, mm) => {
    margins[j][i] = mm;
    cuts[j][i] = cutAt(i, mm);
    got[j] = fAt(i, mm);
  };
  /** Nearest cuttable margin for open fraction Fw at or above mLo; NaN for no hole. */
  const choose = (i, Fw, mLo) => {
    if (!(mFloor[i] >= mLo) || !(Fw > 0)) return NaN;
    if (Fw < fFloorCell[i]) return Fw >= fFloorCell[i] / 2 ? mFloor[i] : NaN;
    return marginFor(i, Fw, mLo);
  };
  const finishCell = (i) => {
    visibleMix(got, vis);
    mixColor(vis, palette, col);
    for (let d = 0; d < D; d++) achieved[i * D + d] = col[d];
  };
  /** Solid mode: only the top hole is a window, onto the region's sheet. */
  const finishSolid = (i) => {
    const f = got[0], c0 = palette[0], cl = palette[lab[i]];
    for (let d = 0; d < D; d++) achieved[i * D + d] = (1 - f) * c0[d] + f * cl[d];
  };

  const visitMixed = (i, want, out) => {
    solveMix(want, palette, m);
    cumulativeOpen(m, F);
    got.fill(0);
    let mLo = mMin;
    for (let j = 0; j < nCut; j++) {
      const mm = choose(i, F[j], mLo);
      if (isNaN(mm)) break;
      setHole(j, i, mm);
      mLo = mm + reg;
    }
    finishCell(i);
    for (let d = 0; d < D; d++) out[d] = achieved[i * D + d];
  };
  const visitSolid = (i, want, out) => {
    const deep = lab[i] - 1;                 // the deepest sheet holed: the one above the region's sheet
    got.fill(0);
    // the top hole is the window, and the smallest: each sheet below it is reg
    // wider all round, down to the web limit, so the top margin leaves room
    const mTop = choose(i, want[0], mMin + deep * reg);
    if (!isNaN(mTop)) for (let j = 0; j <= deep; j++) setHole(j, i, mTop - j * reg);
    out[0] = got[0];
    finishSolid(i);
  };

  if (solid) {
    diffuseGraph(order, nbrs, 1, scal, visitSolid, P.diffuse && !flat, (a, b) => lab[a] === lab[b]);
  } else {
    diffuseGraph(order, nbrs, D, target, visitMixed, P.diffuse && !flat);
  }

  // ---- the web each sheet actually has, from the margins either side of each wall
  const webs = new Array(nCut).fill(Infinity);
  for (let j = 0; j < nCut; j++) {
    for (let i = 0; i < N; i++) {
      if (!cuts[j][i]) continue;
      const C = cells[i];
      for (let k = 0; k < C.xs.length; k++) {
        const q = C.lab[k];
        if (q < 0) webs[j] = Math.min(webs[j], web / 2 + margins[j][i] + extra[i][k]);
        else if (q > i && cuts[j][q]) webs[j] = Math.min(webs[j], margins[j][i] + margins[j][q] + 2 * extra[i][k]);
      }
    }
  }

  let dropped = 0, saturated = 0;
  for (let i = 0; i < N; i++) {
    const want0 = solid ? scal[i] : 1 - topShare(target, i, D, palette, m);
    if (want0 > 1e-3 && !cuts[0][i]) dropped++;
    if (!flat && Math.abs(margins[0][i] - mMin) < 1e-9) saturated++;     // flat: every cell is, by design
  }

  const notes = [...(L.notes || [])];
  if (hFloor > s.minHole + 1e-9) notes.push(`min hole raised to ${hFloor.toFixed(2)} mm by the kerf`);

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N, palette,
    target, achieved, source: src,
    layers: cuts.map((row) => row.filter(Boolean).map(polyHole)),
    webs,
    cellAt: L.cellAt,
    imageRect: { x: 0, y: 0, w: W, h: H },
    cellsLabel: `${N.toLocaleString()} ${L.unit || 'cells'}`,
    dropped, saturated, note: notes.join(' · '),
    debug: { ...L.debug, cells, margins, cuts, labels: lab, extra, fMaxG, fMaxSheet, mMin, rect, sMin, sMax },
  };
}

/** The top sheet's share of cell i's target color (1 minus what layer 0 must open). */
function topShare(target, i, D, palette, m) {
  const x = new Float64Array(D);
  for (let d = 0; d < D; d++) x[d] = target[i * D + d];
  solveMix(x, palette, m);
  return m[0];
}

