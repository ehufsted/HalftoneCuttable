// The assembly sheet: how to put a cut stack together, as a printable page.
//
// assemblyPlan reads a pipeline result (DOM-free, so the harness checks it):
// the stack in physical order (core/stack.js), every loose part numbered, and
// the steps, bottom up. assemblyHTML lays the plan out as a self-contained page
// for the browser to print; the app supplies each sheet's thumbnail.
//
// A LOOSE PART is metal the cut leaves free: floating parts, and parts cut free
// because no bridge could rest on the sheet below. In a traced sheet it is an
// island -- a loop running the opposite way to the cut around it (sign * area
// < 0, core/holes.js). A bridged part has no loop of its own: its outline joins
// the metal round it through the bridges. Patterns of separate holes (grids,
// webs, stipple) never leave one. Each part sits in its own sheet's cut, on the
// sheet beneath, where the map shows it. Parts are numbered "sheet.part", the
// sheet by its position from the top of the stack.

import { namedStack } from './stack.js';
import { polyArea } from './polygon.js';
import { layerStats } from './structure.js';

/**
 * @param {object} res   a pipeline result: {piece, layers, levels, align, stats}
 * @param {{stem?:string, thickness?:number, machine?:{speed, pierce}, backdrop?:string}} opts
 *   thickness: of each sheet, mm, for the stack's height; machine: for the
 *   solid base's cutting time (its outline and alignment holes)
 * @returns {{sheets: Array, steps: string[], totals: object}}
 */
export function assemblyPlan(res, opts = {}) {
  const stem = opts.stem || 'piece';
  const bw = res.piece.mode !== 'color';
  const stack = namedStack(res, stem);
  const levels = res.levels || [];
  const align = res.align || [];
  const sheets = stack.map((e, s) => {
    const pos = s + 1;
    const stats = e.base
      ? (opts.machine ? layerStats(res.piece, align, Infinity, opts.machine) : null)
      : e.level ? res.stats.levels[levels.indexOf(e.level)] : res.stats.layers[e.sheet];
    const parts = looseParts(e.holes).map((p, m) => ({ id: `${pos}.${m + 1}`, ...p }));
    return {
      pos, name: e.name, color: res.piece.colors[e.color] || '#808080',
      kind: e.base ? 'solid base' : e.level ? 'brightness layer' : 'pattern sheet',
      svg: e.file('svg'), dxf: e.file('dxf'), parts, stats,
    };
  });

  // the steps, bottom up
  const pins = align.length ? ', pins through the four corner holes' : ', edges aligned';
  const steps = [];
  for (let s = sheets.length - 1; s >= 0; s--) {
    const sh = sheets[s], under = sheets[s + 1];
    let step = s === sheets.length - 1
      ? (bw ? `Lay ${sh.name} (${sh.color}) over the backdrop${opts.backdrop ? ` (${opts.backdrop})` : ''}.`
        : `Lay down ${sh.name} (${sh.color}): the floor of the stack.`)
      : `Lay ${sh.name} (${sh.color}) on top${pins}.`;
    if (sh.parts.length) {
      const ids = sh.parts.length > 2 ? `${sh.parts[0].id}–${sh.parts[sh.parts.length - 1].id}` : sh.parts.map((p) => p.id).join(' and ');
      step += ` Set its loose part${sh.parts.length > 1 ? 's' : ''} ${ids} into place on ${under ? under.name : 'the backdrop'}, as map ${sh.pos} shows.`;
    }
    steps.push(step);
  }

  const t = opts.thickness;
  return {
    sheets, steps,
    totals: {
      sheets: sheets.length,
      parts: sheets.reduce((a, sh) => a + sh.parts.length, 0),
      height: t > 0 ? sheets.length * t : null,
      seconds: sheets.reduce((a, sh) => a + (sh.stats ? sh.stats.seconds : 0), 0),
      length: sheets.reduce((a, sh) => a + (sh.stats ? sh.stats.length : 0), 0),
    },
  };
}

/** A sheet's loose parts: its island loops, finished outline and a label point inside each. */
function looseParts(holes) {
  const out = [];
  for (const L of holes) {
    if (L.kind !== 'loop' || !(L.sign * polyArea(L) < 0)) continue;
    const xs = L.fx || L.xs, ys = L.fy || L.ys;
    out.push({ xs: Array.from(xs), ys: Array.from(ys), area: Math.abs(polyArea({ xs, ys })), label: labelPoint(xs, ys) });
  }
  // reading order: top to bottom, then left to right, by label
  return out.sort((a, b) => (Math.abs(a.label[1] - b.label[1]) > 1 ? a.label[1] - b.label[1] : a.label[0] - b.label[0]));
}

function inside(xs, ys, x, y) {
  let c = false;
  for (let i = 0, n = xs.length, j = n - 1; i < n; j = i++) {
    if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) c = !c;
  }
  return c;
}

/**
 * Where to write a part's number: the point inside it farthest from its edge,
 * from a 16 × 16 sampling of its box (a non-convex part's centroid can lie
 * outside it); of equally far points, the one nearest the box's middle (along
 * a bar of even width every point ties, and the first sample was a corner).
 * The vertices' mean if no sample falls inside.
 */
export function labelPoint(xs, ys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]);
  }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, tie = 1e-6 * Math.max(x1 - x0, y1 - y0);
  let best = -1, mid = Infinity, at = null;
  for (let gj = 0; gj < 16; gj++) {
    for (let gi = 0; gi < 16; gi++) {
      const x = x0 + ((gi + 0.5) / 16) * (x1 - x0), y = y0 + ((gj + 0.5) / 16) * (y1 - y0);
      if (!inside(xs, ys, x, y)) continue;
      let d = Infinity;
      for (let i = 0, n = xs.length, j = n - 1; i < n; j = i++) d = Math.min(d, segDist(x, y, xs[j], ys[j], xs[i], ys[i]));
      const m = Math.hypot(x - mx, y - my);
      if (d > best + tie || (d > best - tie && m < mid)) { best = d; mid = m; at = [x, y]; }
    }
  }
  if (at) return at;
  let sx = 0, sy = 0;
  for (let i = 0; i < xs.length; i++) { sx += xs[i]; sy += ys[i]; }
  return [sx / xs.length, sy / xs.length];
}

function segDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / L2)) : 0;
  return Math.hypot(ax + t * ex - px, ay + t * ey - py);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#808080');
const fmtTime = (s) => { s = Math.round(s); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const fmtLen = (mm) => (mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`);

/**
 * The plan as a printable, self-contained HTML page: a summary, the steps, the
 * stack table, then one map per sheet with its loose parts outlined and
 * numbered over its thumbnail.
 * @param {object} plan  assemblyPlan()
 * @param {{title:string, widthMm:number, heightMm:number, thumbs?:string[]}} o
 *   thumbs: an image URL per sheet (the app's renders), top first
 */
export function assemblyHTML(plan, o) {
  const W = o.widthMm, H = o.heightMm, { totals } = plan;
  const swatch = (c) => `<span class="sw" style="background:${hex(c)}"></span>`;
  const summary = [
    `${totals.sheets} sheet${totals.sheets === 1 ? '' : 's'}`,
    `${totals.parts} loose part${totals.parts === 1 ? '' : 's'} to glue`,
    totals.height ? `stack ${totals.height.toFixed(1)} mm thick` : null,
    totals.seconds ? `about ${fmtTime(totals.seconds)} of cutting, ${fmtLen(totals.length)} of cut` : null,
    `piece ${W.toFixed(1)} × ${H.toFixed(1)} mm`,
  ].filter(Boolean).join(' · ');
  const rows = plan.sheets.map((sh) => `<tr><td>${sh.pos}</td><td>${swatch(sh.color)}${esc(sh.name)}</td><td>${esc(sh.color)}</td>` +
    `<td>${esc(sh.kind)}</td><td>${sh.parts.length || ''}</td><td>${sh.stats ? fmtTime(sh.stats.seconds) : ''}</td>` +
    `<td class="f">${esc(sh.svg)}<br>${esc(sh.dxf)}</td></tr>`).join('\n');
  const maps = plan.sheets.map((sh, s) => {
    const stroke = W / 350;
    const parts = sh.parts.map((p) => {
      const d = p.xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${p.ys[i].toFixed(2)}`).join('') + 'Z';
      const size = Math.max(W / 90, Math.min(W / 35, Math.sqrt(p.area) * 0.45));
      return `<path d="${d}" class="part" stroke-width="${stroke.toFixed(3)}"/>` +
        `<text x="${p.label[0].toFixed(2)}" y="${p.label[1].toFixed(2)}" font-size="${size.toFixed(2)}" stroke-width="${(size / 5).toFixed(2)}">${esc(p.id)}</text>`;
    }).join('');
    const img = o.thumbs && o.thumbs[s] ? `<image href="${esc(o.thumbs[s])}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` : '';
    const under = plan.sheets[s + 1];
    return `<section class="map"><h2>${sh.pos}. ${swatch(sh.color)}${esc(sh.name)} <small>${esc(sh.color)} · ${esc(sh.kind)}` +
      `${sh.parts.length ? ` · ${sh.parts.length} loose part${sh.parts.length === 1 ? '' : 's'}, set on ${esc(under ? under.name : 'the backdrop')}` : ''}</small></h2>` +
      `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${img}<rect x="0" y="0" width="${W}" height="${H}" class="edge" stroke-width="${stroke.toFixed(3)}"/>${parts}</svg></section>`;
  }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(o.title)} — assembly</title>
<style>
  body { font: 11pt/1.45 system-ui, sans-serif; color: #111; margin: 18px; }
  h1 { font-size: 17pt; margin: 0 0 4px; } h2 { font-size: 12pt; margin: 18px 0 6px; } small { color: #555; font-weight: normal; }
  .sum { color: #333; margin: 0 0 12px; }
  ol { padding-left: 22px; } li { margin: 3px 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 3px 6px; text-align: left; vertical-align: top; }
  td.f { font-family: ui-monospace, monospace; font-size: 8.5pt; }
  .sw { display: inline-block; width: 11px; height: 11px; border: 1px solid #555; margin-right: 6px; vertical-align: -1px; }
  .map { break-inside: avoid; page-break-inside: avoid; }
  .map svg { width: 100%; max-height: 42vh; display: block; background: #fff; }
  .edge { fill: none; stroke: #444; }
  .part { fill: rgba(224, 0, 122, 0.12); stroke: #e0007a; }
  text { fill: #e0007a; stroke: #fff; paint-order: stroke; font-weight: 700; text-anchor: middle; dominant-baseline: central; font-family: system-ui, sans-serif; }
  .noprint { margin: 10px 0; } @media print { .noprint { display: none; } body { margin: 0; } }
</style></head><body>
<button class="noprint" onclick="print()">Print</button>
<h1>${esc(o.title)}: assembly</h1>
<p class="sum">${esc(summary)}</p>
<h2>Steps, bottom up</h2>
<ol>${plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
<h2>The stack, top to bottom</h2>
<table><tr><th>#</th><th>Sheet</th><th>Color</th><th>Kind</th><th>Loose parts</th><th>Cut time</th><th>Files</th></tr>
${rows}
</table>
<h2>Maps</h2>
<p class="sum">Each sheet in its color over a faint view of the sheet beneath. Loose parts are outlined and numbered where they go.</p>
${maps}
</body></html>`;
}
