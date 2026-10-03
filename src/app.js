// UI wiring. Compute happens in worker.js; this module gathers settings, paints
// results and exports. The only file that knows what a DOM is (plus svg.js's
// download helper).

import { METHODS, byId, defaultsFor, paramVisible } from './methods/index.js';
import { layerSVG, downloadSVG, downloadFile, HOLE_STROKE, OUTLINE_STROKE } from './core/svg.js';
import { layerDXF } from './core/dxf.js';
import { sheetFileName } from './core/names.js';
import { FILTERS, filterById } from './core/style.js';
import { holePathData } from './core/holes.js';
import { MAX_CELLS } from './core/units.js';
import { generateSample } from './app/samples.js';

const $ = (id) => document.getElementById(id);

/** Starting colors per stack height, top sheet first, base last. */
const DEFAULT_PALETTES = {
  2: ['#c8102e', '#1a1a1a'],
  3: ['#f2f2f2', '#c8102e', '#1a1a1a'],
  4: ['#f2f2f2', '#e8b400', '#c8102e', '#1a1a1a'],
};

const state = {
  rgbaColor: null,    // {width,height,data} the source as loaded
  rgbaGray: null,     // what B&W reads: the same image, except the procedural
                      // samples, whose color version is a hue sweep that would
                      // wreck a gray ramp
  imageName: 'piece',
  methodId: METHODS[0].id,
  params: defaultsFor(METHODS[0]),
  view: 'result',
  rulers: false,
  palette: DEFAULT_PALETTES[3].slice(),
  // Style filters: the chain order, which are on, and each one's settings
  style: {
    order: FILTERS.map((f) => f.id),
    on: {},
    params: Object.fromEntries(FILTERS.map((f) => [f.id, Object.fromEntries(f.params.map((p) => [p.key, p.def]))])),
  },
  result: null,
  jobId: 0,
  pending: false,
};

// ------------------------------------------------------------------ worker
let worker = null;

function spawnWorker() {
  try {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => setStatus(`worker error: ${e.message}`, 'bad');
    return w;
  } catch (err) {
    setStatus('module workers unavailable — see console', 'bad');
    console.error(err);
    return null;
  }
}
worker = spawnWorker();

/** A busy worker cannot see a stop message; terminating it is the only cancel. */
function cancelInFlight() {
  if (!worker || !state.pending) return;
  worker.terminate();
  worker = spawnWorker();
  state.pending = false;
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.jobId !== state.jobId) return;
  if (msg.type === 'progress') { setStatus(msg.stage + '…'); return; }
  if (msg.type === 'error') {
    state.pending = false;
    setStatus(`error: ${msg.message}`, 'bad');
    console.error(msg.stack || msg.message);
    return;
  }
  if (msg.type === 'palette') {
    state.pending = false;
    state.palette = msg.palette;
    buildPalette();
    run();
    return;
  }
  if (msg.type === 'done') {
    state.pending = false;
    state.result = msg;
    setStatus('ready');
    buildLayerControls();
    paint();
    updateStats();
  }
}

// ----------------------------------------------------------------- settings
const num = (id) => parseFloat($(id).value);
const mode = () => $('mode').value;
const nSheets = () => (mode() === 'color' ? parseInt($('nSheets').value, 10) : 2);

function readSettings() {
  return {
    widthMm: num('widthMm'),
    web: num('web'),
    minHole: num('minHole'),
    kerf: num('kerf'),
    reg: num('reg'),
    border: num('border'),
    alignHoles: $('alignHoles').checked,
    alignDist: num('alignDist'),
    alignDia: num('alignDia'),
    gamma: num('gamma'),
    brightness: num('brightness'),
    saturation: num('saturation'),
    speed: num('speed'),
    pierce: num('pierce'),
    mode: mode(),
    palette: state.palette.slice(0, nSheets()),
    sheet: $('sheetColor').value,
    backdrop: $('backdropColor').value,
    style: {
      chain: state.style.order.filter((id) => state.style.on[id]).map((id) => ({ id, ...state.style.params[id] })),
    },
  };
}

/** Catch settings the pipeline would reject, and say why here rather than as an error. */
function validate(s) {
  if (![s.widthMm, s.web, s.minHole, s.kerf, s.border, s.speed, s.pierce].every(isFinite)) return 'fill in every machine field';
  if (s.alignHoles && ![s.alignDist, s.alignDia].every(isFinite)) return 'fill in the alignment hole fields';
  const pitch = state.params.pitch;       // only the patterns built on cells have one
  if (pitch === undefined) return '';
  if (pitch <= s.web) return 'cell size must be larger than the min web';
  if (Math.floor((s.widthMm - s.web) / pitch) < 1) return 'the piece is narrower than one cell';
  return '';
}

