// The DXF export, read back with a small reader so every check is on the file.
//
// PREDICTIONS.
//  - R12 header with the mm hint; layers HOLES (5) and OUTLINE (1).
//  - Circles land where the SVG puts them, with y flipped: (x + k/2, H - y - k/2).
//  - Arcs bulge OUTWARD: a rounded square or diamond rebuilt from its vertices and
//    bulges has exactly its cut path's area. A wrong bulge sign would bend every
//    corner inward and come out short by 2(4 - π)r²-ish.
//  - Nothing is mirrored: an L keeps its foot at the bottom.

import { check, section, num, noiseRGBA, makeRGBA, plain } from './runner.js';
import { prepare } from '../src/core/units.js';
import { gridHoles } from '../src/core/holes.js';
import { areaOf } from '../src/core/shapes.js';
import { layerDXF } from '../src/core/dxf.js';
import { sheetFileName } from '../src/core/names.js';
import grid from '../src/methods/squareGrid.js';
import stencil from '../src/methods/stencil.js';

/** A small R12 reader: header variables, layer colours, circles, polylines. */
function readDXF(text) {
  const lines = text.split('\n');
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1]]);
  const header = {}, layers = {}, circles = [], polylines = [];
  let section = '', cur = null, entity = null, lastVar = null, layerName = null;
  for (const [code, val] of pairs) {
    if (code === 0 && val === 'SECTION') { section = 'pending'; continue; }
    if (code === 2 && section === 'pending') { section = val; continue; }
    if (code === 0 && val === 'ENDSEC') { section = ''; continue; }
    if (section === 'HEADER') {
      if (code === 9) lastVar = val;
      else if (lastVar) { header[lastVar] = header[lastVar] ?? val; }
    } else if (section === 'TABLES') {
      if (code === 0) entity = val;
      if (entity === 'LAYER' && code === 2) layerName = val;
      if (entity === 'LAYER' && code === 62) layers[layerName] = parseInt(val, 10);
    } else if (section === 'ENTITIES') {
      if (code === 0) {
        entity = val;
        if (val === 'CIRCLE') { cur = { layer: '', x: 0, y: 0, r: 0 }; circles.push(cur); }
        else if (val === 'POLYLINE') { cur = { layer: '', closed: false, v: [] }; polylines.push(cur); }
        else if (val === 'VERTEX') { cur.v.push({ x: 0, y: 0, b: 0 }); }
        continue;
      }
      const num_ = parseFloat(val);
      if (entity === 'CIRCLE') {
        if (code === 8) cur.layer = val; else if (code === 10) cur.x = num_; else if (code === 20) cur.y = num_; else if (code === 40) cur.r = num_;
      } else if (entity === 'POLYLINE') {
        if (code === 8) cur.layer = val; else if (code === 70) cur.closed = (parseInt(val, 10) & 1) === 1;
      } else if (entity === 'VERTEX') {
        const v = cur.v[cur.v.length - 1];
        if (code === 10) v.x = num_; else if (code === 20) v.y = num_; else if (code === 42) v.b = num_;
      }
    }
  }
  return { header, layers, circles, polylines, ends: text.trimEnd().endsWith('EOF') };
}

/** Signed area of a closed polyline with bulges (shoelace plus each arc's segment). */
function bulgeArea(v) {
  let a = 0;
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length];
    a += (p.x * q.y - q.x * p.y) / 2;
    if (p.b) {
      const th = 4 * Math.atan(Math.abs(p.b)), c = Math.hypot(q.x - p.x, q.y - p.y);
      const R = c / (2 * Math.sin(th / 2));
      a += Math.sign(p.b) * (R * R / 2) * (th - Math.sin(th));
    }
  }
  return a;
}

