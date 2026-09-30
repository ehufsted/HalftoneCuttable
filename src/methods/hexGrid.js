// Hex grid: one hole per cell, per cut layer, sized by the local tone -- cells
// tiled in a honeycomb (flat-top hexagons) instead of a square lattice. Two hole
// shapes: a hexagon following the cell's own orientation, or a circle.
//
// TILING. Flat-top hexagons of circumradius R = pitch/2: columns dx = 1.5R apart,
// rows dy = R*sqrt(3) apart, odd columns offset down by dy/2 -- the standard
// offset-coordinate hex lattice. Every cell has exactly 6 neighbors, each at the
// SAME distance pitch*sqrt(3)/2 (true of any regular hex tiling), and that
// distance lies exactly along one of the cell's own six edge normals -- so a
// hexagon hole's (or a circle's) extent toward ANY neighbor is simply its own
// flat-to-flat width, with no per-direction case to work out.
//
// ONE PIECE BY CONSTRUCTION: the general rule (docs/architecture.md's "Self-
// support is by construction") -- every hole inset at least web/2 from its own
// cell's wall, and the grid margined in the piece by at least web/2 -- needs no
// new proof for a hexagon cell; it is the same argument squareGrid and the cell
// webs already rest on.
//
// HOLE AREA LAW. A hexagon hole is a convex polygon (core/holes.js's 'poly' kind):
// the cut path is a sharp hexagon, and the beam rounds its corners on cutting, so
// the finished area is Steiner's exact law (ideal area + perimeter*kerf/2 +
// pi*(kerf/2)^2) -- the same law core/holes.js already uses for the Voronoi web's
// cells, and it is exact for any convex polygon. A circle hole reuses
// core/shapes.js's own closed-form circle (the rounded-square family's r = a/2
// case), the same code squareGrid uses. Both are solved by bisection against a
// target open fraction, the same technique core/shapes.js's own sizeFor uses for
// its family: the kerf floor makes the law piecewise, and a closed form per
// piece is more code than it is worth.
//
// TONE. Per cell, in the same greedy layer-by-layer, error-diffused way as
// squareGrid (see its header): solve the target mix, cap each layer by the one
// above it less the registration allowance, and hand what a cell could not match
// to its neighbors. Diffusion runs over the hex GRAPH (core/diffuse.js's
// diffuseGraph), not the raster diffuseCells, because a hex cell has six
// neighbors, not four.

import { diffuseGraph } from '../core/diffuse.js';
import { solveMix, cumulativeOpen, visibleMix, mixColor, fitMix } from '../core/separate.js';
import { finished, cutPath, areaOf } from '../core/shapes.js';
import { prepareRaster, linearPlanes } from '../core/units.js';
import { luminance } from '../core/color.js';
import { resize } from '../shim/image.js';
import { polyHole } from '../core/holes.js';

export const id = 'hexGrid';
export const label = 'Hex grid';
export const blurb = 'One hole per cell, sized to the local tone, cells tiled in a honeycomb. Every hole stays inside its own cell, so the sheet is always one piece.';

export const params = [
  { key: 'pitch', label: 'Cell pitch', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1 },
  { key: 'shape', label: 'Hole shape', type: 'select', def: 'hex', options: [['hex', 'Hexagon'], ['circle', 'Circle']] },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']] },
  { key: 'diffuse', label: 'Error diffusion', type: 'checkbox', def: true },
];

const WORK_PIXELS = 2e6;
const MAX_CELLS = 250000;      // matches core/units.js's own cols*rows cap
const SQRT3 = Math.sqrt(3);

// ---------------------------------------------------------------- hex geometry

/** Ideal (sharp) hexagon area and perimeter, side length = circumradius R. */
const hexArea = (R) => ((3 * SQRT3) / 2) * R * R;
const hexPerimeter = (R) => 6 * R;

