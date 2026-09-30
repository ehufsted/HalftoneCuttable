// Style filters, starting with XDoG ink lines.
//
// PREDICTIONS.
//  - "None" hands the method the very same pixels: nothing downstream can change.
//  - A step edge draws ONE line, on its dark side, next to the edge; far from the
//    edge both sides stay paper (both are above the fill level).
//  - The line's width follows the Line scale, and is the same in millimetres on a
//    bigger piece (σ is set in mm).
//  - Flat areas below the fill level fill with ink; above it they stay paper.
//  - Following the edges joins a noisy edge's line into fewer pieces.
//  - "Lines over image" leaves colour alone away from the lines.
//  - Lines only, through the stencil, cuts a line drawing that is one piece.

import { check, section, num, makeRGBA, flatGrey, mkRand, plain, say } from './runner.js';
import { applyStyle } from '../src/core/style.js';
import { lowPolyMesh } from '../src/core/lowpoly.js';
import { LINEAR_LUT } from '../src/core/color.js';
import { components } from '../src/core/edt.js';
import { runPipeline } from '../src/pipeline.js';
import { pieceCount } from '../src/core/structure.js';
import stencil from '../src/methods/stencil.js';

const W = 400, H = 100;
const step = (noise = 0, seed = 1, dark = 0.35, light = 0.85) => {
  const r = mkRand(seed);
  return makeRGBA(W, H, (x) => {
    const v = (x < W / 2 ? dark : light) + noise * (r() - 0.5);
    const c = Math.round(255 * Math.max(0, Math.min(1, v)));
    return [c, c, c];
  });
};
const xd = (o) => ({ filter: 'xdog', output: 'lines', scale: 0.6, strength: 20, threshold: 0.3, flow: false, ...o });

/** Dark run along the middle row: [first, last] pixel with ink (< 0.5), or null. */
function inkRun(img, row = H / 2) {
  let a = -1, b = -1;
  for (let x = 0; x < img.width; x++) {
    if (img.data[4 * (row * img.width + x)] < 128) { if (a < 0) a = x; b = x; }
  }
  return a < 0 ? null : [a, b];
}

