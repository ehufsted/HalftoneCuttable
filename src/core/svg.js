// SVG writer for one sheet.
//
// Millimetres with a matching viewBox, so the file imports at its true size in
// LightBurn, RDWorks, Inkscape and friends. Every contour is a closed path.
//
// TWO STROKE COLOURS, because laser software maps colour to a cut layer and the
// order matters: the holes (blue) must be cut BEFORE the outline (red), or the
// piece drops out of the sheet, can shift, and the remaining holes land in the
// wrong place. Assign blue to an earlier cut layer than red.
//
// Everything is shifted by kerf/2 so the outline's cut path, which lies kerf/2
// outside the piece, starts at the origin.

import { outline } from './cutpaths.js';
import { holePathData, isCircle } from './holes.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = 'http://www.inkscape.org/namespaces/inkscape';
export const HOLE_STROKE = '#0000ff';
export const OUTLINE_STROKE = '#ff0000';

const fmt = (v, dp = 3) => {
  // A non-finite coordinate would otherwise reach the path as "NaN", which some
  // importers drop silently and some reject the whole file over.
  if (!isFinite(v)) return '0';
  const s = v.toFixed(dp);
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s;
};

/**
 * @param {{widthMm, heightMm, kerf}} piece
 * @param {Array} holes   this sheet's holes (core/holes.js); [] for the solid base
 * @param {{name:string}} opts
 */
export function layerSVG(piece, holes, opts = {}) {
  const ol = outline(piece);
  const o = -ol.x;   // kerf/2
  const W = ol.w, H = ol.h;
  const parts = [];
  parts.push(
    `<svg xmlns="${NS}" xmlns:inkscape="${INK}" version="1.1" ` +
    `width="${fmt(W)}mm" height="${fmt(H)}mm" viewBox="0 0 ${fmt(W)} ${fmt(H)}">`,
    `<title>${escapeXml(opts.name || 'layer')}</title>`,
    `<g fill="none" stroke-width="0.1">`,
    `<g inkscape:groupmode="layer" inkscape:label="holes" id="holes" stroke="${HOLE_STROKE}">`,
  );
  for (const h of holes) {
    if (isCircle(h)) parts.push(`<circle cx="${fmt(h.cx + o)}" cy="${fmt(h.cy + o)}" r="${fmt(h.a / 2)}"/>`);
    else parts.push(`<path d="${holePathData(h, fmt, o, o)}"/>`);
  }
  parts.push('</g>',
    `<g inkscape:groupmode="layer" inkscape:label="outline" id="outline" stroke="${OUTLINE_STROKE}">`,
    `<rect x="0" y="0" width="${fmt(W)}" height="${fmt(H)}"/>`,
    '</g>', '</g>', '</svg>');
  return { text: parts.join('\n'), holes: holes.length };
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Trigger a download of the SVG text. */
export const downloadSVG = (svgText, filename = 'layer.svg') => downloadFile(svgText, filename, 'image/svg+xml');

/** Trigger a download of any text. The only DOM-touching function in core/. */
export function downloadFile(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
