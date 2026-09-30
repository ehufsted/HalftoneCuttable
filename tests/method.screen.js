// Screen halftones.
//
// PREDICTIONS.
//  - A stripe screen is a triangle wave, so thresholding opens exactly the asked
//    fraction of every period: slot width = f·period, one slot per period.
//  - Overall tone on flat fields matches the target within the band where both
//    the slot and the metal between are cuttable.
//  - Ties cap how long any one slot runs; without them slots run the length of
//    the piece.
//  - Concentric rings are islands, so without ties they need bridges; with ties
//    they need none.
//  - Every screen gives one piece whose every connection is at least the web
//    wide (the stencil's shrink-then-flood-fill check).
//  - The Turing screen is equalised to uniform, so it too opens the asked
//    fraction overall.
//  - In colour, deeper sheets' slots sit inside the ones above.

import { check, section, num, flatGrey, makeRGBA, plain } from './runner.js';
import method from '../src/methods/screen.js';
import { pieceCount } from '../src/core/structure.js';
import { rasterizeHoles } from '../src/core/render.js';
import { edt, components } from '../src/core/edt.js';
import { toEncoded } from '../src/core/color.js';

const base = { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15 };
const PX = 20;

/** A flat grey whose squeezed target open fraction is f (for a stripe screen;
 * the Turing band is smaller, and each run is scored against its own target). */
function greyFor(f, period, web) {
  const fMax = 1 - web / period;
  const v = Math.round(255 * toEncoded(f / fMax));
  return flatGrey(150, 100, v);
}

const meanOf = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** A grey image from fn(x, y) -> brightness in [0, 1] (encoded). */
const makeImage2 = (w, h, fn) => makeRGBA(w, h, (x, y) => { const v = Math.round(255 * fn(x, y)); return [v, v, v]; });

/** Jaggedness (mm) and sharp tips per 100 mm of a sheet's cut paths. */
function roughness(loops) {
  const step = 0.05, win = Math.round(0.4 / step), off = Math.round(0.3 / step);
  let jag = 0, cnt = 0, tips = 0, len = 0;
  for (const L of loops) {
    const X = [], Y = [];
    let carry = 0;
    for (let i = 0, n = L.xs.length; i < n; i++) {
      const j = (i + 1) % n, dx = L.xs[j] - L.xs[i], dy = L.ys[j] - L.ys[i], d = Math.hypot(dx, dy);
      let t = carry;
      for (; t < d; t += step) { X.push(L.xs[i] + (dx * t) / d); Y.push(L.ys[i] + (dy * t) / d); }
      carry = t - d;
    }
    const n = X.length;
    if (n < 2 * win + 3) continue;
    len += n * step;
    let inTip = false;
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let q = -win; q <= win; q++) { sx += X[(i + q + n) % n]; sy += Y[(i + q + n) % n]; }
      jag += Math.hypot(X[i] - sx / (2 * win + 1), Y[i] - sy / (2 * win + 1)); cnt++;
      const a = (i - off + n) % n, c = (i + off) % n;
      const A = Math.hypot(X[i] - X[c], Y[i] - Y[c]), B = Math.hypot(X[a] - X[c], Y[a] - Y[c]), C = Math.hypot(X[a] - X[i], Y[a] - Y[i]);
      const area2 = Math.abs((X[i] - X[a]) * (Y[c] - Y[a]) - (X[c] - X[a]) * (Y[i] - Y[a]));
      const sharp = area2 > 1e-12 && (A * B * C) / (2 * area2) < 0.3;
      if (sharp && !inTip) tips++;
      inTip = sharp;
    }
  }
  return { jag: jag / cnt, tips: (100 * tips) / len };
}

function thickPieces(b, holes, kerf, web) {
  const r = rasterizeHoles({ widthMm: b.widthMm, heightMm: b.heightMm, kerf }, [holes], { pxPerMm: PX, superSample: 1 });
  const M = new Uint8Array(r.w * r.h), C = new Uint8Array(r.w * r.h);
  for (let i = 0; i < M.length; i++) { M[i] = r.counts[2 * i] ? 1 : 0; C[i] = 1 - M[i]; }
  const d = edt(C, r.w, r.h);
  const core = new Uint8Array(M.length);
  const rr = (web / 2) * PX - 1.5;
  for (let i = 0; i < M.length; i++) core[i] = M[i] && d[i] > rr ? 1 : 0;
  return components(core, r.w, r.h).sizes.length;
}

