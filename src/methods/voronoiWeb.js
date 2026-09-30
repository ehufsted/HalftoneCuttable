// Voronoi web: seeds scattered by detail, each seed's Voronoi cell cut as a hole
// inset from its walls, leaving a web of metal. Organic, leaf-skeleton or
// stained-glass looks rather than a screen.
//
// TWO JOBS, TWO KNOBS. The seeds decide WHERE the webs run: dense where the image
// has detail, pinned in pairs across edges so a wall lies on the edge. Each cell's
// own inset margin decides its TONE: the hole is the cell with every wall moved
// in by that margin, and the margin is solved per cell so the finished open area
// is exactly what the cell is asked for. Structure and tone never trade against
// each other.
//
// ONE PIECE BY CONSTRUCTION. Every margin is at least web/2, so two holes either
// side of a shared wall are at least web apart, and the cells are clipped to the
// piece inset by web/2, so an edge hole is at least web from the outline. Every
// hole is convex. Disjoint convex holes that far apart cannot enclose any metal,
// so the sheet is one piece for any image and any seeds. tests/method.voronoiWeb
// checks this by flood fill anyway.
//
// EDGES (param `edges`):
//   off    -- seeds ignore edges; cells may straddle them.
//   breaks -- pinned pairs put a cell wall on each edge, so no cell straddles
//             one: tone changes crisply at the edge, with no extra metal.
//   lines  -- as breaks, and those walls get `lineWidth` more metal: the edges
//             come out as drawn lines. The cells either side still hit their
//             tone -- the line is paid for by the rest of each cell's web -- until
//             a cell cannot shrink its other walls any further.
//
// COLOUR REGIONS (param `regions`, stacked-colour mode only):
//   mixed  -- each cell may show any mix of the sheets, through nested holes,
//             exactly as the square grid does.
//   solid  -- each cell shows the top sheet and ONE other: the image is split into
//             regions by which sheet it is nearest, region boundaries are pinned
//             like edges, and inside a region only tone varies. Purer colour,
//             stained-glass look; no blending within a cell.
//             The sheets in between are cut LARGER than the top hole, by the
//             registration allowance per sheet, so they hide under the top sheet
//             and the top hole alone is the window: a small misalignment shows
//             nothing but the region's colour. (Mixed mode nests them SMALLER,
//             because there the rings are meant to show.) The cost is that the
//             top hole must leave room for them, so a deep sheet's cells reach
//             a little less open area.

import { SeedHash, voronoiCells } from '../core/voronoi.js';
import { placeSeeds } from '../core/seeds.js';
import { buildCellWeb } from './cellWeb.js';

export const id = 'voronoiWeb';
export const label = 'Voronoi web';
export const blurb = 'Voronoi cells cut as holes, leaving a web of metal. Cells shrink where the image has detail and line up along its edges. Cell size is the size where the image is flat.';

export const params = [
  { key: 'pitch', label: 'Cell size', type: 'range', min: 1, max: 20, step: 0.1, def: 4, unit: 'mm', dp: 1 },
  { key: 'edges', label: 'Edges', type: 'select', def: 'breaks',
    options: [['off', 'Ignore'], ['breaks', 'Clean breaks'], ['lines', 'Metal lines']] },
  { key: 'lineWidth', label: 'Line width', type: 'range', min: 0.2, max: 4, step: 0.1, def: 1, unit: 'mm', dp: 1,
    when: (p) => p.edges === 'lines' },
  { key: 'edgeThreshold', label: 'Edge threshold', type: 'range', min: 0.05, max: 0.9, step: 0.05, def: 0.3,
    when: (p) => p.edges !== 'off' },
  { key: 'regions', label: 'Colour regions', type: 'select', def: 'mixed',
    options: [['mixed', 'Mixed colours'], ['solid', 'Solid colours']],
    when: (p, env) => env.mode === 'color' },
  { key: 'refine', label: 'Detail refine', type: 'range', min: 0, max: 0.7, step: 0.05, def: 0.4 },
  { key: 'relax', label: 'Relax', type: 'range', min: 0, max: 6, step: 1, def: 2 },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']] },
  { key: 'diffuse', label: 'Error diffusion', type: 'checkbox', def: true },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1 },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));

/**
 * The Voronoi layout: seeds by detail, pinned in mirrored pairs across edges so a
 * wall lies on each edge (core/seeds.js), and their Voronoi cells. A wall carries
 * an edge line when it separates the two sides of a pinned pair.
 */
export function voronoiLayout(c) {
  const { rect, spacingAt, sMin, sMax, feats, P, W, H, kx, ky } = c;
  const seeds = placeSeeds({ rect, spacingAt, sMin, sMax, edges: feats, seed: P.seed, iters: P.relax });
  const hash = new SeedHash(seeds.xs, seeds.ys, 0, 0, W, H, sMax);
  const cells = voronoiCells(seeds.xs, seeds.ys, rect, hash);
  const crosses = (i, j) => seeds.pinned[i] === 1 && seeds.pinned[j] === 1 &&
    seeds.side[i] * seeds.side[j] * (seeds.nx[i] * seeds.nx[j] + seeds.ny[i] * seeds.ny[j]) < -0.5;
  return {
    N: seeds.xs.length, cells, sites: seeds,
    cellOfPixel: (i, j) => hash.nearest((i + 0.5) / kx, (j + 0.5) / ky),
    cellAt: (x, y) => hash.nearest(x, y),
    isLine: (i, q) => crosses(i, q),
    notes: seeds.pairs ? [`${seeds.pairs} wall pairs pinned`] : [],
    debug: { seeds, crosses },
  };
}

export const build = (rgba, settings, params = {}) => buildCellWeb(rgba, settings, params, DEF, voronoiLayout);

export default { id, label, blurb, params, build };
