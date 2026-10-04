// core/holes.js: alignmentHoles, the four fixed corner holes cut into every
// exported sheet alike; dropBorder, the blank margin that excludes them.

import { check, section } from './runner.js';
import { alignmentHoles, dropBorder, dropNearAlignment, isCircle } from '../src/core/holes.js';

export function run() {
  section('core.holes', 'alignmentHoles: four circles, one per corner, clamped to stay on the piece. dropBorder: only holes wholly outside the border survive.');

  {
    const hs = alignmentHoles(100, 60, 8, 3);
    check('four holes, all circles', hs.length === 4 && hs.every(isCircle),
      `${hs.length} holes`);
    check('diameter matches the setting', hs.every((h) => Math.abs(h.a - 3) < 1e-9));
    const xs = hs.map((h) => h.cx).sort((a, b) => a - b);
    const ys = hs.map((h) => h.cy).sort((a, b) => a - b);
    check('centers sit `dist` in from each edge', Math.abs(xs[0] - 8) < 1e-9 && Math.abs(xs[3] - 92) < 1e-9 &&
      Math.abs(ys[0] - 8) < 1e-9 && Math.abs(ys[3] - 52) < 1e-9,
      `x ${xs.map((v) => v.toFixed(1))}, y ${ys.map((v) => v.toFixed(1))}`);
  }

  {
    // A distance that would push the holes past the piece's center is clamped
    // back so they stay on the piece and never cross, whatever the piece size.
    const hs = alignmentHoles(20, 20, 100, 4);
    const xs = hs.map((h) => h.cx);
    check('an oversized distance is clamped to the piece', xs.every((x) => x >= 2 - 1e-9 && x <= 18 + 1e-9),
      `cx ${xs.map((v) => v.toFixed(1))}`);
  }

  {
    check('zero diameter gives no holes', alignmentHoles(100, 60, 8, 0).length === 0);
  }

  {
    // The diameter is the finished hole's; the cut path is a kerf smaller. A
    // distance that would leave less than a web to the outline is pushed in.
    const hs = alignmentHoles(100, 60, 1, 3, 0.6, 0.2);
    const gap = Math.min(...hs.map((h) => Math.min(h.cx, h.cy, 100 - h.cx, 60 - h.cy) - (h.a / 2 + 0.1)));
    check('the cut path is a kerf smaller than the finished diameter', hs.every((h) => Math.abs(h.a - 2.8) < 1e-9));
    check('a distance too close to the edge is pushed in to leave a web', Math.abs(gap - 0.6) < 1e-9, `${gap.toFixed(3)} mm to the outline`);
    check('a piece too small for a hole and a web each side gets none', alignmentHoles(4, 4, 2, 3, 0.6, 0).length === 0);
  }

  {
    // Pattern holes within a web of an alignment hole are dropped; loops are
    // left to their method's raster.
    const [al] = alignmentHoles(60, 60, 8, 3, 0.5, 0);          // at (8, 8), finished radius 1.5
    const near = { kind: 'rsq', cx: 11, cy: 8, a: 2, r: 1, rot: false };      // 0.5 mm apart, edge to edge: kept
    const close = { kind: 'rsq', cx: 10.9, cy: 8, a: 2, r: 1, rot: false };   // 0.4 mm: dropped
    const over = { kind: 'poly', xs: [7, 9, 9, 7], ys: [7, 7, 9, 9] };      // around the center: dropped
    const polyFar = { kind: 'poly', xs: [10, 12, 12, 10], ys: [7, 7, 9, 9] }; // 0.5 mm: kept
    const loop = { kind: 'loop', xs: [7, 9, 9], ys: [7, 7, 9], sign: 1 };
    const kept = dropNearAlignment([near, close, over, polyFar, loop], [al], 0.5, 0);
    check('dropNearAlignment: holes closer than a web go, the rest and loops stay',
      kept.length === 3 && kept.includes(near) && kept.includes(polyFar) && kept.includes(loop),
      `${kept.length} kept`);
    check('dropNearAlignment counts the kerf growth of both holes',
      dropNearAlignment([near], [alignmentHoles(60, 60, 8, 3, 0.5, 0.2)[0]], 0.5, 0.1).length === 0);
  }

  {
    // Three circles across a 100mm piece: fully inside, straddling a 10mm
    // border, and fully inside the border. A border of 0 is a no-op.
    const holes = [
      { kind: 'rsq', cx: 50, cy: 50, a: 6, r: 3, rot: 0 },   // center: well clear
      { kind: 'rsq', cx: 12, cy: 50, a: 6, r: 3, rot: 0 },   // finished edge at x=9: straddles the 10mm border
      { kind: 'rsq', cx: 5, cy: 5, a: 2, r: 1, rot: 0 },     // deep in the corner border
    ];
    check('border 0 changes nothing', dropBorder(holes, 100, 100, 0, 0).length === 3);
    const kept = dropBorder(holes, 100, 100, 10, 0);
    check('only the hole wholly clear of the border survives', kept.length === 1 && kept[0].cx === 50,
      `${kept.length} kept`);
  }

  {
    // The kerf growth `d` counts too: a hole that just clears the border on its
    // nominal path can still reach into it once the beam's own radius is added.
    const h = { kind: 'rsq', cx: 15, cy: 50, a: 8, r: 4, rot: 0 };   // finished edge at x=11 nominally
    check('kept with no kerf growth', dropBorder([h], 100, 100, 10, 0).length === 1);
    check('dropped once kerf growth reaches the border', dropBorder([h], 100, 100, 10, 1.5).length === 0);
  }
}