/**
 * Cut-path circumradius for a hexagon hole whose FINISHED flat-to-flat width is
 * s: growing a convex shape by a disc of radius d moves every edge outward by d,
 * so the finished inradius is the cut path's inradius plus kd; a regular
 * hexagon's circumradius is its inradius times 2/sqrt(3).
 */
const hexCutRadius = (s, kd) => Math.max(0, (s - 2 * kd) / SQRT3);

/** Open fraction of a cell of area `cellArea`, for a hole of nominal size s
 *  (finished flat-to-flat width for a hexagon, diameter for a circle). */
function openFraction(shape, s, cellArea, kd) {
  if (!(s > 0)) return 0;
  if (shape === 'circle') return areaOf(finished({ shape: 'circle', rounding: 0, kerf: 2 * kd }, s)) / cellArea;
  const R = hexCutRadius(s, kd);
  return (hexArea(R) + hexPerimeter(R) * kd + Math.PI * kd * kd) / cellArea;
}

/**
 * Bisected inverse of openFraction: the size s in [0, cap] whose open fraction
 * is f. Closed forms exist past the kerf floor for both shapes, but the floor
 * itself makes the law piecewise -- core/shapes.js's own sizeFor bisects for
 * exactly this reason, rather than special-case the floor.
 */
function sizeFor(shape, f, cellArea, kd, cap) {
  if (!(f > 0) || !(cap > 0)) return 0;
  if (f >= openFraction(shape, cap, cellArea, kd)) return cap;
  let lo = 0, hi = cap;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (openFraction(shape, mid, cellArea, kd) < f) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Smallest nominal size worth cutting: the user's floor, raised if the kerf
 *  would leave the beam no path (core/shapes.js's floorSize, same reasoning:
 *  the cut path must keep at least half a kerf of side). */
function floorSize(shape, hMin, kerf) {
  const kerfFloor = shape === 'hex' ? (kerf * (2 + SQRT3)) / 2 : 1.5 * kerf;
  return Math.max(hMin, kerfFloor);
}

/** The 6 flat-top hexagon vertices of circumradius R, centered at (cx, cy).
 *  Increasing angle here is clockwise on screen (y runs down), which is the
 *  positive-shoelace-area winding core/polygon.js's convex-polygon tools need. */
function hexVertices(cx, cy, R) {
  const xs = new Array(6), ys = new Array(6);
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k;
    xs[k] = cx + R * Math.cos(a);
    ys[k] = cy + R * Math.sin(a);
  }
  return { xs, ys };
}

/** Cell (col, row)'s up-to-6 neighbors, as flat cell indices. Odd columns are
 *  offset down by half a row, which is why the diagonal neighbors differ by
 *  column parity (the standard offset-coordinate hex-neighbor table). */
function hexNeighbors(col, row, cols, rows) {
  const cand = [[col, row - 1], [col, row + 1]];
  if (col & 1) cand.push([col - 1, row], [col - 1, row + 1], [col + 1, row], [col + 1, row + 1]);
  else cand.push([col - 1, row - 1], [col - 1, row], [col + 1, row - 1], [col + 1, row]);
  const out = [];
  for (const [c, r] of cand) if (c >= 0 && c < cols && r >= 0 && r < rows) out.push(r * cols + c);
  return out;
}

/**
 * Which cell (x, y) falls in: the nearest cell center, checked over the 3x3
 * block of column/row candidates around the naive rounded guess -- generous
 * enough to always include the true nearest center on an evenly spaced lattice.
 * @returns {number} cell index, or -1 outside the grid
 */
function hexCellAt(x, y, marginX, marginY, dx, dy, R, cellInradius, cols, rows) {
  const lx = x - marginX - R, ly = y - marginY - cellInradius;
  const col0 = Math.round(lx / dx);
  let best = -1, bd = Infinity;
  for (let dc = -1; dc <= 1; dc++) {
    const col = col0 + dc;
    if (col < 0 || col >= cols) continue;
    const off = (col & 1) ? dy / 2 : 0;
    const row0 = Math.round((ly - off) / dy);
    for (let dr = -1; dr <= 1; dr++) {
      const row = row0 + dr;
      if (row < 0 || row >= rows) continue;
      const ddx = lx - col * dx, ddy = ly - (row * dy + off);
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < bd) { bd = d2; best = row * cols + col; }
    }
  }
  return best;
}

