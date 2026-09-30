// Colour conversions.
//
// ALL TONE ARITHMETIC IN THIS APP IS IN LINEAR LIGHT. A cut sheet mixes colours
// by area -- half the cell open lets through half the light -- and area mixing is
// linear in light, not in the gamma-encoded values an image file stores. So the
// target a method aims at, the renderer's averaging, and the fidelity score all
// work on linear values; only the edges of the pipeline (loading pixels, painting
// the canvas, the numbers shown to a person) are sRGB-encoded.

/** sRGB-encoded [0,1] -> linear [0,1]. */
export function toLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** linear [0,1] -> sRGB-encoded [0,1]. Clamps: a mix can overshoot by rounding. */
export function toEncoded(v) {
  v = Math.max(0, Math.min(1, v));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Rec. 709 luminance of a linear RGB triple. */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** '#rrggbb' -> linear [r,g,b]. */
export function hexToLinear(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255));
}

/** linear [r,g,b] -> '#rrggbb'. */
export function linearToHex(rgb) {
  return '#' + rgb
    .map((c) => Math.round(toEncoded(c) * 255).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Linear sRGB -> OKLab (Björn Ottosson, 2020): a perceptually uniform space
 * (equal steps look equally different), unlike linear light (equal steps look
 * MORE different in the darks) or encoded sRGB (a gamma curve chosen for storage,
 * not perceptual spacing). Palette clustering measures distance here so the
 * palette groups colours the way a person would, not the way the file format
 * happens to encode them.
 */
export function rgbToOKLab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

/** OKLab -> linear sRGB, the inverse of `rgbToOKLab`. Can overshoot [0,1]: a
 *  cluster centre outside the sRGB gamut clamps at the edges of the display. */
export function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** A 256-entry lookup for toLinear on 8-bit values, for bulk pixel conversion. */
export const LINEAR_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) t[i] = toLinear(i / 255);
  return t;
})();

/** A 4097-entry lookup for toEncoded on [0,1], for raster methods that need millions
 *  of these and not full precision (rounds to the nearest of 4096 steps). */
const ENCODED_LUT = (() => {
  const t = new Float32Array(4097);
  for (let i = 0; i <= 4096; i++) t[i] = toEncoded(i / 4096);
  return t;
})();
export const encodeFast = (v) => ENCODED_LUT[Math.max(0, Math.min(4096, (v * 4096 + 0.5) | 0))];
