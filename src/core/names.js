// Export file names, one per sheet.
//
//   B&W                    piece.svg          piece-2b2b2b.dxf
//   color, 3 sheets       piece-1-top.svg    piece-1-top-eae8e7.dxf
//                          piece-2-sheet2.svg piece-2-sheet2-439dde.dxf
//                          piece-3-base.svg   piece-3-base-9d3400.dxf
//   Stencil brightness layers add "-levelN" to their color's sheet name (below).
//
// The DXF names carry the sheet's color, so a folder of them says which sheet
// of which color each file is for. The colors are the ones the result was MADE
// with (piece.colors, from the pipeline), not whatever the pickers show now.

/**
 * @param {string} stem       from the image name
 * @param {number} i          sheet index, top first
 * @param {{mode, nCut, colors?:string[]}} piece
 * @param {'svg'|'dxf'} ext
 * @param {boolean} withColor  append the sheet's hex color
 */
export function sheetFileName(stem, i, piece, ext, withColor = false) {
  return `${sheetStem(stem, i, piece)}${colorTag(piece, i, withColor)}.${ext}`;
}

/**
 * A Stencil brightness layer's file: its color's sheet name plus the level,
 * 1 being the lowest (just above that sheet), with the color last as above.
 *
 *   B&W      piece-level1.svg         piece-level1-2b2b2b.dxf
 *   color    piece-2-sheet2-level1.svg piece-2-sheet2-level1-439dde.dxf
 *
 * @param {number} color  the sheet index the layer sits on, top first
 * @param {number} level  1..N
 */
export function levelFileName(stem, color, level, piece, ext, withColor = false) {
  return `${sheetStem(stem, color, piece)}-level${level}${colorTag(piece, color, withColor)}.${ext}`;
}

/** "-rrggbb" for sheet i's color, or '' when not asked for or not known. */
function colorTag(piece, i, withColor) {
  return withColor && piece.colors && piece.colors[i] ? `-${piece.colors[i].replace('#', '').toLowerCase()}` : '';
}

function sheetStem(stem, i, piece) {
  if (piece.mode !== 'color') return stem;
  const n = piece.nCut + 1;
  const tag = i === 0 ? 'top' : i === n - 1 ? 'base' : `sheet${i + 1}`;
  return `${stem}-${i + 1}-${tag}`;
}
