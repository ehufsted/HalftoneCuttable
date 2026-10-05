// core/assembly.js: the assembly sheet. Predictions: the plan lists the stack
// in physical order with each sheet's name and files; every loose part (and
// only those) is numbered "sheet.part", with its label inside it; the steps
// run bottom up and say which parts go where; the page is self-contained and
// escapes what it shows.

import { check, section, makeRGBA, plain } from './runner.js';
import { assemblyPlan, assemblyHTML, labelPoint } from '../src/core/assembly.js';
import { namedStack } from '../src/core/stack.js';
import { runPipeline } from '../src/pipeline.js';

const base = { ...plain, widthMm: 60, web: 0.6, minHole: 0.6, kerf: 0.15 };

/** Three white rings on black, 300×200 px (60×40 mm): each ring's middle is an island of metal. */
const rings = () => makeRGBA(300, 200, (x, y) => {
  for (const cx of [75, 150, 225]) {
    const r = Math.hypot(x - cx, y - 100);
    if (r >= 20 && r <= 40) return [255, 255, 255];
  }
  return [0, 0, 0];
});

function inside(xs, ys, x, y) {
  let c = false;
  for (let i = 0, n = xs.length, j = n - 1; i < n; j = i++) {
    if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) c = !c;
  }
  return c;
}

