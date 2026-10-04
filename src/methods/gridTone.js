// The tone side of the two fixed grids (squareGrid, hexGrid): one hole per cell
// per cut layer, sized from the cell's fitted mix. Only the hole family's area
// law and the cell graph differ between them, so those are passed in. The
// reasoning is in squareGrid.js's header.

import { solveMix, cumulativeOpen, visibleMix, mixColor, fitMix } from '../core/separate.js';

/** What a grid aims at per cell: each source color's closest mix, fitted into the band. */
export function fitTargets(source, N, D, palette, fMax, range) {
  const out = new Float32Array(N * D);
  const x = new Float64Array(D), m = new Float64Array(palette.length), c = new Float64Array(D);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) x[d] = source[i * D + d];
    solveMix(x, palette, m);
    fitMix(m, fMax, range);
    mixColor(m, palette, c);
    for (let d = 0; d < D; d++) out[i * D + d] = c[d];
  }
  return out;
}

/**
 * Every cell's hole sizes, greedily from the top layer down: solve the request
 * (plus carried error) for a mix, turn it into cumulative open fractions, cap
 * each layer by the one above it less twice the registration allowance, and
 * round a hole below the floor to nothing or to the floor, whichever is nearer.
 * @param {object} o
 * @param {(s:number) => number} o.fOf          a hole's open fraction of its cell
 * @param {(f:number, cap:number) => number} o.sizeOf  its inverse, within [0, cap]
 * @param {(visit:Function) => void} o.diffuse  runs visit(cell, want, got) over
 *        the cells in error-diffusion order (core/diffuse.js)
 * @returns {Float32Array[]} sizes[j][cell], nominal mm, 0 = no hole
 */
export function realizeCells(o) {
  const { N, palette, nCut, reg, sMax, sFloor, fFloor, fOf, sizeOf } = o;
  const sizes = Array.from({ length: nCut }, () => new Float32Array(N));
  if (sFloor > sMax) return sizes;
  const m = new Float64Array(palette.length), vis = new Float64Array(palette.length);
  const F = new Float64Array(nCut), got = new Float64Array(nCut);
  o.diffuse((cell, want, out) => {
    solveMix(want, palette, m);
    cumulativeOpen(m, F);
    let prev = sMax + 2 * reg;           // so layer 0's cap is exactly sMax
    for (let j = 0; j < nCut; j++) {
      const cap = prev > 0 ? Math.min(sMax, prev - 2 * reg) : 0;
      let s = 0;
      if (cap >= sFloor) {
        s = sizeOf(F[j], cap);
        if (s < sFloor) s = F[j] >= fFloor / 2 ? sFloor : 0;
      }
      sizes[j][cell] = s;
      got[j] = fOf(s);
      prev = s;
    }
    visibleMix(got, vis);
    mixColor(vis, palette, out);
  });
  return sizes;
}

/**
 * Cells that wanted a hole in the top sheet and could not have one, and cells
 * pinned at the largest hole the web allows.
 */
export function topStats(target, top, N, D, palette, sMax) {
  let dropped = 0, saturated = 0;
  const m = new Float64Array(palette.length), x = new Float64Array(D);
  for (let c = 0; c < N; c++) {
    for (let d = 0; d < D; d++) x[d] = target[c * D + d];
    solveMix(x, palette, m);
    if (1 - m[0] > 1e-3 && !(top[c] > 0)) dropped++;
    if (top[c] >= sMax - 1e-6) saturated++;
  }
  return { dropped, saturated };
}

/** The note when the kerf raised the floor above the user's min hole. */
export const kerfNote = (sFloor, minHole) => (sFloor > minHole + 1e-9 ? `min hole raised to ${sFloor.toFixed(2)} mm by the kerf` : '');
