// Stipple: every hole the same size, tone carried by how densely they are packed.
//
// Why it suits metal: one hole size means one pierce, one set of cut parameters,
// and one kind of heat input everywhere -- no tiny holes that weld shut, no huge
// ones that warp. The look is a drawing in dots rather than a screen.
//
// ONE PIECE BY CONSTRUCTION. The holes are circles, and every pair of centres is
// at least `sMin = widest hole + web` apart, and every centre is at least
// `web + widest/2` from the outline. Disjoint convex holes that far apart cannot
// enclose metal (docs/architecture.md, "the hole model"). The spacing is ENFORCED
// after placement, not hoped for: a repair pass pushes apart any pair that
// relaxation left too close, and removes what it cannot separate.
//
// TONE. Open fraction = dot density × hole area, so the method asks for a density
// rho = f / A, where f is the target open fraction. The count is exact by
// construction (N = the integral of rho over the piece); where the dots go is
// the placer's job:
//   1. a stratified sample along a Hilbert curve: walk the image in Hilbert order
//      and drop a dot every 1/rho of accumulated ink, so the count per region is
//      right and the points start well spread;
//   2. weighted Lloyd relaxation, weight rho² (Lloyd settles at weight^(1/2), so
//      that gives density rho), which turns the sample into blue noise;
//   3. the spacing repair above.
// The densest the dots can go is hexagonal packing at sMin; the tone band is set
// at PACKING of that, because relaxation does not reach a perfect lattice and the
// repair would otherwise be removing dots in the lights. MEASURED on a white
// field (tests/method.stipple.js): 0.8 lost 172 of ~560 dots to the repair, 0.75
// lost 76, 0.7 loses 3. Those figures are with the frame excluded from the
// target -- before it was, 0.7 still lost 116, because dots owed to the frame
// were packed into the interior.
//
// COLOUR (stacked sheets): each dot shows ONE sheet, so colours mix by the
// proportion of dots of each kind, like pointillism. A dot showing sheet l is
// holed through sheets 0..l-1; the deeper holes are wider by the registration
// allowance per sheet and hide under the top one, as in the Voronoi web's solid
// mode, so a small misalignment shows nothing extra. Sheets are assigned by
// walking the dots in Hilbert order and paying each sheet the share it is owed
// (1-D error diffusion along the curve), which spreads each colour evenly.

import { linearPlanes, prepareRaster } from '../core/units.js';
import { resize } from '../shim/image.js';
import { mulberry32 } from '../shim/random.js';
import { luminance } from '../core/color.js';
import { solveMix, fitMix, mixColour } from '../core/separate.js';
import { SeedHash } from '../core/voronoi.js';
import { lloyd } from '../core/seeds.js';
import { hilbertIndex, pow2At } from '../core/hilbert.js';

export const id = 'stipple';
export const label = 'Stipple';
export const blurb = 'Every hole the same size; tone comes from how densely they are packed. Blue-noise spacing, never closer than the min web. In colour, each dot shows one sheet.';

export const params = [
  { key: 'dot', label: 'Dot size', type: 'range', min: 0.5, max: 6, step: 0.1, def: 1.5, unit: 'mm', dp: 1 },
  { key: 'relax', label: 'Relax', type: 'range', min: 0, max: 20, step: 1, def: 8 },
  { key: 'range', label: 'Tone range', type: 'select', def: 'squeeze',
    options: [['squeeze', 'Squeeze to fit'], ['clip', 'Clip highlights']] },
  { key: 'seed', label: 'Seed', type: 'range', min: 1, max: 99, step: 1, def: 1 },
];

const DEF = Object.fromEntries(params.map((p) => [p.key, p.def]));
export const PACKING = 0.7;     // of hexagonal density at sMin: the densest tone asked for (measured, above)
const MAX_DOTS = 80000;
const WORK_PIXELS = 1e6;

