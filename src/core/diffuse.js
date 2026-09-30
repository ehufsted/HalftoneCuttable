// Floyd–Steinberg error diffusion over the CELL grid, in any number of channels.
//
// A cell cannot take any open fraction it likes: below the smallest cuttable hole
// it is all-or-nothing, above the largest it saturates, and in a stack the deeper
// layers are squeezed by the registration allowance. Each cell's shortfall is
// handed to its unvisited neighbors, so the tone is right ON AVERAGE even where
// no single cell can be. In the continuous part of the range the residual is only
// rounding, so the pattern stays a clean grid there; the dithering shows up only
// where a cell really cannot say what it was asked to.
//
// Serpentine order, to stop the error drifting one way and leaving diagonal worms.

const CLAMP = 0.5;   // bound on a carried error, so an unreachable region cannot wind it up

/**
 * @param {number} cols, rows, D
 * @param {Float32Array|Float64Array} target  cols*rows*D, what each cell is asked for
 * @param {(cell:number, want:Float64Array, got:Float64Array) => void} visit
 *   realize cell `cell` given the error-adjusted request `want`; write what was
 *   actually achieved into `got`
 * @param {boolean} diffuse  false = each cell sees only its own target
 */
export function diffuseCells(cols, rows, D, target, visit, diffuse = true) {
  const err = new Float64Array(cols * rows * D);
  const want = new Float64Array(D);
  const got = new Float64Array(D);
  for (let j = 0; j < rows; j++) {
    const ltr = (j & 1) === 0;
    const dir = ltr ? 1 : -1;
    for (let k = 0; k < cols; k++) {
      const i = ltr ? k : cols - 1 - k;
      const cell = j * cols + i;
      for (let d = 0; d < D; d++) want[d] = target[cell * D + d] + (diffuse ? err[cell * D + d] : 0);
      visit(cell, want, got);
      if (!diffuse) continue;
      for (let d = 0; d < D; d++) {
        const e = Math.max(-CLAMP, Math.min(CLAMP, want[d] - got[d]));
        if (e === 0) continue;
        const iF = i + dir;
        if (iF >= 0 && iF < cols) err[(cell + dir) * D + d] += e * 7 / 16;
        if (j + 1 < rows) {
          const below = cell + cols;
          if (iF >= 0 && iF < cols) err[(below + dir) * D + d] += e * 1 / 16;
          err[below * D + d] += e * 5 / 16;
          const iB = i - dir;
          if (iB >= 0 && iB < cols) err[(below - dir) * D + d] += e * 3 / 16;
        }
      }
    }
  }
}

/**
 * The same idea on an irregular graph (the Voronoi web's cells): visit cells in
 * `order`, hand each one's shortfall to its not-yet-visited neighbors in
 * proportion to the length of wall they share. `allow(i, j)` can refuse a
 * neighbor -- solid-color regions keep their error to themselves, or a blue
 * region's shortfall would bleed into the red one next to it as extra red.
 *
 * @param {Int32Array|number[]} order   cell indices, each once
 * @param {Array<Array<[number, number]>>} nbrs  per cell, [neighbor, weight]
 */
export function diffuseGraph(order, nbrs, D, target, visit, diffuse = true, allow = null) {
  const N = nbrs.length;
  const err = new Float64Array(N * D);
  const done = new Uint8Array(N);
  const want = new Float64Array(D);
  const got = new Float64Array(D);
  for (const i of order) {
    for (let d = 0; d < D; d++) want[d] = target[i * D + d] + (diffuse ? err[i * D + d] : 0);
    visit(i, want, got);
    done[i] = 1;
    if (!diffuse) continue;
    let wsum = 0;
    for (const [j, w] of nbrs[i]) if (!done[j] && (!allow || allow(i, j))) wsum += w;
    if (!(wsum > 0)) continue;
    for (let d = 0; d < D; d++) {
      const e = Math.max(-CLAMP, Math.min(CLAMP, want[d] - got[d]));
      if (e === 0) continue;
      for (const [j, w] of nbrs[i]) {
        if (!done[j] && (!allow || allow(i, j))) err[j * D + d] += (e * w) / wsum;
      }
    }
  }
}