function currentRGBA() {
  return mode() === 'color' ? state.rgbaColor : state.rgbaGray;
}

function run() {
  const rgba = currentRGBA();
  if (!rgba || !worker) return;
  const settings = readSettings();
  updateGridNote(settings, rgba);
  const problem = validate(settings);
  if (problem) { setStatus(problem, 'bad'); return; }
  cancelInFlight();
  if (!worker) return;
  state.jobId++;
  state.pending = true;
  setStatus('working…');
  worker.postMessage({
    type: 'run', jobId: state.jobId, rgba, settings,
    methodId: state.methodId, params: state.params,
  });
}

let runTimer = null;
function scheduleRun(delay = 200) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, delay);
}

function suggest() {
  if (!state.rgbaColor || !worker) return;
  cancelInFlight();
  if (!worker) return;
  state.jobId++;
  state.pending = true;
  setStatus('suggesting colors…');
  // Suggest from what the method will actually see: Tone and then the Style
  // chain restyle the image first, same as a run (see runPipeline).
  worker.postMessage({
    type: 'suggest', jobId: state.jobId, rgba: state.rgbaColor, n: nSheets(),
    settings: readSettings(),
  });
}

function updateGridNote(s, rgba) {
  const pitch = state.params.pitch;
  if (state.methodId !== 'squareGrid') {
    const H = (s.widthMm * rgba.height) / rgba.width;
    const how = state.methodId === 'stipple' ? 'dots keep at least one min web apart'
      : state.methodId === 'stencil' ? 'shapes are cut whole; metal thinner than the min web is thickened'
      : state.methodId === 'screen' ? 'slots are tied and bridged; metal thinner than the min web is thickened'
      : state.methodId === 'rectangles' ? 'straight cuts placed by the image, into flat blocks of the sheet colors'
      : `cells about ${fmtMm(pitch)} mm where the image is flat, smaller where it is detailed`;
    $('gridNote').innerHTML = isFinite(H) ? `piece <b>${fmtMm(s.widthMm)} × ${fmtMm(H)} mm</b> · ${how}` : '';
    return;
  }
  const cols = Math.max(1, Math.floor((s.widthMm - s.web) / pitch));
  const rows = Math.max(1, Math.round((cols * rgba.height) / rgba.width));
  const H = rows * pitch + (s.widthMm - cols * pitch);
  const tooMany = cols * rows > MAX_CELLS;
  $('gridNote').innerHTML = isFinite(H)
    ? `${cols} × ${rows} cells · piece <b>${fmtMm(s.widthMm)} × ${fmtMm(H)} mm</b>` +
      (tooMany ? ' <span class="bad">— too many cells</span>' : '')
    : '';
}

// ------------------------------------------------------------------- paint
const RULER_SIZE = 20;

function fitStage(canvas, w, h) {
  canvas.width = w;
  canvas.height = h;
  const stage = document.querySelector('.stage');
  const rulerSpace = state.rulers ? RULER_SIZE : 0;
  const maxW = stage.clientWidth - 28 - rulerSpace;
  const maxH = stage.clientHeight - 28 - rulerSpace;
  const scale = Math.min(maxW / w, maxH / h, 2);
  const cssW = Math.max(1, Math.floor(w * scale));
  const cssH = Math.max(1, Math.floor(h * scale));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  $('wrap').style.width = `${cssW}px`;
  $('wrap').style.height = `${cssH}px`;
  return { scale, cssW, cssH };
}

/** Shows/hides the ruler canvases and redraws their ticks for the current zoom. */
function updateRulers(pv, scale, cssW, cssH) {
  const show = state.rulers;
  $('rulerCorner').hidden = !show;
  $('rulerTop').hidden = !show;
  $('rulerLeft').hidden = !show;
  if (!show) return;
  const pxPerMmCss = pv.pxPerMm * scale;
  const step = rulerStep(pxPerMmCss);
  sizeRulerCanvas($('rulerTop'), cssW, RULER_SIZE);
  sizeRulerCanvas($('rulerLeft'), RULER_SIZE, cssH);
  drawRuler($('rulerTop').getContext('2d'), cssW, pxPerMmCss, step, false);
  drawRuler($('rulerLeft').getContext('2d'), cssH, pxPerMmCss, step, true);
}

function sizeRulerCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}

/** The mm spacing between labeled major ticks, the first "nice" step that
 * keeps labels at least ~45 css px apart at the current zoom. */
function rulerStep(pxPerMmCss) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  for (const s of steps) if (s * pxPerMmCss >= 45) return s;
  return steps[steps.length - 1];
}

function drawRuler(ctx, lengthCss, pxPerMmCss, majorStep, vertical) {
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, vertical ? RULER_SIZE : lengthCss, vertical ? lengthCss : RULER_SIZE);
  ctx.fillStyle = '#20232b';
  ctx.fillRect(0, 0, vertical ? RULER_SIZE : lengthCss, vertical ? lengthCss : RULER_SIZE);
  ctx.strokeStyle = '#8a92a6';
  ctx.fillStyle = '#c6cad6';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  const minorStep = majorStep / 5;
  const maxMm = lengthCss / pxPerMmCss;
  for (let mm = 0; mm <= maxMm + minorStep; mm += minorStep) {
    const pos = Math.round(mm * pxPerMmCss) + 0.5;
    if (pos > lengthCss) break;
    const isMajor = Math.round(mm / minorStep) % 5 === 0;
    const tickLen = isMajor ? RULER_SIZE : RULER_SIZE * 0.4;
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(RULER_SIZE - tickLen, pos);
      ctx.lineTo(RULER_SIZE, pos);
    } else {
      ctx.moveTo(pos, RULER_SIZE - tickLen);
      ctx.lineTo(pos, RULER_SIZE);
    }
    ctx.stroke();
    if (isMajor && mm > 0) {
      const label = String(Math.round(mm));
      if (vertical) {
        // Fixed inset from the canvas-adjacent edge, independent of tickLen
        // (which spans the full width for major ticks) so the rotated label
        // always lands inside the ruler's bounds instead of off its edge.
        ctx.save();
        ctx.translate(RULER_SIZE - 6, pos + 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(label, pos + 2, 1);
      }
    }
  }
  ctx.restore();
}

const HINTS = {
  result: 'front-lit: the sheet over what is behind it',
  backlit: 'light through the holes',
  cut: 'what the beam follows, kerf-offset',
  source: 'the image, over the grid area',
  diff: 'red = too dark, blue = too light, per cell',
};

function paint() {
  const res = state.result;
  if (!res) return;
  const canvas = $('view');
  const pv = res.preview;
  const { scale, cssW, cssH } = fitStage(canvas, pv.w, pv.h);
  updateRulers(pv, scale, cssW, cssH);
  const ctx = canvas.getContext('2d');
  $('hint').textContent = state.view === 'result' && res.piece.mode === 'color'
    ? 'front-lit, as the stacked sheets look' : HINTS[state.view] || '';

  if (state.view === 'cut') { paintCut(ctx, res); return; }

  const out = ctx.createImageData(pv.w, pv.h);
  if (state.view === 'diff') {
    for (let i = 0, p = 0; i < pv.diff.length; i++, p += 4) {
      const e = pv.diff[i];
      const [r, g, b] = isNaN(e) ? [128, 128, 128] : divergingColor(e);
      out.data[p] = r; out.data[p + 1] = g; out.data[p + 2] = b; out.data[p + 3] = 255;
    }
  } else {
    const src = state.view === 'source' ? pv.source
      : state.view === 'backlit' && pv.backlit ? pv.backlit
      : pv.result;
    out.data.set(src);
  }
  ctx.putImageData(out, 0, 0);
}

/** Red = rendered darker than target, blue = lighter, white = on target. */
function divergingColor(e) {
  e = Math.max(-0.3, Math.min(0.3, e)) / 0.3;
  const a = Math.abs(e);
  return e > 0
    ? [255 * (1 - a), 255 * (1 - a * 0.55), 255]
    : [255, 255 * (1 - a * 0.65), 255 * (1 - a * 0.65)];
}