/**
 * The thinnest metal one cut layer leaves, in mm: between every pair of
 * neighboring holed cells, and from an edge cell to the outline. Diagonal (non-
 * adjacent) cells need no check, the same reasoning squareGrid's thinnestWeb
 * gives for its own grid. Infinity if no holes.
 */
function hexThinnestWeb(sizes, cols, rows, pitch, cellXY, W, H) {
  const nbrDist = (pitch * SQRT3) / 2;
  let min = Infinity;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = row * cols + col, sC = sizes[c];
      if (!(sC > 0)) continue;
      for (const q of hexNeighbors(col, row, cols, rows)) {
        const sQ = sizes[q];
        if (sQ > 0) min = Math.min(min, nbrDist - (sC + sQ) / 2);
      }
      const [x, y] = cellXY(col, row);
      min = Math.min(min, Math.min(x, y, W - x, H - y) - sC / 2);
    }
  }
  return min;
}

/** Each cell's achieved color, from the final sizes of every cut layer. */
function stackHex(shape, sizesArr, palette, cellArea, kd, N, D) {
  const out = new Float64Array(N * D);
  const f = new Float64Array(sizesArr.length), vis = new Float64Array(sizesArr.length + 1), col = new Float64Array(D);
  for (let c = 0; c < N; c++) {
    for (let j = 0; j < sizesArr.length; j++) f[j] = openFraction(shape, sizesArr[j][c], cellArea, kd);
    mixColor(visibleMix(f, vis), palette, col);
    for (let d = 0; d < D; d++) out[c * D + d] = col[d];
  }
  return out;
}

// -------------------------------------------------------------------- method

/** The shape and size limits every function here shares. */
export function limits(ctx) {
  const { pitch: p, web, shape, minHole, kerf } = ctx;
  const sMax = Math.max(0, (p * SQRT3) / 2 - web);
  const sFloor = floorSize(shape, minHole, kerf);
  const cellArea = hexArea(p / 2);
  const kd = kerf / 2;
  return { shape, sMax, sFloor, cellArea, fMax: openFraction(shape, sMax, cellArea, kd), fFloor: openFraction(shape, sFloor, cellArea, kd) };
}

/** What the method aims at, per cell, in the same D channels as ctx.target. */
export function targetImage(ctx) {
  const { fMax } = limits(ctx);
  const { N, D, palette } = ctx;
  const out = new Float32Array(N * D);
  const x = new Float64Array(D), m = new Float64Array(palette.length), c = new Float64Array(D);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) x[d] = ctx.target[i * D + d];
    solveMix(x, palette, m);
    fitMix(m, fMax, ctx.range);
    mixColor(m, palette, c);
    for (let d = 0; d < D; d++) out[i * D + d] = c[d];
  }
  return out;
}

/**
 * @returns {{sizes: Float32Array[], note: string, target: Float32Array}}
 */
