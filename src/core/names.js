// Export file names, one per sheet.
//
//   B&W                    piece.svg          piece-2b2b2b.dxf
//   colour, 3 sheets       piece-1-top.svg    piece-1-top-eae8e7.dxf
//                          piece-2-sheet2.svg piece-2-sheet2-439dde.dxf
//                          piece-3-base.svg   piece-3-base-9d3400.dxf
//
// The DXF names carry the sheet's colour, so a folder of them says which sheet
// of which colour each file is for. The colours are the ones the result was MADE
// with (piece.colours, from the pipeline), not whatever the pickers show now.

/**
 * @param {string} stem       from the image name
 * @param {number} i          sheet index, top first
 * @param {{mode, nCut, colours?:string[]}} piece
 * @param {'svg'|'dxf'} ext
 * @param {boolean} withColour  append the sheet's hex colour
 */
export function sheetFileName(stem, i, piece, ext, withColour = false) {
  const hex = withColour && piece.colours && piece.colours[i]
    ? `-${piece.colours[i].replace('#', '').toLowerCase()}` : '';
  if (piece.mode !== 'color') return `${stem}${hex}.${ext}`;
  const n = piece.nCut + 1;
  const tag = i === 0 ? 'top' : i === n - 1 ? 'base' : `sheet${i + 1}`;
  return `${stem}-${i + 1}-${tag}${hex}.${ext}`;
}
