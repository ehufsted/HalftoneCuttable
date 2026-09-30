// Rectangles: the Mondrian subdivision on the cell-web engine.
//
// PREDICTIONS.
//  - Exactly `count` rectangles, tiling the inset rectangle, none with a side
//    under `minSide`.
//  - The cuts follow the image: a two-tone image's first cut lands on its edge.
//  - T-junctions are handled: every labeled neighbor really is across that edge.
//  - Taper: the first cut's metal is `cutWidth` wide, and widths fall with rank
//    to the min web; "All the same" keeps every cut at `cutWidth`.
//  - One piece, webs never under the setting (claimed and measured), and in
//    color each rectangle takes its region's sheet, filled flat.

import { check, section, num, noiseRGBA, makeRGBA, plain } from './runner.js';
import method from '../src/methods/rectangles.js';
import { pieceCount } from '../src/core/structure.js';
import { polyArea, polyDistance } from '../src/core/polygon.js';

const base = { ...plain, widthMm: 60, web: 0.5, minHole: 0.5, kerf: 0.15 };
const quadrants = (tl, tr, bl, br) => makeRGBA(300, 200, (x, y) => (y < 100 ? (x < 150 ? tl : tr) : (x < 150 ? bl : br)));

/** The metal across every wall, by the rank of the cut it lies on. */
function wallWebs(b) {
  const { cells, margins, extra, leaves, sideOfEdge } = b.debug;
  const byRank = new Map();
  cells.forEach((C, i) => {
    C.lab.forEach((q, k) => {
      if (q <= i || !(margins[0][i] >= 0) || !(margins[0][q] >= 0)) return;
      const rank = leaves[i].sides[sideOfEdge[i][k]];
      const w = margins[0][i] + margins[0][q] + 2 * extra[i][k];
      byRank.set(rank, Math.min(byRank.get(rank) ?? Infinity, w));
    });
  });
  return byRank;
}

