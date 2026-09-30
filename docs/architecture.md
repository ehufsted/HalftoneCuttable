# Architecture

These are the invariants that no single file is the right home for. A module's own header
explains its reasoning; this page is what holds across modules.

## Layers

```
shim/      image resize/blur (copied verbatim from HalftoneWebPAL-1), mulberry32
core/      units, shapes, color, separate, diffuse, render, cutpaths, svg, structure,
           holes (the hole model), polygon, voronoi, features, seeds, hilbert,
           edt (distance transform and morphology), contour (marching squares),
           cutsheet (the stencil/screen per-sheet pipeline and window scoring),
           steer (direction fields and blurs steered along them),
           style (the style-filter registry and chain), kuwahara, lowpoly,
           delaunay (ported verbatim from HalftoneWebPAL-1)
methods/   one module per pattern; imports core/ only
pipeline.js  the whole chain; imports methods/ and core/
worker.js  wraps pipeline.js
app.js     UI; the only DOM user (plus svg.downloadSVG)
```

Dependencies run downward only. Nothing under `core/` imports `methods/`. This is why
`pipeline.js` sits at `src/` and not in `core/`.

## The hole model

Every method's `build()` returns the same thing (documented in `methods/index.js`):
holes per cut sheet, plus per-cell target / achieved / source colors. The renderer,
stats, SVG and pipeline only ever see that, so a new method needs no changes
downstream. A hole is its **cut path** (what the beam follows), and the finished hole
is that path grown by kerf/2. Two kinds: a rounded square (the grid) and a convex
polygon (the Voronoi web). Growing by a disc is exact for both, and so is the
Steiner area `A + P·d + π·d²`.

**The general rule that keeps a sheet in one piece:** convex holes that are pairwise at
least `web` apart, and at least `web` from the outline, cannot enclose any metal.
Both methods are instances of it. A new method that keeps to it needs no new proof,
but it still gets the flood-fill test.

## Self-support is by construction

Every hole stays inside its own cell, and its nominal size is at most `pitch − web`
(`shapes.maxSize`). The grid sits in the piece with a margin of at least `web/2`.
Together those give:

- neighboring holes along an axis always have ≥ `web` of metal between them;
- diagonal neighbors have ≥ `web·√2`;
- an edge hole has ≥ `web` to the outline.

So every cut sheet is one connected piece for any image. `tests/structure.js`
checks this independently by flood fill, and includes a negative control (holes the
full width of the pitch) to show that the check can see islands.

The Voronoi web's version: every hole is its cell inset by a margin of at least
`web/2` from each wall, and the cells are clipped to the piece inset by `web/2`.
Tests check it three independent ways: the method's own web figure, polygon distances
between neighboring holes, and a flood fill.

**The hex grid's version** (`methods/hexGrid.js`) is the square grid's argument on a
honeycomb lattice instead of a square one: every hole's nominal size (its own
flat-to-flat width) is at most the cell's inradius, doubled, less `web`, and the grid
sits in the piece with a margin of at least `web/2`. The one property that makes this
as simple as the square case: a regular hex tiling's six neighbor directions land
exactly on the cell's own six edge normals, so a hexagon hole (or a circle) has the
same extent -- its own flat-to-flat width, or diameter -- toward every neighbor, with
no per-direction case to work out, unlike an arbitrary convex cell. A hexagon hole is
the 'poly' kind (its area is the exact Steiner law, since a sharp hexagon's corners
are what the beam itself rounds); a circle hole reuses the rounded-square family
directly, the same code the square grid uses.

**A new method must keep a construction argument like this one, or bring its own proof.**
A pattern where holes span cells (slots, a connected web) needs its own reasoning and
its own entries in `tests/structure.js`.

## One hole family

Every hole is a rounded square: side `a`, radius `r`, optionally turned 45°. A circle is
`r = a/2`, and a diamond is a turned square. This gives one closed-form area, one
signed-distance test, one kerf offset and one SVG path writer.

**The beam rounds every corner.** The finished hole has `r ≥ kerf/2` whatever is
asked, and `shapes.finished` builds that in. Tone is therefore computed on the hole the
machine will actually leave. The cut path is the finished hole offset inward by
`kerf/2`, which is exact for this family. The outline is offset outward by the same
amount.

## Tone