export function run(ctx) {
  const { shape, sMax, sFloor, fFloor, cellArea } = limits(ctx);
  const { N, D, palette, nCut, order, nbrs } = ctx;
  const reg = ctx.mode === 'color' ? ctx.reg : 0;
  const kd = ctx.kerf / 2;
  const sizes = Array.from({ length: nCut }, () => new Float32Array(N));

  const target = targetImage(ctx);
  if (sFloor > sMax) {
    return { sizes, note: 'no hole fits: the min hole (or 1.5× kerf) exceeds the cell', target };
  }

  const m = new Float64Array(palette.length);
  const F = new Float64Array(nCut), got = new Float64Array(nCut), vis = new Float64Array(palette.length);

  diffuseGraph(order, nbrs, D, target, (cell, want, out) => {
    solveMix(want, palette, m);
    cumulativeOpen(m, F);
    let prev = sMax + 2 * reg;           // so layer 0's cap is exactly sMax
    for (let j = 0; j < nCut; j++) {
      const cap = prev > 0 ? Math.min(sMax, prev - 2 * reg) : 0;
      let s = 0;
      if (cap >= sFloor) {
        s = sizeFor(shape, F[j], cellArea, kd, cap);
        if (s < sFloor) s = F[j] >= fFloor / 2 ? sFloor : 0;
      }
      sizes[j][cell] = s;
      got[j] = openFraction(shape, s, cellArea, kd);
      prev = s;
    }
    visibleMix(got, vis);
    mixColor(vis, palette, out);
  }, ctx.diffuse !== false);

  let note = '';
  if (sFloor > ctx.minHole + 1e-9) note = `min hole raised to ${sFloor.toFixed(2)} mm by the kerf`;
  return { sizes, note, target };
}

