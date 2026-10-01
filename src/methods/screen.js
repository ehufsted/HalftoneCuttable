// Screen halftones: the image compared against a repeating pattern -- the
// SCREEN -- and cut wherever the image asks for more open area than the screen
// allows there. The classic engraved and printed looks, as cut metal:
//
//   lines        straight stripes that swell in the lights (banknote engraving)
//   waves        the same, rippled
//   concentric   rings round a center
//   spiral       one slot winding out from a center
//   flowLic      stripes bent along the image's own structure -- Line Integral
//                Convolution + an oriented band-pass, iterated from noise
//                (core/lic.js), read only LOCALLY (each pixel's own short
//                streamline), so it tolerates a direction field that winds
//                around a point
//   turing       a reaction-diffusion labyrinth: spots in the darks, maze in
//                the mids, a metal lace in the lights
//
// TONE. A stripe screen is a triangle wave s = |2·frac(phase) - 1|, which is
// uniformly distributed across each period, so "cut where f > s" opens exactly a
// fraction f of every period. The Turing screen is histogram-equalized to the
// same uniform distribution, so the same rule holds on average. The target f is
// the image squeezed into [0, 1 - web/period]: a stripe of metal narrower than
// the web cannot survive, so that is as open as a screen can go.
//
// CUTTABLE. Everything after the threshold is the stencil's pipeline
// (core/cutsheet.js): slots too narrow to cut are filled, metal too thin is
// thickened, loose metal is bridged, and the outlines are traced with the kerf
// offset. Two things are particular to screens:
//   - TIES. A long slot leaves a long strip of metal either side, attached only
//     at its ends: one piece, but springy, and it warps in the heat. Ties are
//     bars of metal across the slots every `ties` mm, staggered between
//     neighboring slots like brickwork. Concentric rings need them to stay in at
//     all; the bridge pass then catches anything they miss.
//   - COLOR. Every sheet uses the SAME screen, thresholded at its own cumulative
//     open fraction (as the square grid's mixed color), so deeper sheets' slots
//     sit inside the ones above; each is then narrowed by the registration
//     allowance per sheet.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize, makeImage } from '../shim/image.js';
import { mulberry32 } from '../shim/random.js';
import { luminance, toEncoded } from '../core/color.js';
import { orientationField, steerBlur, resampleField } from '../core/steer.js';
import { solveMix, fitMix, cumulativeOpen, mixColor } from '../core/separate.js';
import { blur } from '../core/features.js';
import { erode, edt, invert } from '../core/edt.js';
import { sheetTools, scoreWindows, workRaster, borderFrame } from '../core/cutsheet.js';
import { buildLicRows, buildBandpassRows, applyRows, localNormalize, quadraturePhase } from '../core/lic.js';

export const id = 'screen';
export const label = 'Screen';
export const blurb = 'The image thresholded against a repeating screen -- lines, waves, rings, a spiral, image-aligned flow lines, or a Turing labyrinth -- then cleaned, tied and bridged like a stencil.';

const stripes = (p) => p.screen !== 'turing' && p.screen !== 'flowLic';
const centered = (p) => p.screen === 'concentric' || p.screen === 'spiral';

