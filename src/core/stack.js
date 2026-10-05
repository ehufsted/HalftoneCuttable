// The physical stack, top first, once the Stencil's brightness layers are in it.
//
// Every material sheet l (B&W: the one sheet; color: top sheet ... solid base)
// has its own brightness layers stacked directly on top of it, highest level
// first, so a brightness layer is always the color of the region it sits in:
//
//   levels of color 0, sheet 0, levels of color 1, sheet 1, ..., sheet n-1
//
// The pipeline rasterizes this for the Result view, and the app lists exports
// and cut paths, and the assembly sheet its steps, in this order.

import { sheetNames, sheetFileName, levelFileName } from './names.js';

/**
 * @param {Array<Array>} layers  the pattern's holes per cut sheet, top first
 * @param {Array<{color:number, holes:Array}>} levels  brightness layers, in
 *        stack order per color
 * @param {boolean} bw  B&W: one material sheet, and what shows through it is
 *        the backdrop, not a sheet; color: the solid base is a sheet too
 * @returns {Array<{color:number, holes:Array, sheet?:number, level?:object, base?:boolean}>}
 *          top first; `sheet` is the pattern sheet's index, `level` the
 *          brightness layer itself, `base` marks the solid base (no holes)
 */
/**
 * The stack as a person meets it, top first: each sheet's entry from
 * physicalStack plus its display name and its export file name.
 * @param {{piece, layers, levels?}} res  a pipeline result
 * @param {string} stem  the file-name stem (from the image name)
 * @returns {Array<{name:string, file:(ext:string)=>string, color, holes, sheet?, level?, base?}>}
 *   file names carry the sheet's hex color for DXF, not for SVG
 */
export function namedStack(res, stem) {
  const bw = res.piece.mode !== 'color';
  const names = sheetNames(res.piece);
  return physicalStack(res.layers, res.levels || [], bw).map((e) => ({
    ...e,
    // a layer is not solid, though the base it sits on is
    name: e.level ? `${names[e.color].replace(' (solid)', '')} level ${e.level.level}` : names[e.color],
    file: (ext) => (e.level
      ? levelFileName(stem, e.color, e.level.level, res.piece, ext, ext === 'dxf')
      : sheetFileName(stem, e.color, res.piece, ext, ext === 'dxf')),
  }));
}

export function physicalStack(layers, levels = [], bw = false) {
  const nSheets = bw ? 1 : layers.length + 1;
  const out = [];
  for (let l = 0; l < nSheets; l++) {
    for (const lv of levels) if (lv.color === l) out.push({ color: l, holes: lv.holes, level: lv });
    out.push(l < layers.length ? { color: l, holes: layers[l], sheet: l } : { color: l, holes: [], sheet: l, base: true });
  }
  return out;
}
