// DXF writer for one sheet: AutoCAD R12 (AC1009), the version laser and CAM
// software imports most reliably.
//
// Same content as svg.js: every hole's cut path (already offset for the kerf)
// on layer HOLES (color 5, blue), the outline on layer OUTLINE (color 1, red),
// holes first, innermost first, so "cut blue before red" works the same way.
//
//   circles          CIRCLE entities -- the laser cuts them as true circles
//   rounded squares  closed POLYLINEs whose corner arcs are exact BULGES
//   diamonds         the same, turned 45°
//   polygons, loops  closed POLYLINEs
//
// TWO TRAPS, both covered by tests/core.dxf.js:
//   - DXF's y axis runs UP, the app's (and SVG's) runs down. Written as-is every
//     piece would come out mirrored -- a stencil's text backwards. So y becomes
//     height - y.
//   - Mirroring reverses every arc. The bulge sign is not written from a rule
//     about which way the path turns; it is computed from each arc's own start,
//     end and center AFTER the flip, so it cannot disagree with the geometry.
//
// UNITS. R12 has no units field; $INSUNITS (4 = mm) is from later versions and
// is written as a hint -- readers that do not know it skip it. Some software
// will still ask for the units on import: they are millimeters.

import { outline } from './cutpaths.js';
import { isCircle } from './holes.js';
import { rsqCorners } from './shapes.js';

const f = (v) => (isFinite(v) ? (Math.abs(v) < 5e-5 ? 0 : v).toFixed(4) : '0.0000');
const pair = (code, value) => `${code}\n${value}\n`;

/**
 * @param {{widthMm, heightMm, kerf}} piece
 * @param {Array} holes  this sheet's holes (core/holes.js); [] for the solid base
 * @returns {{text:string, holes:number}}
 */
export function layerDXF(piece, holes) {
  const ol = outline(piece);
  const o = -ol.x;                      // kerf/2: the outline's cut path starts at 0
  const Htot = ol.h;
  const X = (x) => x + o;
  const Y = (y) => Htot - (y + o);      // flip: DXF's y runs up

  let s = '';
  // ---- header: version, the units hint, the extents
  s += pair(0, 'SECTION') + pair(2, 'HEADER');
  s += pair(9, '$ACADVER') + pair(1, 'AC1009');
  s += pair(9, '$INSUNITS') + pair(70, 4);
  s += pair(9, '$MEASUREMENT') + pair(70, 1);
  s += pair(9, '$EXTMIN') + pair(10, f(0)) + pair(20, f(0));
  s += pair(9, '$EXTMAX') + pair(10, f(ol.w)) + pair(20, f(ol.h));
  s += pair(0, 'ENDSEC');
  // ---- tables: a continuous line type and the two layers
  s += pair(0, 'SECTION') + pair(2, 'TABLES');
  s += pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1);
  s += pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0) + pair(3, 'Solid line') +
    pair(72, 65) + pair(73, 0) + pair(40, f(0));
  s += pair(0, 'ENDTAB');
  s += pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, 2);
  s += pair(0, 'LAYER') + pair(2, 'HOLES') + pair(70, 0) + pair(62, 5) + pair(6, 'CONTINUOUS');
  s += pair(0, 'LAYER') + pair(2, 'OUTLINE') + pair(70, 0) + pair(62, 1) + pair(6, 'CONTINUOUS');
  s += pair(0, 'ENDTAB');
  s += pair(0, 'ENDSEC');
  // ---- entities
  s += pair(0, 'SECTION') + pair(2, 'ENTITIES');
  for (const h of holes) {
    if (isCircle(h)) {
      s += pair(0, 'CIRCLE') + pair(8, 'HOLES') + pair(10, f(X(h.cx))) + pair(20, f(Y(h.cy))) +
        pair(30, f(0)) + pair(40, f(h.a / 2));
    } else {
      s += polyline('HOLES', vertices(h).map((v) => ({ x: X(v.x), y: Y(v.y), c: v.c && { x: X(v.c.x), y: Y(v.c.y) } })));
    }
  }
  s += polyline('OUTLINE', [
    { x: 0, y: 0 }, { x: ol.w, y: 0 }, { x: ol.w, y: ol.h }, { x: 0, y: ol.h },
  ]);
  s += pair(0, 'ENDSEC') + pair(0, 'EOF');
  return { text: s, holes: holes.length };
}

/**
 * A closed R12 POLYLINE. A vertex with `c` (an arc center) starts an arc to the
 * next vertex: its bulge is tan(sweep / 4), positive when that arc runs
 * counter-clockwise -- decided by the arc's own geometry, in DXF coordinates.
 */
function polyline(layer, vs) {
  let s = pair(0, 'POLYLINE') + pair(8, layer) + pair(66, 1) + pair(70, 1) +
    pair(10, f(0)) + pair(20, f(0)) + pair(30, f(0));
  vs.forEach((v, i) => {
    s += pair(0, 'VERTEX') + pair(8, layer) + pair(10, f(v.x)) + pair(20, f(v.y)) + pair(30, f(0));
    if (v.c) {
      const w = vs[(i + 1) % vs.length];
      const ax = v.x - v.c.x, ay = v.y - v.c.y, bx = w.x - v.c.x, by = w.y - v.c.y;
      const sweep = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);   // signed, CCW positive
      s += pair(42, f(Math.tan(sweep / 4)));
    }
  });
  return s + pair(0, 'SEQEND') + pair(8, layer);
}

/**
 * A non-circular hole's cut path as vertices in piece coordinates (y down), each
 * optionally carrying the center of the arc that leaves it. A rounded square
 * runs the same way as svg.js draws it: along the top, then each corner's arc.
 */
function vertices(h) {
  if (h.kind !== 'rsq') return Array.from(h.xs, (x, i) => ({ x, y: h.ys[i] }));
  const half = h.a / 2, r = h.r;
  const c = h.rot ? Math.SQRT1_2 : 1, sn = h.rot ? Math.SQRT1_2 : 0;
  const P = (x, y) => ({ x: h.cx + c * x - sn * y, y: h.cy + sn * x + c * y });
  if (r <= 1e-9) return [P(-half, -half), P(half, -half), P(half, half), P(-half, half)];
  // straight edge start, straight edge end (+ arc round the corner center)
  return rsqCorners(h).map((p) => (p.cx !== undefined ? { ...P(p.x, p.y), c: P(p.cx, p.cy) } : P(p.x, p.y)));
}
