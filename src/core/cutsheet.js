// One cut sheet, from a raster to cuttable outlines: the machinery the stencil and
// the screen halftones share. Given a cut mask on a work raster:
//
//   cleanSheet   fill slots narrower than the smallest hole, thicken metal
//                narrower than the web, cut away specks too small to hold
//   bridgeSheet  join every core of the metal to the frame with straight bridges
//   measureWeb   the thinnest connection, by shrinking the metal until it parts
//   traceSheet   contour the cut's signed distance at -kerf/2, simplify, order
//                innermost first
//
// and scoreWindows, which scores any hole model against a per-pixel target in
// windows, through the renderer. The reasoning behind each step is in
// methods/stencil.js's header; it is the same pipeline.

import { edt, dilate, opening, invert, components } from './edt.js';
import { traceLoops, simplifyLoop, offsetLoop } from './contour.js';
import { polyArea } from './polygon.js';
import { alignmentHoles } from './holes.js';
import { rasterizeHoles } from './render.js';
import { blur } from './features.js';

export const DIRS = {
  auto: [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]],
  horizontal: [[1, 0], [-1, 0]],
  vertical: [[0, 1], [0, -1]],
};

/**
 * The work raster the stencil and the screen share: fine enough that the min web
 * spans about five pixels, capped by a pixel budget so a large piece stays fast.
 * @param {number} W, H  piece size, mm
 * @param {number} web   mm
 * @param {number} workPixels  the caller's pixel budget
 */
export function workRaster(W, H, web, workPixels) {
  const px = Math.min(Math.min(Math.max(5 / web, 4), 12), Math.sqrt(workPixels / (W * H)));
  const ww = Math.max(8, Math.round(W * px)), wh = Math.max(8, Math.round(H * px));
  return { ww, wh, k: ww / W, ky: wh / H, NP: ww * wh, px };
}

/** 1 where the piece's border must stay metal: closer than `e` mm to any edge. */
export function borderFrame(ww, wh, k, ky, W, H, e) {
  const frame = new Uint8Array(ww * wh);
  for (let q = 0; q < ww * wh; q++) {
    const i = q % ww, j = (q - i) / ww;
    const x = (i + 0.5) / k, y = (j + 0.5) / ky;
    frame[q] = Math.min(x, y, W - x, H - y) < e ? 1 : 0;
  }
  return frame;
}

/**
 * Mark `frame` metal round each alignment hole (core/holes.js): within its
 * finished radius (cut path + `d`) plus `margin`. In place.
 */
export function keepOutHoles(frame, ww, wh, k, ky, holes, d, margin) {
  for (const h of holes) {
    const R = h.a / 2 + d + margin;
    const i0 = Math.max(0, Math.floor((h.cx - R) * k)), i1 = Math.min(ww - 1, Math.ceil((h.cx + R) * k));
    const j0 = Math.max(0, Math.floor((h.cy - R) * ky)), j1 = Math.min(wh - 1, Math.ceil((h.cy + R) * ky));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (Math.hypot((i + 0.5) / k - h.cx, (j + 0.5) / ky - h.cy) < R) frame[j * ww + i] = 1;
      }
    }
  }
}

/**
 * The structural frame a raster method's sheets share: metal within `e` mm of
 * the outline, and round any alignment holes the settings ask for, `margin`
 * clear of their finished edge.
 */
export function sheetFrame(ww, wh, k, ky, W, H, s, e, margin) {
  const frame = borderFrame(ww, wh, k, ky, W, H, e);
  if (s.alignHoles) keepOutHoles(frame, ww, wh, k, ky, alignmentHoles(W, H, s.alignDist, s.alignDia, s.web, s.kerf), s.kerf / 2, margin);
  return frame;
}

/**
 * @param {object} ctx
 * @param {number} ctx.ww, ctx.wh   work raster size
 * @param {number} ctx.k, ctx.ky    pixels per mm across and down
 * @param {Uint8Array} ctx.frame    1 where the piece's border must stay metal
 * @param {number} ctx.web, ctx.hFloor, ctx.kerf   mm
 * @param {number} ctx.bridgeWidth  mm
 * @param {'auto'|'horizontal'|'vertical'} ctx.bridgeStyle
 */
