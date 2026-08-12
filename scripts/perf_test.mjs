import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// GitHub Pages serves gzip for text assets; mirror that so transfer sizes and
// wall-clock times on the throttle reflect what the deployed site ships.
const GZIP_EXT = ['.html', '.css', '.js', '.json', '.svg'];
const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const raw = fs.readFileSync(file);
  const ext = path.extname(file);
  if (GZIP_EXT.includes(ext)) {
    res.writeHead(200, {
      'Content-Type': { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' }[ext] + '; charset=utf-8',
      'Content-Encoding': 'gzip'
    });
    res.end(zlib.gzipSync(raw));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(raw);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// Realistic slow broadband / mobile: 100ms RTT, ~2 Mbps down — makes asset
// size and round-trips matter (the original complaint was "takes a while").
const NET = { latency: 100, downloadThroughput: 2 * 1024 * 1024, uploadThroughput: 512 * 1024, offline: false };

const browser = await chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { ...NET, connectionType: 'wifi' });

const errors = [];
const warnings = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.type() === 'warning') warnings.push(msg.text());
});
page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

const t0 = Date.now();
await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' });
const tDom = Date.now() - t0;
await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 30000 });
const tBoot = Date.now() - t0;
await page.waitForFunction(() => document.querySelectorAll('#map .land-path').length > 0, null, { timeout: 30000 });
const tWorld = Date.now() - t0;

const perf = await page.evaluate(async () => {
  const r = performance.getEntriesByType('resource');
  const nav = performance.getEntriesByType('navigation')[0];
  const burstSettleMs = await new Promise((resolve) => {
    // simulate a slider drag: 60 renders fired in a burst. Coalescing should
    // collapse these into ~1 render per animation frame, so the whole burst
    // settles within a few frames instead of blocking the main thread.
    const t = performance.now();
    for (let i = 0; i < 60; i++) window.VML.events.emit('render');
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(Math.round(performance.now() - t));
    })));
  });
  return {
    loadEventEnd: Math.round(nav.loadEventEnd),
    paints: performance.getEntriesByType('paint').map((p) => p.name + '=' + Math.round(p.startTime)),
    burstSettleMs,
    resources: r.map((x) => ({
      name: x.name.split('/').pop(),
      transferSize: x.transferSize,
      encodedSize: x.encodedBodySize,
      decodedSize: x.decodedBodySize,
      duration: Math.round(x.duration)
    }))
  };
});

console.log('DOMContentLoaded (wall):', tDom + 'ms');
console.log('booted (wall):', tBoot + 'ms');
console.log('world map landed (wall):', tWorld + 'ms');
console.log('paints:', perf.paints.join(', '));
console.log('60-render burst settled in:', perf.burstSettleMs + 'ms');
console.log('resources:');
let total = 0;
perf.resources.forEach((x) => {
  total += x.transferSize;
  console.log('  ' + x.name + '  transfer=' + x.transferSize + 'B  decoded=' + x.decodedSize + 'B  ' + x.duration + 'ms');
});
console.log('total transfer:', (total / 1024).toFixed(1) + 'KB');
console.log('errors:', errors.length ? errors : 'none');
console.log('warnings:', warnings.length ? warnings.slice(0, 5) : 'none');

await browser.close();
server.close();