export function build(rgba, settings, params = {}) {
  const P = { ...DEF, ...params };
  const { s, W, H, bw, palette, n, nCut, D, web, kerf, reg, hFloor } = prepareRaster(rgba, settings);

  // ---- sizes, spacing, the band
  const d = Math.max(P.dot, hFloor);    // the top hole: the window
  const dDeep = d + 2 * (nCut - 1) * reg;               // the widest hole any sheet has
  const sMin = dDeep + web;
  const A = (Math.PI * d * d) / 4;
  const fMax = (PACKING * A) / ((Math.sqrt(3) / 2) * sMin * sMin);
  const e = web + dDeep / 2;
  const rect = [e, e, W - e, H - e];
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) throw new Error('the piece is too small for one dot');

  // ---- the work raster, and each pixel's fitted mix
  const px = Math.min(6 / sMin, Math.sqrt(WORK_PIXELS / (W * H)));
  const ww = Math.max(4, Math.round(W * px)), wh = Math.max(4, Math.round(H * px));
  const kx = ww / W, ky = wh / H, pixA = 1 / (kx * ky);
  const planes = linearPlanes(rgba).map((pl) => resize(pl, ww, wh));
  const NP = ww * wh;
  const srcPix = new Float32Array(NP * D), mixPix = new Float32Array(NP * n), rho = new Float64Array(NP);
  {
    const x = new Float64Array(D), m = new Float64Array(n);
    for (let q = 0; q < NP; q++) {
      const r = planes[0].data[q], g = planes[1].data[q], b = planes[2].data[q];
      if (bw) x[0] = Math.max(0, Math.min(1, luminance(r, g, b)));
      else { x[0] = r; x[1] = g; x[2] = b; }
      for (let k = 0; k < D; k++) srcPix[q * D + k] = x[k];
      // No dot centre can sit in the frame (within web + dDeep/2 of the outline),
      // so the frame is metal: asking for dots there would pack them into the
      // interior instead, too close to fit.
      const i = q % ww, j = (q - i) / ww;
      const cx = (i + 0.5) / kx, cy = (j + 0.5) / ky;
      if (cx < rect[0] || cy < rect[1] || cx > rect[2] || cy > rect[3]) {
        m.fill(0); m[0] = 1;
      } else {
        solveMix(x, palette, m);
        fitMix(m, fMax, P.range);
      }
      for (let k = 0; k < n; k++) mixPix[q * n + k] = m[k];
      rho[q] = (1 - m[0]) / A;
    }
  }
  const pixOf = (x, y) => Math.min(wh - 1, Math.max(0, Math.floor(y * ky))) * ww +
    Math.min(ww - 1, Math.max(0, Math.floor(x * kx)));

  // ---- 1. stratified sample along the Hilbert curve
  let M = 0;
  for (let q = 0; q < NP; q++) M += rho[q] * pixA;
  const N0 = Math.round(M);
  if (N0 > MAX_DOTS) throw new Error(`${N0} dots is too many — raise the dot size`);
  const n2 = pow2At(Math.max(ww, wh));
  const key = new Float64Array(NP);
  for (let j = 0; j < wh; j++) for (let i = 0; i < ww; i++) key[j * ww + i] = hilbertIndex(n2, i, j);
  const order = Array.from({ length: NP }, (_, q) => q).sort((a, b) => key[a] - key[b]);
  const rand = mulberry32(P.seed | 0);
  let xs = new Float64Array(N0), ys = new Float64Array(N0);
  {
    let acc = 0, k = 0, next = N0 > 0 ? (rand() * M) / N0 : Infinity;
    for (const q of order) {
      acc += rho[q] * pixA;
      while (k < N0 && next <= acc) {
        const i = q % ww, j = (q - i) / ww;
        xs[k] = Math.min(rect[2], Math.max(rect[0], (i + rand()) / kx));
        ys[k] = Math.min(rect[3], Math.max(rect[1], (j + rand()) / ky));
        k++;
        next = ((k + rand()) * M) / N0;
      }
    }
    for (; k < N0; k++) { xs[k] = (rect[0] + rect[2]) / 2; ys[k] = (rect[1] + rect[3]) / 2; }   // rounding stragglers
  }

  // ---- 2. relax towards blue noise at density rho
  lloyd(xs, ys, rect, (x, y) => rho[pixOf(x, y)] ** 2, 6 / sMin, P.relax, null, 2 * sMin);

  // ---- 3. enforce the spacing: push apart, then drop what will not separate
  const spaced = enforceSpacing(xs, ys, rect, sMin, rand);
  xs = spaced.xs; ys = spaced.ys;
  const removed = spaced.removed;
  const N = xs.length;

  // ---- which sheet each dot shows
  const lab = assignSheets(xs, ys, N, n, nCut, n2, ww, wh, kx, ky, pixOf, mixPix);

  // ---- holes: sheet j is holed under every dot showing a deeper sheet
  const diam = (j) => d + 2 * j * reg;
  const layers = [];
  for (let j = 0; j < nCut; j++) {
    const c = diam(j) - kerf;
    const holes = [];
    for (let i = 0; i < N; i++) if (lab[i] > j) holes.push({ kind: 'rsq', cx: xs[i], cy: ys[i], a: c, r: c / 2, rot: false });
    layers.push(holes);
  }

  // ---- the web each sheet has
  const webs = measureWebs(N, nCut, xs, ys, W, H, sMin, diam, lab);

  // ---- scoring windows: a few dots across, since one dot says nothing about tone
  const win = 4 * sMin;
  const cols = Math.max(1, Math.round(W / win)), rows = Math.max(1, Math.round(H / win));
  const wx = W / cols, wy = H / rows, NW = cols * rows;
  const cellAt = (x, y) => {
    const i = Math.floor(x / wx), j = Math.floor(y / wy);
    return i < 0 || j < 0 || i >= cols || j >= rows ? -1 : j * cols + i;
  };
  const target = new Float64Array(NW * D), source = new Float64Array(NW * D), cnt = new Float64Array(NW);
  {
    const m = new Float64Array(n), col = new Float64Array(D);
    for (let q = 0; q < NP; q++) {
      const i = q % ww, j = (q - i) / ww;
      const w = cellAt((i + 0.5) / kx, (j + 0.5) / ky);
      if (w < 0) continue;
      for (let k = 0; k < n; k++) m[k] = mixPix[q * n + k];
      mixColour(m, palette, col);
      for (let k = 0; k < D; k++) { target[w * D + k] += col[k]; source[w * D + k] += srcPix[q * D + k]; }
      cnt[w]++;
    }
    for (let w = 0; w < NW; w++) {
      for (let k = 0; k < D; k++) { target[w * D + k] /= cnt[w] || 1; source[w * D + k] /= cnt[w] || 1; }
    }
  }
  // Each dot's window area (exact: π d²/4) split between windows by 12×12 disc samples.
  const openBy = new Float64Array(NW * n);
  for (let i = 0; i < N; i++) {
    const r = d / 2;
    let inside = 0;
    const tally = new Map();
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        const ox = ((a + 0.5) / 12 * 2 - 1) * r, oy = ((b + 0.5) / 12 * 2 - 1) * r;
        if (ox * ox + oy * oy > r * r) continue;
        inside++;
        const w = cellAt(xs[i] + ox, ys[i] + oy);
        if (w >= 0) tally.set(w, (tally.get(w) || 0) + 1);
      }
    }
    for (const [w, c] of tally) openBy[w * n + lab[i]] += (A * c) / inside;
  }
  const achieved = new Float64Array(NW * D);
  for (let w = 0; w < NW; w++) {
    let open = 0;
    for (let l = 1; l < n; l++) {
      const f = openBy[w * n + l] / (wx * wy);
      open += f;
      for (let k = 0; k < D; k++) achieved[w * D + k] += f * palette[l][k];
    }
    for (let k = 0; k < D; k++) achieved[w * D + k] += (1 - open) * palette[0][k];
  }

  const notes = [`${N.toLocaleString()} dots, ${d.toFixed(2)} mm, at least ${sMin.toFixed(2)} mm apart`];
  if (removed) notes.push(`${removed} removed to keep the web`);
  if (d > P.dot + 1e-9) notes.push(`dot raised to ${d.toFixed(2)} mm by the min hole or kerf`);

  return {
    widthMm: W, heightMm: H, mode: bw ? 'bw' : 'color', D, N: NW, palette,
    target, achieved, source, layers, webs, cellAt,
    imageRect: { x: 0, y: 0, w: W, h: H },
    cellsLabel: `${N.toLocaleString()} dots`,
    // dropped/saturated stay at 0: every dot is the same size, so there is no
    // per-dot floor or ceiling to be pinned at, unlike a grid cell's hole. The
    // nearest real equivalent is `removed` (dots the spacing repair deleted),
    // already in the note above -- left out of dropped/saturated rather than
    // stretching their meaning to fit a method they were not defined for.
    dropped: 0, saturated: 0, note: notes.join(' · '),
    debug: { xs, ys, lab, d, dDeep, sMin, fMax, rect, removed, N0, win },
  };
}