export function run() {
  section('core.style', 'XDoG: identity at None, the line on a step edge, its width in mm, fill level, following edges, overlay, a cut drawing. Kuwahara: grain vs edges, flat colour, anisotropy. The chain: order, old settings. Low-poly: tiling, tone, median, adaptive, edges, uniform. Blur: flat colour unchanged, edge softens with radius, radius 0 is identity. CLAHE: local not global, contrast limit, hue kept. Posterize: recovers the palette, deterministic, cleanup absorbs a fleck.');

  {
    const img = step();
    check('None passes the image through untouched', applyStyle(img, { filter: 'none' }, 80) === img && applyStyle(img, undefined, 80) === img);
  }

  // ---- one line, on the dark side of the edge (piece 80 mm wide: 5 px per mm)
  {
    const out = applyStyle(step(), xd(), 80);
    const run = inkRun(out);
    const px = W / 80;
    const farWhite = [20, 100, 300, 380].every((x) => out.data[4 * ((H / 2) * W + x)] > 250);
    check('a step edge draws one line on its dark side, and nothing far from it',
      run && run[1] < W / 2 && run[1] >= W / 2 - 2 && farWhite,
      run ? `ink from ${num(run[0] / px, 2)} to ${num((run[1] + 1) / px, 2)} mm, the edge at 40 mm` : 'no ink');
  }

  // ---- width follows the scale, in millimetres
  {
    const width = (scale, widthMm) => {
      const out = applyStyle(step(), xd({ scale }), widthMm);
      const r = inkRun(out);
      return r ? ((r[1] - r[0] + 1) * widthMm) / W : 0;
    };
    const w05 = width(0.5, 80), w10 = width(1.0, 80), w10big = width(1.0, 160);
    check('the line is broader for a bigger Line scale', w10 / w05 > 1.5 && w10 / w05 < 2.6,
      `${num(w05, 2)} mm at 0.5, ${num(w10, 2)} mm at 1.0 (×${num(w10 / w05, 2)})`);
    check('and the same width in mm on a piece twice as wide', Math.abs(w10big - w10) / w10 < 0.25,
      `${num(w10, 2)} mm on an 80 mm piece, ${num(w10big, 2)} mm on 160 mm`);
  }

  // ---- the fill level
  {
    const dark = applyStyle(flatGrey(60, 60, 50), xd(), 30), light = applyStyle(flatGrey(60, 60, 160), xd(), 30);
    check('flat areas below the fill level fill with ink, above it stay paper',
      dark.data[4 * 1830] < 10 && light.data[4 * 1830] > 245,
      `grey 50 → ${dark.data[4 * 1830]}, grey 160 → ${light.data[4 * 1830]} (fill level 0.3)`);
  }

  // ---- following edges joins a noisy line. Counted in the band round the edge:
  // grain in FLAT areas is not its job (the direction field fades out there by
  // design), and counting it made this measure speckle instead of the line. And on
  // a FAINT edge (0.55 against 0.70): a strong one draws a solid line with or
  // without help, which tests nothing.
  {
    const pieces = (flow) => {
      const out = applyStyle(step(0.2, 7, 0.55, 0.7), xd({ flow }), 80);
      const x0 = W / 2 - 20, x1 = W / 2 + 5, bw = x1 - x0;
      const ink = new Uint8Array(bw * H);
      for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) ink[y * bw + x - x0] = out.data[4 * (y * W + x)] < 128 ? 1 : 0;
      return components(ink, bw, H).sizes.length;
    };
    const off = pieces(false), on = pieces(true);
    check('following the edges joins a noisy edge’s line into fewer pieces', on < off / 2,
      `${off} ink fragments along the edge without, ${on} with`);
  }

  // ---- overlay keeps colour
  {
    const img = makeRGBA(W, H, (x) => (x < W / 2 ? [60, 60, 200] : [220, 90, 60]));
    const out = applyStyle(img, xd({ output: 'over', threshold: 0 }), 80);
    const same = [10, 100, 300, 390].every((x) => { const q = 4 * ((H / 2) * W + x); return out.data[q] === img.data[q] && out.data[q + 1] === img.data[q + 1] && out.data[q + 2] === img.data[q + 2]; });
    const q = 4 * ((H / 2) * W + inkRun(applyStyle(img, xd({ threshold: 0 }), 80))[0]);
    check('lines over image: colour untouched away from the lines, darkened on them', same && out.data[q] < img.data[q] / 2,
      `on the line: ${out.data[q]},${out.data[q + 1]},${out.data[q + 2]}`);
  }

  // ---- a cut line drawing
  {
    const s = { ...plain, widthMm: 80, web: 0.6, minHole: 0.6, kerf: 0.15, style: xd() };
    const res = runPipeline(step(), s, 'stencil', { smooth: 0 }, { preview: false });
    const b = stencil.build(applyStyle(step(), s.style, 80), s, { smooth: 0 });
    const pieces = pieceCount({ ...b, kerf: s.kerf }, b.layers[0], 20);
    check('lines only through the stencil: a cut drawing, one piece',
      res.layers[0].length > 0 && pieces === 1 && res.stats.layers[0].openFraction > 0.5,
      `${res.layers[0].length} contours, ${num(100 * res.stats.layers[0].openFraction, 1)}% open, ${pieces} piece(s)`);
  }

  // ================= Blur (Gaussian) =================

  // ---- a flat colour passes through unchanged
  {
    const flat = makeRGBA(40, 40, () => [180, 70, 40]);
    const out = applyStyle(flat, { chain: [{ id: 'blur', radius: 3 }] }, 20);
    let worst = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      worst = Math.max(worst, Math.abs(out.data[i] - 180), Math.abs(out.data[i + 1] - 70), Math.abs(out.data[i + 2] - 40));
    }
    check('blur: a flat colour comes through unchanged', worst <= 1, `worst channel change ${worst}/255`);
  }

  // ---- softens a step edge, and further with a larger radius (5 px/mm at 80 mm)
  {
    const riseWidth = (radius) => {
      const out = applyStyle(step(), { chain: [{ id: 'blur', radius }] }, 80);
      const prof = new Float64Array(W);
      for (let x = 0; x < W; x++) prof[x] = out.data[4 * ((H / 2) * W + x)];
      const lo = prof[20], hi = prof[W - 20];
      const at = (f) => { for (let x = 0; x < W; x++) if (prof[x] >= lo + f * (hi - lo)) return x; return W; };
      return (at(0.9) - at(0.1)) * (80 / W);
    };
    const r1 = riseWidth(0.3), r2 = riseWidth(1.5);
    check('blur: a larger radius softens the edge further', r2 > r1 * 2,
      `10–90% rise ${num(r1, 2)} mm at 0.3 mm radius, ${num(r2, 2)} mm at 1.5 mm`);
  }

  // ---- radius 0 changes nothing (the same object, like an empty chain)
  {
    const img = flatGrey(20, 20, 128);
    check('blur: radius 0 is an identity', applyStyle(img, { chain: [{ id: 'blur', radius: 0 }] }, 20) === img);
  }

  // ================= CLAHE =================

  // ---- local, not global: two widely separated flat bands each get their OWN
  // local stretch, roughly the same size, regardless of their very different
  // absolute brightness -- a global equalization would treat the two very
  // differently, since it sees one combined histogram with two far-apart humps.
  // (The stretch itself is modest, not a full 0-255 spread: contrast limiting
  // spreads the clipped mass over all 256 bins, most of which hold none of a
  // narrow band's own data, which is the point of the "limited" in CLAHE -- it
  // is what keeps a truly flat, grainy tile from being blown into full-contrast
  // noise, exactly as tested below.)
  {
    const W2 = 200, H2 = 60;
    const img = makeRGBA(W2, H2, (x) => {
      const v = x < 100 ? 100 + (20 * x) / 99 : 200 + (20 * (x - 100)) / 99;
      const c = Math.round(v);
      return [c, c, c];
    });
    // 4 tiles across (25 mm at 2 px/mm = 50 px), so the band boundary at x=100
    // falls exactly on a tile edge, not inside a straddling one.
    const out = applyStyle(img, { chain: [{ id: 'clahe', tileSize: 25, clipLimit: 4 }] }, 100);
    const at = (x) => out.data[4 * ((H2 / 2) * W2 + x)];
    const leftSpread = Math.abs(at(99) - at(0)), rightSpread = Math.abs(at(199) - at(100));
    check('CLAHE: two widely separated bands get a similar local stretch, well beyond their own 20-unit input range',
      leftSpread > 25 && rightSpread > 25 && Math.abs(leftSpread - rightSpread) < 15,
      `left band 100→120 spreads to ${leftSpread}/255, right band 200→220 spreads to ${rightSpread}/255`);
  }

  // ---- contrast limit: a higher limit allows more local stretch of a narrow,
  // near-uniform band (a lower limit clips the histogram harder, spreading more
  // of it as a flat "bonus" across every bin instead of concentrating the CDF's
  // rise within the band actually present)
  {
    const r = mkRand(4);
    const img = makeRGBA(60, 60, () => { const c = Math.round(124 + r() * 8); return [c, c, c]; });
    const spreadAt = (clipLimit) => {
      const out = applyStyle(img, { chain: [{ id: 'clahe', tileSize: 40, clipLimit }] }, 30);
      let lo = 255, hi = 0;
      for (let i = 0; i < out.data.length; i += 4) { lo = Math.min(lo, out.data[i]); hi = Math.max(hi, out.data[i]); }
      return hi - lo;
    };
    const low = spreadAt(1), high = spreadAt(8);
    check('CLAHE: a higher contrast limit stretches a narrow band further', high > low,
      `output spread ${low}/255 at limit 1, ${high}/255 at limit 8`);
  }

  // ---- hue is kept, only luminance is remapped
  {
    const img = makeRGBA(60, 60, () => [200, 80, 40]);
    const out = applyStyle(img, { chain: [{ id: 'clahe', tileSize: 20, clipLimit: 3 }] }, 30);
    const q = 4 * (30 * 60 + 30);
    const ratioIn = [80 / 200, 40 / 200], ratioOut = [out.data[q + 1] / out.data[q], out.data[q + 2] / out.data[q]];
    const diff = Math.max(...ratioIn.map((v, i) => Math.abs(v - ratioOut[i])));
    check('CLAHE: hue is kept, only luminance is remapped', diff < 0.02,
      `g/r, b/r in ${ratioIn.map((v) => num(v, 3))}, out ${ratioOut.map((v) => num(v, 3))}`);
  }

  // ================= Posterize =================

  // ---- a 3-colour image recovers all 3 colours, and nothing else
  {
    const W2 = 90, H2 = 30;
    const cols = [[220, 40, 40], [40, 180, 60], [40, 60, 220]];
    const img = makeRGBA(W2, H2, (x) => cols[Math.min(2, Math.floor(x / 30))]);
    const out = applyStyle(img, { chain: [{ id: 'posterize', levels: 3, cleanup: 0, seed: 1 }] }, 45);
    const vals = new Set();
    for (let i = 0; i < out.data.length; i += 4) vals.add(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`);
    const centres = [15, 45, 75].map((x) => { const q = 4 * ((H2 / 2) * W2 + x); return [out.data[q], out.data[q + 1], out.data[q + 2]]; });
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 15;
    const matched = cols.every((c) => centres.some((o) => near(c, o)));
    check('posterize: a 3-colour image recovers exactly those 3 colours', vals.size === 3 && matched,
      `${vals.size} distinct colours; recovered ${centres.map((c) => c.join('/')).join(' ')}`);
  }

  // ---- deterministic for a given seed
  {
    const img = makeRGBA(60, 60, (x, y) => [Math.round((255 * x) / 59), Math.round((255 * y) / 59), 128]);
    const a = applyStyle(img, { chain: [{ id: 'posterize', levels: 4, cleanup: 0, seed: 3 }] }, 30);
    const b = applyStyle(img, { chain: [{ id: 'posterize', levels: 4, cleanup: 0, seed: 3 }] }, 30);
    let same = true;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) { same = false; break; }
    check('posterize: the same image and seed posterize identically', same);
  }

  // ---- shape cleanup absorbs a small fleck into its surroundings
  {
    const W3 = 60, H3 = 60;
    const fleck = (x, y) => x >= 28 && x <= 31 && y >= 28 && y <= 31;   // a 4×4 speck
    const bg = [40, 180, 60], fleckCol = [220, 40, 40];
    const img = makeRGBA(W3, H3, (x, y) => (fleck(x, y) ? fleckCol : bg));
    const mid = 4 * ((H3 / 2) * W3 + W3 / 2), bgPix = 4 * ((H3 / 2) * W3 + 5);
    const diff = (q1, q2, im) => Math.abs(im.data[q1] - im.data[q2]) + Math.abs(im.data[q1 + 1] - im.data[q2 + 1]) +
      Math.abs(im.data[q1 + 2] - im.data[q2 + 2]);
    // 60 px at 30 mm = 2 px/mm; cleanup 3 mm -> r = 3 px, well over the 4 px fleck
    const withCleanup = applyStyle(img, { chain: [{ id: 'posterize', levels: 2, cleanup: 3, seed: 1 }] }, 30);
    const noCleanup = applyStyle(img, { chain: [{ id: 'posterize', levels: 2, cleanup: 0, seed: 1 }] }, 30);
    check('posterize: shape cleanup absorbs a small fleck into its surroundings',
      diff(mid, bgPix, withCleanup) < 10 && diff(mid, bgPix, noCleanup) > 100,
      `colour difference, fleck vs background: ${diff(mid, bgPix, withCleanup)} with cleanup, ` +
      `${diff(mid, bgPix, noCleanup)} without`);
  }

  // ================= Kuwahara, and the chain =================

  // ---- smooths grain, keeps the edge (40 mm piece, 10 px per mm; brush 2 mm)
  {
    const KW = 400, KH = 200;
    const r = mkRand(3);
    const noisy = makeRGBA(KW, KH, (x) => { const v = (x < KW / 2 ? 0.25 : 0.75) + 0.2 * (r() - 0.5); const c = Math.round(255 * v); return [c, c, c]; });
    const out = applyStyle(noisy, { chain: [{ id: 'kuwahara', size: 2 }] }, 40);
    const sd = (im) => { let s = 0, s2 = 0, n = 0;
      for (let y = 20; y < KH - 20; y++) for (let x = 20; x < 150; x++) { const v = im.data[4 * (y * KW + x)]; s += v; s2 += v * v; n++; }
      return Math.sqrt(s2 / n - (s / n) ** 2); };
    const before = sd(noisy), after = sd(out);
    // mean profile across the edge, rows averaged; 10-90% rise width
    const prof = new Float64Array(KW);
    for (let y = 20; y < KH - 20; y++) for (let x = 0; x < KW; x++) prof[x] += out.data[4 * (y * KW + x)] / (KH - 40);
    const lo = prof[150], hi = prof[250], at = (f) => { for (let x = 150; x < 250; x++) if (prof[x] >= lo + f * (hi - lo)) return x; return 250; };
    const rise = (at(0.9) - at(0.1)) / 10;
    check('kuwahara: flattens grain in flat areas, keeps an edge sharp',
      before / after > 3 && rise <= 0.6,
      `grain ${num(before, 1)} → ${num(after, 1)} (×${num(before / after, 1)} smoother); edge rises 10–90% over ${num(rise, 2)} mm with a 2 mm brush`);
  }

  // ---- flat colour passes through
  {
    const flat = makeRGBA(80, 60, () => [180, 70, 40]);
    const out = applyStyle(flat, { chain: [{ id: 'kuwahara', size: 3 }] }, 20);
    let worst = 0;
    for (let i = 0; i < out.data.length; i += 4) worst = Math.max(worst, Math.abs(out.data[i] - 180), Math.abs(out.data[i + 1] - 70), Math.abs(out.data[i + 2] - 40));
    check('kuwahara: a flat colour comes through unchanged', worst <= 1, `worst channel change ${worst}/255`);
  }

  // ---- anisotropy stretches the patches along the image's direction
  {
    const S = 300, r = mkRand(4);
    const radial = makeRGBA(S, S, (x, y) => { const v = Math.max(0, 1 - Math.hypot(x - 150, y - 150) / 150) * 0.8 + 0.1 + 0.25 * (r() - 0.5); const c = Math.round(255 * Math.max(0, Math.min(1, v))); return [c, c, c]; });
    const texture = (A) => {
      const out = applyStyle(radial, { chain: [{ id: 'kuwahara', size: 3, anisotropy: A }] }, 30);   // 10 px/mm
      // high-pass (the patch texture), then its direction against the circles
      const g = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) g[i] = out.data[4 * i];
      const hp = new Float32Array(S * S), R = 6;
      for (let y = R; y < S - R; y++) for (let x = R; x < S - R; x++) {
        let m = 0; for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) m += g[(y + dy) * S + x + dx];
        hp[y * S + x] = g[y * S + x] - m / 49;
      }
      let num_ = 0, den = 0;
      for (let y = R + 1; y < S - R - 1; y++) for (let x = R + 1; x < S - R - 1; x++) {
        const rr = Math.hypot(x - 150, y - 150); if (rr < 40 || rr > 130) continue;
        const i = y * S + x, gx = hp[i + 1] - hp[i - 1], gy = hp[i + S] - hp[i - S], e = gx * gx + gy * gy;
        const stroke = Math.atan2(gy, gx) + Math.PI / 2, tangent = Math.atan2(y - 150, x - 150) + Math.PI / 2;
        num_ += e * Math.cos(2 * (stroke - tangent)); den += e;
      }
      return num_ / den;
    };
    const a0 = texture(0), a2 = texture(2);
    check('kuwahara: anisotropy stretches the patches along the edges', a2 > a0 + 0.15,
      `patch texture aligned with the edges: ${num(a0, 2)} at anisotropy 0, ${num(a2, 2)} at 2`);
  }

  // ---- the chain: order matters, and the older single-filter settings still work
  {
    const img = step(0.15, 9, 0.35, 0.8);
    const kx = applyStyle(img, { chain: [{ id: 'kuwahara', size: 3 }, { id: 'xdog' }] }, 80);
    const xk = applyStyle(img, { chain: [{ id: 'xdog' }, { id: 'kuwahara', size: 3 }] }, 80);
    let diff = 0;
    for (let i = 0; i < kx.data.length; i += 4) diff += Math.abs(kx.data[i] - xk.data[i]);
    const legacy = applyStyle(img, { filter: 'xdog', scale: 0.6 }, 80), chained = applyStyle(img, { chain: [{ id: 'xdog', scale: 0.6 }] }, 80);
    let same = true;
    for (let i = 0; i < legacy.data.length; i++) if (legacy.data[i] !== chained.data[i]) { same = false; break; }
    check('chain: order changes the result; the old single-filter settings are a chain of one',
      diff / (W * H) > 1 && same, `mean difference between the two orders ${num(diff / (W * H), 2)}/255; old and new XDoG identical: ${same}`);
  }

  // ---- speed on a full-size image (reported, not asserted)
  {
    const big = makeRGBA(1400, 1000, (x, y) => { const v = 128 + 100 * Math.sin(x / 40) * Math.cos(y / 55); return [v, v, v]; });
    const t0 = Date.now();
    applyStyle(big, { chain: [{ id: 'kuwahara', size: 2 }] }, 200);
    say(`<p class="note">Kuwahara, 1400×1000 px at 200 mm, 2 mm brush: ${Date.now() - t0} ms.</p>`);
  }

  // ================= Low-poly =================
  {
    const lp = (o) => ({ layout: 'adaptive', size: 8, detail: 0.5, edges: true, edgeThreshold: 0.3, colour: 'average', seed: 1, ...o });
    const area = (xs, ys, tris, t) => {
      const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
      return Math.abs((xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a])) / 2;
    };

    // flat colour, both colourings
    const flat = makeRGBA(120, 90, () => [180, 70, 40]);
    let worst = 0;
    for (const colour of ['average', 'median']) {
      const out = applyStyle(flat, { chain: [{ id: 'lowpoly', ...lp({ colour, size: 4 }) }] }, 60);
      for (let i = 0; i < out.data.length; i += 4) worst = Math.max(worst, Math.abs(out.data[i] - 180), Math.abs(out.data[i + 1] - 70), Math.abs(out.data[i + 2] - 40));
    }
    check('low-poly: a flat colour comes through unchanged, averaged or median', worst <= 1, `worst channel change ${worst}/255`);

    // facets tile the image; each is one colour; tone kept by the average
    const R = 300;
    const radial = makeRGBA(R, R, (x, y) => { const v = Math.round(255 * Math.max(0, 1 - Math.hypot(x - 150, y - 150) / 170)); return [v, v, v]; });
    const mesh = lowPolyMesh(radial, lp({ size: 5 }), 60);
    let tot = 0;
    for (let t = 0; t < mesh.n; t++) tot += area(mesh.xs, mesh.ys, mesh.tris, t);
    const out = applyStyle(radial, { chain: [{ id: 'lowpoly', ...lp({ size: 5 }) }] }, 60);
    const colours = new Set();
    let lin0 = 0, lin1 = 0;
    for (let i = 0; i < R * R; i++) { colours.add(out.data[4 * i]); lin0 += LINEAR_LUT[radial.data[4 * i]]; lin1 += LINEAR_LUT[out.data[4 * i]]; }
    check('low-poly: the facets tile the image exactly, and the triangulation is clean',
      Math.abs(tot - R * R) / (R * R) < 1e-6 && mesh.report.dropped === 0 && mesh.report.malformed === 0,
      `${mesh.n} facets covering ${num(100 * tot / (R * R), 4)}% of the image; dropped ${mesh.report.dropped}, malformed ${mesh.report.malformed}`);
    check('low-poly: one flat tone per facet, and the average keeps the overall tone',
      colours.size <= mesh.n && Math.abs(lin1 - lin0) / lin0 < 0.01,
      `${colours.size} distinct tones for ${mesh.n} facets; linear light ${num(lin1 / (R * R), 4)} vs ${num(lin0 / (R * R), 4)}`);

    // median ignores specks
    const r = mkRand(12);
    const specks = makeRGBA(120, 90, () => (r() < 0.05 ? [255, 255, 255] : [100, 100, 100]));
    const med = applyStyle(specks, { chain: [{ id: 'lowpoly', ...lp({ colour: 'median', size: 6 }) }] }, 60);
    const avg = applyStyle(specks, { chain: [{ id: 'lowpoly', ...lp({ colour: 'average', size: 6 }) }] }, 60);
    let medOk = true, avgMean = 0;
    for (let i = 0; i < med.data.length; i += 4) { if (med.data[i] !== 100) medOk = false; avgMean += avg.data[i] / (med.data.length / 4); }
    check('low-poly: the median ignores specks that pull the average up', medOk && avgMean > 105,
      `median everywhere 100: ${medOk}; average ${num(avgMean, 1)} (5% white specks on grey 100)`);

    // adaptive: smaller facets where the image is busy (left flat, right textured)
    const rt = mkRand(13);
    const half = makeRGBA(300, 200, (x, y) => { const v = x < 150 ? 128 : Math.round(128 + 110 * Math.sin(x / 3) * Math.cos(y / 4) + 20 * (rt() - 0.5)); return [v, v, v]; });
    const hm = lowPolyMesh(half, lp({ size: 8, detail: 0.7, edges: false }), 60);
    let aL = 0, nL = 0, aR = 0, nR = 0;
    for (let t = 0; t < hm.n; t++) {
      const cx = (hm.xs[hm.tris[3 * t]] + hm.xs[hm.tris[3 * t + 1]] + hm.xs[hm.tris[3 * t + 2]]) / 3;
      const a = area(hm.xs, hm.ys, hm.tris, t);
      if (cx < 120) { aL += a; nL++; } else if (cx > 180) { aR += a; nR++; }
    }
    check('low-poly adaptive: facets are smaller where the image is busy', aR / nR < (aL / nL) / 2,
      `mean facet ${num(aL / nL / 25, 2)} mm² in the flat half, ${num(aR / nR / 25, 2)} mm² in the busy half`);

    // follow edges: facets do not straddle an edge
    const edgeImg = makeRGBA(300, 200, (x) => (x < 150 ? [60, 60, 60] : [200, 200, 200]));
    const straddle = (edges) => {
      const m = lowPolyMesh(edgeImg, lp({ size: 8, edges }), 60);
      let s = 0;
      for (let t = 0; t < m.n; t++) {
        const X = [0, 1, 2].map((q) => m.xs[m.tris[3 * t + q]]);
        if (Math.min(...X) < 149 && Math.max(...X) > 151) s++;
      }
      return s;
    };
    const sOff = straddle(false), sOn = straddle(true);
    check('low-poly: following edges keeps facets from straddling them', sOn < sOff / 3,
      `${sOn} facets straddle the edge with Follow edges, ${sOff} without`);

    // uniform: an even equilateral grid at the set size
    const um = lowPolyMesh(radial, lp({ layout: 'uniform', size: 5 }), 60);   // 5 px per mm
    const areas = [];
    for (let t = 0; t < um.n; t++) {
      const X = [0, 1, 2].map((q) => um.xs[um.tris[3 * t + q]]), Y = [0, 1, 2].map((q) => um.ys[um.tris[3 * t + q]]);
      if (Math.min(...X) > 30 && Math.max(...X) < R - 30 && Math.min(...Y) > 30 && Math.max(...Y) < R - 30) areas.push(area(um.xs, um.ys, um.tris, t));
    }
    const mA = areas.reduce((a, b) => a + b, 0) / areas.length;
    const cv = Math.sqrt(areas.reduce((a, b) => a + (b - mA) ** 2, 0) / areas.length) / mA;
    const side = Math.sqrt((4 * mA) / Math.sqrt(3)) / 5;
    check('low-poly uniform: an even triangle grid at the set size', cv < 0.05 && Math.abs(side - 5) / 5 < 0.1,
      `interior facets vary by ${num(100 * cv, 1)}%, side ${num(side, 2)} mm for 5 mm`);

    // speed on a full-size image (reported)
    const big = makeRGBA(1400, 1000, (x, y) => { const v = 128 + 100 * Math.sin(x / 40) * Math.cos(y / 55); return [v, v, v]; });
    const t0 = Date.now();
    applyStyle(big, { chain: [{ id: 'lowpoly', ...lp({ size: 4 }) }] }, 200);
    say(`<p class="note">Low-poly, 1400×1000 px at 200 mm, 4 mm facets: ${Date.now() - t0} ms.</p>`);
  }
}