/** The method end to end, as the hole model pipeline.js expects. */
export function build(rgba, settings, params = {}) {
  const P = { ...settings, ...params, pitch: params.pitch ?? settings.pitch };
  const { s, W, H, bw, palette, D, web, kerf, reg } = prepareRaster(rgba, P);
  const pitch = P.pitch ?? 4;
  const shape = P.shape || 'hex';

  // ---- the grid: cols/rows of hex cells, margined in the piece by >= web/2
  const R = pitch / 2, dx = 1.5 * R, dy = R * SQRT3, cellInradius = (pitch * SQRT3) / 4;
  if (!(W - web >= pitch)) throw new Error('the piece is too narrow for one hex cell at this pitch');
  const cols = Math.floor((W - web - pitch) / dx) + 1;
  const marginX = (W - ((cols - 1) * dx + pitch)) / 2;
  const hasOffset = cols > 1 ? 1 : 0;
  const vGap = H - web - (pitch * SQRT3) / 2 - hasOffset * (dy / 2);
  if (vGap < 0) throw new Error('the piece is too short for one hex cell at this pitch');
  const rows = Math.floor(vGap / dy) + 1;
  const gridHeight = (rows - 1) * dy + hasOffset * (dy / 2) + (pitch * SQRT3) / 2;
  const marginY = (H - gridHeight) / 2;
  const N = cols * rows;
  if (N > MAX_CELLS) throw new Error(`${cols}×${rows} cells is too many — raise the cell pitch`);

  const cellXY = (col, row) => [marginX + R + col * dx, marginY + cellInradius + row * dy + (col & 1) * (dy / 2)];
  const cellAt = (x, y) => hexCellAt(x, y, marginX, marginY, dx, dy, R, cellInradius, cols, rows);

  // ---- diffusion order (serpentine by row) and the neighbor graph
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => {
    const ra = Math.floor(a / cols), rb = Math.floor(b / cols);
    if (ra !== rb) return ra - rb;
    const ca = a % cols, cb = b % cols;
    return (ra & 1) ? cb - ca : ca - cb;
  });
  const nbrs = Array.from({ length: N }, (_, i) => {
    const col = i % cols, row = (i - col) / cols;
    return hexNeighbors(col, row, cols, rows).map((q) => [q, 1]);
  });

  // ---- the work raster, and each cell's mean color (as cellWeb.js samples its
  // own cells: resize to a fine raster, then average the pixels that land in
  // each cell -- the hex lattice's own point-location, not a generic one)
  const px = Math.min(6 / pitch, Math.sqrt(WORK_PIXELS / (W * H)));
  const ww = Math.max(8, Math.round(W * px)), wh = Math.max(8, Math.round(H * px));
  const kx = ww / W, ky = wh / H, NP = ww * wh;
  const planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  const lum = bw ? new Float32Array(NP) : null;
  if (bw) for (let q = 0; q < NP; q++) lum[q] = luminance(planes[0].data[q], planes[1].data[q], planes[2].data[q]);

  const src = new Float64Array(N * D), cnt = new Float64Array(N);
  for (let j = 0; j < wh; j++) {
    const y = (j + 0.5) / ky;
    for (let i = 0; i < ww; i++) {
      const x = (i + 0.5) / kx;
      const c = cellAt(x, y);
      if (c < 0) continue;
      const q = j * ww + i;
      cnt[c]++;
      if (bw) src[c] += lum[q];
      else for (let d = 0; d < 3; d++) src[c * D + d] += planes[d].data[q];
    }
  }
  for (let c = 0; c < N; c++) {
    if (cnt[c] === 0) {           // a sliver no pixel center fell in: use the pixel under the cell's own center
      const col = c % cols, row = (c - col) / cols;
      const [cx, cy] = cellXY(col, row);
      const i = Math.min(ww - 1, Math.max(0, Math.floor(cx * kx))), j = Math.min(wh - 1, Math.max(0, Math.floor(cy * ky)));
      const q = j * ww + i;
      if (bw) src[c] = lum[q]; else for (let d = 0; d < 3; d++) src[c * D + d] = planes[d].data[q];
      cnt[c] = 1;
    }
    for (let d = 0; d < D; d++) src[c * D + d] = Math.max(0, Math.min(1, src[c * D + d] / cnt[c]));
  }

  const ctx = {
    N, D, cols, rows, pitch, web, kerf, reg, minHole: s.minHole, mode: bw ? 'bw' : 'color',
    palette, nCut: palette.length - 1, order, nbrs, target: src,
    shape, range: P.range || 'squeeze', diffuse: P.diffuse,
  };

  const res = run(ctx);
  const { shape: sh, sMax, cellArea } = limits(ctx);
  const kd = kerf / 2;
  const target = res.target;
  const achieved = stackHex(sh, res.sizes, palette, cellArea, kd, N, D);

  // Cells that wanted a hole in the top sheet and could not have one, and cells
  // pinned at the largest hole the web allows.
  let dropped = 0, saturated = 0;
  {
    const mm = new Float64Array(palette.length), xx = new Float64Array(D);
    for (let c = 0; c < N; c++) {
      for (let d = 0; d < D; d++) xx[d] = target[c * D + d];
      solveMix(xx, palette, mm);
      if (1 - mm[0] > 1e-3 && !(res.sizes[0][c] > 0)) dropped++;
      if (res.sizes[0][c] >= sMax - 1e-6) saturated++;
    }
  }

  const layers = [];
  for (let j = 0; j < ctx.nCut; j++) {
    const holes = [];
    for (let c = 0; c < N; c++) {
      const sNom = res.sizes[j][c];
      if (!(sNom > 0)) continue;
      const col = c % cols, row = (c - col) / cols;
      const [cx, cy] = cellXY(col, row);
      if (sh === 'circle') {
        const g = cutPath({ shape: 'circle', rounding: 0, kerf }, sNom);
        if (g) holes.push({ kind: 'rsq', cx, cy, a: g.a, r: g.r, rot: false });
      } else {
        const Rcut = hexCutRadius(sNom, kd);
        if (Rcut > 1e-9) holes.push(polyHole(hexVertices(cx, cy, Rcut)));
      }
    }
    layers.push(holes);
  }
  const webs = res.sizes.map((sz) => hexThinnestWeb(sz, cols, rows, pitch, cellXY, W, H));

  return {
    widthMm: W, heightMm: H, mode: ctx.mode, D, N, palette,
    target, achieved, source: src,
    layers, webs, cellAt,
    imageRect: { x: 0, y: 0, w: W, h: H },
    cellsLabel: `${N.toLocaleString()} hex cells`,
    dropped, saturated, note: res.note,
    debug: { cols, rows, marginX, marginY, sMax, shape: sh },
  };
}

export default { id, label, blurb, params, run, targetImage, limits, build };
