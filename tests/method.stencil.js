// Stencil: bridges hold every island in, in the style asked for; floating parts
// come out as separate pieces when allowed; no metal thinner than the web and no
// slot narrower than the smallest hole; the kerf offset; color sheets layered by
// palette region with the registration extension; halftone inside shapes.
//
// Structure is checked on an INDEPENDENT raster: the sheet's traced contours are
// filled at 20 px/mm and grown by the kerf (render.rasterizeHoles), then shrunk
// by just under web/2 and flood-filled. One piece means every connection is at
// least the web wide, which is a stronger claim than merely "one piece".

import { check, section, num, makeRGBA, plain, metalOf, thickPieces } from './runner.js';
import method from '../src/methods/stencil.js';
import { pieceCount } from '../src/core/structure.js';
import { opening } from '../src/core/edt.js';
import { layerSVG } from '../src/core/svg.js';
import { polyArea, polyPerimeter } from '../src/core/polygon.js';

const base = { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15 };
const PX = 20;

/** 300×200 px (60×40 mm): three white rings on black -- each ring's middle is an
 * island -- plus a hairline of black across a white bar (metal too thin to keep
 * as drawn) and a hairline of white across the black (a slot too thin to cut). */
function rings() {
  const cs = [[75, 100], [150, 100], [225, 100]];
  return makeRGBA(300, 200, (x, y) => {
    for (const [cx, cy] of cs) {
      const r = Math.hypot(x - cx, y - cy);
      if (r >= 20 && r <= 40) return [255, 255, 255];
    }
    if (y >= 160 && y < 185 && x >= 40 && x < 260) return x === 150 ? [0, 0, 0] : [255, 255, 255];   // 0.2 mm black line in a white bar
    if (y >= 15 && y < 45 && x === 150) return [255, 255, 255];                                      // 0.2 mm white slot
    return [0, 0, 0];
  });
}