- **Linear light.** Area mixing is linear in light, so targets, mixes and scores are all
  linear. Only the loading and display edges are sRGB-encoded (`core/color.js`).
- **Everything is a mix.** A cell shows a convex mix of the sheet colors, and the
  weights are the visible areas. B&W is the two-sheet, one-channel case: a dark sheet
  and a light hole. `separate.solveMix` finds the closest mix exactly by trying every
  face of the simplex, which is at most 15 for 4 sheets.
- **Unreachable by specification.** The largest hole leaves `1 − fMax` of the top
  sheet in every cell, so pure white (or a pure base color) cannot be reached.
  `targetImage` states the band, either squeezing into it or clipping to it, and the app
  scores against that band, not the source.
- **Scores come from the exact area law, not a raster.** `separate.stackColors`
  computes them. An axis-aligned raster miscounts square holes systematically, because
  their edges hold one phase against the sample grid. The harness measured 2.6% on one
  square before the check was changed. The preview raster is checked against the area
  law instead (`method.squareGrid`, the instrument check).
- **Error diffusion covers what a cell can't do.** That is the gap below the smallest
  hole, and the deeper layers squeezed by registration. It works in the target's own
  channels, in serpentine order (`core/diffuse.js`).
- **Gamma, brightness and saturation run before Style, not inside each method.**
  `core/units.js`'s `applyTone` applies all three to the raw pixels, in
  `runPipeline`, before `applyStyle` -- so the Style chain, every method, AND the
  Source view all see the result, rather than gamma/brightness/saturation being
  invisible adjustments a method made privately after the preview had already
  been built from the styled image. Gamma is a darkness curve on the encoded
  value (as the pen-plotter app this was copied from does, so the slider means
  the same thing there); brightness and saturation run after, in LINEAR light,
  since that is where this app's own mixing model lives, then the result is
  encoded back to ordinary pixels -- the same shape of function as a Style
  filter (`{width, height, data}` in, the same out), and an identity, returning
  the very same object, when all three are at their defaults. Brightness and
  saturation can leave [0, 1] where gamma alone never did, so the result is
  clamped before encoding back; `core/units.js`'s own `linearPlanes` no longer
  adjusts anything, only decodes, so it cannot disagree with what the Source
  view showed.
- **Smoothing is a Style filter now, not a setting.** The old global Smoothing
  slider ran inside every method's own `linearPlanes` step, paid for whether a
  method's look needed it or not (Stencil's own separate "Shape smoothing" param,
  for smoothing the raster before thresholding into shapes, was never this and is
  untouched). It is now `core/style.js`'s Blur (Gaussian) filter: optional,
  reorderable, and applied once in the chain instead.

## Voronoi web

- **Seeds decide where the walls go; a per-cell margin decides the tone.** The margin
  is solved per cell by bisection on the exact finished area. Structure and tone never
  trade against each other.
- **Walls go on edges through mirrored pairs.** A wall lies halfway between two seeds,
  so a pair placed symmetrically across an edge point puts one on the edge. Pairs are
  pinned during relaxation. Region boundaries in solid-color mode are pinned the
  same way.
- **Metal lines** move the pinned walls in by `lineWidth/2` on each side, per edge
  (`insetConvex` takes one offset per edge; the edge labels say which neighbor a wall
  faces).
- **One tone band for all cells,** set where 90% of cells can reach it. A per-cell band
  would print detailed areas darker, because small cells have less room for a hole.
  The band is measured **as if no wall carried a line.** Counting the lines thickened
  every web in a busy photo; leaving the line cells out raised the band instead,
  because they are the small ones. Both mistakes were made and are now tested.
- **Solid color hides the in-between sheets.** Mixed mode nests deeper holes smaller
  by the registration allowance, because there the rings are meant to show. Solid mode
  cuts them *larger*, so they sit under the top sheet and the top hole alone is the
  window. Nesting them smaller showed a ring of the wrong color over about a quarter
  of each cell. The price is that deeper sheets reach less open area, so each sheet has
  its own band.
- **Solid regions keep their error:** diffusion only passes error between cells of the
  same region.

## Cell webs: one engine, three layouts

`methods/cellWeb.js` is the Voronoi web's engine with the cell placement taken
out. It covers reading the image, the detail and edge features, color regions,
the per-cell tone law, targets, diffusion over the cell graph, color modes and
web figures. A **layout** places the cells: `{N, cells, sites, cellOfPixel, cellAt,
isLine, notes, unit, debug}`. Any convex cells work, since the one-piece argument
needs nothing else.

