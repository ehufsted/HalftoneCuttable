// The physical stack, top first, once the Stencil's brightness layers are in it.
//
// Every material sheet l (B&W: the one sheet; color: top sheet ... solid base)
// has its own brightness layers stacked directly on top of it, highest level
// first, so a brightness layer is always the color of the region it sits in:
//
//   levels of color 0, sheet 0, levels of color 1, sheet 1, ..., sheet n-1
//
// The pipeline rasterizes this for the Result view, and the app lists exports
// and cut paths in this order.

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
export function physicalStack(layers, levels = [], bw = false) {
  const nSheets = bw ? 1 : layers.length + 1;
  const out = [];
  for (let l = 0; l < nSheets; l++) {
    for (const lv of levels) if (lv.color === l) out.push({ color: l, holes: lv.holes, level: lv });
    out.push(l < layers.length ? { color: l, holes: layers[l], sheet: l } : { color: l, holes: [], sheet: l, base: true });
  }
  return out;
}