export function run() {
  section('method.stencil', 'Bridges by style, floating parts, feature sizes, kerf offset, palette layering, halftone inside shapes.');
  const img = rings();

  // ---- bridges, three styles
  for (const style of ['auto', 'horizontal', 'vertical']) {
    const b = method.build(img, base, { bridges: style });
    const holes = b.layers[0];
    const { M, w, h } = metalOf(b, holes, base.kerf);
    const pieces = pieceCount({ ...b, kerf: base.kerf }, holes, PX);
    const thick = thickPieces(M, w, h, base.web);
    const br = b.debug.bridges;
    const offStyle = br.filter((x) => (style === 'horizontal' && x.dy !== 0) || (style === 'vertical' && x.dx !== 0)).length;
    check(`${style} bridges: one piece, and still one piece shrunk by just under web/2`,
      pieces === 1 && thick === 1 && b.debug.unresolved === 0,
      `${pieces} piece(s), ${thick} when shrunk, ${br.length} bridges, ${b.debug.unresolved} unresolved`);
    check(`${style} bridges: at least two per island, all in the style asked for`,
      br.length >= 6 && offStyle === 0 && b.debug.fallback === 0,
      `${br.length} bridges for 3 islands, ${offStyle} off-style, ${b.debug.fallback} fell back`);
  }

  // ---- floating parts
  {
    const b = method.build(img, base, { floating: true });
    const pieces = pieceCount({ ...b, kerf: base.kerf }, b.layers[0], PX);
    check('floating parts: no bridges, and each island comes out as its own piece',
      b.debug.bridges.length === 0 && pieces === 4 && b.debug.floating === 3,
      `${pieces} pieces, ${b.debug.floating} reported floating`);
  }

  // ---- feature sizes (smoothing off: at its default 0.5 mm it blurs a 0.2 mm
  // hairline away before the threshold, and the cleanup would never see it)
  {
    const b = method.build(img, base, { smooth: 0 });
    const { M, w, h } = metalOf(b, b.layers[0], base.kerf);
    const C = M.map((v) => 1 - v);
    const open = opening(C, w, h, (base.minHole / 2) * PX - 1.5);
    let cut = 0, kept = 0;
    for (let i = 0; i < C.length; i++) { cut += C[i]; kept += open[i]; }
    check('no cut slot narrower than the smallest hole', kept / cut > 0.995,
      `${num(100 * (1 - kept / cut), 3)}% of the cut is narrower than ${base.minHole} mm`);
    const at = (xmm, ymm) => M[Math.floor(ymm * PX) * w + Math.floor(xmm * PX)];
    check('a black hairline in a white area is kept, thickened', at(30.1, 34.5) === 1 && at(30.1 + base.web / 2 - 0.1, 34.5) === 1,
      'metal at the line and within web/2 of it');
    check('a white hairline in a black area is not cut', at(30.1, 6) === 1, 'metal where the 0.2 mm slot was');
  }

  // ---- kerf: every cut path moves in by kerf/2
  {
    const a = method.build(img, { ...base, kerf: 0 }, {}), c = method.build(img, { ...base, kerf: 0.3 }, {});
    const area = (b) => b.layers[0].reduce((s, L) => s + L.sign * polyArea(L), 0);
    const per = a.layers[0].reduce((s, L) => s + polyPerimeter(L), 0);
    const shift = (area(a) - area(c)) / per;
    check('kerf: the cut path sits kerf/2 inside the shape', Math.abs(shift - 0.15) < 0.02,
      `mean inward offset ${num(shift, 4)} mm for a 0.3 mm kerf`);
  }

  // ---- export
  {
    const b = method.build(img, base, {});
    const { text, holes } = layerSVG({ ...b, kerf: base.kerf }, b.layers[0], { name: 'stencil' });
    const paths = [...text.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1]);
    check('SVG: one closed path per contour, no non-finite coordinates',
      paths.length === holes && paths.every((d) => d.endsWith('Z')) && !/NaN|Infinity/.test(text),
      `${paths.length} paths`);
    const depths = b.layers[0].map((L) => L.depth);
    check('SVG: innermost contours are cut first', depths.every((d, i) => i === 0 || d <= depths[i - 1]),
      `depths in order: ${[...new Set(depths)].join(' → ')}`);
  }

  // ---- color: layered by palette region, registration hidden under the top sheet
  {
    const pal = ['#202020', '#d02020', '#2040d0'];
    const s = { ...base, mode: 'color', palette: pal, reg: 0.3 };
    // red block 12..48 mm × 8..32 mm; blue block 30..56 × 14..26, running out of
    // the red into the dark on the right
    const im = makeRGBA(300, 200, (x, y) => {
      if (x >= 150 && x < 280 && y >= 70 && y < 130) return [32, 64, 208];
      if (x >= 60 && x < 240 && y >= 40 && y < 160) return [208, 32, 32];
      return [32, 32, 32];
    });
    const b = method.build(im, s, {});
    const { cuts, k, ww } = b.debug;
    const row = Math.floor(20 * k);
    const lastCut = (C) => { let l = -1; for (let i = 0; i < ww; i++) if (C[row * ww + i]) l = i; return l; };
    const firstCut = (C, from) => { for (let i = from; i < ww; i++) if (C[row * ww + i]) return i; return -1; };
    const extRight = (lastCut(cuts[1]) - lastCut(cuts[0])) / k;
    const extLeft = firstCut(cuts[1], 0) / k - 30;      // the blue block's left edge is at 30 mm
    check('color: the blue sheet’s cut runs under the dark top sheet by the registration allowance',
      Math.abs(extRight - s.reg) <= 1.5 / k, `extends ${num(extRight, 3)} mm past the top sheet’s edge (want ${s.reg})`);
    check('color: and does not reach into the red, where it would show', Math.abs(extLeft) <= 1.5 / k,
      `starts ${num(extLeft, 3)} mm from the red/blue boundary`);
    const pieces = b.layers.map((L) => pieceCount({ ...b, kerf: s.kerf }, L, PX));
    check('color: every cut sheet is one piece', pieces.every((p) => p === 1), pieces.join(', '));
    let err = 0;
    for (let i = 0; i < b.N * 3; i++) err += Math.abs(b.achieved[i] - b.target[i]);
    check('color: each region shows its own sheet', err / (b.N * 3) < 0.02, `mean |Δ| ${num(err / (b.N * 3), 4)} (linear)`);
  }

  // ---- keep bridges on the sheet below: a dark island inside a ring, red on
  // top and blue below. The top sheet's bridges to the island cross the ring;
  // the red sheet beneath is cut where the ring is blue, so only bridges over
  // the red half rest on metal.
  {
    const pal = ['#202020', '#d02020', '#2040d0'];
    const s = { ...base, mode: 'color', palette: pal, reg: 0 };
    const img = makeRGBA(300, 200, (x, y) => {
      const r = Math.hypot(x - 150, y - 100);
      if (r >= 20 && r <= 40) return y < 100 ? [208, 32, 32] : [32, 64, 208];
      return [32, 32, 32];
    });
    const overBlue = (b) => {
      const { lab, k, ww, wh } = b.debug, ky = wh / b.heightMm;
      let n = 0;
      for (const br of b.debug.bridges) {
        for (let t = 0; t <= 20; t++) {
          const x = br.x0 + ((br.x1 - br.x0) * t) / 20, y = br.y0 + ((br.y1 - br.y0) * t) / 20;
          if (lab[Math.floor(y * ky) * ww + Math.floor(x * k)] === 2) n++;
        }
      }
      return n;
    };
    const off = method.build(img, s, {}), on = method.build(img, s, { supported: true });
    const pieces = pieceCount({ ...on, kerf: s.kerf }, on.layers[0], PX);
    check('without the option, a bridge crosses the blue half, over the hole in the red sheet beneath',
      overBlue(off) > 0, `${overBlue(off)} bridge samples over blue, ${off.debug.bridges.length} bridges`);
    check('keep bridges on the sheet below: none crosses the blue, and the top sheet is still one piece',
      overBlue(on) === 0 && on.debug.bridges.length > 0 && pieces === 1 && on.debug.unsupported === 0 && on.debug.unresolved === 0,
      `${overBlue(on)} samples over blue, ${on.debug.bridges.length} bridges, ${pieces} piece(s)`);
    check('the option leaves the sheet beneath alone', on.layers[1].length === off.layers[1].length);
    // a ring all blue but for a red notch 1.2 mm wide at the bottom: the red
    // sheet's middle reaches the outside through the notch, so it has no
    // bridges of its own to stack on, and the notch is too narrow for a 1.2 mm
    // bridge to rest on. The island has no route over metal, and is cut free
    // to glue down -- onto the red sheet, which is metal under it.
    const notched = makeRGBA(300, 200, (x, y) => {
      const r = Math.hypot(x - 150, y - 100);
      if (r < 20 || r > 40) return [32, 32, 32];
      return y > 100 && Math.abs(x - 150) < 3 ? [208, 32, 32] : [32, 64, 208];
    });
    const cut = method.build(notched, s, { supported: true, smooth: 0 });
    const cp = pieceCount({ ...cut, kerf: s.kerf }, cut.layers[0], PX);
    check('no route over metal: the island is cut free to glue down, and the note says so',
      cut.debug.bridges.length === 0 && cut.debug.unsupported === 1 && cut.debug.unresolved === 0 && cp === 2 &&
        cut.webs[0] === s.web && /1 parts could not be bridged over the sheet below — cut free to glue down/.test(cut.note),
      `${cut.debug.unsupported} cut free, ${cp} pieces, web ${num(cut.webs[0], 3)} · ${cut.note}`);
  }

  // ---- halftone inside shapes
  {
    // a light disc (radius 15 mm) with a ramp inside it -- every value above the
    // threshold, so the whole disc is one shape -- on black
    const im = makeRGBA(300, 200, (x, y) => {
      const r = Math.hypot(x - 150, y - 100);
      if (r > 75) return [0, 0, 0];
      const v = Math.round(150 + 105 * (x - 75) / 150);
      return [v, v, v];
    });
    const b = method.build(im, base, { halftone: true, pitch: 2.5, smooth: 0 });
    const holes = b.layers[0];
    // inside ITS SHAPE: the shape the method thresholded, sampled round each
    // finished hole's rim, half a work pixel in
    const { lab, k, ww } = b.debug;
    let outside = 0;
    for (const hl of holes) {
      const rr = (hl.a + base.kerf) / 2 - 0.5 / k;
      for (let t = 0; t < 24; t++) {
        const x = hl.cx + rr * Math.cos((t * Math.PI) / 12), y = hl.cy + rr * Math.sin((t * Math.PI) / 12);
        if (!lab[Math.floor(y * k) * ww + Math.floor(x * k)]) { outside++; break; }
      }
    }
    const pieces = pieceCount({ ...b, kerf: base.kerf }, holes, PX);
    check('halftone: round holes, each inside its shape, the sheet one piece',
      holes.length > 50 && holes.every((hl) => hl.kind === 'rsq') && outside === 0 && pieces === 1 && b.webs[0] >= base.web - 1e-9,
      `${holes.length} holes, ${outside} outside the disc, ${pieces} piece(s), thinnest web ${num(b.webs[0], 3)} mm`);
    const left = holes.filter((hl) => hl.cx < 25), right = holes.filter((hl) => hl.cx > 35);
    const mean = (hs) => hs.reduce((s, hl) => s + hl.a, 0) / hs.length;
    check('halftone: holes grow with the tone', mean(right) > mean(left),
      `mean cut diameter ${num(mean(left), 3)} mm on the dark side, ${num(mean(right), 3)} on the light`);
  }

  // ---- border: folded into the structural rim at the raster stage (not
  // dropped from the traced loops afterward), so a loop that merely grazes the
  // border is clipped, not thrown away whole.
  {
    // A border well clear of the rings changes nothing: same three islands.
    const plain0 = method.build(img, base, {});
    const clear = method.build(img, { ...base, border: 4 }, {});
    check('a border clear of the shapes leaves them alone',
      clear.layers[0].length === plain0.layers[0].length && clear.debug.unresolved === 0,
      `${plain0.layers[0].length} islands unbordered, ${clear.layers[0].length} with a 4 mm border`);

    // A border that reaches into a ring clips it -- the rest of the sheet still
    // traces, and nothing is cut inside the border band.
    const wide = method.build(img, { ...base, border: 10 }, {});
    let inBorder = 0;
    for (const hl of wide.layers[0]) {
      for (let i = 0; i < hl.fx.length; i++) {
        const x = hl.fx[i], y = hl.fy[i];
        if (x < 10 || y < 10 || x > wide.widthMm - 10 || y > wide.heightMm - 10) inBorder++;
      }
    }
    check('nothing is cut inside a wide border', inBorder === 0, `${inBorder} finished vertices inside the border band`);
    check('the rest of the sheet still traces, one piece',
      wide.layers[0].length > 0 && pieceCount({ ...wide, kerf: base.kerf }, wide.layers[0], PX) === 1);
  }

  // ---- determinism
  {
    const a = method.build(img, base, {}), c = method.build(img, base, {});
    const key = (b) => b.layers[0].map((L) => `${L.xs.length}:${L.xs[0].toFixed(6)}`).join(';');
    check('two runs on the same input are identical', key(a) === key(c));
  }
}