export const params = [
  { key: 'screen', label: 'Screen', type: 'select', def: 'lines',
    options: [['lines', 'Straight lines'], ['waves', 'Wavy lines'], ['concentric', 'Concentric rings'],
      ['spiral', 'Spiral'], ['flowLic', 'Flow lines'], ['turing', 'Turing pattern']] },
  // For flow lines this is the wavelength in the DARKS; Line contrast narrows
  // it from there, toward the lights (narrowing in the darks would fight the
  // area law instead of reading with it -- see where it's used).
  { key: 'period', label: 'Period', type: 'range', min: 1, max: 15, step: 0.1, def: 6, unit: 'mm', dp: 1 },
  { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 180, step: 1, def: 45, unit: '°',
    when: (p) => p.screen === 'lines' || p.screen === 'waves' },
  { key: 'amplitude', label: 'Wave height', type: 'range', min: 0, max: 10, step: 0.1, def: 2, unit: 'mm', dp: 1,
    when: (p) => p.screen === 'waves' },
  { key: 'wavelength', label: 'Wave length', type: 'range', min: 2, max: 60, step: 1, def: 15, unit: 'mm',
    when: (p) => p.screen === 'waves' },
  { key: 'lineContrast', label: 'Line contrast', type: 'range', min: 0, max: 3, step: 0.1, def: 1, dp: 1,
    when: (p) => p.screen === 'flowLic' },
  { key: 'licIterations', label: 'Iterations', type: 'range', min: 2, max: 16, step: 1, def: 8,
    when: (p) => p.screen === 'flowLic' },
  { key: 'cx', label: 'Center across', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, when: centered },
  { key: 'cy', label: 'Center down', type: 'range', min: 0, max: 1, step: 0.01, def: 0.5, when: centered },
  { key: 'ties', label: 'Tie spacing', type: 'range', min: 0, max: 60, step: 1, def: 20, unit: 'mm', when: stripes },
  { key: 'bridgeWidth', label: 'Tie width', type: 'range', min: 0.3, max: 5, step: 0.1, def: 1.2, unit: 'mm', dp: 1 },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']] },
  { key: 'anisotropy', label: 'Anisotropy', type: 'range', min: 0, max: 3, step: 0.1, def: 0, dp: 1,
    when: (p) => p.screen === 'turing' },
  { key: 'flow', label: 'Worms run', type: 'select', def: 'edges',
    options: [['edges', 'Along the edges'], ['gradient', 'Along the gradient']],
    when: (p) => p.screen === 'flowLic' || (p.screen === 'turing' && p.anisotropy > 0) },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1,
    when: (p) => p.screen === 'turing' || p.screen === 'flowLic' },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
const WORK_PIXELS = 2.5e6;
const tri = (phase) => Math.abs(2 * (phase - Math.floor(phase)) - 1);
const frac = (v) => v - Math.floor(v);
const GOLDEN = 0.6180339887498949;   // (sqrt(5) - 1) / 2, the golden ratio's conjugate

