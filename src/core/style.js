// Style filters: the image restyled BEFORE any method sees it.
//
// A CHAIN: runPipeline applies the enabled filters, in the order given, to the
// source pixels and hands the result to the method, which neither knows nor
// cares -- so any filter works with every method, and an empty chain passes the
// image through untouched (the very same object).
//
// Each filter is a registry entry: {id, label, blurb, params, apply(rgba, p,
// widthMm)}, with params in the same format as a method's, so the app builds its
// controls the same way. A new filter is a new entry in FILTERS; the order there
// is the default order of the chain.
//
// settings.style is {chain: [{id, ...params}, ...]}. The older single-filter shape
// {filter: 'xdog', ...} is still read, as a chain of one.
//
// INK LINES (XDoG, Winnemöller et al., "XDoG: an eXtended difference-of-Gaussians
// compendium", 2012). A difference of Gaussians is an edge detector; XDoG adds the
// image back and thresholds softly, so the result is a clean pen-and-ink drawing:
//
//   S = (1 + p)·G_σ(I) - p·G_kσ(I)       sharpened image (k = 1.6)
//   T = 1                         if S >= ε
//       1 + tanh(φ·(S - ε))       otherwise   (φ high: nearly black and white)
//
// On a flat area S is just the image, so ε decides which flat darks fill in with
// ink ("Fill level": 0 = outlines only). Across an edge S swings below the dark
// side's value by about p times the edge's contrast, which draws the line. σ is
// set in MILLIMETERS and converted with the piece width, so a line keeps its width
// on the metal whatever the image's resolution.
//
// FOLLOW EDGES (the flow-based variant, FDoG, Kang et al. 2007): S is smoothed
// along the image's edge direction before the threshold (core/steer.js), which
// joins broken dashes into long, coherent strokes and drops isolated specks.
//
// POSTERIZE. A real reduction to K colors, not a tone-band trick:
//   1. PALETTE. K-means clusters a sample of the image's pixels in OKLab (a
//      perceptual space -- equal steps look equally different to the eye, unlike
//      linear light or encoded sRGB), reusing separate.js's clustering (the same
//      code the Sheets tab's palette suggester runs, minus its sheet-specific
//      push away from the mean -- Posterize wants the image's ACTUAL dominant
//      colors, not extra gamut for nested-hole mixing).
//   2. ASSIGN. Every pixel takes its nearest palette color, in the same OKLab
//      space: a hard partition of the image into K regions.
//   3. SIMPLIFY. Because K arbitrary colors have no natural order (unlike tone
//      bands), each color's region is cleaned up on its own -- an opening then
//      a closing at the cleanup radius, removing small islands and filling small
//      notches -- and any pixel a cleanup leaves claimed by none or several
//      colors is resolved to whichever cleaned region is nearest, by the same
//      exact distance transform (core/edt.js) the stencil's own cleanup uses.
//
// CLAHE (Contrast Limited Adaptive Histogram Equalization, Pizer et al. 1987).
// A flat or washed-out photo has most of its pixels crowded into a narrow band
// of luminance, which a pattern's own tone band then compresses further; CLAHE
// spreads that band back out, but locally, tile by tile, rather than over the
// whole image (a global equalization would still leave a flat REGION flat, just
// at a different level):
//   1. The image is divided into a grid of tiles. Each tile's luminance histogram
//      becomes its own equalization curve (the cumulative distribution, scaled
//      to fill [0, 255]).
//   2. CONTRAST LIMITED: before that, any bin taller than a limit (a multiple of
//      the tile's average bin height) is clipped, and what was clipped off is
//      spread back over every bin evenly. Unclipped, a truly flat or grainy tile
//      has one huge spike, and equalizing it amplifies noise instead of detail.
//   3. ADAPTIVE: a pixel's own curve is bilinearly interpolated between the four
//      nearest tiles' curves (by its position relative to their centers), so the
//      mapping changes smoothly and tile edges do not show as seams.
// Applied to luminance only, and rescaled back into the pixel keeping its hue:
// equalizing each of R, G, B independently would shift colors, not just
// contrast.
//
// BLUR (Gaussian). A plain isotropic blur, in millimeters on the piece, each of
// R, G, B independently: blurring treats every channel alike, so unlike CLAHE it
// needs no hue-preserving recombination.
//
// Painterly (Kuwahara) and Low-poly live in their own modules, core/kuwahara.js
// and core/lowpoly.js, whose headers explain them.

import { makeImage } from '../shim/image.js';
import { blur } from './features.js';
import { orientationField, steerBlur } from './steer.js';
import { kuwahara } from './kuwahara.js';
import { lowPoly } from './lowpoly.js';
import { edt, dilate, erode, opening } from './edt.js';
import { rgbToOKLab, oklabToRgb, toLinear, toEncoded, luminance } from './color.js';
import { kmeansPoints } from './separate.js';

