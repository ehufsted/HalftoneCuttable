# HalftoneCuttable

An HTML5 app that turns an image into a halftone you can laser-cut from stiff sheet
material such as metal. Every pattern is **self-supporting**: nothing in a cut sheet
can fall out, whatever the image.

Two modes:

- **Black & white:** one sheet. Cut-away metal reads as white, whether held up to
  a light or set in front of a pale background.
- **Stacked color:** 2–4 sheets. The top sheets are cut and the bottom one stays
  solid. Each cell's holes are nested, so a cell shows a mix of the sheet colors.
  For example, a red sheet with holes over a white sheet with smaller holes, over a
  black base.

Seven patterns:

- **Square grid:** one hole per cell, sized to the local tone. The hole can be a
  circle, a square or a diamond, with optional corner rounding.
- **Hex grid:** the same idea, cells tiled in a honeycomb instead of a square
  lattice. The hole can be a hexagon (denser packing, so it reaches a slightly
  darker black than a circle can at the same pitch) or a circle.
- **Voronoi web:** each cell of a Voronoi diagram is cut as a hole, leaving a web of
  metal. Cells shrink where the image has detail. Two settings shape how it follows
  the image:
  - **Edges:** *Ignore*; *Clean breaks* (a cell wall lies on each image edge, so no
    cell straddles one); or *Metal lines* (those walls get extra width and read as
    drawn lines).
  - **Color regions** (stacked mode): *Mixed colors* (any blend of sheets in a cell,
    through nested holes); or *Solid colors* (the image is split into regions by
    sheet, each cell shows the top sheet and one other, and region boundaries are
    walls, like stained glass).

  Its cell size (under Pattern) is the size in flat areas of the image.
- **Facets:** low-poly triangles cut as holes, leaving a faceted web of metal. It
  has the Voronoi web's controls (edges as clean breaks or metal lines, color
  regions, detail refine...) and the same guarantees. Triangles hold less hole than
  Voronoi cells, so facets default larger (6 mm).
- **Rectangles:** a Mondrian-like composition. Straight cuts divide the piece, each
  one placed where it best separates the image, until there are as many rectangles as
  you ask for (no smaller than *Smallest side*). With *Flat color* each rectangle
  opens fully onto its sheet color, so the rectangles become flat blocks of the
  chosen sheet colors, with the top sheet as the lines. *Narrower with each cut*
  makes the first cuts *Cut width* wide and thins the later ones down to the min web.
  The outline frame is as bold as the first cut. *By tone* sizes each hole by the
  image instead.
- **Stipple:** every hole is the same size, and tone comes from how densely they are
  packed, in an even blue-noise scatter never closer than the min web. One hole size
  means one pierce and one set of cut settings everywhere. In color, each dot shows
  one sheet, so colors mix by the proportion of dots, like pointillism.
- **Stencil:** the image as solid shapes, cut out whole, for logos, text and
  silhouettes. Metal that would fall out (the middle of an O) is held by bridges,
  in an *Automatic*, *Horizontal* or *Vertical* style. *Allow floating parts* skips
  the bridges and cuts those parts free to glue down. Slots too narrow to cut are
  filled, and metal thinner than the min web is thickened rather than lost. In
  color, each sheet is cut by palette region. *Halftone inside shapes* fills each
  shape with round holes sized by its tone, instead of cutting it out whole.
  *Brightness layers per color* adds that many extra sheets for each color,
  stacked directly on that color's own sheet and cut along brightness contours,
  so the brighter parts of each color's region stand higher, like a topographic
  map. The levels are spaced evenly over the brightness range found in that
  color's region, either *even as seen* (encoded) or *even in linear light*. In
  B&W only the metal sheet gets them. They are held together by bridges, or cut
  free to glue down, the same as the stencil's own sheets. Seen straight on, a
  brightness layer is the same color as the sheet under it, so the Result view
  outlines each one in a faded version of its color.
- **Screen:** the image compared against a repeating pattern: straight or wavy lines
  (engraving), concentric rings, a spiral, flow lines, or a Turing labyrinth (spots
  in the shadows, a maze in the mids, metal lace in the lights). The Turing pattern's
  *Anisotropy* stretches the worms along the image's edges, or along its gradient,
  where the image has structure; it stays round where the image is flat. *Flow
  lines* bends straight engraving lines to run along the image's own structure
  instead (line integral convolution and a band-pass, grown from noise), and
  also narrows their spacing in the lights (*Line contrast*) -- cut metal reads
  as open/light, so a dark target already asks for little open area; narrowing
  where there is little to narrow only erases detail, where the lights' spare
  room turns into fine texture instead. A curving line has no simple
  staggered-tie pattern, so it relies on bridging alone, like the Turing
  pattern does. Then it's cleaned up and
  bridged like a stencil. *Tie spacing* (the straight/wavy/ring/spiral screens)
  puts staggered bars of metal across long slots, so the strips between them don't
  flex or warp in the heat.

## Style