export function run() {
  section('method.screen', 'Stripe geometry, tone, ties, bridges, one piece for every screen, Turing uniformity, colour nesting.');

  // ---- stripe geometry: vertical stripes (angle 0), no ties
  {
    const f = 0.5, period = 3;
    const b = method.build(greyFor(f, period, base.web), base, { screen: 'lines', angle: 0, period, ties: 0 });
    const { cuts, k, ww, wh } = b.debug;
    const row = Math.floor(wh / 2), C = cuts[0];
    const runs = [];
    let start = -1;
    for (let i = 0; i < ww; i++) {
      const c = C[row * ww + i];
      if (c && start < 0) start = i;
      if (!c && start >= 0) { runs.push([start, i]); start = -1; }
    }
    const widths = runs.map(([a, z]) => (z - a) / k);
    const centres = runs.map(([a, z]) => (a + z) / 2 / k);
    const gaps = centres.slice(1).map((c, i) => c - centres[i]);
    const target = f * period;
    check('lines: every slot is f × period wide', widths.every((w) => Math.abs(w - target) <= 1.5 / k),
      `${runs.length} slots, widths ${num(Math.min(...widths), 3)}–${num(Math.max(...widths), 3)} mm, want ${num(target, 3)}`);
    check('lines: one slot per period', gaps.every((g) => Math.abs(g - period) <= 1.5 / k),
      `spacing ${num(Math.min(...gaps), 3)}–${num(Math.max(...gaps), 3)} mm`);
  }

  // ---- overall tone on flat fields
  {
    const rows = [];
    let worst = 0;
    // Rings are tied, as they would be used: untied, every ring is an island held
    // by two bridges, which are metal the tone cannot have -- 2 × 1.2 mm of a
    // ring's slot, 4% at 10 mm radius and 18% within 8 mm of the centre (measured).
    // Ties are paid back in the slot width; bridges are not.
    for (const screen of ['lines', 'concentric', 'turing']) {
      for (const f of [0.3, 0.5, 0.7]) {
        const b = method.build(greyFor(f, 3, base.web), base, { screen, period: 3, ties: screen === 'concentric' ? 15 : 0 });
        const t = meanOf(Array.from(b.target)), g = meanOf(Array.from(b.achieved));
        worst = Math.max(worst, Math.abs(g - t) / t);
        rows.push(`${screen} ${f}: ${num(g, 3)}/${num(t, 3)}`);
      }
    }
    // with ties on, and waves (whose band is set by their tightest spacing)
    for (const [name, prm] of [['lines+ties', { screen: 'lines', ties: 15 }], ['waves+ties', { screen: 'waves', ties: 15 }]]) {
      const b = method.build(greyFor(0.5, 3, base.web), base, { period: 3, ...prm });
      const t = meanOf(Array.from(b.target)), g = meanOf(Array.from(b.achieved));
      worst = Math.max(worst, Math.abs(g - t) / t);
      rows.push(`${name}: ${num(g, 3)}/${num(t, 3)}`);
    }
    check('flat fields: open fraction within 4% of the target, every screen, ties included', worst < 0.04,
      `achieved/target — ${rows.join(', ')}`);
  }

  // ---- ties
  {
    const img = greyFor(0.6, 3, base.web);
    const longest = (b) => Math.max(...b.layers[0].map((L) => Math.max(...L.ys) - Math.min(...L.ys)));
    const tied = method.build(img, base, { screen: 'lines', angle: 0, period: 3, ties: 10 });
    const loose = method.build(img, base, { screen: 'lines', angle: 0, period: 3, ties: 0 });
    check('ties: no slot runs longer than the tie spacing', longest(tied) <= 10 + 0.1 && longest(loose) > 30,
      `longest slot ${num(longest(tied), 2)} mm with 10 mm ties, ${num(longest(loose), 2)} mm without`);
  }

  // ---- rings are islands: bridged without ties, held by the ties with them
  {
    const img = greyFor(0.5, 3, base.web);
    const bare = method.build(img, base, { screen: 'concentric', period: 3, ties: 0 });
    const tied = method.build(img, base, { screen: 'concentric', period: 3, ties: 12 });
    const pb = pieceCount({ ...bare, kerf: base.kerf }, bare.layers[0], PX);
    const pt = pieceCount({ ...tied, kerf: base.kerf }, tied.layers[0], PX);
    check('rings: without ties the bridges hold every ring; with ties no bridges are needed',
      pb === 1 && pt === 1 && bare.debug.bridges.length > 0 && tied.debug.bridges.length === 0 && bare.debug.unresolved === 0,
      `${bare.debug.bridges.length} bridges without ties, ${tied.debug.bridges.length} with; ${pb} and ${pt} piece(s)`);
  }

  // ---- every screen: one piece, every connection at least the web wide. On a
  // ramp and on a busy image: the ramp alone never produced the single-pixel
  // metal flecks a Turing screen left on a photo (web read 0 mm in the app).
  {
    const ramp = makeRGBA(300, 200, (x) => { const v = Math.round(60 + 190 * x / 299); return [v, v, v]; });
    const busy = makeRGBA(300, 200, (x, y) => {
      const v = Math.round(150 + 90 * Math.sin(x / 9) * Math.cos(y / 13) + 30 * Math.sin((x + y) / 4));
      return [v, v, v];
    });
    const bad = [];
    let runs = 0;
    for (const [name, img] of [['ramp', ramp], ['busy', busy]]) {
      for (const screen of ['lines', 'waves', 'concentric', 'spiral', 'turing']) {
        const b = method.build(img, base, { screen, period: 3 });
        const holes = b.layers[0];
        const pieces = pieceCount({ ...b, kerf: base.kerf }, holes, PX);
        const thick = thickPieces(b, holes, base.kerf, base.web);
        runs++;
        if (pieces !== 1 || thick !== 1 || b.debug.unresolved || b.webs[0] < base.web) {
          bad.push(`${name} ${screen}: ${pieces} piece(s), ${thick} shrunk, ${b.debug.unresolved} unresolved, web ${num(b.webs[0], 2)}`);
        }
      }
    }
    check('every screen is one piece, still one when shrunk by just under web/2, web as set', bad.length === 0,
      bad.join('; ') || `${runs} runs: lines, waves, concentric, spiral, turing on a ramp and a busy image`);
  }

  // ---- Turing edges are smooth: measured on the cut paths, resampled to 0.05 mm.
  // Jaggedness is the mean distance of the outline from its own ±0.4 mm running
  // average; a sharp tip is a stretch tighter than a 0.3 mm radius. The field-
  // ranked screen traced from a stepped distance field measured 25 µm and 9.9 tips
  // per 100 mm on the rhino; the signed-distance screen with a smoothed trace
  // measured 18.5 µm and 4.2.
  {
    const b = method.build(greyFor(0.5, 3, base.web), base, { screen: 'turing', period: 3 });
    const { jag, tips } = roughness(b.layers[0]);
    check('turing: edges are smooth (no pixel staircase, few sharp tips)', jag < 0.022 && tips < 6,
      `jaggedness ${num(jag * 1000, 1)} µm, ${num(tips, 2)} sharp tips per 100 mm`);
  }

  // ---- anisotropic Turing
  // Alignment score: over a region, the cut pattern's own local direction (its
  // gradient, turned 90°) against a reference direction, as the gradient-energy-
  // weighted mean of cos 2Δ -- doubled angles, since a worm has no front or back.
  // +1 = worms all along the reference, -1 = all across it, 0 = no preference.
  {
    const align = (b, refAt, inRegion) => {
      const { cuts, ww, wh, k } = b.debug;
      const C = cuts[0];
      let num = 0, den = 0;
      for (let y = 1; y < wh - 1; y++) {
        for (let x = 1; x < ww - 1; x++) {
          const xm = (x + 0.5) / k, ym = (y + 0.5) / k;
          if (!inRegion(xm, ym)) continue;
          const i = y * ww + x;
          const gx = C[i + 1] - C[i - 1], gy = C[i + ww] - C[i - ww];
          const e = gx * gx + gy * gy;
          if (!e) continue;
          const worm = Math.atan2(gy, gx) + Math.PI / 2;
          num += e * Math.cos(2 * (worm - refAt(xm, ym)));
          den += e;
        }
      }
      return den ? num / den : 0;
    };
    // radial ramp: bright at the centre, dark outside -- edges are circles
    const radial = makeImage2(300, 300, (x, y) => Math.max(0, 1 - Math.hypot(x - 150, y - 150) / 150));
    const s = { ...base, widthMm: 60 };
    const tangent = (x, y) => Math.atan2(y - 30, x - 30) + Math.PI / 2;
    const annulus = (x, y) => { const r = Math.hypot(x - 30, y - 30); return r > 6 && r < 24; };
    const t0 = Date.now();
    const edges = method.build(radial, s, { screen: 'turing', period: 3, anisotropy: 2, flow: 'edges' });
    const ms = Date.now() - t0;
    const grad = method.build(radial, s, { screen: 'turing', period: 3, anisotropy: 2, flow: 'gradient' });
    const round = method.build(radial, s, { screen: 'turing', period: 3 });
    const aE = align(edges, tangent, annulus), aG = align(grad, tangent, annulus), a0 = align(round, tangent, annulus);
    check('anisotropy: worms run along the edges, or along the gradient, as asked',
      aE > 0.3 && aG < -0.3 && Math.abs(a0) < 0.1,
      `alignment with the edges: ${num(aE, 2)} along edges, ${num(aG, 2)} along gradient, ${num(a0, 2)} at anisotropy 0 (${ms} ms for the anisotropic run)`);

    const flat = greyFor(0.5, 3, base.web);
    const fb = method.build(flat, base, { screen: 'turing', period: 3, anisotropy: 2 });
    const everywhere = () => true;
    const ax = align(fb, () => 0, everywhere), ad = align(fb, () => Math.PI / 4, everywhere);
    check('anisotropy: where the image is flat the maze stays round',
      Math.hypot(ax, ad) < 0.1, `alignment ${num(ax, 3)} with x, ${num(ad, 3)} with the diagonal`);

    const key = (b) => b.layers[0].slice(0, 30).map((L) => L.xs[0].toFixed(6)).join(',');
    const d0 = method.build(flat, base, { screen: 'turing', period: 3 });
    const d1 = method.build(flat, base, { screen: 'turing', period: 3, anisotropy: 0, flow: 'gradient' });
    check('anisotropy 0 is the round labyrinth, whatever the direction setting', key(d0) === key(d1));

    const t = meanOf(Array.from(fb.target)), g = meanOf(Array.from(fb.achieved));
    const pieces = pieceCount({ ...edges, kerf: base.kerf }, edges.layers[0], PX);
    const thick = thickPieces(edges, edges.layers[0], base.kerf, base.web);
    check('anisotropy: tone and structure hold', Math.abs(g - t) / t < 0.04 && pieces === 1 && thick === 1 && edges.webs[0] >= base.web,
      `flat field ${num(g, 3)}/${num(t, 3)}; radial: ${pieces} piece(s), ${thick} shrunk, web ${num(edges.webs[0], 2)}`);
  }

  // ---- the Turing screen is uniform, and seeded
  {
    const a = method.build(greyFor(0.5, 3, base.web), base, { screen: 'turing', period: 3, seed: 2 });
    const sc = a.debug.screen;
    let below = 0;
    for (let i = 0; i < sc.length; i++) if (sc[i] < 0.5) below++;
    check('turing: the equalised screen is uniform (half of it below 0.5)', Math.abs(below / sc.length - 0.5) < 0.01,
      `${num(100 * below / sc.length, 2)}% below 0.5`);
    const c = method.build(greyFor(0.5, 3, base.web), base, { screen: 'turing', period: 3, seed: 2 });
    const d = method.build(greyFor(0.5, 3, base.web), base, { screen: 'turing', period: 3, seed: 3 });
    const key = (b) => b.layers[0].slice(0, 20).map((L) => L.xs[0].toFixed(5)).join(',');
    check('turing: same seed, same pattern; another seed, another', key(a) === key(c) && key(a) !== key(d));
  }

  // ---- colour: deeper slots inside the ones above
  {
    const s = { ...base, mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0.3 };
    const b = method.build(makeRGBA(150, 100, () => [120, 60, 150]), s, { screen: 'lines', period: 4, ties: 15 });
    const [C0, C1] = b.debug.cuts;
    let deep = 0, outside = 0;
    for (let i = 0; i < C1.length; i++) if (C1[i]) { deep++; if (!C0[i]) outside++; }
    const pieces = b.layers.map((L) => pieceCount({ ...b, kerf: s.kerf }, L, PX));
    check('colour: the deeper sheet’s slots lie inside the top sheet’s', deep > 0 && outside / deep < 0.01,
      `${num(100 * outside / Math.max(1, deep), 2)}% of its cut outside, ${deep} px cut`);
    check('colour: every sheet is one piece', pieces.every((p) => p === 1), pieces.join(', '));
  }
}
