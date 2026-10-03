// Space colonization: grows a branching tree from root points toward a cloud
// of attractors, the way leaf veins and root systems do (Runions et al. 2007,
// "Modeling Trees with a Space Colonization Algorithm"). Each round:
//   - every live attractor joins the nearest node within `influenceRadius`;
//   - every node that gained at least one attractor this round grows one
//     child, `stepSize` along the (normalized) sum of its attractors' pull
//     directions, optionally blended with a `steer` field so growth can bend
//     along the image's own structure, the way Turing's anisotropy already
//     bends its own pattern (methods/screen.js);
//   - any attractor within `killDistance` of ANY node (including children
//     just grown this round, since a child can itself have passed an
//     attractor its parent only reached toward) is then removed, so a branch
//     that has passed an attractor stops being pulled toward it.
// Repeats until every attractor is dead or `maxIter` rounds pass.
//
// Uses the project's one RNG source (shim/random.js's mulberry32), passed in
// by the caller, only to break an exact tie (attractors pulling a node in
// exactly opposite directions, summing to zero) -- never for anything that
// would make a re-run with the same seed diverge. No Math.random anywhere.

import { SeedHash } from './voronoi.js';

const MAX_NODES = 60000;

/**
 * @param {object} o
 * @param {Array<{x:number,y:number}>} o.roots         at least one
 * @param {Array<{x:number,y:number}>} o.attractors
 * @param {number} o.stepSize        mm per growth step
 * @param {number} o.killDistance    mm; an attractor this close to a node is consumed
 * @param {number} o.influenceRadius mm; an attractor this far from a node cannot pull it
 * @param {number} o.maxIter
 * @param {() => number} o.rand      seeded RNG (shim/random.js mulberry32)
 * @param {(x:number,y:number) => {ux:number,uy:number,strength:number}|null} [o.steer]
 *   optional direction bias, strength in [0,1]; `ux,uy` need not be a signed
 *   vector (a doubled-angle axis works: see below)
 * @returns {{xs:Float64Array, ys:Float64Array, parent:Int32Array, leaves:Int32Array, width:Float64Array}}
 *   node i's parent is an earlier index (-1 for a root): the tree is already
 *   topologically sorted, so a segment is (parent[i], i) for every i with
 *   parent[i] >= 0. `leaves` is each node's descendant leaf count and `width`
 *   is `sqrt(leaves)` (river-network scaling) -- the caller remaps that into
 *   an actual mm width for its own tone law.
 */
export function growVeins(o) {
  const { roots, attractors, stepSize, killDistance, influenceRadius, maxIter, rand } = o;
  const steer = o.steer || null;
  if (!roots.length) throw new Error('space colonization needs at least one root');

  const xs = roots.map((r) => r.x), ys = roots.map((r) => r.y), parent = roots.map(() => -1);
  const ax = Float64Array.from(attractors, (a) => a.x), ay = Float64Array.from(attractors, (a) => a.y);
  const alive = new Uint8Array(ax.length).fill(1);
  let aliveCount = ax.length;

  let minX = Math.min(...xs, ...ax), maxX = Math.max(...xs, ...ax);
  let minY = Math.min(...ys, ...ay), maxY = Math.max(...ys, ...ay);
  const pad = influenceRadius + stepSize;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const h = Math.max(influenceRadius, 1e-6);

  for (let iter = 0; iter < maxIter && aliveCount > 0 && xs.length < MAX_NODES; iter++) {
    const n0 = xs.length;
    const hash = new SeedHash(Float64Array.from(xs), Float64Array.from(ys), minX, minY, maxX, maxY, h);
    const sumX = new Float64Array(n0), sumY = new Float64Array(n0), cnt = new Int32Array(n0);
    for (let a = 0; a < ax.length; a++) {
      if (!alive[a]) continue;
      const near = hash.nearest(ax[a], ay[a]);
      const dx = ax[a] - xs[near], dy = ay[a] - ys[near];
      const d = Math.hypot(dx, dy);
      if (d > influenceRadius) continue;
      if (d > 1e-9) { sumX[near] += dx / d; sumY[near] += dy / d; }
      cnt[near]++;
    }
    for (let i = 0; i < n0; i++) {
      if (!cnt[i]) continue;
      let dx = sumX[i], dy = sumY[i], d = Math.hypot(dx, dy);
      if (d < 1e-9) { const a = rand() * 2 * Math.PI; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
      let ux = dx / d, uy = dy / d;
      if (steer) {
        const s = steer(xs[i], ys[i]);
        if (s && s.strength > 0) {
          // the field has no front/back (a doubled angle); pick the sign that
          // agrees with the pull, so it bends growth, never reverses it
          let vx = s.ux, vy = s.uy;
          if (vx * ux + vy * uy < 0) { vx = -vx; vy = -vy; }
          const bx = ux * (1 - s.strength) + vx * s.strength, by = uy * (1 - s.strength) + vy * s.strength;
          const bl = Math.hypot(bx, by);
          if (bl > 1e-9) { ux = bx / bl; uy = by / bl; }
        }
      }
      xs.push(xs[i] + ux * stepSize);
      ys.push(ys[i] + uy * stepSize);
      parent.push(i);
    }
    if (xs.length === n0) break;   // no live attractor was within reach of anything: stuck
    const hash2 = new SeedHash(Float64Array.from(xs), Float64Array.from(ys), minX, minY, maxX, maxY, h);
    for (let a = 0; a < ax.length; a++) {
      if (!alive[a]) continue;
      const near = hash2.nearest(ax[a], ay[a]);
      if (Math.hypot(ax[a] - xs[near], ay[a] - ys[near]) <= killDistance) { alive[a] = 0; aliveCount--; }
    }
  }

  const N = xs.length;
  const px = Int32Array.from(parent);
  const hasChild = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (px[i] >= 0) hasChild[px[i]] = 1;
  const leaves = Int32Array.from({ length: N }, (_, i) => (hasChild[i] ? 0 : 1));
  for (let i = N - 1; i >= 0; i--) if (px[i] >= 0) leaves[px[i]] += leaves[i];
  const width = Float64Array.from(leaves, Math.sqrt);

  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), parent: px, leaves, width };
}

