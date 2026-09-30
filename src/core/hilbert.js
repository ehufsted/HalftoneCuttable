// Hilbert curve index: a 1-D order over a 2-D grid that keeps neighbours near
// each other. Walking the image in this order and stepping through its ink one
// quantum at a time spreads points (or decisions) evenly in space -- the 2-D
// structure of a 1-D stratified sample -- with none of the rows a raster scan
// leaves.

/** Index of (x, y) on the curve over an n×n grid, n a power of two. */
export function hilbertIndex(n, x, y) {
  let d = 0;
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {                       // rotate the quadrant
      if (rx === 1) { x = n - 1 - x; y = n - 1 - y; }
      const t = x; x = y; y = t;
    }
  }
  return d;
}

/** Smallest power of two >= v. */
export const pow2At = (v) => 2 ** Math.ceil(Math.log2(Math.max(1, v)));
