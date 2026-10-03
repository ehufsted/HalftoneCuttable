// Vein web: the grown tree, rasterized and run through Stencil/Screen's own
// raster pipeline, must still come out as one piece with at least the web
// everywhere -- the whole point of reusing that pipeline instead of a new
// analytic proof. Darker images should grow denser veins (more metal, which
// reads darker, per the app's "open area = brightness" rule); the root
// options should actually move where the tree starts; and steering should
// bend branches measurably toward the field it's given.
//
// Structure is checked the same way tests/method.stencil.js checks it: the
// traced contours rasterized and grown by the kerf, then shrunk by just under
// web/2 and flood-filled.

import { check, section, num, flatGray, noiseRGBA, makeRGBA, plain } from './runner.js';
import method from '../src/methods/veinWeb.js';
import { pieceCount } from '../src/core/structure.js';

const base = { ...plain, widthMm: 80, web: 0.6, minHole: 0.6, kerf: 0.15 };
const PX = 20;

export function run() {
  section('method.veinWeb', 'One piece at the full web, tone by density, root placement, steering.');

  // ---- structure: a busy (noisy) image is the harder case for bridging
  {
    const img = noiseRGBA(120, 120, 11, false);
    const b = method.build(img, base, { pitch: 3, thickness: 1.5, seed: 4 });
    const pieces = pieceCount({ ...b, kerf: base.kerf }, b.layers[0], PX);
    check('a busy image still comes out as one piece, at least the web wide',
      pieces === 1 && b.webs[0] >= base.web - 1e-9,
      `${pieces} piece(s), thinnest web ${num(b.webs[0], 3)} mm (want ≥ ${base.web})`);
  }

  // ---- tone: a black piece wants far more metal (reads darker) than white
  {
    const white = method.build(flatGray(60, 60, 255), base, { pitch: 3, seed: 2 });
    const black = method.build(flatGray(60, 60, 0), base, { pitch: 3, seed: 2 });
    const coverage = (b) => {
      let vein = 0;
      for (let q = 0; q < b.debug.lab.length; q++) if (b.debug.lab[q] < 1) vein++;
      return vein / b.debug.lab.length;
    };
    const cw = coverage(white), cb = coverage(black);
    check('a black piece grows far more vein coverage than a white one', cb > cw + 0.3,
      `white ${num(cw, 3)}, black ${num(cb, 3)} (fraction of the raster covered)`);
    // Not "almost nothing": a blank image still carries a sparse connective
    // web (core/methods/veinWeb.js's RHO_FLOOR) so growth from the border can
    // reach genuinely blank regions of a REAL image at all -- classic space
    // colonization cannot cross a gap wider than influenceRadius with nothing
    // in it to pull toward. The claim here is just "much less than black".
    check('a white piece stays sparse, well short of black’s coverage', cw < cb / 2, `${num(cw, 3)} covered`);
  }

  // ---- root placement: "Roots from" + "Single root point" actually move the roots
  {
    const img = flatGray(60, 60, 60);
    const roots = (p) => {
      const b = method.build(img, base, { pitch: 4, seed: 3, ...p });
      const t = b.debug.tree;
      const pts = [];
      for (let i = 0; i < t.parent.length; i++) if (t.parent[i] < 0) pts.push({ x: t.xs[i], y: t.ys[i] });
      return { pts, H: b.heightMm };
    };
    const all = roots({ rootEdge: 'all' });
    check('"All edges" scatters roots around the whole border', all.pts.length > 4);

    const { pts: bottomPts, H } = roots({ rootEdge: 'bottom' });
    const e = base.web + base.kerf / 2;
    check('"Bottom" keeps every root on the bottom edge',
      bottomPts.length > 0 && bottomPts.every((p) => Math.abs(p.y - (H - e)) < 1e-6),
      `${bottomPts.length} root(s), y in [${Math.min(...bottomPts.map((p) => p.y)).toFixed(3)}, ${Math.max(...bottomPts.map((p) => p.y)).toFixed(3)}], edge at ${(H - e).toFixed(3)}`);

    const { pts: pointPts } = roots({ rootEdge: 'bottom', rootPoint: true });
    check('"Single root point" collapses the edge to exactly one root', pointPts.length === 1,
      `${pointPts.length} root(s)`);
  }

  // ---- steering: branches lean toward the given field when it is strong.
  // A flat image has no gradient to steer along (orientationField's own
  // strength is gated on it), so this needs real structure: a uniform ramp
  // gives a constant, maximal-coherence gradient everywhere, so steering has
  // something to bend along over the whole growth area, not just one edge.
  {
    const img = makeRGBA(100, 100, (x) => { const v = Math.round((80 * x) / 99); return [v, v, v]; });
    const steered = method.build(img, base, { pitch: 3, seed: 6, steer: true, anisotropy: 1 });
    const plainGrowth = method.build(img, base, { pitch: 3, seed: 6, steer: false });
    const key = (b) => b.layers[0].map((L) => `${L.xs.length}:${L.xs[0].toFixed(6)}`).join(';');
    check('steering changes the grown tree from the unsteered run', key(steered) !== key(plainGrowth));
  }

  // ---- color: every cut sheet is one piece
  {
    const pal = ['#f0f0f0', '#c02020', '#202020'];
    const img = noiseRGBA(80, 80, 9, true);
    const b = method.build(img, { ...base, mode: 'color', palette: pal, reg: 0.2 }, { pitch: 3, seed: 5 });
    const pieces = b.layers.map((L) => pieceCount({ ...b, kerf: base.kerf }, L, PX));
    check('color: every cut sheet is one piece', pieces.every((p) => p === 1), pieces.join(', '));
  }

  // ---- determinism
  {
    const img = noiseRGBA(60, 60, 3, false);
    const a = method.build(img, base, { pitch: 3, seed: 8 });
    const c = method.build(img, base, { pitch: 3, seed: 8 });
    const key = (b) => b.layers[0].map((L) => `${L.xs.length}:${L.xs[0].toFixed(6)}`).join(';');
    check('two runs on the same input are identical', key(a) === key(c));
  }
}
