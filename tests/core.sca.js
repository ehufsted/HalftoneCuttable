// Space colonization: the growth engine itself, independent of any method.
//
// PREDICTION. A lone root pulled by a single attractor grows a dead-straight
// chain, exactly `distance / stepSize` steps long, ending within
// `killDistance` of the attractor -- no raster, no image, just the geometry.
// (A root pulled by SEVERAL attractors at once sums their directions every
// round, which is a real feature -- symmetric attractors can briefly cancel
// and fall back to the tie-break -- but makes the path unpredictable, so the
// straight-line check below uses one root, one attractor, run four times at
// different angles instead of one four-armed cross.) Steering, at strength 1,
// replaces the pull direction outright (bx = vx, by = vy in growVeins), so a
// one-step growth from a single attractor should land exactly along the steer
// axis, not toward the attractor at all. The tree is always a forest of
// chains back to a root, so a child's own leaf count can never exceed its
// parent's.

import { check, section, num } from './runner.js';
import { growVeins, rasterizeVeins, paintVeinLabels } from '../src/core/sca.js';
import { mulberry32 } from '../src/shim/random.js';

export function run() {
  section('core.sca', 'Growth toward attractors, steering, width-by-leaves, and the two rasterizers.');

  // ---- one root, one attractor, at four different angles
  {
    const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 4];
    let worstSeg = 0, worstMiss = 0, worstSteps = null;
    for (const a of angles) {
      const target = { x: 10 * Math.cos(a), y: 10 * Math.sin(a) };
      const tree = growVeins({
        roots: [{ x: 0, y: 0 }], attractors: [target], stepSize: 1, killDistance: 1, influenceRadius: 50,
        maxIter: 30, rand: mulberry32(1),
      });
      for (let i = 1; i < tree.xs.length; i++) {
        const p = tree.parent[i];
        worstSeg = Math.max(worstSeg, Math.abs(Math.hypot(tree.xs[i] - tree.xs[p], tree.ys[i] - tree.ys[p]) - 1));
      }
      let best = Infinity;
      for (let i = 0; i < tree.xs.length; i++) best = Math.min(best, Math.hypot(tree.xs[i] - target.x, tree.ys[i] - target.y));
      worstMiss = Math.max(worstMiss, best);
      if (worstSteps === null || Math.abs(tree.xs.length - 11) > Math.abs(worstSteps - 11)) worstSteps = tree.xs.length;

      // leaves accumulate from child to parent, so a parent's count is never less
      const px = tree.parent;
      const monotone = tree.leaves.every((v, i) => px[i] < 0 || tree.leaves[px[i]] >= v);
      const widthOk = tree.width.every((w, i) => Math.abs(w - Math.sqrt(tree.leaves[i])) < 1e-9);
      check(`leaves monotone and width = sqrt(leaves) at angle ${num(a, 2)}`, monotone && widthOk);
    }
    check('every segment is exactly one step long', worstSeg < 1e-9, `worst deviation ${num(worstSeg, 8)} mm`);
    check('the attractor is reached within the kill distance', worstMiss <= 1 + 1e-9,
      `farthest miss ${num(worstMiss, 4)} mm`);
    check('a straight 10 mm chain takes about 10 steps', worstSteps >= 9 && worstSteps <= 12,
      `${worstSteps} nodes (1 root + chain)`);
  }

  // ---- determinism: same seed, same inputs, identical tree
  {
    const attractors = Array.from({ length: 12 }, (_, i) => ({ x: 8 * Math.cos(i), y: 8 * Math.sin(i) }));
    const run1 = growVeins({
      roots: [{ x: 0, y: 0 }], attractors, stepSize: 0.7, killDistance: 0.7, influenceRadius: 20, maxIter: 40,
      rand: mulberry32(7),
    });
    const run2 = growVeins({
      roots: [{ x: 0, y: 0 }], attractors, stepSize: 0.7, killDistance: 0.7, influenceRadius: 20, maxIter: 40,
      rand: mulberry32(7),
    });
    const key = (t) => Array.from(t.xs).map((v, i) => `${v.toFixed(6)},${t.ys[i].toFixed(6)},${t.parent[i]}`).join(';');
    check('two runs with the same seed are identical', key(run1) === key(run2));
  }

  // ---- steering overrides the pull direction at strength 1
  {
    const rand = mulberry32(3);
    const steer = () => ({ ux: 0, uy: 1, strength: 1 });
    const tree = growVeins({
      roots: [{ x: 0, y: 0 }], attractors: [{ x: 10, y: 0 }], stepSize: 1, killDistance: 0.01,
      influenceRadius: 50, maxIter: 1, rand, steer,
    });
    // one iteration: exactly one child of the root
    const child = tree.xs.length - 1;
    check('full-strength steering sends the first step along the steer axis, not the pull',
      Math.abs(tree.xs[child] - 0) < 1e-9 && Math.abs(tree.ys[child] - 1) < 1e-9,
      `child landed at (${num(tree.xs[child], 4)}, ${num(tree.ys[child], 4)}), wanted (0, 1)`);
  }

  // ---- unreachable: no roots within influence range of any attractor
  {
    const rand = mulberry32(5);
    const tree = growVeins({
      roots: [{ x: 0, y: 0 }], attractors: [{ x: 1000, y: 1000 }], stepSize: 1, killDistance: 1,
      influenceRadius: 5, maxIter: 50, rand,
    });
    check('growth stalls (and stops) rather than looping when nothing is in reach', tree.xs.length === 1,
      `${tree.xs.length} node(s), expected just the root`);
  }

  // ---- rasterizeVeins and paintVeinLabels, on a hand-built two-segment tree
  {
    // root at (2,5), one child straight right at (8,5): a 6 mm horizontal
    // capsule on a 10x10 px/mm raster, radius 1 px (2 px wide)
    const tree = { xs: Float64Array.from([2, 8]), ys: Float64Array.from([5, 5]), parent: Int32Array.from([-1, 0]) };
    const ww = 100, wh = 100, k = 10, ky = 10;
    const mask = rasterizeVeins(tree, ww, wh, k, ky, () => 0.2);   // 0.2 mm wide -> r = 1 px
    const at = (xmm, ymm) => mask[Math.floor(ymm * ky) * ww + Math.floor(xmm * k)];
    check('rasterizeVeins paints along the segment', at(5, 5) === 1 && at(2, 5) === 1 && at(8, 5) === 1);
    check('rasterizeVeins leaves pixels off the segment unpainted', at(5, 9) === 0 && at(5, 1) === 0);

    const labRaster = new Uint8Array(ww * wh).fill(9);
    paintVeinLabels(tree, ww, wh, k, ky, () => 0.2, () => 3, labRaster);
    check('paintVeinLabels writes the branch’s label where it paints', labRaster[5 * ky * ww + 5 * k] === 3);
    check('paintVeinLabels leaves the sentinel elsewhere', labRaster[9 * ky * ww + 5 * k] === 9);

    // a second, shallower-labeled branch crossing the same spot: the shallower wins
    const cross = { xs: Float64Array.from([5, 5]), ys: Float64Array.from([2, 8]), parent: Int32Array.from([-1, 0]) };
    paintVeinLabels(cross, ww, wh, k, ky, () => 0.2, () => 1, labRaster);
    check('on overlap, the shallower label wins', labRaster[5 * ky * ww + 5 * k] === 1);
  }
}
