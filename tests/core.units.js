// core/units.js: the cell grid's margin invariant, and applyTone's gamma,
// brightness and saturation.

import { check, section, flatGray, makeRGBA, plain } from './runner.js';
import { prepare, applyTone } from '../src/core/units.js';
import { luminance, toLinear } from '../src/core/color.js';

export function run() {
  section('core.units', 'The cell grid keeps its margin invariant, or refuses rather than breaking it. applyTone: identity at defaults, brightness scales linear light, saturation moves toward/away from luminance without changing it, no invalid pixels at extreme settings.');

  {
    // A piece wide enough for several cells: the margin invariant holds with room
    // to spare, and prepare() succeeds as before.
    const ctx = prepare(flatGray(10, 10, 128), { ...plain, widthMm: 24, pitch: 1.6, web: 0.2 });
    check('a piece with room for several cells succeeds', ctx.cols >= 1,
      `${ctx.cols} cols, margin ${ctx.margin.toFixed(3)} mm`);
    check('its margin is at least web/2', ctx.margin >= ctx.web / 2 - 1e-9,
      `margin ${ctx.margin.toFixed(3)} mm, web/2 ${(ctx.web / 2).toFixed(3)} mm`);
  }

  {
    // A piece exactly one pitch plus one web wide: the boundary case, cols === 1
    // and margin === web/2 exactly (values chosen to divide exactly in floating point).
    const ctx = prepare(flatGray(10, 10, 128), { ...plain, widthMm: 3, pitch: 2, web: 1 });
    check('a piece exactly one cell wide keeps cols=1 and margin=web/2', ctx.cols === 1 && Math.abs(ctx.margin - ctx.web / 2) < 1e-9,
      `${ctx.cols} cols, margin ${ctx.margin.toFixed(3)} mm`);
  }

  {
    // A piece narrower than one pitch used to silently clamp to a 1-column grid
    // with a margin below web/2 (or negative) -- the exact quantity the one-piece
    // structural guarantee depends on. It must now refuse instead.
    let threw = false;
    try { prepare(flatGray(10, 10, 128), { ...plain, widthMm: 1, pitch: 2, web: 1 }); }
    catch (e) { threw = true; }
    check('a piece narrower than one pitch is refused, not silently clamped', threw);
  }

  // ---- applyTone: identity, brightness, saturation. Output is encoded pixels
  // (like a Style filter's), so checks that care about the underlying LINEAR
  // relationship decode a channel back with toLinear first, and use a looser
  // tolerance than an exact linear check would need, for the 8-bit round trip.
  {
    const img = flatGray(10, 10, 128);
    check('applyTone: all three at their defaults is an identity (the same object)',
      applyTone(img, 1, 1, 1) === img);
  }

  {
    const gray = flatGray(4, 4, 128);
    const base = toLinear(applyTone(gray, 1, 1, 1).data[0] / 255);
    const bright = toLinear(applyTone(gray, 1, 2, 1).data[0] / 255);
    check('brightness scales linear light', Math.abs(bright - Math.min(1, base * 2)) < 0.01,
      `base ${base.toFixed(4)}, ×2 → ${bright.toFixed(4)}`);
  }

  {
    const img = makeRGBA(2, 2, () => [200, 80, 40]);
    const out = applyTone(img, 1, 1, 0);
    check('saturation 0 desaturates to the pixel’s own luminance', out.data[0] === out.data[1] && out.data[1] === out.data[2],
      `r ${out.data[0]}, g ${out.data[1]}, b ${out.data[2]}`);
  }

  {
    // Two IN-GAMUT saturation levels (both <= 1, a convex combination of the
    // pixel and its own luminance, so neither can leave [0,1] and the identity
    // holds exactly, modulo the 8-bit round trip). A push ABOVE 1 can drive a
    // channel negative -- clamped, correctly, which breaks exact luminance
    // preservation on purpose; that is not what this checks.
    const img = makeRGBA(2, 2, () => [200, 80, 40]);
    const at = (sat) => { const o = applyTone(img, 1, 1, sat); return [0, 1, 2].map((k) => toLinear(o.data[k] / 255)); };
    const low = at(0.3), high = at(0.8);
    const chroma = (c) => Math.abs(c[0] - c[1]);
    const lum = (c) => luminance(c[0], c[1], c[2]);
    check('higher saturation (within gamut) increases chroma but keeps luminance', chroma(high) > chroma(low) && Math.abs(lum(high) - lum(low)) < 0.01,
      `chroma ${chroma(low).toFixed(4)} → ${chroma(high).toFixed(4)}, luminance ${lum(low).toFixed(4)} vs ${lum(high).toFixed(4)}`);
  }

  {
    const img = flatGray(2, 2, 255);
    const out = applyTone(img, 1, 3, 2);
    let ok = true;
    for (const v of out.data) if (!(Number.isFinite(v) && v >= 0 && v <= 255)) ok = false;
    check('extreme brightness and saturation never produce an invalid pixel', ok);
  }
}