export function run() {
  section('core.assembly', 'The assembly sheet: the stack in order, loose parts numbered with labels inside them, steps bottom up, a self-contained page.');

  // ---- floating parts: three islands, numbered in reading order, labeled inside
  {
    const res = runPipeline(rings(), base, 'stencil', { floating: true }, { preview: false });
    const plan = assemblyPlan(res, { stem: 'rings', thickness: 1.5, backdrop: '#ffffff' });
    const parts = plan.sheets[0].parts;
    check('floating parts: one sheet, its three islands numbered 1.1-1.3 left to right',
      plan.sheets.length === 1 && parts.map((p) => p.id).join() === '1.1,1.2,1.3' &&
        parts[0].label[0] < parts[1].label[0] && parts[1].label[0] < parts[2].label[0],
      `${plan.sheets.length} sheet, parts ${parts.map((p) => `${p.id} at x ${p.label[0].toFixed(1)}`).join(', ')}`);
    // a ring's middle is 4 mm across before the cut grows into it and the
    // smoothing rounds it: 50 mm² at most
    check('every label lies inside its part, each part about a ring’s middle',
      parts.every((p) => inside(p.xs, p.ys, p.label[0], p.label[1]) && p.area > 35 && p.area < 60),
      parts.map((p) => `${p.area.toFixed(1)} mm²`).join(', '));
    check('B&W: one step -- the sheet over the backdrop, and its parts set on the backdrop',
      plan.steps.length === 1 && /^Lay Sheet \(#[0-9a-f]{6}\) over the backdrop \(#ffffff\)\. Set its loose parts 1\.1–1\.3 into place on the backdrop, as map 1 shows\.$/.test(plan.steps[0]),
      plan.steps[0]);
    check('totals: parts and height (one 1.5 mm sheet)', plan.totals.parts === 3 && plan.totals.height === 1.5 && plan.totals.seconds > 0);
    const bridged = assemblyPlan(runPipeline(rings(), base, 'stencil', {}, { preview: false }));
    check('bridged islands are not loose parts', bridged.totals.parts === 0, `${bridged.totals.parts} parts`);
  }

  // ---- a color stack with brightness layers: physical order, names, files, steps
  {
    const s = { ...base, mode: 'color', palette: ['#202020', '#d02020', '#2040d0'], reg: 0 };
    const img = makeRGBA(300, 200, (x, y) => {
      if (x >= 40 && x < 140 && y >= 50 && y < 150) return [Math.round(150 + 105 * (x - 40) / 99), 32, 32];
      if (x >= 170 && x < 270 && y >= 50 && y < 150) return [32, 64, Math.round(160 + 95 * (y - 50) / 99)];
      return [32, 32, 32];
    });
    const res = runPipeline(img, s, 'stencil', { levels: 2 }, { preview: false });
    const plan = assemblyPlan(res, { stem: 'blocks', machine: { speed: 20, pierce: 0.3 } });
    const want = namedStack(res, 'blocks');
    check('the plan follows the physical stack: names, files, top first',
      plan.sheets.map((sh) => sh.name).join('|') === want.map((e) => e.name).join('|') &&
        plan.sheets.every((sh, i) => sh.pos === i + 1 && sh.svg === want[i].file('svg') && sh.dxf === want[i].file('dxf')),
      plan.sheets.map((sh) => sh.name).join(' / '));
    const last = plan.sheets[plan.sheets.length - 1];
    check('the solid base: last, its cutting time from its outline (the machine given)',
      last.kind === 'solid base' && last.stats && last.stats.seconds > 0 && plan.sheets.filter((sh) => sh.kind === 'brightness layer').length === 4,
      `${last.name}, ${last.kind}, ${last.stats ? last.stats.seconds.toFixed(1) : '-'} s`);
    check('steps: one per sheet, from the floor up, each on top of the last',
      plan.steps.length === plan.sheets.length && plan.steps[0].startsWith(`Lay down ${last.name}`) &&
        plan.steps.slice(1).every((st, i) => st.startsWith(`Lay ${plan.sheets[plan.sheets.length - 2 - i].name} `)),
      plan.steps.slice(0, 2).join(' / '));
  }

  // ---- separate holes leave no loose parts
  {
    const res = runPipeline(rings(), { ...base, mode: 'color', palette: ['#ffffff', '#d02020', '#101010'] }, 'squareGrid',
      { pitch: 3, shape: 'circle', rounding: 0, range: 'squeeze', diffuse: true }, { preview: false });
    const plan = assemblyPlan(res);
    check('square grid: three sheets, no loose parts', plan.sheets.length === 3 && plan.totals.parts === 0);
  }

  // ---- a non-convex part's label: inside it, though its centroid is not
  {
    // a U, 30 wide and 30 tall, arms 6 thick: the centroid falls in the gap
    const xs = [0, 30, 30, 24, 24, 6, 6, 0], ys = [0, 0, 30, 30, 6, 6, 30, 30];
    const [x, y] = labelPoint(xs, ys);
    const cx = xs.reduce((a, v) => a + v, 0) / xs.length, cy = ys.reduce((a, v) => a + v, 0) / ys.length;
    // inside, as far from the edge as the 6 mm bars allow, and in the middle
    // of the bottom bar rather than a corner of it
    check('a U-shaped part is labeled inside it, mid-bar, where its vertices’ mean is not',
      inside(xs, ys, x, y) && !inside(xs, ys, cx, cy) && Math.abs(x - 15) < 2 && y > 2 && y < 4,
      `label at (${x.toFixed(1)}, ${y.toFixed(1)}), mean (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
  }

  // ---- the page
  {
    const res = runPipeline(rings(), base, 'stencil', { floating: true }, { preview: false });
    const plan = assemblyPlan(res, { stem: 'rings' });
    const html = assemblyHTML(plan, { title: 'Rings <b>&', widthMm: res.piece.widthMm, heightMm: res.piece.heightMm, thumbs: ['data:image/png;base64,AAAA'] });
    const labels = [...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    check('the page: each part labeled once on its map, the files listed, the thumbnail in place',
      labels.join() === '1.1,1.2,1.3' && html.includes(plan.sheets[0].svg) && html.includes(plan.sheets[0].dxf) &&
        html.includes('href="data:image/png;base64,AAAA"'),
      `labels ${labels.join(', ')}`);
    const external = [...html.matchAll(/(?:src|href)="(https?:[^"]*)"/g)].map((m) => m[1]);
    check('the page escapes the title and loads nothing from elsewhere',
      html.includes('Rings &lt;b&gt;&amp;') && !html.includes('<b>&') && external.length === 0 && !/<script\b/.test(html),
      external.length ? external.join(', ') : 'no outside references, no scripts');
  }
}
