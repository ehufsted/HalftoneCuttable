// core/holes.js: alignmentHoles, the four fixed corner holes cut into every
// exported sheet alike; dropBorder, the blank margin that excludes them.

import { check, section } from './runner.js';
import { alignmentHoles, dropBorder, isCircle } from '../src/core/holes.js';

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