/** The chosen sheet's cut paths, drawn from the same geometry the SVG is. */
function paintCut(ctx, res) {
  const pv = res.preview;
  const k = pv.pxPerMm;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pv.w, pv.h);
  const li = parseInt($('cutLayer').value || '0', 10);
  // Every sheet gets the alignment holes too, including the solid base (li
  // beyond layers.length, which has no pattern holes of its own) -- same as
  // exportLayer.
  const holes = (res.layers[li] || []).concat(res.align || []);
  ctx.save();
  ctx.scale(k, k);
  ctx.lineWidth = Math.max(0.6 / k, 0.02);
  if (holes.length) {
    ctx.strokeStyle = HOLE_STROKE;
    const fmt = (v) => v.toFixed(4);
    const path = new Path2D();
    for (const h of holes) path.addPath(new Path2D(holePathData(h, fmt)));
    ctx.stroke(path);
  }
  // The outline's true path lies kerf/2 outside the piece, off the canvas; draw
  // it just inside the edge instead, where it can be seen.
  const lw = ctx.lineWidth;
  ctx.strokeStyle = OUTLINE_STROKE;
  ctx.strokeRect(lw / 2, lw / 2, res.piece.widthMm - lw, res.piece.heightMm - lw);
  ctx.restore();
}

// ------------------------------------------------------------------- stats
const fmtMm = (v) => (Math.round(v * 10) / 10).toString();

function fmtTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function setStat(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

function updateStats() {
  const res = state.result;
  if (!res) return;
  const st = res.stats;
  const L = st.layers;
  const holes = L.reduce((a, l) => a + l.holes, 0);
  // A stack's solid base is cut too: its outline and one pierce.
  const base = res.piece.mode === 'color' ? outlineLength(res.piece) : 0;
  const cut = L.reduce((a, l) => a + l.length, 0) + base;
  const time = L.reduce((a, l) => a + l.seconds, 0) +
    (base ? base / num('speed') + num('pierce') : 0);
  const web = Math.min(...L.map((l) => l.thinnestWeb));
  setStat('statCells', st.cellsLabel);
  setStat('statHoles', holes.toLocaleString());
  setStat('statOpen', `${(100 * L[0].openFraction).toFixed(1)}%`);
  setStat('statWeb', isFinite(web) ? `${web.toFixed(2)} mm` : '—',
    web < res.piece.web - 1e-6 ? 'bad' : '');
  setStat('statDropped', st.dropped.toLocaleString(), st.dropped > 0.02 * st.cells ? 'warn' : '');
  setStat('statCut', cut >= 1000 ? `${(cut / 1000).toFixed(2)} m` : `${Math.round(cut)} mm`);
  setStat('statTime', fmtTime(time));
  setStat('statFid', st.fidelity.toFixed(3));
  setStat('statReach', st.reach.toFixed(3));
  const notes = [];
  if (res.note) notes.push(res.note);
  if (st.dropped > 0) notes.push(`${st.dropped} cells wanting less than the smallest hole were dithered to none`);
  if (st.saturated > 0.2 * st.cells) notes.push(`${Math.round(100 * st.saturated / st.cells)}% of cells at the largest hole`);
  $('methodNote').textContent = notes.join(' · ');
}

const outlineLength = (g) => 2 * (g.widthMm + g.heightMm + 2 * g.kerf);

// ----------------------------------------------------------- sheets & export
function buildPalette() {
  const n = nSheets();
  while (state.palette.length < n) state.palette.splice(state.palette.length - 1, 0, '#808080');
  if (state.palette.length > n) state.palette = [...state.palette.slice(0, n - 1), state.palette[state.palette.length - 1]];
  const names = sheetNamesFor(n);
  const host = $('palette');
  host.innerHTML = '';
  state.palette.forEach((hex, i) => {
    const row = document.createElement('div');
    row.className = 'sheet';
    row.innerHTML = `<span class="name">${names[i]}</span>` +
      `<input type="color" value="${hex}">` +
      `<span class="hex">${hex}</span>` +
      `<button class="mini" data-dir="-1" title="move up the stack"${i === 0 ? ' disabled' : ''}>↑</button>` +
      `<button class="mini" data-dir="1" title="move down the stack"${i === n - 1 ? ' disabled' : ''}>↓</button>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      state.palette[i] = input.value;
      row.querySelector('.hex').textContent = input.value;
      scheduleRun();
    });
    for (const b of row.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const j = i + parseInt(b.dataset.dir, 10);
        [state.palette[i], state.palette[j]] = [state.palette[j], state.palette[i]];
        buildPalette();
        scheduleRun(0);
      });
    }
    host.appendChild(row);
  });
}

/** Per-sheet export buttons and the Cut-paths sheet picker, sized to the result. */
function buildLayerControls() {
  const res = state.result;
  const names = res.piece.mode === 'color' ? sheetNamesFor(res.piece.nCut + 1) : ['Sheet'];
  const host = $('layerExports');
  host.innerHTML = '';
  names.forEach((name, i) => {
    for (const ext of ['svg', 'dxf']) {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = `${name} ${ext.toUpperCase()}`;
      b.title = `download ${name.toLowerCase()} as ${ext.toUpperCase()}: ${layerFileName(i, ext)}`;
      b.addEventListener('click', () => exportLayer(i, ext));
      host.appendChild(b);
    }
  });
  const sel = $('cutLayer');
  const prev = sel.value;
  sel.innerHTML = names.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  if (prev && parseInt(prev, 10) < names.length) sel.value = prev;
}

function sheetNamesFor(n) {
  return Array.from({ length: n }, (_, i) =>
    i === 0 ? 'Top sheet' : i === n - 1 ? 'Base (solid)' : `Sheet ${i + 1}`);
}

/** SVG names as before; DXF names carry the sheet's hex color. */
const layerFileName = (i, ext = 'svg') => sheetFileName(state.imageName, i, state.result.piece, ext, ext === 'dxf');

function exportLayer(i, ext = 'svg') {
  const res = state.result;
  if (!res) return;
  // Every exported sheet gets the alignment holes too, including the solid base
  // (index >= layers.length, which has no pattern holes of its own).
  const holes = (res.layers[i] || []).concat(res.align || []);
  const name = layerFileName(i, ext);
  if (ext === 'dxf') downloadFile(layerDXF(res.piece, holes).text, name, 'application/dxf');
  else downloadSVG(layerSVG(res.piece, holes, { name }).text, name);
}

async function exportAll(ext = 'svg') {
  const res = state.result;
  if (!res) return;
  const n = res.piece.mode === 'color' ? res.piece.nCut + 1 : 1;
  for (let i = 0; i < n; i++) {
    exportLayer(i, ext);
    // Browsers drop back-to-back downloads fired in the same tick.
    await new Promise((r) => setTimeout(r, 350));
  }
}

function exportPng() {
  const canvas = $('view');
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.imageName}-${state.view}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

// ------------------------------------------------------------------ images
function loadFromImageBitmapSource(src, name) {
  const c = document.createElement('canvas');
  const maxDim = 1400;
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const imgData = ctx.getImageData(0, 0, c.width, c.height);
  setImage({ width: imgData.width, height: imgData.height, data: imgData.data }, null, name);
}

function setImage(rgbaColor, rgbaGray, name) {
  state.rgbaColor = rgbaColor;
  state.rgbaGray = rgbaGray || rgbaColor;
  state.imageName = safeStem(name);
  if (mode() === 'color') suggest(); else run();
}

function safeStem(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '');
  return s.slice(0, 64) || 'piece';
}

function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus(`${file.name} is not an image`, 'bad');
    return;
  }
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    loadFromImageBitmapSource(img, file.name.replace(/\.[^.]+$/, ''));
  };
  img.onerror = () => {
    URL.revokeObjectURL(img.src);
    setStatus(`could not decode ${file.name}`, 'bad');
  };
  img.src = URL.createObjectURL(file);
}

const PRESET_IMAGES = {
  rhino: new URL('../assets/rhino.jpg', import.meta.url).href,
};

function loadPreset(kind, fallback = null) {
  const src = PRESET_IMAGES[kind];
  if (!src) { sample(kind); return; }
  const img = new Image();
  img.onload = () => loadFromImageBitmapSource(img, `sample-${kind}`);
  img.onerror = () => {
    setStatus(`could not load the ${kind} sample`, 'bad');
    if (fallback) sample(fallback);
  };
  img.src = src;
}

/** A procedural sample, when a bundled preset photo fails to load (src/app/samples.js). */
function sample(kind) {
  const { color, gray } = generateSample(kind);
  setImage(color, gray, `sample-${kind}`);
}

// ------------------------------------------------------------------ params
function buildMethodUI() {
  const sel = $('method');
  sel.innerHTML = METHODS.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  sel.value = state.methodId;
  $('methodBlurb').textContent = byId(state.methodId).blurb || '';
}

function buildParamUI() {
  renderParams($('methodParams'), byId(state.methodId).params, state.params, 'param', buildParamUI);
}

/**
 * Controls for a list of params (a method's or a style filter's), into `host`,
 * reading and writing `values`. Ids are `${prefix}-${key}`. `rebuild` re-renders
 * when a select, checkbox or released range may have changed which params show.
 */
function renderParams(host, defs, values, prefix, rebuild) {
  host.innerHTML = '';
  for (const p of defs) {
    if (!paramVisible(p, values, { mode: mode() })) continue;
    const id = `${prefix}-${p.key}`;
    const el = p.type === 'checkbox' ? renderCheckboxParam(p, id, values, rebuild)
      : p.type === 'select' ? renderSelectParam(p, id, values, rebuild)
      : renderRangeParam(p, id, values, rebuild);
    host.appendChild(el);
  }
}

/** A checkbox param: a single labeled toggle. */
function renderCheckboxParam(p, id, values, rebuild) {
  const lab = document.createElement('label');
  lab.className = 'check';
  lab.innerHTML = `<input type="checkbox" id="${id}"> ${p.label}`;
  const input = lab.querySelector('input');
  input.checked = !!values[p.key];
  input.addEventListener('change', () => {
    values[p.key] = input.checked;
    rebuild();
    scheduleRun(0);
  });
  return lab;
}

/** A select param: a labeled dropdown. */
function renderSelectParam(p, id, values, rebuild) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label for="${id}">${p.label}</label><select id="${id}">` +
    p.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('') + '</select>';
  const input = row.querySelector('select');
  input.value = values[p.key];
  input.addEventListener('change', () => {
    values[p.key] = input.value;
    rebuild();       // a gate may read this select
    scheduleRun(0);
  });
  return row;
}

/** A numeric param: a labeled slider with its live value shown alongside. */
function renderRangeParam(p, id, values, rebuild) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label for="${id}">${p.label}</label>` +
    `<input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}">` +
    '<span class="val"></span>';
  const input = row.querySelector('input');
  const val = row.querySelector('.val');
  const dp = p.dp ?? (p.step >= 1 ? 0 : 2);
  const show = () => { val.textContent = Number(input.value).toFixed(dp) + (p.unit ? ` ${p.unit}` : ''); };
  input.value = values[p.key];
  show();
  input.addEventListener('input', () => {
    values[p.key] = parseFloat(input.value);
    show();
    scheduleRun();
  });
  // a range can gate another param (Turing's Anisotropy shows "Worms run"), so
  // rebuild on release -- not while dragging, which would drop the drag
  input.addEventListener('change', () => rebuild());
  return row;
}


/**
 * The Style section: one card per filter, in chain order -- a tick to use it,
 * up/down to move it, and its own controls while it is on. Built from the filter
 * registry (core/style.js), so a new filter needs no change here.
 */
function buildStyleUI() {
  const host = $('styleChain');
  host.innerHTML = '';
  const { order, on, params } = state.style;
  order.forEach((fid, i) => {
    const f = filterById(fid);
    const card = document.createElement('div');
    card.className = `fcard${on[fid] ? ' on' : ''}`;
    card.innerHTML = `<div class="fhead"><label class="check"><input type="checkbox" id="style-${fid}"> ${f.label}</label>` +
      `<button class="mini" data-dir="-1" title="run earlier"${i === 0 ? ' disabled' : ''}>↑</button>` +
      `<button class="mini" data-dir="1" title="run later"${i === order.length - 1 ? ' disabled' : ''}>↓</button></div>` +
      '<div class="fbody"><div class="fparams"></div><p class="note"></p></div>';
    const tick = card.querySelector('input');
    tick.checked = !!on[fid];
    tick.addEventListener('change', () => { on[fid] = tick.checked; buildStyleUI(); scheduleRun(0); });
    for (const b of card.querySelectorAll('button')) {
      b.addEventListener('click', () => {
        const j = i + parseInt(b.dataset.dir, 10);
        [order[i], order[j]] = [order[j], order[i]];
        buildStyleUI();
        if (on[order[i]] || on[order[j]]) scheduleRun(0);
      });
    }
    const fbody = card.querySelector('.fbody');
    fbody.hidden = !on[fid];
    if (on[fid]) {
      renderParams(card.querySelector('.fparams'), f.params, params[fid], `style-${fid}`, buildStyleUI);
      card.querySelector('.note').textContent = f.blurb;
    }
    host.appendChild(card);
  });
}

// ------------------------------------------------------------------- misc
function setStatus(text, cls = '') {
  const el = $('status');
  el.textContent = text;
  el.className = cls;
}

function bindRange(id, fmt) {
  const input = $(id), val = $(`${id}Val`);
  const show = () => { val.textContent = fmt(parseFloat(input.value)); };
  show();
  input.addEventListener('input', () => { show(); scheduleRun(); });
}

function updateModeUI() {
  const color = mode() === 'color';
  $('bwGroup').hidden = color;
  $('colorGroup').hidden = !color;
  document.querySelector('[data-view="backlit"]').hidden = color;
  if (color && state.view === 'backlit') setView('result');
  $('exportAll').textContent = color ? 'Export all SVG' : 'Export SVG';
  $('exportAllDxf').textContent = color ? 'Export all DXF' : 'Export DXF';
}

function setView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#viewSeg button')) {
    b.setAttribute('aria-pressed', String(b.dataset.view === v));
  }
  $('cutLayer').hidden = v !== 'cut';
  paint();
}

