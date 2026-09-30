// Headless harness runner, for when a JS runtime is available:
//
//   node run-tests.mjs              everything
//   node run-tests.mjs structure    one section
//   deno run --allow-read run-tests.mjs
//
// Exits non-zero if any check failed.

import { getHtml, getTally } from './tests/runner.js';
import { runAll, SECTIONS } from './tests/index.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (only.length) {
  const known = SECTIONS.map(([n]) => n);
  const bad = only.filter((n) => !known.includes(n));
  if (bad.length) {
    console.error(`unknown section(s): ${bad.join(', ')}\nknown: ${known.join(', ')}`);
    process.exit(2);
  }
}

runAll(only.length ? only : null);
const text = getHtml()
  .replace(/<\/(p|h2)>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .split('\n').map((l) => l.trimEnd()).filter((l) => l.length).join('\n');
console.log(text);
process.exit(getTally().fail ? 1 : 0);