const K = 1.6, PHI = 40;

const xdogFilter = {
  id: 'xdog',
  label: 'Ink lines (XDoG)',
  blurb: 'A pen-and-ink drawing of the image. Fill level decides which dark areas fill in solid (0 = outlines only). Lines only makes the drawing the image (the Stencil cuts it as a line drawing); Lines over image darkens the photo along its edges, which fine patterns cut as dark lines -- coarse ones (a Turing maze, a 3 mm screen) average narrower lines into their tone.',
  params: [
    { key: 'output', label: 'Output', type: 'select', def: 'lines', options: [['lines', 'Lines only'], ['over', 'Lines over image']] },
    { key: 'scale', label: 'Line scale', type: 'range', min: 0.1, max: 3, step: 0.05, def: 0.6, unit: 'mm', dp: 2 },
    { key: 'strength', label: 'Edge strength', type: 'range', min: 2, max: 60, step: 1, def: 20 },
    { key: 'threshold', label: 'Fill level', type: 'range', min: 0, max: 1, step: 0.01, def: 0.3 },
    { key: 'flow', label: 'Follow edges', type: 'checkbox', def: true },
  ],
  apply: xdogStyle,
};

const kuwaharaFilter = {
  id: 'kuwahara',
  label: 'Painterly (Kuwahara)',
  blurb: 'Flattens the image into even, brush-like patches with crisp edges, the patches stretched along the form. Calms grain and noise for every pattern, and gives XDoG clean regions to outline when it runs first.',
  params: [
    { key: 'size', label: 'Brush size', type: 'range', min: 0.5, max: 10, step: 0.1, def: 2, unit: 'mm', dp: 1 },
    { key: 'anisotropy', label: 'Anisotropy', type: 'range', min: 0, max: 3, step: 0.1, def: 1, dp: 1 },
    { key: 'sharpness', label: 'Sharpness', type: 'range', min: 2, max: 16, step: 1, def: 8 },
  ],
  apply: kuwahara,
};

const blurFilter = {
  id: 'blur',
  label: 'Blur (Gaussian)',
  blurb: 'Softens the image with a plain Gaussian blur, in millimeters on the piece. Replaces fine grain and noise with an even gradient before any pattern or filter reads it.',
  params: [
    { key: 'radius', label: 'Blur radius', type: 'range', min: 0, max: 10, step: 0.1, def: 2, unit: 'mm', dp: 1 },
  ],
  apply: blurStyle,
};

const claheFilter = {
  id: 'clahe',
  label: 'Local contrast (CLAHE)',
  blurb: 'Equalizes contrast within local tiles rather than over the whole image, so a flat or washed-out photo reaches better local detail before a pattern’s own tone band compresses it further. Contrast limit caps how far a tile can be stretched, so a truly flat or grainy one is not blown into noise.',
  params: [
    { key: 'tileSize', label: 'Tile size', type: 'range', min: 5, max: 60, step: 1, def: 20, unit: 'mm' },
    { key: 'clipLimit', label: 'Contrast limit', type: 'range', min: 1, max: 8, step: 0.5, def: 2, dp: 1 },
  ],
  apply: claheStyle,
};

const posterizeFilter = {
  id: 'posterize',
  label: 'Posterize',
  blurb: 'Reduces the image to a palette of N colors pulled from it (clustered the way the eye groups colors), then simplifies each color’s shape: removes small islands and fills small notches, so a fleck of grain does not turn into a shape of its own.',
  params: [
    { key: 'levels', label: 'Palette colors', type: 'range', min: 2, max: 12, step: 1, def: 5 },
    { key: 'cleanup', label: 'Shape cleanup', type: 'range', min: 0, max: 5, step: 0.1, def: 1, unit: 'mm', dp: 1 },
    { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1 },
  ],
  apply: posterizeStyle,
};

const lowPolyFilter = {
  id: 'lowpoly',
  label: 'Low-poly facets',
  blurb: 'The image as flat triangular facets. Adaptive puts smaller facets where the image is busy and lays their sides along its strong edges; uniform is an even triangle grid. Average keeps each facet’s tone; median ignores specks and gives more contrast. With the Stencil it makes a faceted poster; chained before Ink lines, outlined facets.',
  params: [
    { key: 'layout', label: 'Layout', type: 'select', def: 'adaptive', options: [['adaptive', 'Adaptive'], ['uniform', 'Uniform grid']] },
    { key: 'size', label: 'Facet size', type: 'range', min: 1, max: 40, step: 0.5, def: 8, unit: 'mm', dp: 1 },
    { key: 'detail', label: 'Detail', type: 'range', min: 0, max: 0.8, step: 0.05, def: 0.5, when: (p) => p.layout === 'adaptive' },
    { key: 'edges', label: 'Follow edges', type: 'checkbox', def: true, when: (p) => p.layout === 'adaptive' },
    { key: 'edgeThreshold', label: 'Edge threshold', type: 'range', min: 0.05, max: 0.9, step: 0.05, def: 0.3,
      when: (p) => p.layout === 'adaptive' && p.edges },
    { key: 'color', label: 'Facet color', type: 'select', def: 'average', options: [['average', 'Average'], ['median', 'Median']] },
    { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1, when: (p) => p.layout === 'adaptive' },
  ],
  apply: lowPoly,
};

