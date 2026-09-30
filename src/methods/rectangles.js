// Rectangles: a Mondrian-like composition of the image, cut in metal.
//
// The piece is cut the way Mondrian's canvases are: by straight lines, each
// spanning the rectangle it divides (guillotine cuts, so the joints are T's), each
// placed where it best separates the image. Greedily, until there are `count`
// rectangles:
//
//   1. of all current rectangles, take the one whose best split helps most --
//      the largest drop in total squared color error (area-weighted, so a big
//      varied rectangle goes before a small one)
//   2. its best split: every vertical and horizontal line through it, one work
//      pixel apart and at least `minSide` from its sides, scored by the error of
//      the two halves -- constant time each, from summed-area tables of the image
//      and its square, so the whole search is cheap
//   3. cut there, and repeat.
//
// Cuts land on the image's strong edges and rectangles stay large where it is
// flat. Each cut remembers its RANK (the order it was made in, which is also its
// importance), and with Taper the metal of a cut narrows with rank, from
// `cutWidth` for the first cut to the min web for the last -- Mondrian's bold
// structural lines and fine late ones. The outline frame is as bold as the first
// cut.
//
// The rectangles are cells of the shared cell-web engine (cellWeb.js), so color,
// tone, the web guarantee and the export come with them. At a T-junction a
// rectangle's side borders several neighbors, so each side is broken at the
// neighbors' corners into segments, each labeled with the one cell across it.
// All segments of a side lie on the same cut, so they carry the same width.
//
// Fill: 'flat' opens every rectangle fully onto its color -- with Solid color
// regions, a flat block of its sheet, the lines being the top sheet: Mondrian's
// look. 'tone' sizes each hole by the image, as the other cell webs do.

import { buildCellWeb } from './cellWeb.js';

export const id = 'rectangles';
export const label = 'Rectangles';
export const blurb = 'A Mondrian-like composition: the image divided by straight cuts, each placed where it best separates the image, into flat blocks of the sheet colors. The first cuts can be bolder than the later ones.';

export const params = [
  { key: 'count', label: 'Rectangles', type: 'range', min: 2, max: 300, step: 1, def: 30 },
  { key: 'minSide', label: 'Smallest side', type: 'range', min: 2, max: 40, step: 0.5, def: 8, unit: 'mm', dp: 1 },
  { key: 'cutWidth', label: 'Cut width', type: 'range', min: 0.5, max: 10, step: 0.1, def: 3, unit: 'mm', dp: 1 },
  { key: 'taper', label: 'Cut widths', type: 'select', def: 'even',
    options: [['taper', 'Narrower with each cut'], ['even', 'All the same']] },
  { key: 'fill', label: 'Fill', type: 'select', def: 'tone', options: [['flat', 'Flat color'], ['tone', 'By tone']] },
  { key: 'regions', label: 'Color regions', type: 'select', def: 'mixed',
    options: [['solid', 'Solid colors'], ['mixed', 'Mixed colors']], when: (p, env) => env.mode === 'color' },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']], when: (p) => p.fill === 'tone' },
  { key: 'diffuse', label: 'Error diffusion', type: 'checkbox', def: true, when: (p) => p.fill === 'tone' },
];

// the engine's other knobs, fixed: no edge features, no detail map (the cuts
// follow the image themselves), a nominal cell size for its sanity checks
const DEF = {
  ...Object.fromEntries(params.map((p) => [p.key, p.def])),
  edges: 'off', refine: 0, relax: 0, seed: 1, lineWidth: 0, edgeThreshold: 0.3, pitch: 10,
};
const TAPER_POWER = 1.5;       // most cuts come late, so let the width fall fast at first

