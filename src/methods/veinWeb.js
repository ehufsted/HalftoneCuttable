// Vein web: a branching tree grown toward a tone-weighted cloud of attractors
// (core/sca.js, space colonization) IS the metal web -- the open space between
// branches is the cut area. Every other method sizes a hole to hit a target
// tone; this one grows a skeleton and lets LOCAL ATTRACTOR DENSITY carry the
// tone instead: more attractors pull more, thicker branches through an area
// that wants more metal, exactly the "tone via branch density, not hole size"
// idea this method exists to try.
//
// SAME RASTER PIPELINE AS STENCIL AND SCREEN (core/cutsheet.js). Once the
// grown tree is rasterized into a mask, self-support comes from the same
// proven safety net those two already use -- cleanSheet / bridgeSheet /
// finishSheet / traceSheet -- not a new analytic proof: every node's parent
// chain already reaches a root seeded on the piece's own border, so the tree
// is one connected graph by construction, and the raster pipeline is what
// guarantees that survives rasterizing, thinning and cleanup. Output holes
// are the `loop` kind, same as Stencil/Screen.
//
// STEERING ("Steer along image") blends each node's growth direction with
// core/steer.js's orientationField, exactly as Turing's Anisotropy already
// blends ITS pattern along the image (methods/screen.js) -- the right reuse
// here too, since a vein node's own growth direction is already an average of
// several nearby attractors' pulls, the same "many locally ambiguous
// directions" situation orientationField was built for. (Flow Lines, in the
// same file, deliberately does NOT use it, because it needs one globally
// consistent vector field for phase integration -- a different problem.)
//
// COLOR (stacked sheets). A posterize-style label per raster pixel, reusing
// Stencil's own rule verbatim: sheet j is cut wherever `lab > j`. "No vein
// reaches here" is the deepest label (cut on every sheet, revealing the
// base) -- the same role Stencil's own background pixels play. A vein
// node's label (which of the shallower colors it shows) is chosen by
// core/seeds.js's assignSheetsByMix, the same Hilbert-order error diffusion
// Stipple already uses to assign dots to sheets -- adapted here with the
// "base" role swapped to the DEEPEST palette entry, since a vein's ordinary
// case is "cut through everything", the opposite of a dot's ordinary case
// ("show the base").

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize, makeImage } from '../shim/image.js';
import { mulberry32 } from '../shim/random.js';
import { luminance, toEncoded } from '../core/color.js';
import { solveMix } from '../core/separate.js';
import { placeWeightedPoints, assignSheetsByMix } from '../core/seeds.js';
import { hilbertIndex, pow2At } from '../core/hilbert.js';
import { growVeins, paintVeinLabels } from '../core/sca.js';
import { orientationField } from '../core/steer.js';
import { sheetTools, scoreWindows, workRaster, borderFrame } from '../core/cutsheet.js';
import { dilate } from '../core/edt.js';

export const id = 'veinWeb';
export const label = 'Vein web';
export const blurb = 'A branching tree grown toward the image, like a leaf’s veins: the branches are the metal, the gaps between them are the holes. Density carries the tone.';

export const params = [
  { key: 'pitch', label: 'Vein spacing', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1 },
  { key: 'thickness', label: 'Max branch width', type: 'range', min: 0.5, max: 6, step: 0.1, def: 2, unit: 'mm', dp: 1 },
  { key: 'rootEdge', label: 'Roots from', type: 'select', def: 'all',
    options: [['all', 'All edges'], ['bottom', 'Bottom'], ['top', 'Top'], ['left', 'Left'], ['right', 'Right']] },
  { key: 'rootPoint', label: 'Single root point', type: 'checkbox', def: false, when: (p) => p.rootEdge !== 'all' },
  { key: 'steer', label: 'Steer along image', type: 'checkbox', def: false },
  { key: 'flow', label: 'Follow', type: 'select', def: 'edges',
    options: [['edges', 'Edges'], ['gradient', 'Gradient']], when: (p) => p.steer },
  { key: 'anisotropy', label: 'Steering strength', type: 'range', min: 0, max: 1, step: 0.05, def: 0.6,
    when: (p) => p.steer },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1 },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
