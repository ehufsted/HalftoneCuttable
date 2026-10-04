// Structural numbers: is the sheet one piece, how thin does it get, how long does
// it take to cut.
//
// The thinnest web comes from the GEOMETRY, and each method computes its own,
// because each knows what it built: the grid along its axes (below), the Voronoi
// web from the offsets on each shared cell wall. Both are exact.
//
// Connectivity is a separate, raster question, and only the harness asks it: a
// flood fill needs a few pixels across the thinnest web to be trustworthy, which
// at app resolutions it often would not have. The app relies on each method's
// construction; the harness checks the construction.

import { finished, extentOf } from './shapes.js';
import { outline } from './cutpaths.js';
import { rasterizeHoles } from './render.js';
import { gridHoles, holePerimeter, holeFinishedArea } from './holes.js';
import { components } from './edt.js';

/**
 * The square grid's thinnest metal in one cut layer, in mm: along each axis
 * between neighboring holes, and from an edge hole to the outline. Diagonal
 * neighbors need no check -- two holes each within (pitch - web) of their own
 * cell leave at least web·√2 between diagonal cells. Infinity if no holes.
 */
export function thinnestWeb(ctx, sizes, spec) {
  const { cols, rows, pitch: p, margin } = ctx;
  const ext = new Float32Array(cols * rows);
  for (let c = 0; c < ext.length; c++) ext[c] = extentOf(finished(spec, sizes[c]));
  let min = Infinity;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const e = ext[j * cols + i];
      if (e <= 0) continue;
      if (i + 1 < cols && ext[j * cols + i + 1] > 0) min = Math.min(min, p - (e + ext[j * cols + i + 1]) / 2);
      if (j + 1 < rows && ext[(j + 1) * cols + i] > 0) min = Math.min(min, p - (e + ext[(j + 1) * cols + i]) / 2);
      const edge = margin + (p - e) / 2;
      if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) min = Math.min(min, edge);
    }
  }
  return min;
}

/**
 * Per-sheet counts and cut cost, for any holes.
 * @param {{widthMm, heightMm, kerf}} piece
 * @param {number} thinnest   the method's own thinnest-web figure
 * @param {{speed:number, pierce:number}} machine  mm/s and seconds per pierce
 */
export function layerStats(piece, holes, thinnest, machine) {
  const d = piece.kerf / 2;
  let length = 0, open = 0;
  for (const h of holes) {
    length += holePerimeter(h);
    open += holeFinishedArea(h, d);
  }
  const ol = outline(piece);
  length += 2 * (ol.w + ol.h);
  const pierces = holes.length + 1;
  const seconds = length / Math.max(1e-6, machine.speed) + pierces * machine.pierce;
  return {
    holes: holes.length, length, pierces, seconds,
    openFraction: open / (piece.widthMm * piece.heightMm),
    thinnestWeb: thinnest,
  };
}

/**
 * Connected pieces of metal in one sheet, by 4-connected flood fill on a raster
 * at `pxPerMm` (one sample per pixel). 1 means the sheet is one piece. Choose
 * `pxPerMm` so the thinnest web spans at least ~3 pixels, or a thin web can read
 * as a break.
 */
export function pieceCount(piece, holes, pxPerMm) {
  const r = rasterizeHoles(piece, [holes], { pxPerMm, superSample: 1 });
  const solid = new Uint8Array(r.w * r.h);
  for (let i = 0; i < solid.length; i++) solid[i] = r.counts[2 * i] ? 1 : 0;
  return components(solid, r.w, r.h).sizes.length;
}

/** The square grid's sheet, by its sizes. */
export const materialComponents = (ctx, sizes, spec, pxPerMm) =>
  pieceCount(ctx, gridHoles(ctx, sizes, spec), pxPerMm);