/**
 * Push apart every pair of dots closer than sMin, then drop what still will
 * not separate. Greedy in index order: pairs are visited as (i, j > i) with i
 * ascending, so drop[i] is final by the time i's pairs come up, and a kept i
 * drops every j that crowds it. No two survivors end up closer than sMin.
 * @returns {{xs:Float64Array, ys:Float64Array, removed:number}}
 */
function enforceSpacing(xs, ys, rect, sMin, rand) {
  const tooClose = (fn) => {
    const hash = new SeedHash(xs, ys, rect[0], rect[1], rect[2], rect[3], sMin);
    for (let i = 0; i < xs.length; i++) {
      const [ix, iy] = hash.bucketOf(xs[i], ys[i]);
      for (let r = 0; r <= 1; r++) {
        hash.ring(ix, iy, r, (j) => {
          if (j <= i) return;
          const dx = xs[j] - xs[i], dy = ys[j] - ys[i];
          const dist = Math.hypot(dx, dy);
          if (dist < sMin - 1e-9) fn(i, j, dx, dy, dist);
        });
      }
    }
  };
  for (let pass = 0; pass < 30; pass++) {
    let moved = false;
    tooClose((i, j, dx, dy, dist) => {
      moved = true;
      if (dist < 1e-12) { const a = rand() * 2 * Math.PI; dx = Math.cos(a); dy = Math.sin(a); dist = 1; }
      const push = (sMin - Math.hypot(xs[j] - xs[i], ys[j] - ys[i])) / 2 + 1e-6;
      if (push <= 0) return;
      const ux = dx / dist, uy = dy / dist;
      xs[i] = Math.min(rect[2], Math.max(rect[0], xs[i] - ux * push));
      ys[i] = Math.min(rect[3], Math.max(rect[1], ys[i] - uy * push));
      xs[j] = Math.min(rect[2], Math.max(rect[0], xs[j] + ux * push));
      ys[j] = Math.min(rect[3], Math.max(rect[1], ys[j] + uy * push));
    });
    if (!moved) break;
  }
  const drop = new Uint8Array(xs.length);
  tooClose((i, j) => { if (!drop[i]) drop[j] = 1; });
  const keep = [];
  for (let i = 0; i < xs.length; i++) if (!drop[i]) keep.push(i);
  return {
    xs: Float64Array.from(keep, (i) => xs[i]),
    ys: Float64Array.from(keep, (i) => ys[i]),
    removed: xs.length - keep.length,
  };
}

