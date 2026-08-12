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

// d3 v7 modules re-exported under the global `d3`. Only the symbols the app
// actually calls are imported by name — `export *` from a module would keep
// every export alive (no tree-shaking), which adds ~60KB of unused code. The
// modules' transitive dependencies (d3-color, d3-format, d3-timer, ...) still
// get bundled because the kept symbols import them internally. `d3-transition`
// is imported for its side effect: it patches d3.selection.prototype with
// .transition(), so chart/map code can call .transition() and .join() on
// selections exactly like full d3.v7.
const D3_IMPORTS = [
  "export { extent, max, mean, quantile, min } from 'd3-array';",
  "export { axisBottom, axisLeft } from 'd3-axis';",
  "export { geoNaturalEarth1, geoPath, geoDistance, geoGraticule10 } from 'd3-geo';",
  "export { interpolateRgbBasis } from 'd3-interpolate';",
  "export { scaleSequential, scaleLinear } from 'd3-scale';",
  "export { select } from 'd3-selection';",
  "import 'd3-transition';",
  "export { zoom, zoomIdentity } from 'd3-zoom';"
];

async function main() {
  const t0 = Date.now();

  await build({
    stdin: {
      contents: D3_IMPORTS.join('\n'),
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

  // Inline the minified stylesheet into index.html so first paint doesn't wait
  // on a separate render-blocking CSS request. The <style> block is injected
  // between the two markers below, and the external <link> (plus its preload)
  // are dropped. Keep the source <link> lines in index.html so the page still
  // renders if it is ever opened before a build runs.
  const INLINE_START = '<!--INLINE-CSS:START-->';
  const INLINE_END = '<!--INLINE-CSS:END-->';
  const indexPath = path.join(ROOT, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'css', 'style.min.css'), 'utf8');
  let out = html;
  if (html.includes(INLINE_START) && html.includes(INLINE_END)) {
    out = out.replace(
      new RegExp(INLINE_START + '[\\s\\S]*?' + INLINE_END),
      () => INLINE_START + '\n<style>\n' + css + '\n</style>\n' + INLINE_END
    );
  }
  out = out.replace(/[ \t]*<link rel="preload" href="css\/style\.min\.css"[^>]*>\r?\n?/g, '');
  out = out.replace(/[ \t]*<link rel="stylesheet" href="css\/style\.min\.css"[^>]*>\r?\n?/g, '');
  if (out !== html) fs.writeFileSync(indexPath, out);

  const size = (p) => {
    const b = fs.statSync(path.join(ROOT, p)).size;
    return (b / 1024).toFixed(1) + ' KB';
  };
  console.log(`wrote lib/d3.custom.min.js (${size('lib/d3.custom.min.js')})`);
  console.log(`wrote js/app.min.js (${size('js/app.min.js')})`);
  console.log(`wrote css/style.min.css (${size('css/style.min.css')})`);
  console.log(`inlined css into index.html (${size('index.html')})`);
  console.log(`done in ${Date.now() - t0} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