export function rectLayout(c) {
  const { rect, P, ww, wh, kx, ky, enc, web } = c;
  const W1 = ww + 1;

  // summed-area tables of each channel and its square
  const S1 = enc.map(() => new Float64Array(W1 * (wh + 1)));
  const S2 = enc.map(() => new Float64Array(W1 * (wh + 1)));
  enc.forEach((im, ch) => {
    const d = im.data, a = S1[ch], b = S2[ch];
    for (let j = 0; j < wh; j++) {
      let r1 = 0, r2 = 0;
      for (let i = 0; i < ww; i++) {
        const v = d[j * ww + i];
        r1 += v; r2 += v * v;
        a[(j + 1) * W1 + i + 1] = a[j * W1 + i + 1] + r1;
        b[(j + 1) * W1 + i + 1] = b[j * W1 + i + 1] + r2;
      }
    }
  });
  const box = (T, i0, j0, i1, j1) => T[j1 * W1 + i1] - T[j0 * W1 + i1] - T[j1 * W1 + i0] + T[j0 * W1 + i0];
  const colI = (x) => Math.min(ww, Math.max(0, Math.round(x * kx)));
  const rowJ = (y) => Math.min(wh, Math.max(0, Math.round(y * ky)));
  /** Squared color error of a rectangle of pixels about its own mean. */
  const sseP = (i0, j0, i1, j1) => {
    const n = (i1 - i0) * (j1 - j0);
    if (n <= 0) return 0;
    let e = 0;
    for (let ch = 0; ch < enc.length; ch++) {
      const s = box(S1[ch], i0, j0, i1, j1);
      e += box(S2[ch], i0, j0, i1, j1) - (s * s) / n;
    }
    return e;
  };

  /** The best split of a rectangle: {gain, dir, pos (mm)} or null. */
  const bestSplit = (r) => {
    const i0 = colI(r.x0), i1 = colI(r.x1), j0 = rowJ(r.y0), j1 = rowJ(r.y1);
    const whole = sseP(i0, j0, i1, j1);
    let best = null;
    const better = (g) => best === null || g > best.gain;      // first of equals wins: deterministic
    for (let i = colI(r.x0 + P.minSide); i <= colI(r.x1 - P.minSide); i++) {
      const g = whole - sseP(i0, j0, i, j1) - sseP(i, j0, i1, j1);
      if (better(g)) best = { gain: g, dir: 'v', pos: i / kx };
    }
    for (let j = rowJ(r.y0 + P.minSide); j <= rowJ(r.y1 - P.minSide); j++) {
      const g = whole - sseP(i0, j0, i1, j) - sseP(i0, j, i1, j1);
      if (better(g)) best = { gain: g, dir: 'h', pos: j / ky };
    }
    return best;
  };

  // ---- the greedy subdivision. sides: the cut each side lies on (top, right,
  // bottom, left), -1 for the outline
  const leaves = [{ x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3], sides: [-1, -1, -1, -1] }];
  leaves[0].split = bestSplit(leaves[0]);
  const cuts = [];
  while (leaves.length < P.count) {
    let k = -1;
    for (let q = 0; q < leaves.length; q++) {
      const s = leaves[q].split;
      if (!s) continue;
      if (k < 0) { k = q; continue; }
      const b = leaves[k].split;
      // most gain first; on a tie (a flat image) the larger rectangle
      const area = (L) => (L.x1 - L.x0) * (L.y1 - L.y0);
      if (s.gain > b.gain + 1e-9 || (Math.abs(s.gain - b.gain) <= 1e-9 && area(leaves[q]) > area(leaves[k]))) k = q;
    }
    if (k < 0) break;                                   // nothing left that can be split
    const r = leaves[k], s = r.split, rank = cuts.length;
    cuts.push({ dir: s.dir, pos: s.pos, rank });
    let a, b;
    if (s.dir === 'v') {
      a = { x0: r.x0, y0: r.y0, x1: s.pos, y1: r.y1, sides: [r.sides[0], rank, r.sides[2], r.sides[3]] };
      b = { x0: s.pos, y0: r.y0, x1: r.x1, y1: r.y1, sides: [r.sides[0], r.sides[1], r.sides[2], rank] };
    } else {
      a = { x0: r.x0, y0: r.y0, x1: r.x1, y1: s.pos, sides: [r.sides[0], r.sides[1], rank, r.sides[3]] };
      b = { x0: r.x0, y0: s.pos, x1: r.x1, y1: r.y1, sides: [rank, r.sides[1], r.sides[2], r.sides[3]] };
    }
    a.split = bestSplit(a); b.split = bestSplit(b);
    leaves.splice(k, 1, a, b);
  }
  const N = leaves.length;

  // ---- cells: each side broken at the neighbors' corners into labeled segments
  const eps = 1e-6;
  const cells = [], sideOfEdge = [];
  const neighborAlong = (i, horizontal, line, from, to, otherSide) => {
    // segments [from, to] along a side, each with the cell across it
    const cuts2 = [from, to];
    const who = [];
    leaves.forEach((q, qi) => {
      if (qi === i) return;
      const onLine = horizontal ? Math.abs((otherSide ? q.y0 : q.y1) - line) < eps : Math.abs((otherSide ? q.x0 : q.x1) - line) < eps;
      if (!onLine) return;
      const a = horizontal ? q.x0 : q.y0, b = horizontal ? q.x1 : q.y1;
      if (b <= Math.min(from, to) + eps || a >= Math.max(from, to) - eps) return;
      who.push([a, b, qi]);
      if (a > Math.min(from, to) + eps && a < Math.max(from, to) - eps) cuts2.push(a);
      if (b > Math.min(from, to) + eps && b < Math.max(from, to) - eps) cuts2.push(b);
    });
    const pts = [...new Set(cuts2)].sort((u, v) => (from < to ? u - v : v - u));
    return pts.slice(0, -1).map((p0, t) => {
      const mid = (p0 + pts[t + 1]) / 2;
      const hit = who.find(([a, b]) => mid > a && mid < b);
      return { at: p0, q: hit ? hit[2] : -1 };
    });
  };
  leaves.forEach((r, i) => {
    const xs = [], ys = [], lab = [], side = [];
    // top: y = y0, x ascending; the cell across has its BOTTOM on this line
    for (const s of neighborAlong(i, true, r.y0, r.x0, r.x1, false)) { xs.push(s.at); ys.push(r.y0); lab.push(s.q); side.push(0); }
    // right: x = x1, y ascending; across has its LEFT on this line
    for (const s of neighborAlong(i, false, r.x1, r.y0, r.y1, true)) { xs.push(r.x1); ys.push(s.at); lab.push(s.q); side.push(1); }
    // bottom: y = y1, x descending; across has its TOP on this line
    for (const s of neighborAlong(i, true, r.y1, r.x1, r.x0, true)) { xs.push(s.at); ys.push(r.y1); lab.push(s.q); side.push(2); }
    // left: x = x0, y descending; across has its RIGHT on this line
    for (const s of neighborAlong(i, false, r.x0, r.y1, r.y0, false)) { xs.push(r.x0); ys.push(s.at); lab.push(s.q); side.push(3); }
    cells.push({ xs, ys, lab });
    sideOfEdge.push(side);
  });

  // ---- cut widths
  const R = Math.max(1, cuts.length);
  const widthOf = (rank) => {
    if (rank < 0 || P.taper === 'even') return P.cutWidth;
    const t = R > 1 ? rank / (R - 1) : 0;
    return web + (P.cutWidth - web) * (1 - t) ** TAPER_POWER;
  };
  // a wall between two rectangles is metal from both sides, each adding half; the
  // frame has only the one rectangle (and web/2 of rim outside the inset rect)
  const wallExtra = (i, q, k) => Math.max(0, (widthOf(leaves[i].sides[sideOfEdge[i][k]]) - web) / (q < 0 ? 1 : 2));

  // ---- which rectangle owns each work pixel (the border band: the nearest one)
  const owner = new Int32Array(ww * wh).fill(-1);
  leaves.forEach((r, t) => {
    for (let j = rowJ(r.y0); j < rowJ(r.y1); j++) for (let i2 = colI(r.x0); i2 < colI(r.x1); i2++) owner[j * ww + i2] = t;
  });
  // a point outside the rectangle (the border band) is clamped into it first;
  // the ownership raster then answers in constant time (the Difference view asks
  // once per preview pixel)
  const i0r = colI(rect[0]), i1r = colI(rect[2]) - 1, j0r = rowJ(rect[1]), j1r = rowJ(rect[3]) - 1;
  const ownerAt = (xm, ym) => {
    const i = Math.min(i1r, Math.max(i0r, Math.floor(xm * kx))), j = Math.min(j1r, Math.max(j0r, Math.floor(ym * ky)));
    const o = owner[j * ww + i];
    return o >= 0 ? o : 0;
  };
  const cellOfPixel = (i, j) => ownerAt((i + 0.5) / kx, (j + 0.5) / ky);

  return {
    N, cells,
    sites: { xs: leaves.map((r) => (r.x0 + r.x1) / 2), ys: leaves.map((r) => (r.y0 + r.y1) / 2) },
    cellOfPixel, cellAt: ownerAt,
    isLine: () => false, wallExtra,
    notes: [`${N} rectangles from ${cuts.length} cuts`],
    unit: 'rectangles',
    debug: { leaves, splits: cuts, sideOfEdge, widthOf },
  };
}

export const build = (rgba, settings, params = {}) =>
  buildCellWeb(rgba, settings, params, DEF, rectLayout, { minPxPerMm: 4 });

export default { id, label, blurb, params, build };