function init() {
  buildMethodUI();
  buildParamUI();
  buildPalette();
  updateModeUI();

  wireModeControls();
  wireImageControls();
  wireMachineControls();
  wireViewControls();
  wireIOControls();

  loadPreset('rhino', 'sphere');
}

/** Method and mode: switching patterns, B&W/color, sheet count, the palette suggester. */
function wireModeControls() {
  $('method').addEventListener('change', () => {
    const prevMethod = state.methodId;
    state.methodId = $('method').value;
    // Settings the two patterns share (cell size, tone range, seed...) carry over,
    // so switching to compare them does not quietly reset what you had chosen.
    // Only where the defaults agree: a shared NAME is not a shared meaning --
    // Voronoi's Relax defaults to 2 and stipple's to 8, on different scales.
    const prevDefs = defaultsFor(byId(prevMethod)), prev = state.params;
    state.params = defaultsFor(byId(state.methodId));
    for (const k of Object.keys(state.params)) {
      if (k in prev && prevDefs[k] === state.params[k]) state.params[k] = prev[k];
    }
    buildMethodUI();
    buildParamUI();
    run();
  });

  $('mode').addEventListener('change', () => {
    updateModeUI();
    buildPalette();
    buildParamUI();         // some params only apply to one mode
    if (mode() === 'color') suggest(); else run();
  });
  $('nSheets').addEventListener('change', () => {
    state.palette = DEFAULT_PALETTES[nSheets()].slice();
    buildPalette();
    suggest();
  });
  $('suggest').addEventListener('click', suggest);
}