export function run() {
  section('method.rectangles', 'Count and tiling; cuts on the image’s edges; T-junction neighbors; tapering cut widths; one piece; sheet colors.');

  // ---- count, tiling, smallest side
  {
    const b = method.build(noiseRGBA(300, 200, 3, false), base, { count: 40, minSide: 4 });
    const [x0, y0, x1, y1] = b.debug.rect;
    const tiled = b.debug.cells.reduce((a, C) => a + polyArea(C), 0);
    const small = b.debug.leaves.filter((r) => Math.min(r.x1 - r.x0, r.y1 - r.y0) < 4 - 0.3).length;
    check('exactly the rectangles asked for, tiling the piece, none under the smallest side',
      b.N === 40 && Math.abs(tiled - (x1 - x0) * (y1 - y0)) < 1e-6 * tiled && small === 0,
      `${b.N} rectangles, ${num(100 * tiled / ((x1 - x0) * (y1 - y0)), 5)}% covered, ${small} too small`);
  }

  // ---- cuts follow the image
  {
    const b = method.build(quadrants([40, 40, 40], [220, 220, 220], [40, 40, 40], [220, 220, 220]), base, { count: 2 });
    const c = b.debug.splits[0];
    check('a two-tone image’s first cut lands on its edge', c.dir === 'v' && Math.abs(c.pos - 30) <= 0.3,
      `${c.dir === 'v' ? 'vertical' : 'horizontal'} cut at ${num(c.pos, 2)} mm, the edge at 30 mm`);
  }

  // ---- T-junctions: every labeled neighbor is really across the edge
  {
    const b = method.build(noiseRGBA(300, 200, 4, false), base, { count: 60, minSide: 3 });
    const { cells, leaves } = b.debug;
    let bad = 0, walls = 0, mutual = 0;
    cells.forEach((C, i) => {
      const n = C.xs.length;
      for (let k = 0; k < n; k++) {
        const q = C.lab[k];
        const k2 = (k + 1) % n;
        const mx = (C.xs[k] + C.xs[k2]) / 2, my = (C.ys[k] + C.ys[k2]) / 2;
        // step 0.01 mm outward: the outward normal of edge a->b is (ey, -ex)/|e|
        const ex = C.xs[k2] - C.xs[k], ey = C.ys[k2] - C.ys[k], L = Math.hypot(ex, ey);
        const px = mx + (0.01 * ey) / L, py = my - (0.01 * ex) / L;
        const across = leaves.findIndex((r) => px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1);
        walls++;
        if (across !== q) bad++;
        if (q >= 0 && !cells[q].lab.includes(i)) mutual++;
      }
    });
    check('T-junctions: every edge is labeled with the rectangle across it, both ways', bad === 0 && mutual === 0,
      `${bad} of ${walls} edges mislabeled, ${mutual} one-sided`);
  }

  // ---- tapering cut widths
  {
    const img = noiseRGBA(300, 200, 5, false);
    // Flat fill, pinned explicitly: every cell opens as far as the wall width
    // allows, so the measured metal between cells reads back widthOf(rank)
    // directly. With the tone fill (now the default) a cell's hole is sized by
    // its own tone instead, and the walls no longer trace the taper this checks.
    const t = method.build(img, base, { count: 20, cutWidth: 3, taper: 'taper', minSide: 5, fill: 'flat' });
    const e = method.build(img, base, { count: 20, cutWidth: 3, taper: 'even', minSide: 5, fill: 'flat' });
    const wt = wallWebs(t), we = wallWebs(e);
    const ranks = [...wt.keys()].filter((r) => r >= 0).sort((a, b) => a - b);
    const first = wt.get(ranks[0]), last = wt.get(ranks[ranks.length - 1]);
    const widths = ranks.map((r) => t.debug.widthOf(r));
    const falling = widths.every((w, i) => i === 0 || w <= widths[i - 1] + 1e-12);
    const evenMin = Math.min(...[...we.entries()].filter(([r]) => r >= 0).map(([, w]) => w));
    check('taper: the first cut is the cut width, and they narrow to the min web',
      Math.abs(first - 3) < 1e-6 && last < first && last >= base.web - 1e-9 && falling,
      `first cut ${num(first, 3)} mm, last ${num(last, 3)} mm (min web ${base.web})`);
    check('all the same: every cut is the cut width', Math.abs(evenMin - 3) < 1e-6, `narrowest ${num(evenMin, 3)} mm`);
  }

  // ---- one piece, webs, in B&W and a 4-sheet solid stack
  {
    const cases = [
      ['B&W noise', noiseRGBA(300, 200, 6, false), {}, { count: 50, minSide: 4 }],
      ['color quadrants, 4 sheets, solid', quadrants([200, 30, 30], [30, 60, 200], [240, 240, 240], [200, 30, 30]),
        { mode: 'color', palette: ['#101010', '#d02020', '#2040d0', '#f0f0f0'], reg: 0.3 }, { count: 12, minSide: 5 }],
    ];
    const fails = [];
    for (const [name, rgba, extra, params] of cases) {
      const s = { ...base, ...extra };
      const b = method.build(rgba, s, params);
      b.layers.forEach((holes, j) => {
        const pieces = pieceCount({ ...b, kerf: s.kerf }, holes, 4 / s.web);
        let g = Infinity;
        const { cells, cuts } = b.debug;
        cells.forEach((C, i) => {
          const A = cuts[j][i];
          if (!A) return;
          for (const q of C.lab) if (q > i && cuts[j][q]) g = Math.min(g, polyDistance(A, cuts[j][q]) - s.kerf);
        });
        if (pieces !== 1) fails.push(`${name} sheet ${j + 1}: ${pieces} pieces`);
        if (b.webs[j] < s.web - 1e-9 || g < s.web - 1e-6) fails.push(`${name} sheet ${j + 1}: web ${num(b.webs[j], 3)} / ${num(g, 3)}`);
      });
    }
    check('every cut sheet is one piece, no web under the setting (claimed and measured)', fails.length === 0, fails.join('; ') || '2 configurations');
  }

  // ---- sheet colors: each quadrant's rectangles take its sheet, filled flat.
  // Flat fill and solid regions, pinned explicitly (mixed regions -- now the
  // default -- blend a rectangle's own color with its neighbors' near a wall,
  // which this check's "shows it at full flat strength" would rightly fail).
  {
    const s = { ...base, mode: 'color', palette: ['#101010', '#d02020', '#2040d0', '#f0f0f0'], reg: 0.3 };
    const b = method.build(quadrants([200, 30, 30], [30, 60, 200], [240, 240, 240], [200, 30, 30]), s,
      { count: 12, minSide: 5, fill: 'flat', regions: 'solid' });
    const want = (cx, cy) => (cy < 20 ? (cx < 30 ? 1 : 2) : (cx < 30 ? 3 : 1));
    let wrong = 0;
    b.debug.leaves.forEach((r, i) => { if (b.debug.labels[i] !== want((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)) wrong++; });
    let err = 0;
    for (let i = 0; i < b.N * 3; i++) err += Math.abs(b.achieved[i] - b.target[i]);
    check('each rectangle takes the sheet of its region, and shows it at full flat strength',
      wrong === 0 && err / (b.N * 3) < 0.01, `${wrong} of ${b.N} on the wrong sheet; mean |Δ| ${num(err / (b.N * 3), 4)} (linear)`);
  }

  // ---- determinism (no randomness at all)
  {
    const img = noiseRGBA(200, 150, 7, false);
    const key = (b) => b.debug.splits.map((c) => `${c.dir}${c.pos.toFixed(6)}`).join(',');
    check('the same image gives the same composition', key(method.build(img, base, { count: 30 })) === key(method.build(img, base, { count: 30 })));
  }
}