/**
 * Which sheet each dot shows: walk the dots in Hilbert order and pay each
 * sheet the share it is owed under it (1-D error diffusion along the curve),
 * which spreads each colour evenly.
 * @returns {Uint8Array} lab[i] = sheet index dot i shows (>= 1)
 */
function assignSheets(xs, ys, N, n, nCut, n2, ww, wh, kx, ky, pixOf, mixPix) {
  const lab = new Uint8Array(N).fill(1);
  if (nCut > 1) {
    const hk = Float64Array.from({ length: N }, (_, i) =>
      hilbertIndex(n2, Math.min(ww - 1, Math.floor(xs[i] * kx)), Math.min(wh - 1, Math.floor(ys[i] * ky))));
    const dotOrder = Array.from({ length: N }, (_, i) => i).sort((a, b) => hk[a] - hk[b]);
    const debt = new Float64Array(n);
    for (const i of dotOrder) {
      const q = pixOf(xs[i], ys[i]);
      let tot = 0;
      for (let l = 1; l < n; l++) tot += mixPix[q * n + l];
      if (tot > 0) for (let l = 1; l < n; l++) debt[l] += mixPix[q * n + l] / tot;
      let best = 1;
      for (let l = 2; l < n; l++) if (debt[l] > debt[best]) best = l;
      lab[i] = best;
      debt[best] -= 1;
    }
  }
  return lab;
}

/** The thinnest web each cut sheet leaves: to the outline, and between every
 *  pair of dots holed through it together. Infinity for a sheet with no holes. */
function measureWebs(N, nCut, xs, ys, W, H, sMin, diam, lab) {
  const webs = new Array(nCut).fill(Infinity);
  if (N > 0) {
    const hash = new SeedHash(xs, ys, 0, 0, W, H, sMin);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < nCut && j < lab[i]; j++) {
        webs[j] = Math.min(webs[j], Math.min(xs[i], ys[i], W - xs[i], H - ys[i]) - diam(j) / 2);
      }
      const [ix, iy] = hash.bucketOf(xs[i], ys[i]);
      for (let r = 0; r <= 1; r++) {
        hash.ring(ix, iy, r, (q) => {
          if (q <= i) return;
          const dist = Math.hypot(xs[q] - xs[i], ys[q] - ys[i]);
          const deepest = Math.min(lab[i], lab[q]);        // both holed in sheets below this
          for (let j = 0; j < deepest && j < nCut; j++) webs[j] = Math.min(webs[j], dist - diam(j));
        });
      }
    }
  }
  return webs;
}

export default { id, label, blurb, params, build };