/** The Style section and the darkness/brightness/saturation sliders every method sees before it. */
function wireImageControls() {
  bindRange('gamma', (v) => v.toFixed(2));
  bindRange('brightness', (v) => v.toFixed(2));
  bindRange('saturation', (v) => v.toFixed(2));
  buildStyleUI();
}

/** Cutter and material settings, and the sheet/backdrop color swatches. */
function wireMachineControls() {
  for (const id of ['widthMm', 'web', 'minHole', 'kerf', 'reg', 'border', 'speed', 'pierce', 'alignDist', 'alignDia']) {
    $(id).addEventListener('input', () => scheduleRun(400));
  }
  $('alignHoles').addEventListener('change', () => {
    $('alignFields').hidden = !$('alignHoles').checked;
    scheduleRun();
  });
  for (const id of ['sheetColor', 'backdropColor']) {
    const input = $(id);
    const hex = input.parentElement.querySelector('.hex');
    hex.textContent = input.value;
    input.addEventListener('input', () => { hex.textContent = input.value; scheduleRun(); });
  }
}

/** The preview's view mode, its per-layer switch, and repainting on resize. */
function wireViewControls() {
  for (const b of document.querySelectorAll('#viewSeg button')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }
  $('cutLayer').addEventListener('change', paint);
  $('rulers').addEventListener('change', () => {
    state.rulers = $('rulers').checked;
    paint();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(paint, 100);
  });
}

/** Export buttons, and loading an image by drop, file picker, or a sample button. */
function wireIOControls() {
  $('exportAll').addEventListener('click', () => exportAll('svg'));
  $('exportAllDxf').addEventListener('click', () => exportAll('dxf'));
  $('exportPng').addEventListener('click', exportPng);

  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });
  for (const b of document.querySelectorAll('[data-sample]')) {
    b.addEventListener('click', () => loadPreset(b.dataset.sample));
  }
}

init();
