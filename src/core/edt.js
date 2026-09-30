// Exact Euclidean distance transform, and the morphology built on it.
//
// Felzenszwalb & Huttenlocher's two-pass lower-envelope algorithm: linear in the
// pixel count, exact (not a chamfer approximation), so "grow by r" and "shrink by
// r" mean a true disc of radius r at any angle. The stencil's whole cleanup --
// slots too narrow to cut, metal too thin to hold, the kerf offset -- is
// thresholds on these distances.
//
// Distances are between PIXEL CENTRES, in pixels.

const INF = 1e20;

function pass1D(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Distance from every pixel to the nearest pixel where `mask` is set (0 on them).
 * @param {Uint8Array} mask  w*h, row-major
 * @returns {Float32Array} distances in pixels; ~1e10 everywhere if mask is empty
 */
export function edt(mask, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    pass1D(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    pass1D(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

const not = (a) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ? 0 : 1; return o; };

/** Grow A by a disc of radius r (pixels). */
export function dilate(A, w, h, r) {
  if (!(r > 0)) return Uint8Array.from(A);
  const d = edt(A, w, h), o = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = d[i] <= r ? 1 : 0;
  return o;
}

/** Shrink A by a disc of radius r: keep what is more than r from outside A. */
export function erode(A, w, h, r) {
  if (!(r > 0)) return Uint8Array.from(A);
  const d = edt(not(A), w, h), o = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = A[i] && d[i] > r ? 1 : 0;
  return o;
}

/** Opening: remove every part of A narrower than 2r, keep the rest as it was. */
export const opening = (A, w, h, r) => dilate(erode(A, w, h, r), w, h, r);

export { not as invert };

/**
 * 4-connected components of the set pixels.
 * @returns {{id:Int32Array, sizes:number[]}} id -1 off the set
 */
export function components(mask, w, h) {
  const id = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const sizes = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || id[s] >= 0) continue;
    const c = sizes.length;
    let top = 0, n = 0;
    stack[top++] = s; id[s] = c;
    while (top > 0) {
      const k = stack[--top];
      n++;
      const x = k % w;
      if (x > 0 && mask[k - 1] && id[k - 1] < 0) { id[k - 1] = c; stack[top++] = k - 1; }
      if (x < w - 1 && mask[k + 1] && id[k + 1] < 0) { id[k + 1] = c; stack[top++] = k + 1; }
      if (k >= w && mask[k - w] && id[k - w] < 0) { id[k - w] = c; stack[top++] = k - w; }
      if (k + w < w * h && mask[k + w] && id[k + w] < 0) { id[k + w] = c; stack[top++] = k + w; }
    }
    sizes.push(n);
  }
  return { id, sizes };
}