const WORK_PIXELS = 1.5e6;
const WINDOW = 3;            // mm, scoring window
const MAX_ATTRACTORS = 40000;
const RHO_FLOOR = 0.08;      // minimum "wants a vein" weight, even on blank image areas

export function build(rgba, settings, params = {}) {
  const P = { ...DEF, ...params };
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } = prepareRaster(rgba, settings);

  // ---- the work raster (same budget/shape rule as Stencil/Screen)
  const { ww, wh, k, ky, NP } = workRaster(W, H, web, WORK_PIXELS);
  const e = web + kerf / 2 + (s.border || 0);
  const frame = borderFrame(ww, wh, k, ky, W, H, e);
  const rect = [e, e, W - e, H - e];
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) throw new Error('the piece is too small for one vein');
  const planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));

  // ---- each pixel's source color and target mix, and the attractor density.
  // palette[0] is the TOP SHEET'S OWN, uncut appearance (core/units.js's
  // paletteFor: "the sheet is dark [palette[0]], the hole is light" in B&W) --
  // the same role Stencil's lab=0 plays ("never cut, shows palette[0]"). A
  // vein is metal, i.e. uncut, so its density runs on m[0] directly: one
  // attractor per pitch^2 of area where the image wants to stay solid. (This
  // is the mirror image of Stipple's rho = (1 - m[0]) / A: Stipple's dots ARE
  // the open area, so ITS density runs on everything BUT m[0].)
  const srcPix = new Float32Array(NP * D), mixPix = new Float32Array(NP * n), rho = new Float64Array(NP);
  {
    const x = new Float64Array(D), m = new Float64Array(n);
    for (let q = 0; q < NP; q++) {
      const r = planes[0].data[q], g = planes[1].data[q], b = planes[2].data[q];
      if (bw) x[0] = Math.max(0, Math.min(1, luminance(r, g, b)));
      else { x[0] = r; x[1] = g; x[2] = b; }
      for (let d = 0; d < D; d++) srcPix[q * D + d] = x[d];
      const i = q % ww, j = (q - i) / ww;
      const cx = (i + 0.5) / k, cy = (j + 0.5) / ky;
      const inside = cx >= rect[0] && cy >= rect[1] && cx <= rect[2] && cy <= rect[3];
      if (inside) solveMix(x, palette, m); else m.fill(0);
      for (let l = 0; l < n; l++) mixPix[q * n + l] = m[l];
      // No attractor sits in the frame margin -- it is always metal anyway
      // (the `frame` raster below), so asking for one there would just crowd
      // the interior for nothing. Inside it, a SPARSE FLOOR keeps a few
      // attractors even where the image is blank: classic space colonization
      // cannot grow through a gap wider than influenceRadius with nothing in
      // it to pull toward, so a wholly blank margin around the actual content
      // (a centered photo on a white background, say) would permanently wall
      // the border roots off from ever reaching it. The floor is small enough
      // that blank areas stay thin and sparse, not a competing texture.
      rho[q] = inside ? Math.max(RHO_FLOOR, m[0]) / (P.pitch * P.pitch) : 0;
    }
  }
  const pixOf = (x, y) => Math.min(wh - 1, Math.max(0, Math.floor(y * ky))) * ww +
    Math.min(ww - 1, Math.max(0, Math.floor(x * k)));

  // ---- attractors: the same stratified-Hilbert + weighted-Lloyd + spacing
  // repair stipple uses, but attractors carry no structural guarantee of
  // their own (unlike stipple's dots, which ARE the final holes) -- the
  // raster pipeline below is what actually guarantees the web, so the floor
  // here only keeps the placement numerically sane, not the piece together.
  const rand = mulberry32(P.seed | 0);
  let M = 0;
  for (let q = 0; q < NP; q++) M += rho[q] / (k * ky);
  if (Math.round(M) > MAX_ATTRACTORS) throw new Error(`${Math.round(M)} veins is too many — raise the vein spacing`);
  const sMin = Math.max(0.3, P.pitch * 0.4);
  const placed = placeWeightedPoints(rho, ww, wh, k, ky, rect, sMin, 4, rand);

  // ---- roots: by default a ring around the whole border, so the tree starts
  // connected to the frame everywhere; "Roots from" narrows that to one edge
  // (still a line of roots along it, unless "Single root point" collapses it
  // to that edge's own center).
  const stepSize = Math.max(0.2, P.pitch * 0.5);
  const roots = borderRoots(W, H, e, stepSize, P.rootEdge, P.rootEdge !== 'all' && P.rootPoint);

  // ---- optional steering: blend growth direction with the image's own
  // structure, the same field (and the same reasoning) Turing's Anisotropy
  // already uses to bend ITS pattern.
  let steer = null;
  if (P.steer && P.anisotropy > 0) {
    const lum = makeImage(ww, wh);
    for (let q = 0; q < NP; q++) {
      lum.data[q] = bw ? toEncoded(srcPix[q]) : toEncoded(luminance(srcPix[3 * q], srcPix[3 * q + 1], srcPix[3 * q + 2]));
    }
    const field = orientationField(lum, 1.5 * k * P.pitch, P.flow);
    const strengthScale = P.anisotropy;
    steer = (x, y) => {
      const q = pixOf(x, y);
      return { ux: field.ux[q], uy: field.uy[q], strength: field.strength[q] * strengthScale };
    };
  }

  const tree = growVeins({
    roots,
    attractors: Array.from({ length: placed.xs.length }, (_, i) => ({ x: placed.xs[i], y: placed.ys[i] })),
    stepSize,
    killDistance: stepSize,
    influenceRadius: P.pitch * 4,
    maxIter: Math.min(4000, Math.ceil((2 * Math.hypot(W, H)) / stepSize)),
    rand,
    steer,
  });

  // ---- branch width: river-network taper (sqrt of descendant leaf count),
  // remapped into [a small paintable floor, Max branch width]. The TRUE
  // structural minimum (the web) is enforced later by cleanSheet/thicken,
  // the same trap other raster methods already guard against -- this floor
  // only keeps a tip from painting as zero pixels wide.
  let maxW = 0;
  for (let i = 0; i < tree.width.length; i++) maxW = Math.max(maxW, tree.width[i]);
  const widthFloor = Math.min(0.3, P.thickness);
  const widthAt = (i) => maxW > 0 ? widthFloor + (P.thickness - widthFloor) * (tree.width[i] / maxW) : P.thickness;

  // ---- color label per node (see header), then the per-pixel posterize-
  // style label raster: Stencil's own rule, `cut[j] = lab > j`, reused as-is.
  const n2 = pow2At(Math.max(ww, wh));
  const N = tree.xs.length;
  let nodeLabel;
  if (nCut > 1) {
    const mixAt = (i, out) => {
      const q = pixOf(tree.xs[i], tree.ys[i]);
      // role-remap: the generic "base" (role 0) stands for the DEEPEST real
      // palette entry here, since a vein's ordinary case is "cut through
      // everything" -- the opposite of a dot's ordinary case (role 0 =
      // show the base), which is what assignSheetsByMix was written for.
      out[0] = mixPix[q * n + nCut];
      for (let l = 1; l <= nCut; l++) out[l] = mixPix[q * n + (l - 1)];
    };
    const hilbertKeyOf = (i) => hilbertIndex(n2,
      Math.min(ww - 1, Math.floor(tree.xs[i] * k)), Math.min(wh - 1, Math.floor(tree.ys[i] * ky)));
    const roles = assignSheetsByMix(N, n, mixAt, hilbertKeyOf);     // roles[i] in 1..nCut
    nodeLabel = (i) => roles[i] - 1;                                 // real palette index 0..nCut-1
  } else {
    nodeLabel = () => 0;
  }

  const labRaster = new Uint8Array(NP).fill(nCut);   // sentinel: cut on every sheet (no vein here)
  paintVeinLabels(tree, ww, wh, k, ky, widthAt, nodeLabel, labRaster);
  for (let q = 0; q < NP; q++) if (frame[q]) labRaster[q] = 0;   // the frame always wins, like Stencil's

  // sheet j's cut, with the same registration extension Stencil's own
  // posterize path uses: grown by j·reg into areas a shallower label leaves
  // solid, so a small misalignment between stacked sheets hides nothing extra.
  const cuts = [];
  for (let j = 0; j < nCut; j++) {
    const C = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) C[q] = labRaster[q] > j ? 1 : 0;
    if (reg > 0 && j > 0) {
      const ext = dilate(C, ww, wh, j * reg * k);
      for (let q = 0; q < NP; q++) if (!C[q] && ext[q] && labRaster[q] < j) C[q] = 1;
    }
    for (let q = 0; q < NP; q++) if (frame[q]) C[q] = 0;
    cuts.push(C);
  }

  // ---- clean, bridge, trace: identical to Stencil's own non-halftone path
  const debug = { k, ww, wh, lab: labRaster, bridges: [], fallback: 0, unresolved: 0, specks: 0 };
  const { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet } = sheetTools({
    ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth: Math.max(1, 1.5 * web), bridgeStyle: 'auto',
  });
  const layers = [], webs = [];
  let contours = 0;
  for (let j = 0; j < nCut; j++) {
    let C = cleanSheet(cuts[j], debug);
    C = finishSheet(bridgeSheet(C, debug), debug);
    webs.push(measureWeb(C));
    const holes = traceSheet(C);
    contours += holes.length;
    layers.push(holes);
  }

  const notes = [`${N.toLocaleString()} branch points, spaced about ${P.pitch.toFixed(1)} mm apart`];
  if (placed.removed) notes.push(`${placed.removed} attractors removed to keep the placement sane`);
  if (debug.bridges.length) notes.push(`${debug.bridges.length} bridges`);
  if (debug.fallback) notes.push(`${debug.fallback} parts could not be bridged and were bridged at an angle`);
  if (debug.unresolved) notes.push(`${debug.unresolved} parts could NOT be bridged — they will fall out`);
  if (debug.specks) notes.push(`${debug.specks} metal specks too small to hold were cut away`);

  const tgtPix = (q, out) => { for (let d = 0; d < D; d++) out[d] = palette[labRaster[q]][d]; };
  const { target, source, achieved, cellAt, N: NW } = scoreWindows({
    W, H, ww, wh, k, ky, D, palette, kerf, window: WINDOW, src: srcPix, layers, tgtPix,
  });

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N: NW, palette,
    target, achieved, source, layers, webs, cellAt,
    imageRect: { x: 0, y: 0, w: W, h: H },
    cellsLabel: `${contours.toLocaleString()} contours`,
    dropped: 0, saturated: 0, note: notes.join(' · '),
    debug: { ...debug, cuts, frame, tree },
  };
}

/**
 * Root points along the piece's own border, inset by `e` (the frame's own
 * half-width) so the tree starts continuous with the frame rather than
 * merely touching it.
 * @param {'all'|'bottom'|'top'|'left'|'right'} edge  which side(s) to root on
 * @param {boolean} single  collapse the chosen edge to one point at its center
 *   (ignored when edge is 'all', which always rings the whole border)
 */
function borderRoots(W, H, e, step, edge, single) {
  const roots = [];
  const addEdge = (x0, y0, x1, y1) => {
    if (single) { roots.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }); return; }
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(len / step));
    for (let i = 0; i < steps; i++) { const t = i / steps; roots.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }); }
  };
  const SIDES = {
    top: [e, e, W - e, e],
    right: [W - e, e, W - e, H - e],
    bottom: [W - e, H - e, e, H - e],
    left: [e, H - e, e, e],
  };
  if (edge === 'all' || !SIDES[edge]) {
    for (const side of Object.values(SIDES)) addEdge(...side);
  } else {
    addEdge(...SIDES[edge]);
  }
  return roots;
}

export default { id, label, blurb, params, build };