export function sheetTools(ctx) {
  const { ww, wh, k, ky, frame, web, hFloor, kerf, bridgeWidth, bridgeStyle } = ctx;
  const NP = ww * wh;
  return { cleanSheet, bridgeSheet, finishSheet, measureWeb, traceSheet };

  /**
   * Make every part of the metal at least the web wide: grow the parts an
   * opening would lose (thin lines, thin walls) by web/2, then drop what is still
   * narrower -- the necks left where two grown discs barely overlap. The frame
   * stays metal. A grown hairline is 2r + 1 px wide and survives the drop.
   */
  function thicken(M) {
    const r = (web / 2) * k;
    const openM = opening(M, ww, wh, r);
    const thin = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) thin[q] = M[q] && !openM[q] ? 1 : 0;
    const grow = dilate(thin, ww, wh, r);
    const out = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) out[q] = M[q] || grow[q] || frame[q] ? 1 : 0;
    const kept = opening(out, ww, wh, r - 1);
    for (let q = 0; q < NP; q++) out[q] = kept[q] || frame[q] ? 1 : 0;
    return out;
  }

  /**
   * The metal M's connected components smaller than a 2·web square, not
   * counting whichever component the frame belongs to. Shared by cleanSheet
   * (which cuts these specks away) and finishSheet (same test, but it fills
   * them back to cut and reports the honestly-too-big leftovers separately).
   */
  function specksOf(M) {
    const { id, sizes } = components(M, ww, wh);
    const frameId = id[0];
    const speck = (4 * web * web) * k * ky;
    const drop = sizes.map((sz, c) => c !== frameId && sz < speck);
    return { id, sizes, frameId, speck, drop };
  }

  /**
   * After the bridges: fill the cut slivers they left narrower than the smallest
   * hole -- then cut away any metal that filling left loose. At pixel scale an
   * opening can strand a single metal pixel between two cut discs; found as
   * three 0.16 mm flecks on a Turing screen, where the web check read 0 mm.
   * Anything loose and larger than a speck is left alone and counted as
   * unresolved, so it shows up instead of being quietly cut away.
   */
  function finishSheet(C0, dbg) {
    // Filling a cut THROAT narrower than the smallest hole turns it into a metal
    // wall only as thick as the throat was long -- found as necks of 0.64 mm on a
    // Turing photo with a 0.8 mm web, whose traced outlines then crossed. So the
    // filled metal is thickened again, exactly as in cleanSheet.
    const M = thicken(invert(opening(C0, ww, wh, (hFloor / 2) * k)));
    const C = invert(M);
    const { id, sizes, frameId, speck, drop } = specksOf(M);
    for (let q = 0; q < NP; q++) if (id[q] >= 0 && drop[id[q]]) C[q] = 1;
    dbg.unresolved += sizes.filter((sz, c) => c !== frameId && sz >= speck).length;
    return C;
  }

  /** Step 3: fill slots too narrow to cut, thicken thin metal, drop specks. */
  function cleanSheet(C0, dbg) {
    let C = opening(C0, ww, wh, (hFloor / 2) * k);
    const M = thicken(invert(C));
    const { id, drop } = specksOf(M);
    for (let q = 0; q < NP; q++) if (id[q] >= 0 && drop[id[q]]) M[q] = 0;
    dbg.specks += drop.filter(Boolean).length;
    C = invert(M);
    return C;
  }

  /** Step 4: join every core component of the metal to the frame. */
  function bridgeSheet(C, dbg) {
    const M = invert(C);
    const rc = Math.max(0.5, (web / 2) * k - 1);
    const dC = edt(C, ww, wh);
    const core = new Uint8Array(NP);
    for (let q = 0; q < NP; q++) core[q] = M[q] && dC[q] > rc ? 1 : 0;
    const { id, sizes } = components(core, ww, wh);
    const nc = sizes.length;
    if (nc <= 1) return C;
    const frameId = id[0];
    const parent = Int32Array.from({ length: nc }, (_, i) => i);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const union = (a, b) => { parent[find(a)] = find(b); };

    // boundary samples per component, thinned to at most ~400 each
    const bnd = Array.from({ length: nc }, () => []);
    for (let q = 0; q < NP; q++) {
      if (!core[q]) continue;
      const x = q % ww;
      if ((x > 0 && !core[q - 1]) || (x < ww - 1 && !core[q + 1]) || (q >= ww && !core[q - ww]) || (q + ww < NP && !core[q + ww])) bnd[id[q]].push(q);
    }
    for (let c = 0; c < nc; c++) {
      const b = bnd[c];
      if (b.length > 400) { const step = b.length / 400; bnd[c] = Array.from({ length: 400 }, (_, i) => b[Math.floor(i * step)]); }
    }
    const R = (Math.max(bridgeWidth, web) / 2) * k;
    const maxSteps = Math.round(60 * k);

    const cast = (c, q0, dx, dy, avoid) => {
      let x = q0 % ww, y = (q0 - x) / ww, sx = x, sy = y, steps = 0;
      while (steps < maxSteps) {
        x += dx; y += dy; steps++;
        if (x < 0 || y < 0 || x >= ww || y >= wh) return null;
        const cid = id[y * ww + x];
        if (cid === c) { sx = x; sy = y; steps = 0; continue; }
        if (cid >= 0 && !avoid(cid)) {
          return { x0: sx, y0: sy, x1: x, y1: y, len: steps * Math.hypot(dx, dy), target: cid, dx, dy };
        }
      }
      return null;
    };
    /** Shortest bridge per direction from any of `comps`. */
    const bestPerDir = (comps, dirs, avoid) => dirs.map(([dx, dy]) => {
      let best = null;
      for (const c of comps) {
        for (const q of bnd[c]) {
          const b = cast(c, q, dx, dy, avoid);
          if (b && (!best || b.len < best.len)) best = b;
        }
      }
      return best;
    }).filter(Boolean);
    const paint = (b) => {
      const ax = b.x0 + 0.5, ay = b.y0 + 0.5, bx = b.x1 + 0.5, by = b.y1 + 0.5;
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - R - 1)), i1 = Math.min(ww - 1, Math.ceil(Math.max(ax, bx) + R + 1));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - R - 1)), j1 = Math.min(wh - 1, Math.ceil(Math.max(ay, by) + R + 1));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const pxc = i + 0.5, pyc = j + 0.5;
          let t = L2 > 0 ? ((pxc - ax) * ex + (pyc - ay) * ey) / L2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if ((ax + t * ex - pxc) ** 2 + (ay + t * ey - pyc) ** 2 <= R * R) M[j * ww + i] = 1;
        }
      }
      dbg.bridges.push({ x0: ax / k, y0: ay / ky, x1: bx / k, y1: by / ky, dx: b.dx, dy: b.dy });
    };
    const style = DIRS[bridgeStyle] || DIRS.auto;

    // pass 1: two bridges for every unit but the frame
    for (let c = 0; c < nc; c++) {
      if (c === frameId || bnd[c].length === 0) continue;
      const avoid = (cid) => cid === c;
      let cands = bestPerDir([c], style, avoid);
      if (!cands.length && style !== DIRS.auto) { cands = bestPerDir([c], DIRS.auto, avoid); if (cands.length) dbg.fallback++; }
      if (!cands.length) continue;
      cands.sort((a, b) => a.len - b.len);
      const first = cands[0];
      const second = cands.find((b) => b.dx * first.dx + b.dy * first.dy <= 0);
      for (const b of second ? [first, second] : [first]) { paint(b); union(c, b.target); }
    }
    // later passes: one more bridge for each cluster not yet joined to the frame
    for (let pass = 0; pass < 8; pass++) {
      const roots = new Map();
      for (let c = 0; c < nc; c++) {
        if (find(c) === find(frameId)) continue;
        const r = find(c);
        if (!roots.has(r)) roots.set(r, []);
        roots.get(r).push(c);
      }
      if (!roots.size) break;
      for (const [r, comps] of roots) {
        if (find(r) === find(frameId)) continue;
        const avoid = (cid) => find(cid) === find(r);
        let cands = bestPerDir(comps, style, avoid);
        if (!cands.length && style !== DIRS.auto) { cands = bestPerDir(comps, DIRS.auto, avoid); if (cands.length) dbg.fallback++; }
        if (!cands.length) continue;
        cands.sort((a, b) => a.len - b.len);
        paint(cands[0]);
        union(r, cands[0].target);
      }
    }
    let left = 0;
    const seen = new Set();
    for (let c = 0; c < nc; c++) {
      const r = find(c);
      if (r !== find(frameId) && !seen.has(r)) { seen.add(r); left++; }
    }
    dbg.unresolved += left;
    const out = invert(M);
    for (let q = 0; q < NP; q++) if (frame[q]) out[q] = 0;
    return out;
  }

  /**
   * The thinnest connection in the metal: the largest r for which the metal
   * shrunk by r is still one piece, doubled. Checked first at just under web/2,
   * which is what the construction promises; searched only if that fails.
   */
  function measureWeb(C) {
    const dC = edt(C, ww, wh);
    const M = invert(C);
    const onePiece = (r) => {
      const core = new Uint8Array(NP);
      for (let q = 0; q < NP; q++) core[q] = M[q] && dC[q] > r ? 1 : 0;
      return components(core, ww, wh).sizes.length <= 1;
    };
    const rWeb = (web / 2) * k - 1;
    if (onePiece(rWeb)) return web;
    let lo = 0, hi = rWeb;
    if (!onePiece(0)) return 0;
    for (let it = 0; it < 8; it++) {
      const mid = (lo + hi) / 2;
      if (onePiece(mid)) lo = mid; else hi = mid;
    }
    return (2 * (lo + 1)) / k;
  }

  /** Step 5: the cut path, kerf-offset, as loops in mm; innermost cut first. */
  function traceSheet(C) {
    const dCut = edt(C, ww, wh), dMet = edt(invert(C), ww, wh);
    const sd0 = new Float32Array(NP);
    for (let q = 0; q < NP; q++) sd0[q] = C[q] ? -(dMet[q] - 0.5) : dCut[q] - 0.5;
    // A signed distance from a binary mask steps along every diagonal edge, and
    // contouring it traced pixel staircases, faceted into 0/45/90° by the
    // simplification. A one-pixel blur makes it a smooth ramp; the contour then
    // follows the shape, not the grid, and simplifies at a tighter tolerance.
    const sd = blur({ w: ww, h: wh, data: sd0 }, 1).data;
    const raw = traceLoops(sd, ww, wh, -(kerf / 2) * k);
    let loops = raw.map((L) => {
      const t = simplifyLoop(L.xs, L.ys, 0.3);
      return { xs: Float64Array.from(t.xs, (v) => v / k), ys: Float64Array.from(t.ys, (v) => v / ky) };
    }).filter((L) => L.xs.length >= 3);
    const total = loops.reduce((a, L) => a + polyArea(L), 0);
    const sign = total >= 0 ? 1 : -1;
    // nesting depth: how many other loops contain this one; deepest cut first
    const box = loops.map((L) => [Math.min(...L.xs), Math.min(...L.ys), Math.max(...L.xs), Math.max(...L.ys)]);
    const depth = loops.map((L, i) => {
      let dpt = 0;
      for (let j = 0; j < loops.length; j++) {
        if (j === i) continue;
        const a = box[i], b = box[j];
        if (a[0] < b[0] || a[1] < b[1] || a[2] > b[2] || a[3] > b[3]) continue;
        if (pointInLoop(L.xs[0], L.ys[0], loops[j])) dpt++;
      }
      return dpt;
    });
    // The finished outline: the cut path grown by kerf/2 -- outward for the outside
    // of a cut region, inward for an island (the cut grows into it). Carried with
    // the loop so the renderer and the area do not have to regrow it on a raster,
    // where half a kerf is often under half a pixel and simply vanishes.
    loops = loops.map((L, i) => {
      const outer = sign * polyArea(L) > 0;
      const f = offsetLoop(L.xs, L.ys, outer ? kerf / 2 : -kerf / 2);
      return { kind: 'loop', xs: L.xs, ys: L.ys, fx: f.xs, fy: f.ys, sign, depth: depth[i] };
    });
    loops.sort((a, b) => b.depth - a.depth);
    return loops;
  }

}

