// Shared harness machinery: output accumulation, pass/fail lines, fixtures.
//
// NOTHING HERE TOUCHES THE DOM. tests/report.js paints the accumulated HTML in a
// browser; run-tests.mjs strips it to text under node/deno. Same test modules both
// ways.

import { mulberry32 } from '../src/shim/random.js';

const html = [];
export const say = (s) => html.push(s);
export const getHtml = () => html.join('\n');
export const reset = () => { html.length = 0; };

export const num = (v, dp = 3) => (isFinite(v) ? v.toFixed(dp) : String(v));

const tally = { pass: 0, fail: 0 };
export const getTally = () => ({ ...tally });

/** One checked claim. `detail` is the measurement, so a failure says by how much. */
export function check(label, ok, detail = '') {
  if (ok) tally.pass++; else tally.fail++;
  say(`<p><span class="${ok ? 'pass' : 'fail'}">${ok ? 'PASS' : 'FAIL'}</span> ${label}` +
      (detail ? ` <span class="note">— ${detail}</span>` : '') + '</p>');
  return ok;
}

export const section = (title, blurb = '') => {
  say(`<h2>${title}</h2>`);
  if (blurb) say(`<p class="note">${blurb}</p>`);
};

export const mkRand = mulberry32;

/** An RGBA fixture from fn(x, y) -> [r, g, b] in 0-255. */
export function makeRGBA(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const p = 4 * (y * w + x);
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Gray ramp, black at the left, white at the right. */
export const grayRamp = (w, h) => makeRGBA(w, h, (x) => {
  const v = Math.round((255 * x) / (w - 1));
  return [v, v, v];
});

export const flatGray = (w, h, v) => makeRGBA(w, h, () => [v, v, v]);

/** Seeded per-pixel noise, in color or gray. */
export function noiseRGBA(w, h, seed, color = true) {
  const rand = mulberry32(seed);
  return makeRGBA(w, h, () => {
    const r = rand() * 255;
    return color ? [r, rand() * 255, rand() * 255] : [r, r, r];
  });
}

/** Settings that make the maths easy to predict: no gamma, brightness or saturation shift. */
export const plain = {
  widthMm: 60, pitch: 3, web: 0.4, minHole: 0, kerf: 0, reg: 0,
  gamma: 1, brightness: 1, saturation: 1, mode: 'bw', speed: 20, pierce: 0.3,
};