- **Voronoi web** (`voronoiLayout`): seeds in mirrored pairs across edges, and a
  wall carries an edge line when it separates a pair. The split was checked
  behavior-preserving: all 16 Voronoi tests reproduced their numbers exactly.
- **Facets** (`facetLayout`): Delaunay triangles over corners placed ON edges and
  region boundaries (pinned), a border ring, a detail-driven fill and Lloyd. A side
  is an edge wall when both its corners are on an edge, their normals agree, and it
  runs along the edge. Triangle cell `t`'s edge `k` (vertex k→k+1) is labeled with
  the neighbor opposite vertex `k+2` (Delaunay's convention). Pixels are assigned
  by rasterising the triangles, and border-band pixels take the facet at the
  nearest point of the rectangle. The corner count is capped at 15 k, since
  Delaunay is quadratic.
- **Triangles hold less hole:** the inscribed circle is 0.29 × the side, against a
  hexagon's 0.43. So the tone band is narrower, facets default to 6 mm, and small
  facets in busy areas go without a hole sooner.

- **Rectangles** (`rectLayout`): greedy guillotine splitting. The rectangle whose
  best split most reduces the total squared color error is split next; on ties (flat
  areas), the largest goes first. Candidate splits are every work-pixel column and
  row at least `minSide` from the sides, each scored in constant time from
  summed-area tables of the encoded channels and their squares. There is no
  randomness. Each side remembers the RANK of the cut it lies on (−1 for the
  outline). At a T-junction a side borders several neighbors, so it is broken at
  their corners into segments, each labeled with the cell across it (tested on every
  edge, both ways). The work raster has a floor of 4 px/mm (`opts.minPxPerMm`),
  because the cells are large but cut positions must be fine.
- **Walls of different weight:** a layout may return `wallExtra(i, q, k)`, which
  replaces the single edge-line width. Rectangles' cut width is `web + (cutWidth −
  web)·(1 − rank/(R−1))^1.5` with Taper, and `cutWidth` otherwise. A shared wall
  gets half the excess from each side. The frame gets all of it from its one side,
  plus the web/2 rim, so it comes out at `cutWidth`.
- **Flat fill** (`P.fill === 'flat'`): each cell opens to ITS OWN web limit, not the
  shared tone band. The band is the 10th percentile over all cells, and it held large
  rectangles back to the small ones' size (measured: mean color error 0.07 against
  the full-strength target, now 0). Nothing is left to diffuse, and the "at the
  largest hole" warning is not raised. Voronoi and Facets have no `fill` parameter,
  so their output is unchanged, and all their tests reproduce.

A new cell shape (a hex grid, quads, anything convex) is a new layout function.

## Stipple

- **Fixed-size circles with centers at least `sMin = widest hole + web` apart.**
  This is the general rule again. The spacing is *enforced* after relaxation: pairs
  too close are pushed apart, and whatever still clashes is removed greedily. The
  note says how many.
- **The count is exact:** N = the integral of the target density (open fraction /
  hole area). Points start as a stratified sample along a Hilbert curve, then
  weighted Lloyd with weight ρ² relaxes them (Lloyd settles at weight^½).
- **The densest tone is 0.7 of hexagonal packing (`PACKING`), measured.** Above it,
  the repair removes dots in the lights: 0.8 lost 172 of about 560 on white.
- **The frame is metal in the target.** No center can sit within `web + dDeep/2` of
  the outline, so asking for dots there packed them into the interior. That alone
  cost 116 dots on white at 0.7 before it was fixed.
- **Color is by dot, not by nesting.** Each dot shows one sheet, chosen by 1-D error
  diffusion along the Hilbert order of the dots. Deeper holes are wider and hidden, as
  in the Voronoi web's solid mode.
- **Tone is scored per window about four dots across,** because a single dot says
  nothing about tone.

## Stencil

- **Raster first, then traced.** Posterize, clean up, bridge and offset all happen
  on a raster where the min web spans about five pixels. All morphology is done with
  an exact Euclidean distance transform (`core/edt.js`), so "narrower than w" means a
  true disc at any angle. Outlines come from marching squares on the cut's signed
  distance, contoured at `-kerf/2`: the cut path is sub-pixel accurate, and the
  harness measures its mean offset at 0.154 mm for a 0.3 mm kerf.
- **A third hole kind, `loop`.** A sheet's loops are read together, even-odd (an
  island inside a cut is a loop running the other way). The renderer fills them
  per sheet and grows them by the kerf with the same distance transform.
- **Thin metal is thickened, not removed.** Only the parts an opening of the metal
  loses are grown by `web/2`, so a hairline survives as a line of web width.
- **Bridges join the CORES of the metal** (the metal shrunk by just under `web/2`),
  not the metal itself. A neck thinner than the web therefore counts as a break and
  gets bridged. The harness's structure check shrinks the traced sheet the same way
  before its flood fill, so "one piece" there means every connection is at least
  the web wide.
- **Bridges are straight rays** from a part's boundary, two per part, at least 90°
  apart (opposite for the horizontal and vertical styles). If the chosen style has
  no path, the app falls back to any angle and says so in the note. Clusters still
  not joined to the frame get one more bridge per pass.
- **Color layering reuses the hidden-registration rule.** A deeper sheet's cut is
  extended by `j·reg`, but only into areas where a sheet above it is solid. Extending
  it into its own visible region would move the color boundary.
- **Halftone inside shapes:** a grid of circles, each capped to stay inside its
  shape. The cap subtracts 1.25 px, because the distance is measured between pixel
  centers; without that, holes poked out of their shape by up to a pixel (caught by
  the harness).

## Screen

- **Same pipeline as the stencil** (`core/cutsheet.js`); only the drawing of the
  cut differs. A stripe screen is a triangle wave in phase, uniform over each
  period, so "cut where f > screen" opens exactly f. The harness measures slot
  width = f × period and one slot per period.
- **Band:** stripes can open up to `1 - web/period`. Waves use their *tightest*
  spacing, `period / sqrt(1 + (2πA/λ)²)`; on the nominal period they lost a fifth of
  their open area to thickening. Turing stops at 0.9 of the stripe band (measured;
  the full band is reachable but reads 3% light at the top).
- **The Turing screen is the maze's signed distance, not the grown field.** The
  grown field is almost binary (72% within 0.05 of 0 or 1), so ranking it ordered
  the flat plateaus by noise, and every mid tone cut along that noise: notched,
  uneven walls. Thresholding the field into the maze and ranking pixels by depth
  inside it makes every tone the same maze grown or shrunk evenly. Together with the
  smoothed trace (below), this took the rhino from 25 µm jaggedness and 9.9 sharp
  tips per 100 mm to 19 µm and 3.7, and the harness now checks it.
- **Anisotropic Turing** (Anisotropy > 0; off by default, so the round path costs
  nothing extra): the image's structure tensor gives a direction per point (doubled
  angles throughout) and a strength that fades to round where the image is flat.
  Both growth blurs are stretched along it (`steer.steerBlur`: two 1-D passes that
  follow the local line), and so is the depth blur, which matters as much. Stretching
  only the growth, the screen leaned 0.37 but the cut only 0.04–0.10: thresholding
  depth opens the deepest points first, and those are round whatever the maze's
  shape. Stretching the depth as well gives dashes at every tone (cut alignment 0.29
  in the lights, 0.56 in the mids, 0.61 in the darks on a radial ramp). The strength
  gate is relative to the image's 90th-percentile energy; gated on the median, a
  smooth ramp got half strength everywhere. The anisotropic path grows at 8 px per
  period: on the rhino about 4.5 s against 3 s.
- **Turing feedback:** cleanup fills tips and necks too narrow to cut, so the first
  cut runs light. One correction pass at full gain fixes that. The shortfall is
  measured on cells **two periods across**: measured finer than the pattern, the
  "shortfall" was the labyrinth itself, and correcting by it inverted the pattern
  (0.28 came out 0.04). With the old ragged screen the full gain overshot and 0.75
  was needed.
- **Tracing is smoothed** (`cutsheet.traceSheet`, for the stencil too). The signed
  distance of a binary mask steps along every diagonal edge, and contouring it gave
  pixel staircases faceted into 0/45/90°. A one-pixel blur of the distance, and
  simplifying at 0.3 px instead of 0.5, give outlines that follow the shape. The
  harness's kerf-offset check still reads 0.158 mm for a 0.3 mm kerf.
- **Ties** close `tieWidth / spacing` of every slot, so slots are widened by that
  much to pay it back, within the band. **Bridges are not paid back:** untied rings
  are islands held by two bridges each, which cost 4% of the tone at 10 mm radius
  and 18% within 8 mm of the center. So rings should be used with ties.
- **Color:** every sheet uses the same screen at its own cumulative open fraction,
  so deeper slots sit inside the ones above. Each is then narrowed by the
  registration allowance per sheet.

## Style filters

`core/style.js` restyles the source pixels in `runPipeline` before the method
sees them, so any filter works with any method, and the Source view and the reach
score see the styled image. An empty chain returns the very same object, so the
no-style path cannot change. `applyTone` (gamma, brightness, saturation; see
Tone, above) runs on the raw pixels just before this, so a filter sees whatever
those sliders did too.

**A registry and a chain.** Each filter is an entry in `FILTERS`: `{id, label, blurb,
params, apply}`, with params in the same format as a method's. The app renders both
through one `renderParams`, and builds the Style cards from the registry, so a new
filter needs no UI code. `settings.style = {chain: [{id, ...params}]}` in run order;
the older `{filter: 'xdog', ...}` is read as a chain of one (the harness checks the
two give identical output). The order matters: Kuwahara then XDoG draws lines on
clean, flattened regions; XDoG then Kuwahara softens the lines into blobs.

**Blur (Gaussian)** softens each of R, G, B independently (`core/features.js`'s
`blur`, the same one XDoG and Kuwahara use for their own internal blurs), radius
in millimeters. No hue-preserving recombination step, unlike CLAHE and Posterize:
blurring already treats every channel alike and needs none. This is what the old
global Smoothing setting became -- see Tone, above.

**Local contrast (CLAHE)** (Pizer et al. 1987) equalizes a tile's own luminance
histogram (its cumulative distribution, scaled to fill [0, 255]) rather than the
whole image's, so a flat region gets its own local stretch instead of whatever the
global histogram happens to do with it. CONTRAST LIMITED: any histogram bin taller
than a multiple of the tile's average bin height is clipped first, the clipped
mass spread back evenly over every bin -- unclipped, a tile that is a narrow, near-
uniform band (grain, not signal) gets the SAME full-range stretch as real detail
would, the classic AHE noise-amplification failure. ADAPTIVE: a pixel's own curve
is bilinearly interpolated between its four nearest tiles' curves, so the mapping
changes smoothly and tile edges do not show as seams. Applied to luminance only,
recombined into the pixel keeping its hue -- the same technique, and the same
reason, as Posterize's output.

**Posterize** reduces the image to a real palette of N colors, not a tone-band
trick. K-means clusters a sample of the pixels in OKLab (a perceptual space: equal
steps look equally different to the eye, unlike linear light or encoded sRGB) --
the same clustering `separate.js`'s palette suggester runs for the Sheets tab,
minus its push away from the mean, since that push is for extra nested-hole gamut
and Posterize wants the image's actual dominant colors. Every pixel then takes
its nearest palette color, a hard partition into N regions. Because N arbitrary
colors have no natural order (unlike tone bands, where band j+1 is always inside
band j), the "shape simplification" cleans up each color's region on its own --
an opening then a closing at the cleanup radius, removing small islands and filling
small notches -- and resolves any pixel a cleanup leaves claimed by none or several
colors to whichever cleaned region is nearest, by the same exact distance
transform (`core/edt.js`) the stencil's own cleanup uses.

**Anisotropic Kuwahara** (`core/kuwahara.js`): an ellipse along the structure-tensor
direction, 8 soft sectors (cos⁴ weights × a radial Gaussian), each sector's mean
weighted by `1/(1 + spread^q)` so the sectors straddling an edge drop out. It runs
at the resolution where the brush radius is 4 px and is scaled back up (1.4 s for a
1400×1000 photo). Measured: grain 13× smoother with an edge still rising within
0.2 mm; patch alignment with the edges 0.22 → 0.58 from anisotropy 0 to 2. Brush
size is in mm, so on a LOW-RESOLUTION image a small brush can be under a pixel and do
nothing. The bundled rhino is only 216×188 px, about one pixel per mm at 200 mm, so a
2 mm brush barely changes it; a 6 mm one does.

**XDoG ink lines.** A difference of Gaussians with the image added back
(`(1+p)·G_σ − p·G_kσ`), then a soft threshold at the fill level: flat areas below it
fill with ink, edges draw a line on their dark side. σ is in mm, converted with the
piece width. The harness measured line widths of 1.8 mm at σ 0.5 and 3.4 mm at σ
1.0, and 3.4 against 3.6 mm on a piece twice as wide. *Follow edges* is the
flow-based variant: the sharpened image is smoothed along the edge direction
(`steer.js`). On a faint, noisy edge it joined the line from 7 fragments into 2.
It does NOT clean grain in flat areas; the direction field fades out there by
design. That job belongs to a smoothing filter (Kuwahara, next).

**A limit, stated rather than hidden:** "Lines over image" only darkens the image,
so a pattern coarser than the lines averages them into its tone. On the rhino's
Turing maze even 1.5 mm lines barely showed. Crisp metal outlines over a coarse
pattern would need the METHOD to keep a line mask solid, which is method-level work
and not a filter.

**Low-poly** (`core/lowpoly.js`) triangulates corners with Delaunay:
- *Adaptive* places them by the Voronoi web's rules: variable-spacing fill from the
  detail map, then a short Lloyd pass. With *Follow edges*, points go ON the strong
  edges first, not in pairs across them, so Delaunay joins them along the line and
  facet sides follow outlines (measured: 0 facets straddling a step edge, against 8
  without).
- *Uniform* is an equilateral lattice.
- Both add the corners and a border ring, so the facets tile the piece (checked to
  1e-6).
- Average color is taken in linear light, which keeps tone to 0.1%. Median works
  per channel, through one reused histogram, since one per facet would be hundreds
  of MB at the point cap.
- The triangulation is quadratic, fine at the 1–10 k points this uses (0.7 s for a
  1400×1000 image at 4 mm facets). The cap is 30 k points, with a message.

Low-poly into the Stencil does NOT outline every facet: adjacent facets on a smooth
gradient differ too little to cross a threshold, so they merge, and chaining XDoG
only outlines the higher-contrast boundaries. A full facet lattice needs the edges
drawn explicitly: an option on this filter, or a cutting method.

## Export

`core/svg.js` and `core/dxf.js` write the same hole model: holes first,
innermost first, then the outline, all shifted by kerf/2 so the outline's cut path
starts at the origin. Names come from `core/names.js`, using the colors the result
was made with (`piece.colors`, from the pipeline).

The DXF has two traps. Its **y axis runs up**, so y becomes `height - y`; written
as-is, every piece would be mirrored. And the flip **reverses every arc**, so each
bulge sign is computed from the arc's own start, end and center after the flip,
never from a rule about which way the path turns. `tests/core.dxf.js` reads files
back and checks both: an L keeps its foot at the bottom, and rounded squares
rebuilt from vertices and bulges have their exact cut-path area (a reversed bulge
would be about 20% off).

## Traps

- **Every morphology step that ADDS metal must re-thicken it.** Filling a cut throat
  narrower than the smallest hole makes a metal wall as thin as the throat was
  short. Growing thin metal from discs leaves necks where two discs barely
  overlap. Both happened: on a Turing photo, necks of 0.64 mm with a 0.8 mm web,
  and traced outlines crossing where the kerf would cut through them.
  `cutsheet.thicken` (grow the thin parts, then drop what is still narrower than
  the web) runs after both the cleanup and the final sliver fill. The harness now
  checks the measured web on a busy image as well as a ramp, because the ramp
  never showed it.
- **An opening can strand a single metal pixel** between two cut discs, which is
  loose metal. `finishSheet` cuts away specks that the fill leaves loose, and
  reports anything larger as unresolved rather than hiding it.
- **Sizes are Float32.** A hole cut exactly at a limit reads back about 1e-7 mm either
  side of it, so a test comparing against a limit needs a tolerance of about 1e-5, not
  1e-9.
- **All randomness is seeded** (`shim/random.js` mulberry32): the palette
  suggester, the Voronoi and stipple placement, and the Turing screen, each with a
  Seed control where it shows. Nothing calls `Math.random`, and the harness checks
  that two runs are identical and that another seed differs.
- **Stacking order is a design choice, not a sort.** The base shows only through every
  hole, so it gets the least area. The suggester puts the most-used color on top, but a
  user with a black base in mind should reorder the sheets. The app allows it.
