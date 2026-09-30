// Procedural sample images, used when a bundled preset photo fails to load (or as
// the built-in samples themselves): a ramp, rings, and a lit sphere over a horizon.
// Each comes in a grey version (for B&W) and a colour version (for a stack) -- the
// colour ramp is a hue sweep, which as luminance would no longer be a ramp at all.
//
// Pure pixel generation, with no dependency on app.js's state: app.js hands the
// result straight to setImage().

/** h in degrees, s/l in [0,1]. Returns [r,g,b] in [0,255]. */
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * @param {'ramp'|'rings'|string} kind  anything else falls back to the lit sphere
 * @returns {{width:number, height:number,
 *   colour:{width:number, height:number, data:Uint8ClampedArray},
 *   grey:{width:number, height:number, data:Uint8ClampedArray}}}
 */
export function generateSample(kind) {
  const w = 600, h = 600;
  const grey = new Uint8ClampedArray(w * h * 4);
  const col = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / (w - 1)) * 2 - 1, ny = (y / (h - 1)) * 2 - 1;
      let v, hue, sat;
      if (kind === 'ramp') {
        v = x / (w - 1); hue = 300 * v; sat = 0.95;
      } else if (kind === 'rings') {
        const r = Math.hypot(nx, ny);
        v = 0.5 + 0.45 * Math.cos(r * 18) * Math.exp(-r * 0.8);
        hue = (Math.atan2(ny, nx) * 180) / Math.PI; sat = 0.95;
      } else {
        const r = Math.hypot(nx, ny);
        if (r < 0.72) {
          const z = Math.sqrt(Math.max(0, 0.72 * 0.72 - r * r)) / 0.72;
          const lx = -0.45, ly = -0.55, lz = 0.7;
          const nlen = Math.hypot(nx, ny, z * 0.72) || 1;
          const dot = (nx * lx + ny * ly + z * 0.72 * lz) / nlen;
          v = Math.max(0.02, Math.min(1, 0.12 + 0.95 * Math.max(0, dot)));
          hue = 25; sat = 0.95;
        } else {
          v = 0.55 + 0.4 * (y / (h - 1)) - 0.12 * Math.exp(-((r - 0.72) ** 2) * 12);
          hue = 205; sat = 0.6;
        }
      }
      v = Math.max(0, Math.min(1, v));
      const p = 4 * (y * w + x);
      grey[p] = grey[p + 1] = grey[p + 2] = v * 255; grey[p + 3] = 255;
      const [rr, gg, bb] = hslToRgb(hue, sat, v);
      col[p] = rr; col[p + 1] = gg; col[p + 2] = bb; col[p + 3] = 255;
    }
  }
  return { width: w, height: h, colour: { width: w, height: h, data: col }, grey: { width: w, height: h, data: grey } };
}
