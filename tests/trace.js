// The cut paths agree with the rasters they trace: every stencil and screen
// sheet's traced outlines, filled even-odd and grown by the kerf
// (render.rasterizeHoles), against the raster the method finished, at that
// raster's own pixel centers.
//
// This is the check that would have caught core/contour.js orienting segments
// by geometry: on a sheet whose signed distance hit the contour level exactly
// -- routine when kerf/2 is half a work pixel, as here (web 1 mm gives 5 px/mm,
// and kerf 0.2 mm puts the level at -0.5) -- loops broke and closed with
// chords across the sheet, and traced and raster disagreed by 1-30% on a busy
// image; the old code fails this test with thousands of pixels wrong. Away
// from the raster's edges every sheet must now agree exactly. Along them a
// pixel may differ: the outline is simplified, and its kerf offset is a miter.

import { check, section, num, makeRGBA, mkRand, plain } from './runner.js';
import stencil from '../src/methods/stencil.js';
import screen from '../src/methods/screen.js';
import { rasterizeHoles } from '../src/core/render.js';
import { edt } from '../src/core/edt.js';

const base = { ...plain, widthMm: 60, web: 1, minHole: 1, kerf: 0.2 };
const LIMIT = 0.02;          // of all pixels, edges included: a fine screen is mostly edge

/** A busy image: seeded soft blobs in each channel, 300×200 px (60×40 mm). */
function blobs(seed, color) {
  const rand = mkRand(seed);
  const sets = [0, 1, 2].map(() => Array.from({ length: 30 }, () => ({
    x: rand() * 300, y: rand() * 200, r: 6 + rand() * 30, a: rand() * 2 - 1,
  })));
  return makeRGBA(300, 200, (x, y) => {
    const ch = sets.map((set) => {
      let v = 0.5;
      for (const b of set) v += 0.6 * b.a * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.r * b.r));
      return Math.round(255 * Math.max(0, Math.min(1, v)));
    });
    return color ? ch : [ch[0], ch[0], ch[0]];
  });
}

/**
 * Where the traced cut and the raster disagree: pixels more than 2 px from any
 * edge of the raster (`far`, which only a wrong loop can cause), and the share
 * of all pixels (`share`, mostly edge pixels: the outline is simplified and its
 * kerf offset is a miter, so it can differ by a pixel along any edge).
 */
function disagreement(b, holes, C) {
  const { ww, wh, k } = b.debug, ky = wh / b.heightMm;
  const r = rasterizeHoles({ widthMm: b.widthMm, heightMm: b.heightMm, kerf: base.kerf }, [holes], { pxPerMm: k, superSample: 1 });
  const edge = new Uint8Array(ww * wh);
  for (let q = 0; q < ww * wh; q++) {
    const i = q % ww;
    if ((i + 1 < ww && C[q] !== C[q + 1]) || (q + ww < ww * wh && C[q] !== C[q + ww])) { edge[q] = 1; if (i + 1 < ww) edge[q + 1] = 1; if (q + ww < ww * wh) edge[q + ww] = 1; }
  }
  const dEdge = edt(edge, ww, wh);
  let bad = 0, far = 0;
  for (let j = 0; j < wh; j++) {
    const rj = Math.min(r.h - 1, Math.floor(((j + 0.5) / ky) * k));   // the traced raster's row at this pixel center
    for (let i = 0; i < ww; i++) {
      const q = j * ww + i;
      const cutT = r.counts[2 * (rj * r.w + Math.min(r.w - 1, i)) + 1] > 0;
      if (cutT === !!C[q]) continue;
      bad++;
      if (dEdge[q] > 2) far++;
    }
  }
  return { far, share: bad / (ww * wh) };
}

export function run() {
  section('trace', 'Every stencil and screen sheet’s traced cut agrees with the raster it traced, on busy images with the contour level exactly half a pixel.');

  const color = { ...base, mode: 'color', palette: ['#f2f2f2', '#c8102e', '#1a1a1a'], reg: 0.2 };
  const cases = [
    ['stencil, B&W, 3 brightness layers', () => stencil.build(blobs(3, false), base, { levels: 3 })],
    ['stencil, color, 2 brightness layers', () => stencil.build(blobs(5, true), color, { levels: 2 })],
    ['stencil, color, layers, bridges kept on the sheet below', () => stencil.build(blobs(5, true), color, { levels: 2, supported: true })],
    ['stencil, color, layers, floating parts', () => stencil.build(blobs(5, true), color, { levels: 2, floating: true })],
    ['screen, straight lines, color', () => screen.build(blobs(7, true), color, { screen: 'lines', period: 4 })],
    ['screen, Turing, B&W', () => screen.build(blobs(9, false), base, { screen: 'turing', period: 4 })],
  ];
  for (const [name, make] of cases) {
    const b = make();
    const sheets = b.layers.map((holes, j) => [`sheet ${j + 1}`, holes, b.debug.cuts[j]]);
    (b.levels || []).forEach((lv, i) => sheets.push([`layer ${lv.color + 1}.${lv.level}`, lv.holes, b.debug.levels.cuts[i]]));
    const d = sheets.map(([label, holes, C]) => ({ label, ...disagreement(b, holes, C) }));
    const far = d.reduce((a, s) => a + s.far, 0);
    const worst = d.reduce((a, s) => (s.share > a.share ? s : a));
    check(`${name}: every sheet’s cut path agrees with its raster, away from its edges`, far === 0 && worst.share <= LIMIT,
      `${d.length} sheets: ${far} px wrong more than 2 px from an edge; worst sheet ${num(100 * worst.share, 2)}% of pixels wrong (${worst.label})`);
  }
}