/** The filters, in their default chain order. */
export const FILTERS = [blurFilter, claheFilter, posterizeFilter, kuwaharaFilter, lowPolyFilter, xdogFilter];
export const filterById = (id) => FILTERS.find((f) => f.id === id);
const defaultsOf = (f) => Object.fromEntries(f.params.map((p) => [p.key, p.def]));

/** The chain a settings.style asks for, as [{id, ...params}], defaults filled in. */
export function chainOf(style) {
  if (!style) return [];
  const raw = style.chain ? style.chain : style.filter && style.filter !== 'none' ? [{ ...style, id: style.filter }] : [];
  return raw.filter((st) => filterById(st.id)).map((st) => ({ ...defaultsOf(filterById(st.id)), ...st }));
}

/**
 * @param {{width, height, data}} rgba
 * @param {object} style      {chain: [...]} (or the older {filter, ...})
 * @param {number} widthMm    the piece width the image spans
 * @returns the styled pixels, or `rgba` itself when the chain is empty
 */
export function applyStyle(rgba, style, widthMm) {
  let out = rgba;
  for (const st of chainOf(style)) out = filterById(st.id).apply(out, st, widthMm);
  return out;
}

function blurStyle(rgba, st, widthMm) {
  const { width: w, height: h, data } = rgba;
  const n = w * h;
  const sigma = st.radius * (w / widthMm);
  if (!(sigma > 0.3)) return rgba;   // matches blur()'s own no-op threshold
  const planes = [0, 1, 2].map(() => makeImage(w, h));
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    planes[0].data[i] = data[q]; planes[1].data[i] = data[q + 1]; planes[2].data[i] = data[q + 2];
  }
  const blurred = planes.map((pl) => blur(pl, sigma));
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    out[q] = blurred[0].data[i]; out[q + 1] = blurred[1].data[i]; out[q + 2] = blurred[2].data[i];
    out[q + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

const CLAHE_BINS = 256;

function claheStyle(rgba, st, widthMm) {
  const { width: w, height: h, data } = rgba;
  const n = w * h;

  // luminance, as an integer 0..255 -- histogram bins need discrete values
  const Y = new Uint8Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    Y[i] = Math.round(luminance(data[q], data[q + 1], data[q + 2]));
  }

  // ---- one equalization curve per tile, contrast-limited
  const tilePx = Math.max(8, st.tileSize * (w / widthMm));
  const tx = Math.max(1, Math.round(w / tilePx)), ty = Math.max(1, Math.round(h / tilePx));
  const tw = w / tx, th = h / ty;
  const luts = new Array(tx * ty);
  for (let j = 0; j < ty; j++) {
    const y0 = Math.floor(j * th), y1 = j === ty - 1 ? h : Math.floor((j + 1) * th);
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor(i * tw), x1 = i === tx - 1 ? w : Math.floor((i + 1) * tw);
      const hist = new Float64Array(CLAHE_BINS);
      let count = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[Y[y * w + x]]++; count++; }
      // clip any bin taller than the limit, and spread what was clipped off evenly
      const clip = Math.max(1, (st.clipLimit * count) / CLAHE_BINS);
      let excess = 0;
      for (let b = 0; b < CLAHE_BINS; b++) if (hist[b] > clip) { excess += hist[b] - clip; hist[b] = clip; }
      const bonus = excess / CLAHE_BINS;
      const lut = new Float32Array(CLAHE_BINS);
      let acc = 0;
      for (let b = 0; b < CLAHE_BINS; b++) { acc += hist[b] + bonus; lut[b] = count > 0 ? (255 * acc) / count : b; }
      luts[j * tx + i] = lut;
    }
  }

  // ---- every pixel's curve, bilinearly interpolated from its 4 nearest tiles
  const out = new Uint8ClampedArray(n * 4);
  for (let py = 0; py < h; py++) {
    const gy = (py + 0.5) / th - 0.5;
    const gy0 = Math.floor(gy), fy = gy - gy0;
    const ty0 = Math.max(0, Math.min(ty - 1, gy0)), ty1 = Math.max(0, Math.min(ty - 1, gy0 + 1));
    for (let px = 0; px < w; px++) {
      const gx = (px + 0.5) / tw - 0.5;
      const gx0 = Math.floor(gx), fx = gx - gx0;
      const tx0 = Math.max(0, Math.min(tx - 1, gx0)), tx1 = Math.max(0, Math.min(tx - 1, gx0 + 1));
      const i = py * w + px, y = Y[i];
      const l00 = luts[ty0 * tx + tx0][y], l01 = luts[ty0 * tx + tx1][y];
      const l10 = luts[ty1 * tx + tx0][y], l11 = luts[ty1 * tx + tx1][y];
      const top = l00 + (l01 - l00) * fx, bot = l10 + (l11 - l10) * fx;
      const newY = top + (bot - top) * fy;
      const q = 4 * i;
      if (y > 0) {
        const scale = newY / y;
        out[q] = data[q] * scale; out[q + 1] = data[q + 1] * scale; out[q + 2] = data[q + 2] * scale;
      } else {
        out[q] = out[q + 1] = out[q + 2] = newY;
      }
      out[q + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Morphological closing: fill notches and holes narrower than 2r, keep the rest. */
const closing = (A, w, h, r) => erode(dilate(A, w, h, r), w, h, r);

/** Index of the center nearest point p, by squared OKLab distance. */
const nearest = (p, centers) => {
  let best = 0, bd = Infinity;
  for (let k = 0; k < centers.length; k++) {
    const c = centers[k];
    const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return best;
};

function posterizeStyle(rgba, st, widthMm) {
  const { width: w, height: h, data } = rgba;
  const n = w * h;
  const nCol = Math.max(2, Math.round(st.levels));
  const toOKLab = (r, g, b) => rgbToOKLab(toLinear(r), toLinear(g), toLinear(b));

  // 1. the palette: K-means in OKLab (separate.js's clustering, no gamut push)
  const { centers } = kmeansPoints(rgba, nCol, st.seed | 0, toOKLab);
  const palette = centers.map((c) => oklabToRgb(c).map((v) => 255 * toEncoded(v)));

  // 2. every pixel takes its nearest palette color, in the same space
  const label = new Uint8Array(n);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    label[i] = nearest(toOKLab(data[q] / 255, data[q + 1] / 255, data[q + 2] / 255), centers);
  }

  // 3. shape cleanup, per color, then resolve any pixel a cleanup leaves
  // claimed by none or several colors to whichever cleaned region is nearest
  const r = 0.5 * Math.max(0, st.cleanup) * (w / widthMm);
  let finalLabel = label;
  if (r > 0) {
    const dists = [];
    for (let k = 0; k < nCol; k++) {
      let M = new Uint8Array(n);
      for (let i = 0; i < n; i++) M[i] = label[i] === k ? 1 : 0;
      M = opening(M, w, h, r);
      M = closing(M, w, h, r);
      dists.push(edt(M, w, h));
    }
    finalLabel = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < nCol; k++) if (dists[k][i] < bd) { bd = dists[k][i]; best = k; }
      finalLabel[i] = best;
    }
  }

  // 4. paint: every pixel becomes its final label's palette color
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const c = palette[finalLabel[i]];
    out[q] = c[0]; out[q + 1] = c[1]; out[q + 2] = c[2]; out[q + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

function xdogStyle(rgba, st, widthMm) {
  const { width: w, height: h, data } = rgba;
  const n = w * h;
  const lum = makeImage(w, h);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    lum.data[i] = luminance(data[q], data[q + 1], data[q + 2]) / 255;
  }
  const T = xdog(lum, st.scale * (w / widthMm), st);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    const t = T[i];
    if (st.output === 'over') {
      out[q] = data[q] * t; out[q + 1] = data[q + 1] * t; out[q + 2] = data[q + 2] * t;
    } else {
      out[q] = out[q + 1] = out[q + 2] = 255 * t;
    }
    out[q + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/**
 * The XDoG drawing of a luminance image: 1 = paper, 0 = ink.
 * @param {{w,h,data}} lum  encoded luminance in [0, 1]
 * @param {number} sigma    pixels
 * @returns {Float32Array}
 */
export function xdog(lum, sigma, st) {
  const { w, h } = lum;
  const n = w * h;
  const g1 = blur(lum, sigma).data, g2 = blur(lum, K * sigma).data;
  const p = st.strength, eps = st.threshold;
  let S = new Float32Array(n);
  for (let i = 0; i < n; i++) S[i] = (1 + p) * g1[i] - p * g2[i];
  if (st.flow) {
    // along the edges, about 2σ at full strength; across, barely at all
    const field = orientationField(lum, 2 * sigma, 'edges');
    S = steerBlur(field, w, h, 0.5, Math.max(0, 4 * sigma - 1))(S);
  }
  const T = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = S[i] >= eps ? 1 : 1 + Math.tanh(PHI * (S[i] - eps));
    T[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return T;
}
