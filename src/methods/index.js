// The method registry. A method module exports
//
//   id, label, blurb, params,
//   build(rgba, settings, params) -> the hole model:
//     { widthMm, heightMm, mode, D, N, palette,
//       target, achieved, source   N*D per cell, linear: aimed at / got / asked
//       layers                     holes per cut sheet, top first (core/holes.js)
//       webs                       thinnest web per cut sheet, mm, from geometry
//       cellAt(x, y)               cell index at a point (mm), -1 outside
//       imageRect                  where the image lies on the piece, mm
//       cellsLabel, dropped, saturated, note }
//
// The square grid also exports run/targetImage/limits, which its tests use.
// Params are {key, label, type: 'range'|'select'|'checkbox', def, ...}; a range
// may give `unit` and `dp` (decimals shown). Anything that depends on the
// pattern belongs here, not in the app's Piece & machine settings. Params may
// carry `when(params, env) => boolean` to hide a control that does not apply;
// env is {mode} from the app.

import squareGrid from './squareGrid.js';
import hexGrid from './hexGrid.js';
import voronoiWeb from './voronoiWeb.js';
import stipple from './stipple.js';
import stencil from './stencil.js';
import screen from './screen.js';
import facets from './facets.js';
import rectangles from './rectangles.js';

export const METHODS = [squareGrid, hexGrid, voronoiWeb, facets, rectangles, stipple, stencil, screen];

export const byId = (id) => METHODS.find((m) => m.id === id) || METHODS[0];

export function defaultsFor(method) {
  const out = {};
  for (const p of method.params) out[p.key] = p.def;
  return out;
}

/** `env` carries app-level settings a gate may read, e.g. {mode: 'color'}. */
export const paramVisible = (p, params, env = {}) => !p.when || p.when(params, env);