export function run() {
  section('core.dxf', 'Header and layers, circle positions after the y flip, arcs bulging outward, no mirroring, names.');
  const kerf = 0.2;

  // ---- header, layers, circles
  {
    const ctx = { ...prepare(noiseRGBA(100, 100, 4, false), { ...plain, kerf, minHole: 0.6 }), shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true };
    const { sizes } = grid.run(ctx);
    const holes = gridHoles(ctx, sizes[0], grid.limits(ctx).spec);
    const d = readDXF(layerDXF(ctx, holes).text);
    check('R12 header with the mm hint, HOLES blue and OUTLINE red, ends in EOF',
      d.header.$ACADVER === 'AC1009' && d.header.$INSUNITS === '4' && d.layers.HOLES === 5 && d.layers.OUTLINE === 1 && d.ends,
      `version ${d.header.$ACADVER}, units ${d.header.$INSUNITS}, layers ${JSON.stringify(d.layers)}`);
    const o = kerf / 2, H = ctx.heightMm + kerf;
    let worst = 0;
    holes.forEach((h, i) => {
      const c = d.circles[i];
      worst = Math.max(worst, Math.abs(c.x - (h.cx + o)), Math.abs(c.y - (H - h.cy - o)), Math.abs(c.r - h.a / 2));
    });
    check('circles: one per hole, at (x + k/2, H − y − k/2), radius as cut', d.circles.length === holes.length && worst < 1e-3 &&
      d.circles.every((c) => c.layer === 'HOLES'), `${d.circles.length} circles for ${holes.length} holes, worst error ${worst.toExponential(1)} mm`);
    const out = d.polylines.filter((p) => p.layer === 'OUTLINE');
    const xs = out[0].v.map((v) => v.x), ys = out[0].v.map((v) => v.y);
    check('outline: one closed rectangle, the piece plus one kerf', out.length === 1 && out[0].closed &&
      Math.abs(Math.max(...xs) - (ctx.widthMm + kerf)) < 1e-3 && Math.abs(Math.max(...ys) - H) < 1e-3 && Math.min(...xs, ...ys) === 0,
      `${num(Math.max(...xs), 3)} × ${num(Math.max(...ys), 3)} mm`);
  }

  // ---- arcs bulge outward: rebuilt areas equal the cut paths'
  {
    let worst = 0, n = 0, open = 0;
    for (const shape of ['square', 'diamond']) {
      const ctx = { ...prepare(noiseRGBA(60, 60, 5, false), { ...plain, kerf, minHole: 0.6 }), shape, rounding: 0.6, range: 'squeeze', diffuse: true };
      const { sizes } = grid.run(ctx);
      const holes = gridHoles(ctx, sizes[0], grid.limits(ctx).spec);
      const d = readDXF(layerDXF(ctx, holes).text);
      const polys = d.polylines.filter((p) => p.layer === 'HOLES');
      holes.forEach((h, i) => {
        const e = Math.abs(Math.abs(bulgeArea(polys[i].v)) - areaOf(h)) / areaOf(h);
        worst = Math.max(worst, e); n++;
        if (!polys[i].closed) open++;
      });
    }
    // 0.1%: coordinates are written to 0.1 µm, which on ~1 mm holes is ~0.04% of
    // area; a reversed bulge would be ~20% off, so this still catches it 200 times over
    check('rounded squares and diamonds: corner arcs bulge outward (area from vertices + bulges = cut path area)',
      worst < 1e-3 && open === 0, `${n} holes, worst area error ${(100 * worst).toFixed(4)}%, ${open} open`);
  }

  // ---- no mirroring: an L keeps its foot at the bottom
  {
    // white L on black: upright bar on the left, foot along the bottom to the right
    const img = makeRGBA(200, 200, (x, y) => ((x >= 40 && x < 80 && y >= 30 && y < 170) || (x >= 40 && x < 170 && y >= 130 && y < 170) ? [255, 255, 255] : [0, 0, 0]));
    const b = stencil.build(img, { ...plain, widthMm: 40, kerf, web: 0.6, minHole: 0.6 }, { smooth: 0 });
    const d = readDXF(layerDXF({ ...b, kerf }, b.layers[0]).text);
    const L = d.polylines.filter((p) => p.layer === 'HOLES');
    const pts = L.flatMap((p) => p.v);
    const right = pts.filter((p) => p.x > 30);          // only the foot reaches this far right
    const H = b.heightMm + kerf;
    check('no mirroring: the L’s foot stays at the bottom (low y, since DXF’s y runs up)',
      // the foot is 26-34 mm down in the image: in DXF, 6-14 mm up; mirrored, 26-34 mm up
      L.length === 1 && L[0].closed && right.length > 0 && right.every((p) => p.y < H / 2),
      `${L.length} contour(s); foot vertices at y ${num(Math.min(...right.map((p) => p.y)), 2)}–${num(Math.max(...right.map((p) => p.y)), 2)} of ${num(H, 1)} mm`);
    const svgLike = b.layers[0][0];
    const worst = Math.max(...svgLike.xs.map((x, i) => Math.hypot(L[0].v[i].x - (x + kerf / 2), L[0].v[i].y - (H - svgLike.ys[i] - kerf / 2))));
    check('stencil outline: every vertex where the cut path is, flipped', worst < 1e-3, `worst ${worst.toExponential(1)} mm`);
  }

  // ---- names
  {
    const bw = { mode: 'bw', nCut: 1, colours: ['#2B2B2B'] };
    const col = { mode: 'color', nCut: 2, colours: ['#eae8e7', '#439dde', '#9d3400'] };
    const got = [sheetFileName('rhino', 0, bw, 'dxf', true), sheetFileName('rhino', 0, bw, 'svg'),
      ...[0, 1, 2].map((i) => sheetFileName('rhino', i, col, 'dxf', true)), sheetFileName('rhino', 2, col, 'svg')];
    const want = ['rhino-2b2b2b.dxf', 'rhino.svg', 'rhino-1-top-eae8e7.dxf', 'rhino-2-sheet2-439dde.dxf', 'rhino-3-base-9d3400.dxf', 'rhino-3-base.svg'];
    check('file names: DXF carries the sheet colour, SVG as before', got.join() === want.join(), got.join(', '));
  }
}
