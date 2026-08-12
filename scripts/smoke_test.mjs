import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const warnings = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.type() === 'warning') warnings.push(msg.text());
});
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'load' });
await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 15000 });
// the world map loads asynchronously (data/world.js); wait for its landmass
await page.waitForFunction(() => document.querySelectorAll('#map .land-path').length > 0, null, { timeout: 15000 });
await page.waitForTimeout(500);

const result = await page.evaluate(() => ({
  booting: document.body.classList.contains('booting'),
  mapSvg: !!document.querySelector('#map svg'),
  landPaths: document.querySelectorAll('#map .land-path').length,
  arcs: document.querySelectorAll('#map .arc').length,
  markers: document.querySelectorAll('#map .region').length,
  heatCells: document.querySelectorAll('#heatmap rect.cell').length,
  boxes: document.querySelectorAll('#boxes g.box').length,
  scatterDots: document.querySelectorAll('#scatter circle.dot').length,
  legend: document.getElementById('legend').textContent.slice(0, 60),
  stats: document.getElementById('stats').textContent.slice(0, 80),
  sources: document.querySelectorAll('#source-list input').length,
  d3Version: (() => { try { return typeof d3 !== 'undefined' ? 'd3 global present' : 'MISSING'; } catch (e) { return 'MISSING'; } })()
}));

console.log(JSON.stringify(result, null, 2));
console.log('console errors:', errors.length ? errors : 'none');
console.log('console warnings:', warnings.length ? warnings.slice(0, 5) : 'none');

const transfer = await page.evaluate(() => performance.getEntriesByType('resource')
  .map((r) => r.name.split('/').pop() + '=' + Math.round(r.transferSize / 1024) + 'KB (' + Math.round(r.duration) + 'ms)'));
console.log('resources:', transfer.join(', '));

await browser.close();
process.exit(errors.length ? 1 : 0);