function pointInLoop(x, y, L) {
  let inside = false;
  for (let i = 0, n = L.xs.length, j = n - 1; i < n; j = i++) {
    const yi = L.ys[i], yj = L.ys[j];
    if ((yi > y) !== (yj > y) && x < ((L.xs[j] - L.xs[i]) * (y - yi)) / (yj - yi) + L.xs[i]) inside = !inside;
  }
  return inside;
}


/**
 * Scoring windows about `size` mm on a side, tiling the piece: their count, size
 * and the window at a point (-1 off the piece).
 */
export function windowGrid(W, H, size) {
  const cols = Math.max(1, Math.round(W / size)), rows = Math.max(1, Math.round(H / size));
  const wx = W / cols, wy = H / rows;
  const cellAt = (x, y) => {
    const i = Math.floor(x / wx), j = Math.floor(y / wy);
    return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
  };
  return { cols, rows, wx, wy, N: cols * rows, cellAt };
}

/**
 * Score a hole model in windows: the per-pixel target and source averaged per
 * window, and what the sheets actually show there, from the renderer at the work
 * resolution.
 * @param {(q:number, out:Float64Array)=>void} o.tgtPix  target color of work pixel q
 */
export function scoreWindows(o) {
  const { W, H, ww, wh, k, ky, D, palette, kerf, src, layers, tgtPix } = o;
  const NP = ww * wh;
  const { N: NW, cellAt } = windowGrid(W, H, o.window);
  const target = new Float64Array(NW * D), source = new Float64Array(NW * D), achieved = new Float64Array(NW * D);
  const cnt = new Float64Array(NW);
  {
    const t = new Float64Array(D);
    for (let q = 0; q < NP; q++) {
      const i = q % ww, j = (q - i) / ww;
      const w = cellAt((i + 0.5) / k, (j + 0.5) / ky);
      if (w < 0) continue;
      tgtPix(q, t);
      for (let d = 0; d < D; d++) { target[w * D + d] += t[d]; source[w * D + d] += src[q * D + d]; }
      cnt[w]++;
    }
    const piece = { widthMm: W, heightMm: H, kerf };
    const r = rasterizeHoles(piece, layers, { pxPerMm: k, superSample: 1 });
    const cnt2 = new Float64Array(NW);
    for (let py = 0; py < r.h; py++) {
      for (let pxl = 0; pxl < r.w; pxl++) {
        const w = cellAt((pxl + 0.5) / r.pxPerMm, (py + 0.5) / r.pxPerMm);
        if (w < 0) continue;
        const base = (py * r.w + pxl) * r.n;
        for (let l = 0; l < r.n; l++) {
          const c = r.counts[base + l];
          if (c) for (let d = 0; d < D; d++) achieved[w * D + d] += c * palette[l][d];
        }
        cnt2[w]++;
      }
    }
    for (let w = 0; w < NW; w++) {
      for (let d = 0; d < D; d++) {
        target[w * D + d] /= cnt[w] || 1;
        source[w * D + d] /= cnt[w] || 1;
        achieved[w * D + d] /= cnt2[w] || 1;
      }
    }
  }

  return { target, source, achieved, cellAt, N: NW };
}