A **Style** section of filters, applied to the image before any pattern, so every
pattern can use them. Tick a filter to use it; they run top to bottom, and ↑ ↓
change the order.

**Blur (Gaussian)** softens the image with a plain Gaussian blur, in millimeters
on the piece, replacing fine grain and noise with an even gradient before any
pattern or other filter reads it.

**Local contrast (CLAHE)** equalizes contrast within local tiles instead of over
the whole image, so a flat or washed-out photo reaches better local detail
before a pattern's own tone band compresses it further. *Tile size* sets how
local; *Contrast limit* caps how far a tile can be stretched, so a truly flat or
grainy one is not blown into noise.

**Posterize** reduces the image to a palette of colors pulled from it (clustered
the way the eye groups colors) and paints every pixel with its nearest one, like
a screen-print poster. *Palette colors* sets how many; *Shape cleanup* removes
small islands and fills small notches at each color's edge, so a fleck of grain
does not turn into a shape of its own; *Seed* nudges the clustering if two colors
come out too close together.

**Painterly (Kuwahara)** flattens the image into even, brush-like patches with crisp
edges, stretched along the form (brush size in millimeters). It calms grain and noise
for every pattern.

**Low-poly facets** turns the image into flat triangles. *Adaptive* makes them
smaller where the image is busy and lays their sides along its strong edges;
*uniform* is an even triangle grid. A facet's color is its average (which keeps the
tone) or its median (which ignores specks).

**Ink lines (XDoG)** turns the image into a pen-and-ink drawing. *Lines only* makes the drawing the image; through the Stencil it becomes a
cut line drawing. *Lines over image* darkens the photo along its edges, which fine
patterns cut as dark lines (coarse ones average thin lines into their tone). Line
scale is in millimeters on the metal. *Follow edges* smooths the lines along the
image's direction, so they come out as long strokes rather than dashes.

## Running it

Browsers block ES module imports from `file://`, so the app has to be served. No
installs are needed:

```powershell
powershell -ExecutionPolicy Bypass -File serve.ps1
```

then open:

- <http://localhost:8080/> for the app
- <http://localhost:8080/verify.html> for the verification harness

## Settings that matter at the cutter

| Setting | Meaning |
|---|---|
| Cell pitch / cell size / dot size | Under Pattern, since each pattern sizes itself differently: grid spacing, Voronoi cell size in flat areas, or the stipple hole. |
| Min web | Thinnest metal left anywhere, including between an edge hole and the outline. About the sheet thickness is a safe start. |
| Min hole | Smallest finished hole worth cutting. Cells that want less than this are dithered between no hole and this size. It is raised to 1.5× the kerf if it is below that. |
| Kerf | Beam width. The exported paths are **already offset** by it, so turn kerf compensation off in your laser software. |
| Registration | Color mode only. Each deeper hole is this much smaller on every side than the one above it, so small misalignment when stacking doesn't show. |
| Alignment holes | Four corner holes, the same on every sheet, for pins that hold the stack in register. The diameter is the finished hole's: size it to the pin. Each keeps at least the min web to the edge (moved in if need be) and to the pattern (pattern holes closer than that are left out). |

## Export

One file per sheet, as **SVG** or **DXF**, in true millimeters, with every path closed
and already offset for the kerf, so turn kerf compensation off in your laser
software.

- **Cut order:** holes are blue (DXF layer `HOLES`) and the outline red (layer
  `OUTLINE`). Set the holes to cut before the outline, so the piece stays in the
  sheet until its holes are done. Within the holes, innermost contours come first.
- **DXF details:** DXF is AutoCAD R12, the version laser and CAM software imports
  most reliably. Circles are true `CIRCLE`s, and rounded corners are exact arcs. R12
  has no units field: the file carries a millimeter hint that most software reads,
  and if yours still asks, the units are millimeters.
- **File names:** DXF names end in the sheet's color, e.g. `rhino-1-top-eae8e7.dxf`.
  SVG names don't, e.g. `rhino-1-top.svg`.
- **Solid base:** the base sheet's file is its outline alone.
- **Brightness layers** (Stencil): one file per layer, named after the sheet it
  sits on plus its level, 1 being the lowest, e.g. `rhino-2-sheet2-level1.svg`
  (B&W: `rhino-level1.svg`). Exports and the Cut paths picker list every sheet
  in stack order, top first.

## Layout

```
index.html      app shell
verify.html     harness shell
run-tests.mjs   headless runner (node/deno), if a JS runtime is available
serve.ps1       zero-install static server
src/
  app.js        UI wiring, the only file that touches the DOM
  worker.js     runs pipeline.js off the main thread
  pipeline.js   settings + pixels -> holes, previews, scores
  shim/         image resize/blur (copied from HalftoneWebPAL-1), seeded RNG
  core/         units, shapes, color, separation, diffusion, render, cut paths, SVG, structure
  methods/      one module per pattern, plus the engines they share (cellWeb, gridTone)
tests/          one module per area; runner.js has no DOM, report.js paints
docs/architecture.md   the invariants, read before changing core/
```