/**
 * Paint a grown tree's segments as capsules (round-capped, `widthAt(i)` mm
 * wide at the child end `i`) onto a `ww`×`wh` raster at `k`,`ky` px/mm.
 * `workRaster` (core/cutsheet.js) always derives `k` and `ky` from one shared
 * scalar, so pixels are square enough to paint a segment's width with `k`
 * alone, the same assumption `core/cutsheet.js`'s own bridge painter makes.
 * @param {{xs:Float64Array, ys:Float64Array, parent:Int32Array}} tree
 * @param {(i:number) => number} widthAt  mm
 */
export function rasterizeVeins(tree, ww, wh, k, ky, widthAt) {
  const { xs, ys, parent } = tree;
  const M = new Uint8Array(ww * wh);
  for (let i = 0; i < xs.length; i++) {
    const p = parent[i];
    if (p < 0) continue;
    const r = Math.max(0.5, (widthAt(i) / 2) * k);
    forEachCapsulePixel(ww, wh, xs[p] * k, ys[p] * ky, xs[i] * k, ys[i] * ky, r, (q) => { M[q] = 1; });
  }
  return M;
}

/**
 * Like `rasterizeVeins`, but for color mode: writes `Math.min(current, label)`
 * at every pixel a segment covers, into a caller-supplied `labRaster` (already
 * filled with the "no vein here" sentinel). On overlap between two branches
 * with different labels, the shallower one (the one needing less cutting)
 * wins -- a minor cosmetic choice for a rare case, not a structural one.
 * @param {(i:number) => number} labelAt
 */
export function paintVeinLabels(tree, ww, wh, k, ky, widthAt, labelAt, labRaster) {
  const { xs, ys, parent } = tree;
  for (let i = 0; i < xs.length; i++) {
    const p = parent[i];
    if (p < 0) continue;
    const r = Math.max(0.5, (widthAt(i) / 2) * k);
    const l = labelAt(i);
    forEachCapsulePixel(ww, wh, xs[p] * k, ys[p] * ky, xs[i] * k, ys[i] * ky, r, (q) => {
      if (l < labRaster[q]) labRaster[q] = l;
    });
  }
}

/** Every raster pixel within `r` of the segment (ax,ay)-(bx,by), all in px. */
function forEachCapsulePixel(ww, wh, ax, ay, bx, by, r, fn) {
  const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
  const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), i1 = Math.min(ww - 1, Math.ceil(Math.max(ax, bx) + r + 1));
  const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), j1 = Math.min(wh - 1, Math.ceil(Math.max(ay, by) + r + 1));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const pxc = i + 0.5, pyc = j + 0.5;
      let t = L2 > 0 ? ((pxc - ax) * ex + (pyc - ay) * ey) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if ((ax + t * ex - pxc) ** 2 + (ay + t * ey - pyc) ** 2 <= r * r) fn(j * ww + i);
    }
  }
}