export function build(rgba, settings, params = {}) {
  const P = { ...DEF, ...params };
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } = prepareRaster(rgba, settings);
  const p = P.period;
  // Stripes can open up to 1 - web/period: the strip of metal between two slots
  // is then exactly one web. The Turing lace gets close to that too, but not all
  // the way -- near the top its metal is everywhere close to the web and the
  // cleanup takes some back. Measured with the signed-distance screen, one
  // correction at full gain: band 1.0 gave -1.4/-1.1/-3.0% at 0.3/0.5/0.7 of the
  // stripe band, 0.9 gave -1.2/-0.9/-1.9%, 0.8 gave -0.4/-1.6/-1.5%. 0.9 keeps
  // every level within 2%. (With the old field-ranked screen the lace was ragged,
  // 0.875 of the band was unreachable, and this had to be 0.8.)
  const TURING_BAND = 0.9;
  // The Turing feedback applies GAIN of the measured shortfall. With the old
  // field-ranked screen the full amount overshot the lows (raising the target
  // merged ragged spots) and 0.75 was needed; the signed-distance screen grows
  // every shape evenly, and at band 0.9 the full amount measured -1.2/-0.9/-1.9%
  // against 0.9's -2.4/-1.2/-2.0%.
  const GAIN = 1.0;
  // A wave compresses the stripes where it slopes: their spacing across drops to
  // p / sqrt(1 + (2πA/λ)²) (0.77 of the period at the defaults), and the band must
  // leave a web THERE -- sized on the nominal period, wavy lines lost a fifth of
  // their open area to the thickening.
  const slope = P.screen === 'waves' ? (2 * Math.PI * P.amplitude) / P.wavelength : 0;
  const pTight = p / Math.sqrt(1 + slope * slope);
  const fMax = Math.max(0, 1 - web / pTight) * (P.screen === 'turing' ? TURING_BAND : 1);

  // ---- work raster (as the stencil's: about five pixels across the web)
  const { ww, wh, k, ky, NP, px } = workRaster(W, H, web, WORK_PIXELS);
  const planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  const src = new Float32Array(NP * D);
  for (let q = 0; q < NP; q++) {
    const r = planes[0].data[q], g = planes[1].data[q], b = planes[2].data[q];
    if (bw) src[q] = Math.max(0, Math.min(1, luminance(r, g, b)));
    else { src[3 * q] = r; src[3 * q + 1] = g; src[3 * q + 2] = b; }
  }

  // ---- each sheet's open fraction, per pixel: the fitted mix, on a coarser
  // raster (the mix solve is the costly part) and interpolated up. Flow lines
  // (LIC) builds two operators whose row COUNT is quadratic-ish in this grid's
  // pixel count (each pixel's own streamline and band-pass window, both
  // several samples long) and cost dominates for a piece of any real size, so
  // it gets a tighter cap than the plain color-mix solve needs.
  const cpx = Math.min(px, P.screen === 'flowLic' ? 1.5 : 3);
  const cw = Math.max(4, Math.round(W * cpx)), ch = Math.max(4, Math.round(H * cpx));
  const coarse = planes.map((pl) => resize(pl, cw, ch));
  // Both flow-line screens' own wavelength, per coarse pixel: P.period in the darks,
  // narrowing toward the lights. Narrower in the DARKS would fight the area
  // law instead of reading with it -- open = light here (as every screen),
  // so a dark target already asks for close to no open area, and dividing an
  // already-tiny opening into even more, even-tinier slices only pushes each
  // one further below the structural floor for nothing: the achieved tone
  // does not change (the law conserves it regardless of how the period is
  // sliced), and `cleanSheet` quietly erases most of what was drawn there.
  // The lights have the opposite problem -- plenty of room, one wide slot per
  // period reads as a single bold highlight -- so that is where narrowing
  // usefully adds texture instead of erasing it.
  //
  // Computed here, before the duty fit below, so duty can be capped by THIS
  // pixel's own fMax rather than the nominal one -- the metal-stays-at-least-
  // web argument (fMax = 1 - web/L) only holds for the wavelength actually
  // painted there.
  const flowLmm = P.screen === 'flowLic' ? new Float64Array(cw * ch) : null;
  if (flowLmm) {
    for (let q = 0; q < cw * ch; q++) {
      const light = Math.max(0, Math.min(1, luminance(coarse[0].data[q], coarse[1].data[q], coarse[2].data[q])));
      flowLmm[q] = p / (1 + P.lineContrast * light);
    }
  }
  const Fc = Array.from({ length: nCut }, () => makeImage(cw, ch));
  const tgtC = Array.from({ length: D }, () => makeImage(cw, ch));
  {
    const x = new Float64Array(D), m = new Float64Array(n), F = new Float64Array(nCut), col = new Float64Array(D);
    for (let q = 0; q < cw * ch; q++) {
      const r = coarse[0].data[q], g = coarse[1].data[q], b = coarse[2].data[q];
      if (bw) x[0] = Math.max(0, Math.min(1, luminance(r, g, b)));
      else { x[0] = r; x[1] = g; x[2] = b; }
      solveMix(x, palette, m);
      const localMax = flowLmm ? Math.max(0, 1 - web / flowLmm[q]) : fMax;
      fitMix(m, localMax, P.range);
      cumulativeOpen(m, F);
      mixColor(m, palette, col);
      for (let j = 0; j < nCut; j++) Fc[j].data[q] = F[j];
      for (let d = 0; d < D; d++) tgtC[d].data[q] = col[d];
    }
  }
  // Ties close bwTie of every L mm of slot, so widen the slots to pay it back,
  // within the band (ties are metal on purpose; the tone should not pay for them).
  const tieCost = stripes(P) && P.ties > 0 ? Math.min(0.5, Math.max(P.bridgeWidth, web) / P.ties) : 0;
  const Fs = Fc.map((im) => {
    const f = resize(im, ww, wh).data;
    if (tieCost) for (let q = 0; q < f.length; q++) f[q] = Math.min(fMax, f[q] / (1 - tieCost));
    return f;
  });
  const tgt = tgtC.map((im) => resize(im, ww, wh).data);

  // ---- the screen, and the ties across its slots
  const cxm = P.cx * W, cym = P.cy * H;
  const th = (P.angle * Math.PI) / 180, ca = Math.cos(th), sa = Math.sin(th);
  const L = P.ties, bwTie = Math.max(P.bridgeWidth, web);
  const screen = new Float32Array(NP), tie = new Uint8Array(NP);
  let orient = null;       // the Turing/flow screens' direction field, when anisotropic
  let flowPhase = null;    // flow lines' phase, precomputed once over the whole raster
  if (P.screen === 'flowLic') flowPhase = flowLicPhaseField();
  if (P.screen === 'turing') {
    turingScreen(screen);
  } else {
    for (let q = 0; q < NP; q++) {
      const i = q % ww, j = (q - i) / ww;
      const x = (i + 0.5) / k, y = (j + 0.5) / ky;
      let phase, along, ring = 0;
      if (P.screen === 'flowLic') {
        phase = flowPhase[q];
      } else if (P.screen === 'lines' || P.screen === 'waves') {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        phase = (P.screen === 'waves' ? u + P.amplitude * Math.sin((2 * Math.PI * v) / P.wavelength) : u) / p;
        along = v;
      } else {
        const dx = x - cxm, dy = y - cym, r = Math.hypot(dx, dy), t = Math.atan2(dy, dx) / (2 * Math.PI);
        phase = P.screen === 'spiral' ? r / p - t : r / p;
        // this slot's mid radius (a spiral's grows with the angle)
        ring = Math.max(0.5, Math.floor(phase) + 0.5 + (P.screen === 'spiral' ? t : 0)) * p;
        along = (t + 0.5) * 2 * Math.PI * ring;                  // arc length round it
      }
      screen[q] = tri(phase);
      // Flow lines have no simple global "along the stripe" coordinate to stagger
      // a regular tie pattern on (the whole point is that it isn't one fixed
      // direction) -- like the Turing screen, it relies on bridgeSheet alone.
      if (L > 0 && P.screen !== 'flowLic') {
        // stagger the ties slot to slot; round a ring, fit a whole number of them.
        // Concentric rings stagger by the golden angle instead of alternating
        // 0/0.5: alternation lines every OTHER ring's ties up radially (ring 0,
        // 2, 4, ... all land at the same stagger), the golden ratio's conjugate
        // is the standard low-discrepancy step for exactly this -- irrational, so
        // no run of rings ever repeats a prior ring's offset and ties stay
        // minimally aligned radially, ring to ring, all the way out.
        const slot = Math.floor(phase);         // a slot spans one period, centered on +0.5
        const stagger = P.screen === 'concentric' ? frac(slot * GOLDEN) : (slot & 1) * 0.5;
        let spacing = L;
        if (ring) spacing = (2 * Math.PI * ring) / Math.max(3, Math.round((2 * Math.PI * ring) / L));
        if (frac(along / spacing + stagger) * spacing < bwTie) tie[q] = 1;
      }
    }
  }

  // ---- border metal, then each sheet through the stencil's pipeline. The
  // blank border, if any, is folded into the rim here rather than dropped from
  // the traced loops afterward -- see stencil.js's build() for why.
  const e = web + kerf / 2 + (s.border || 0);
  const frame = borderFrame(ww, wh, k, ky, W, H, e);
  const debug = { k, ww, wh, bridges: [], fallback: 0, unresolved: 0, specks: 0, floating: 0 };
  const { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet } = sheetTools({
    ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth: P.bridgeWidth, bridgeStyle: 'auto',
  });
  /** Threshold one sheet's open fraction against the screen, then make it cuttable. */
  const cutSheet = (F, j, dbg) => {
    let C = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) C[q] = F[q] > screen[q] ? 1 : 0;
    if (reg > 0 && j > 0) C = erode(C, ww, wh, j * reg * k);
    for (let q = 0; q < NP; q++) if (frame[q] || tie[q]) C[q] = 0;
    C = cleanSheet(C, dbg);
    return finishSheet(bridgeSheet(C, dbg), dbg);
  };

  const layers = [], webs = [], cuts = [];
  let contours = 0;
  for (let j = 0; j < nCut; j++) {
    let C;
    if (P.screen !== 'turing') {
      C = cutSheet(Fs[j], j, debug);
    } else {
      // FEEDBACK. The Turing screen is uniform, but its shapes are not:
      // worm tips and necks come out narrower than the smallest hole and the
      // cleanup fills them, so the first cut runs light of its target -- measured
      // 5-11% short on flat fields. Measure what the cleanup left, region by
      // region, raise the target by the shortfall, and cut again.
      // The regions must be LARGER than the pattern: two periods across. Measured
      // at the coarse raster's third of a millimeter instead, the "shortfall" was
      // the labyrinth itself, and adding it back inverted the pattern against its
      // own screen (a 0.28 target came out 0.04).
      const rw = Math.max(1, Math.round(W / (2 * p))), rh = Math.max(1, Math.round(H / (2 * p)));
      const want = makeImage(ww, wh);
      for (let q = 0; q < NP; q++) want.data[q] = frame[q] ? 0 : Fs[j][q];
      const wantR = resize(want, rw, rh);
      const scratch = () => ({ bridges: [], fallback: 0, unresolved: 0, specks: 0, floating: 0 });
      const F = Fs[j];
      C = cutSheet(F, j, scratch());
      // One correction is enough: a second changed 0.3/0.5/0.7 by under 1%.
      {
        const got = makeImage(ww, wh);
        for (let q = 0; q < NP; q++) got.data[q] = C[q];
        const gotR = resize(got, rw, rh);
        const errR = makeImage(rw, rh);
        for (let q = 0; q < rw * rh; q++) errR.data[q] = wantR.data[q] - gotR.data[q];
        const err = resize(errR, ww, wh).data;
        const F2 = new Float32Array(NP);
        for (let q = 0; q < NP; q++) F2[q] = Fs[j][q] > 0 ? Math.min(1, Math.max(0, F[q] + GAIN * err[q])) : 0;
        C = cutSheet(F2, j, debug);
      }
    }
    webs.push(measureWeb(C));
    cuts.push(C);
    const holes = traceSheet(C);
    contours += holes.length;
    layers.push(holes);
  }

  // the frame is metal whatever the image says, so that is its target too
  const tgtPix = (q, out) => { for (let d = 0; d < D; d++) out[d] = frame[q] ? palette[0][d] : tgt[d][q]; };
  const { target, source, achieved, cellAt, N } = scoreWindows({
    W, H, ww, wh, k, ky, D, palette, kerf, window: Math.max(3, 2 * p), src, layers, tgtPix,
  });

  const notes = [];
  if (debug.bridges.length) {
    notes.push(`${debug.bridges.length} bridges ${stripes(P) && P.ties > 0 ? 'for parts the ties missed' : 'for loose metal'}`);
  }
  if (debug.unresolved) notes.push(`${debug.unresolved} parts could NOT be bridged — they will fall out`);
  if (debug.specks) notes.push(`${debug.specks} metal specks too small to hold were cut away`);
  if (fMax < 0.5) notes.push(`the period leaves little room: at most ${Math.round(100 * fMax)}% open`);

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N, palette,
    target, achieved, source, layers, webs, cellAt,
    imageRect: { x: 0, y: 0, w: W, h: H },
    cellsLabel: `${contours.toLocaleString()} contours`,
    // dropped/saturated are left at 0 rather than measured: the coarse mix-solve
    // raster (Fc/tgtC above) could report the same "wanted the top sheet open but
    // fitMix clipped it to 0 / to fMax" check squareGrid does per cell, but that
    // would be measured BEFORE the screen threshold and cleanup, not after -- an
    // approximation whose error hasn't been characterized, so left undone rather
    // than guessed at.
    dropped: 0, saturated: 0, note: notes.join(' · '),
    debug: { ...debug, cuts, frame, tie, screen, fMax, orient, flowLmm, Fc, cw, ch },
  };

  /**
   * A homogeneous Turing labyrinth, as a screen: histogram-equalized to [0, 1).
   *
   * Grown by the classic activator-inhibitor shortcut: blur at two radii, keep
   * the difference (short-range excitation, long-range inhibition), squash,
   * repeat. Normalizing each round by the difference's own spread keeps it from
   * dying out or saturating. With the two blurs at 1.95 and 3.9 px, the size that
   * survives best is 12.7 px, so at 12 px per period the maze's own period is
   * about 6% over the setting.
   *
   * THE SCREEN IS THE MAZE'S SIGNED DISTANCE, not the grown field. The squash
   * leaves the field almost binary (measured: 72% within 0.05 of 0 or 1), so
   * ranking it ordered the flat plateaus by leftover noise, and every mid tone
   * cut along that noise -- notched, uneven walls. Instead the field is
   * thresholded at 0.5 into the maze itself, and each pixel is ranked by how far
   * inside it lies: every tone is then the same maze grown or shrunk evenly, with
   * walls parallel to its own. Low tones open the deepest points first (spots at
   * the junctions), mid tones the maze, high tones leave a metal lace.
   */
  function turingScreen(out) {
    // ANISOTROPY stretches both blurs along the image's local direction, so the
    // worms grow long that way (core/steer.js). It grows at 8 px per period rather
    // than 12 -- the steered blur samples along lines and costs several times the
    // separable one, and the signed-distance screen below smooths the result.
    // At anisotropy 0 none of this runs: the round labyrinth is exactly as before.
    const aniso = P.anisotropy > 0;
    const tr = (aniso ? 8 : 12) / p;
    const tw = Math.max(8, Math.round(W * tr)), tht = Math.max(8, Math.round(H * tr));
    const rand = mulberry32(P.seed | 0);
    let u = makeImage(tw, tht);
    for (let i = 0; i < u.data.length; i++) u.data[i] = rand();
    const s1 = aniso ? 1.3 : 1.95, s2 = 2 * s1;
    let blurA = (im) => blur(im, s1), blurB = (im) => blur(im, s2);
    if (aniso) {
      const small = planes.map((pl) => resize(pl, tw, tht).data);
      const lum = makeImage(tw, tht);
      for (let i = 0; i < tw * tht; i++) lum.data[i] = toEncoded(luminance(small[0][i], small[1][i], small[2][i]));
      // directions judged over 1.5 periods: finer and the worms follow noise
      const field = orientationField(lum, 1.5 * tr * p, P.flow);
      const fa = steerBlur(field, tw, tht, s1, P.anisotropy), fb = steerBlur(field, tw, tht, s2, P.anisotropy);
      blurA = (im) => ({ w: tw, h: tht, data: fa(im.data) });
      blurB = (im) => ({ w: tw, h: tht, data: fb(im.data) });
      orient = { field, tw, tht };
    }
    for (let it = 0; it < 20; it++) {
      const a = blurA(u), b = blurB(u);
      let mean = 0, sq = 0;
      const v = new Float32Array(u.data.length);
      for (let i = 0; i < v.length; i++) { v[i] = a.data[i] - b.data[i]; mean += v[i]; }
      mean /= v.length;
      for (let i = 0; i < v.length; i++) sq += (v[i] - mean) ** 2;
      const sd = Math.sqrt(sq / v.length) || 1;
      const next = makeImage(tw, tht);
      for (let i = 0; i < v.length; i++) next.data[i] = 0.5 + 0.5 * Math.tanh((2.5 * (v[i] - mean)) / sd);
      u = next;
    }
    const field = resize(u, ww, wh).data;
    const maze = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) maze[q] = field[q] >= 0.5 ? 1 : 0;
    const dIn = edt(invert(maze), ww, wh), dOut = edt(maze, ww, wh);
    // depth into the maze, negated so the deepest points rank lowest (cut first);
    // a one-pixel blur turns the distance transform's steps into a smooth ramp
    const depth = makeImage(ww, wh);
    for (let q = 0; q < NP; q++) depth.data[q] = maze[q] ? -(dIn[q] - 0.5) : dOut[q] - 0.5;
    let big;
    if (!aniso) {
      big = blur(depth, 1).data;
    } else {
      // Stretch the DEPTH too. Thresholding depth opens the deepest points first,
      // and those are round whatever shape the maze is: low tones came out as
      // spots, high tones as round holes, and only the mid tones leaned (measured
      // 0.37 on the screen, 0.04-0.10 on the cut). Blurred along the direction,
      // the deepest regions are dashes along it, at every tone.
      // across: the same one pixel as the round case; along: up to half a period per
      // unit of anisotropy, scaled by the local strength
      big = steerBlur(resampleField(orient.field, tw, tht, ww, wh), ww, wh, 1, (P.anisotropy * p * k) / 2)(depth.data);
    }
    // equalize: each pixel's rank among all of them, by a fine histogram
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < NP; i++) { if (big[i] < lo) lo = big[i]; if (big[i] > hi) hi = big[i]; }
    const B = 4096, span = hi - lo || 1;
    const hist = new Float64Array(B + 1);
    const bin = (v) => Math.min(B - 1, Math.floor(((v - lo) / span) * B));
    for (let i = 0; i < NP; i++) hist[bin(big[i]) + 1]++;
    for (let b = 0; b < B; b++) hist[b + 1] += hist[b];
    for (let i = 0; i < NP; i++) {
      const v = ((big[i] - lo) / span) * B, b = bin(big[i]), f = Math.min(1, Math.max(0, v - b));
      out[i] = (hist[b] + f * (hist[b + 1] - hist[b])) / NP;   // interpolated within the bin
    }
  }

  /**
   * The image's own (smoothed) gradient direction, mod 2pi, one per coarse
   * pixel -- flow lines' T.
   *
   * NOT core/steer.js's orientationField, despite it being right there and
   * already used for the Turing screen's anisotropy. That field reconstructs
   * a DOUBLED angle: an AXIS (mod pi, no front or back), the right choice
   * when averaging many local gradients that could point either way without
   * canceling (steerBlur just needs a line to steer along). Converting an
   * axis to a vector by picking cos/sin of it outright -- flow lines' first
   * version did exactly that -- cannot stay consistent all the way around a
   * point the axis winds around once (the annulus test's radial image, for
   * one) without a branch-cut discontinuity somewhere, which corrupted the
   * phase well past the seam itself. A smoothed image's own single gradient
   * has no such ambiguity to begin with.
   */
  function gradientDirection() {
    const clum = makeImage(cw, ch);
    for (let q = 0; q < cw * ch; q++) {
      clum.data[q] = toEncoded(luminance(coarse[0].data[q], coarse[1].data[q], coarse[2].data[q]));
    }
    // direction judged over 1.5 periods, as the Turing screen's anisotropy is
    const sm = blur(clum, 1.5 * cpx * p);
    const g0 = new Float64Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      const yu = Math.max(0, y - 1), yd = Math.min(ch - 1, y + 1);
      for (let x = 0; x < cw; x++) {
        const xl = Math.max(0, x - 1), xr = Math.min(cw - 1, x + 1);
        const gx = (sm.data[y * cw + xr] - sm.data[y * cw + xl]) / 2;
        const gy = (sm.data[yd * cw + x] - sm.data[yu * cw + x]) / 2;
        g0[y * cw + x] = Math.atan2(gy, gx);
      }
    }
    return g0;
  }

  /**
   * FLOW LINES. Stripes grown along the image's own direction, and spaced by
   * its own wavelength -- core/lic.js: Line Integral Convolution along the
   * direction, an oriented band-pass across it to select the wavelength,
   * local amplitude normalization, and a tanh soft clip, iterated from
   * noise, then the phase recovered by quadrature. Read only LOCALLY (each
   * pixel's own short streamline), unlike a global potential solve, so it
   * tolerates a T that winds all the way around a point without needing one
   * single consistent field to exist everywhere.
   *
   * T here is the reference's own convention, the ACROSS-stripe (normal)
   * direction -- tangent = T + 90 deg -- so 'edges' (stripes run along the
   * edge, tangent = gradient + 90) means T = the plain gradient direction
   * itself, and 'gradient' (stripes run along the gradient) means
   * T = gradient + 90.
   */
  function flowLicPhaseField() {
    const g0 = gradientDirection();
    const N = cw * ch;
    const T = new Float64Array(N), Lpx = new Float64Array(N);
    for (let q = 0; q < N; q++) {
      T[q] = g0[q] + (P.flow === 'gradient' ? Math.PI / 2 : 0);
      Lpx[q] = Math.max(2, flowLmm[q] * cpx);
    }
    const lic = buildLicRows(T, Lpx, cw, ch);
    const bp = buildBandpassRows(T, Lpx, cw, ch);
    let meanL = 0;
    for (let q = 0; q < N; q++) meanL += Lpx[q];
    meanL /= N;
    const rand = mulberry32(P.seed | 0);
    let u = new Float64Array(N);
    for (let q = 0; q < N; q++) u[q] = rand() * 2 - 1;
    const tanhGain = 2, tanhG = Math.tanh(tanhGain);
    for (let it = 0; it < P.licIterations; it++) {
      u = applyRows(bp, applyRows(lic, u));
      u = localNormalize(u, cw, ch, meanL);
      for (let q = 0; q < N; q++) u[q] = Math.tanh(tanhGain * u[q]) / tanhG;
    }
    // A few final LINEAR passes, no nonlinearity, for a clean phase to
    // recover: tanh flattens u's peaks/troughs toward a square-ish profile,
    // and quadraturePhase's atan2 is most sensitive right where that
    // flattening happens (see docs/architecture.md for the full history).
    for (let it = 0; it < 3; it++) {
      u = applyRows(bp, applyRows(lic, u));
      u = localNormalize(u, cw, ch, meanL);
    }
    const phi = quadraturePhase(u, T, Lpx, cw, ch);
    // Upsample via (cos, sin) of the phase, not the phase itself: phi WRAPS
    // (atan2's range is bounded, unlike every other screen's ever-increasing
    // phase) right at the stripe center, where interpolating the raw angle
    // breaks (see docs/architecture.md). A wrapped angle's (cos, sin) pair
    // has no such discontinuity to interpolate across.
    const cosPhi = new Float32Array(N), sinPhi = new Float32Array(N);
    for (let q = 0; q < N; q++) { cosPhi[q] = Math.cos(2 * Math.PI * phi[q]); sinPhi[q] = Math.sin(2 * Math.PI * phi[q]); }
    const c = resize({ w: cw, h: ch, data: cosPhi }, ww, wh).data;
    const s = resize({ w: cw, h: ch, data: sinPhi }, ww, wh).data;
    const out = new Float32Array(ww * wh);
    for (let q = 0; q < ww * wh; q++) out[q] = Math.atan2(s[q], c[q]) / (2 * Math.PI);
    return out;
  }
}

export default { id, label, blurb, params, build };
