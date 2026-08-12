#!/usr/bin/env node
// build_frontend.mjs - minify and bundle the frontend assets:
//   * lib/d3.custom.min.js - a custom d3 bundle with only the modules the app
//     uses (full d3.v7 is ~280KB; this cut keeps the transfer under a third)
//   * js/app.min.js - js/{config,normalize,map,charts,app}.js bundled in order
//   * css/style.min.css - minified stylesheet
// Run after editing js/*.js or css/style.css:
//   npm run build
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_FILES = ['config.js', 'normalize.js', 'map.js', 'charts.js', 'app.js'];

// d3 v7 modules re-exported under the global `d3`. Selection and transition
// also patch d3.selection.prototype as a side effect, so chart/map code can
// call .transition() and .join() on selections exactly like full d3.v7.
const D3_EXPORTS = [
  'd3-array',
  'd3-axis',
  'd3-color',
  'd3-dispatch',
  'd3-drag',
  'd3-ease',
  'd3-format',
  'd3-geo',
  'd3-interpolate',
  'd3-scale',
  'd3-selection',
  'd3-timer',
  'd3-transition',
  'd3-zoom'
];

async function main() {
  const t0 = Date.now();

  await build({
    stdin: {
      contents: D3_EXPORTS.map((m) => `export * from '${m}';`).join('\n'),
      resolveDir: ROOT,
      sourcefile: 'd3-custom.js'
    },
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'd3',
    target: ['es2018'],
    outfile: path.join(ROOT, 'lib', 'd3.custom.min.js')
  });

  const appSource = APP_FILES
    .map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'))
    .join('\n;\n');
  await build({
    stdin: { contents: appSource, resolveDir: ROOT, sourcefile: 'app.js' },
    bundle: false,
    minify: true,
    format: 'iife',
    target: ['es2018'],
    outfile: path.join(ROOT, 'js', 'app.min.js')
  });

  await build({
    entryPoints: [path.join(ROOT, 'css', 'style.css')],
    minify: true,
    outfile: path.join(ROOT, 'css', 'style.min.css')
  });

  const size = (p) => {
    const b = fs.statSync(path.join(ROOT, p)).size;
    return (b / 1024).toFixed(1) + ' KB';
  };
  console.log(`wrote lib/d3.custom.min.js (${size('lib/d3.custom.min.js')})`);
  console.log(`wrote js/app.min.js (${size('js/app.min.js')})`);
  console.log(`wrote css/style.min.css (${size('css/style.min.css')})`);
  console.log(`done in ${Date.now() - t0} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
