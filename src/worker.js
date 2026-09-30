// All compute, off the main thread. A thin wrapper: the pipeline itself is
// src/pipeline.js, which the harness also calls directly.
//
// Messages in:
//   {type:'run', jobId, rgba, settings, methodId, params}
//   {type:'suggest', jobId, rgba, n, settings}
// Messages out: 'progress', 'done', 'palette', 'error' -- all carry jobId, and the
// app drops any whose jobId is stale.

import { runPipeline } from './pipeline.js';
import { suggestPalette } from './core/separate.js';
import { applyStyle } from './core/style.js';
import { applyTone } from './core/units.js';

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'suggest') {
      // suggest from the same pixels the method will actually see: whatever Tone
      // and the Style chain do to the image, the app's Sheets tab sees too.
      const s = msg.settings || {};
      const toned = applyTone(msg.rgba, s.gamma, s.brightness, s.saturation);
      const rgba = applyStyle(toned, s.style, s.widthMm);
      self.postMessage({ type: 'palette', jobId: msg.jobId, palette: suggestPalette(rgba, msg.n) });
      return;
    }
    if (msg.type !== 'run') return;
    self.postMessage({ type: 'progress', jobId: msg.jobId, stage: 'cutting' });
    const out = runPipeline(msg.rgba, msg.settings, msg.methodId, msg.params);
    const p = out.preview;
    const transfer = [p.result.buffer, p.source.buffer, p.diff.buffer,
      ...(p.backlit ? [p.backlit.buffer] : [])];
    self.postMessage({ type: 'done', jobId: msg.jobId, ...out }, transfer);
  } catch (err) {
    self.postMessage({
      type: 'error', jobId: msg.jobId,
      message: String((err && err.message) || err), stack: err && err.stack,
    });
  }
};
