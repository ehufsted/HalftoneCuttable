// The only DOM-aware file in the harness. Paints after every section, so a slow
// or failing section is named on screen rather than leaving "Running…".

import { getHtml, reset } from './runner.js';
import { SECTIONS, summary } from './index.js';

const out = document.getElementById('out');
const param = new URLSearchParams(location.search).get('only');
const only = param ? param.split(',').map((s) => s.trim()) : null;
const status = (msg, cls = 'note') => `<p class="${cls}">${msg}</p>`;

function renderPicker() {
  const host = document.getElementById('sections');
  const cell = (n) => {
    const on = only && only.includes(n);
    return `<label class="pick${on ? ' on' : ''}"><input type="checkbox" value="${n}"${on ? ' checked' : ''}> ` +
      `<a href="?only=${encodeURIComponent(n)}" title="run only this one">${n}</a></label>`;
  };
  host.innerHTML =
    `<details${only ? ' open' : ''}><summary>Run a subset — <b>${only ? `${only.length} of ${SECTIONS.length}` : `all ${SECTIONS.length}`}</b> sections</summary>` +
    `<p>${SECTIONS.map(([n]) => cell(n)).join(' ')}</p>` +
    '<p><button id="runSel">Run selected</button> <button id="runAll">Run all</button></p></details>';
  document.getElementById('runSel').addEventListener('click', () => {
    const picked = [...host.querySelectorAll('input:checked')].map((i) => i.value);
    location.search = picked.length ? `?only=${picked.map(encodeURIComponent).join(',')}` : '';
  });
  document.getElementById('runAll').addEventListener('click', () => { location.search = ''; });
}
renderPicker();

const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  reset();
  const planned = SECTIONS.filter(([n]) => !only || only.includes(n));
  let total = 0;
  for (const [i, [name, mod]] of planned.entries()) {
    out.innerHTML = getHtml() + status(`running <b>${name}</b> — ${i} of ${planned.length} done…`);
    await yieldToPaint();
    const t0 = performance.now();
    try {
      mod.run();
    } catch (err) {
      out.innerHTML = getHtml() +
        status(`section <b>${name}</b> threw: ${String((err && err.message) || err)}`, 'fail') +
        `<pre>${String((err && err.stack) || '').replace(/</g, '&lt;')}</pre>`;
      throw err;
    }
    total += performance.now() - t0;
  }
  summary();
  out.innerHTML = getHtml() + status(`${planned.length} sections in ${(total / 1000).toFixed(1)} s.`);
}

main();
