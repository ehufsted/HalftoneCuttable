// Settings in millimetres -> the cell grid a method works on.
//
// THE GRID. Cells of pitch `p` tile the piece, and every hole stays inside its own
// cell, inset by at least web/2 from each cell edge (see shapes.js: sMax = p - web).
// Two neighbouring holes therefore always have >= web of metal between them. The
// grid is then centred in the piece with a margin of at least web/2, so an edge
// hole also has >= web to the outline. That is the whole structural argument, and
// it holds for ANY image: the material is one connected piece by construction.
// The harness checks it anyway, by flood fill, rather than trusting this comment.
//
// THE IMAGE CONVENTION. Unlike the pen-plotter app this was copied from, the tone
// planes here are LINEAR LIGHT with 1 = light/white (see core/color.js). The
// darkness gamma is applied to the encoded values first, as there, so the slider
// means the same thing to a person who knows the other app.

import { makeImage, resize } from '../shim/image.js';
import { toLinear, toEncoded, luminance, hexToLinear } from './color.js';

export const DEFAULTS = {
  widthMm: 200,
  pitch: 4,         // mm, cell size
  web: 0.8,         // mm, thinnest metal allowed between holes
  minHole: 0.8,     // mm, smallest nominal hole worth cutting
  kerf: 0.15,       // mm, beam width
  reg: 0.3,         // mm, registration allowance between stacked layers
  gamma: 1,
  brightness: 1,    // linear-light multiplier
  saturation: 1,    // 0 = grey, 1 = unchanged, >1 = more saturated
  mode: 'bw',       // 'bw' | 'color'
  palette: ['#1a1a1a', '#ffffff'],  // colour mode: top sheet first, solid base last
};

/** Beyond this the worker's arrays and the SVG both get unreasonable. */
export const MAX_CELLS = 250000;

/**
 * @param {{width:number, height:number, data:Uint8ClampedArray}} rgba  source pixels
 * @param {object} settings  see DEFAULTS
 * @returns the grid context every method receives
 */
export function prepare(rgba, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const p = s.pitch, web = s.web, W = s.widthMm;
  if (!(p > web)) throw new Error('cell pitch must be larger than the min web');
  if (!(W - web >= p)) throw new Error('the piece is too narrow for one cell at this pitch');

  const cols = Math.floor((W - web) / p);
  const rows = Math.max(1, Math.round((cols * rgba.height) / rgba.width));
  if (cols * rows > MAX_CELLS) {
    throw new Error(`${cols}×${rows} cells is too many — raise the cell pitch`);
  }
  // At least web/2 by construction: cols * p <= W - web.
  const margin = (W - cols * p) / 2;
  const H = rows * p + 2 * margin;

  const planes = linearPlanes(rgba);

  // Area-average down to one value per cell: `resize` box-averages when both
  // axes shrink, and averaging linear values is the physically right mean.
  const cells = planes.map((pl) => resize(pl, cols, rows));

  const bw = s.mode !== 'color';
  const D = bw ? 1 : 3;
  const target = new Float32Array(cols * rows * D);
  for (let i = 0; i < cols * rows; i++) {
    const r = cells[0].data[i], g = cells[1].data[i], b = cells[2].data[i];
    if (bw) target[i] = clamp01(luminance(r, g, b));
    else { target[3 * i] = clamp01(r); target[3 * i + 1] = clamp01(g); target[3 * i + 2] = clamp01(b); }
  }

  const palette = paletteFor(s);

  return {
    cols, rows, pitch: p, web, margin,
    widthMm: W, heightMm: H,
    kerf: s.kerf, minHole: s.minHole, reg: s.reg,
    mode: bw ? 'bw' : 'color', D, target, palette,
    nCut: palette.length - 1,
    settings: s,
  };
}

/**
 * The raster methods' shared setup: settings merged with defaults, the piece size,
 * B&W/colour and the palette, and the size floors every raster method needs. Unlike
 * `prepare()` this does not build a cell grid or the target planes -- each raster
 * method resizes the source to its own work resolution.
 * @param {{width:number, height:number}} rgba
 * @param {object} settings  see DEFAULTS
 */
export function prepareRaster(rgba, settings = {}) {
  const s = { ...DEFAULTS, ...settings };
  const W = s.widthMm, H = (W * rgba.height) / rgba.width;
  const bw = s.mode !== 'color';
  const palette = paletteFor(s);
  const n = palette.length, nCut = n - 1, D = bw ? 1 : 3;
  const web = s.web, kerf = s.kerf, reg = bw ? 0 : s.reg;
  const hFloor = Math.max(s.minHole, 1.5 * kerf);
  return { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * The source as three LINEAR planes, a plain sRGB decode. Every method starts
 * here, on whatever `applyTone` and the Style chain have already made of the
 * pixels -- this itself no longer adjusts anything, so it cannot disagree with
 * what the Source view showed.
 */
export function linearPlanes(rgba) {
  const n = rgba.width * rgba.height;
  const planes = [0, 1, 2].map(() => makeImage(rgba.width, rgba.height));
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    planes[0].data[i] = toLinear(rgba.data[q] / 255);
    planes[1].data[i] = toLinear(rgba.data[q + 1] / 255);
    planes[2].data[i] = toLinear(rgba.data[q + 2] / 255);
  }
  return planes;
}

/**
 * Gamma, brightness and saturation, applied to the RAW pixels before anything
 * else -- the Style chain and every method see the result, and so does the
 * Source view, which is why this runs first rather than inside each method's
 * own linearPlanes step (where it used to live, after Style, invisible to that
 * preview). Gamma is a darkness curve on the encoded value, as the pen-plotter
 * app this was copied from does. Brightness is a plain multiplier in LINEAR
 * light (physically: scaling the light), and saturation moves each channel
 * toward or away from the pixel's own linear-light luminance -- both commute
 * with each other exactly (both are linear in the channel values), so the order
 * they are applied in cannot change the result. Clamped to [0, 1] before
 * encoding back: gamma alone always stayed inside that range, brightness and
 * saturation do not.
 * @returns {{width,height,data}} encoded pixels, or `rgba` itself when all
 *   three are at their defaults (an empty chain returns the same object too)
 */
export function applyTone(rgba, gamma = 1, brightness = 1, saturation = 1) {
  if (gamma === 1 && brightness === 1 && saturation === 1) return rgba;
  const { width: w, height: h, data } = rgba;
  const n = w * h;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(1 - Math.pow(1 - i / 255, gamma));
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    let r = lut[data[q]], g = lut[data[q + 1]], b = lut[data[q + 2]];
    if (saturation !== 1) {
      const y = luminance(r, g, b);
      r = y + saturation * (r - y); g = y + saturation * (g - y); b = y + saturation * (b - y);
    }
    out[q] = 255 * toEncoded(clamp(r * brightness));
    out[q + 1] = 255 * toEncoded(clamp(g * brightness));
    out[q + 2] = 255 * toEncoded(clamp(b * brightness));
    out[q + 3] = data[q + 3];
  }
  return { width: w, height: h, data: out };
}

/**
 * The TONE palette: what each visible sheet contributes, top sheet first. In B&W
 * the sheet is dark and the hole is light, whatever colours the preview paints
 * them -- the tone model is "open fraction = brightness".
 */
export function paletteFor(settings) {
  return settings.mode !== 'color' ? [[0], [1]] : settings.palette.map(hexToLinear);
}

/** Centre of cell (i, j) in mm from the piece's top-left corner. */
export const cellCentre = (ctx, i, j) => [
  ctx.margin + (i + 0.5) * ctx.pitch,
  ctx.margin + (j + 0.5) * ctx.pitch,
];
