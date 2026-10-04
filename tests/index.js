// The ordered section list. Order is part of the contract: the transcript is
// diffed between runs, so a reordering reads as a change.

import { reset, say, getTally } from './runner.js';
import * as shapes from './core.shapes.js';
import * as separate from './core.separate.js';
import * as svg from './core.svg.js';
import * as dxf from './core.dxf.js';
import * as style from './core.style.js';
import * as lic from './core.lic.js';
import * as units from './core.units.js';
import * as holes from './core.holes.js';
import * as relief from './core.relief.js';
import * as contour from './core.contour.js';
import * as squareGrid from './method.squareGrid.js';
import * as hexGrid from './method.hexGrid.js';
import * as polygon from './core.polygon.js';
import * as voronoi from './core.voronoi.js';
import * as voronoiWeb from './method.voronoiWeb.js';
import * as facets from './method.facets.js';
import * as rectangles from './method.rectangles.js';
import * as stipple from './method.stipple.js';
import * as stencil from './method.stencil.js';
import * as stencilLevels from './method.stencilLevels.js';
import * as screen from './method.screen.js';
import * as structure from './structure.js';
import * as pipeline from './pipeline.js';

export const SECTIONS = [
  ['core.shapes', shapes],
  ['core.separate', separate],
  ['core.svg', svg],
  ['core.dxf', dxf],
  ['core.style', style],
  ['core.lic', lic],
  ['core.units', units],
  ['core.holes', holes],
  ['core.relief', relief],
  ['core.contour', contour],
  ['core.polygon', polygon],
  ['core.voronoi', voronoi],
  ['method.squareGrid', squareGrid],
  ['method.hexGrid', hexGrid],
  ['method.voronoiWeb', voronoiWeb],
  ['method.facets', facets],
  ['method.rectangles', rectangles],
  ['method.stipple', stipple],
  ['method.stencil', stencil],
  ['method.stencilLevels', stencilLevels],
  ['method.screen', screen],
  ['structure', structure],
  ['pipeline', pipeline],
];

/** Headless: run every section (or those named) synchronously. */
export function runAll(only = null) {
  reset();
  for (const [name, mod] of SECTIONS) {
    if (only && !only.includes(name)) continue;
    mod.run();
  }
  summary();
}

export function summary() {
  const t = getTally();
  say(`<h2>Summary</h2><p class="${t.fail ? 'fail' : 'pass'}">${t.pass} passed, ${t.fail} failed</p>`);
}
