(function () {
  var VML = window.VML = window.VML || {};
  VML.config = {
    metrics: {
      // defaultMin is the lower threshold knob's value when a metric has no
      // saved threshold of its own. latency floors at 1ms (sub-millisecond
      // links are same-datacenter pairs); jitter must floor at 0 — almost
      // every jitter reading is below 1ms, so a 1ms floor empties the charts;
      // loss floors at 1% so the loss view surfaces problem pairs only.
      latency: { label: 'Latency', unit: 'ms', short: 'latency', decimals: 0, defaultMin: 1 },
      jitter: { label: 'Jitter', unit: 'ms', short: 'jitter', decimals: 1, defaultMin: 0 },
      loss: { label: 'Loss', unit: '%', short: 'loss', decimals: 1, defaultMin: 1 }
    },
    continents: ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'],
    // Cloud providers whose measured meshes are shown side by side. Each
    // measured dataset is loaded by js/normalize.js into a per-provider
    // matrix; every location belongs to exactly one provider and arcs are
    // only ever drawn within one provider's mesh (no cross-provider links are
    // measured). `color` rings the map markers so the two clouds stay apart.
    providers: [
      { id: 'vultr', label: 'Vultr', color: '#38bdf8' },
      { id: 'linode', label: 'Linode', color: '#f472b6' }
    ],
    continentColors: {
      'Africa': '#f4a261',
      'Asia': '#e76f51',
      'Europe': '#2a9d8f',
      'North America': '#457b9d',
      'Oceania': '#a8dadc',
      'South America': '#e9c46a',
      'Unknown': '#94a3b8'
    },
    defaults: {
      metric: 'latency',
      source: 'ams',
      thresholdFactor: 0.98
    },
    // d3-scale-chromatic's RdYlGn[11], inlined so the 20KB library can be
    // dropped. Index 0 is dark red (worse) and index 10 dark green (better);
    // the app reverses it via slice().reverse() so low values render green
    // and high values red.
    schemeRdYlGn: [
      '#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#ffffbf',
      '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'
    ]
  };
})();
