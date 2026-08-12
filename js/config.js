(function () {
  var VML = window.VML = window.VML || {};
  VML.config = {
    metrics: {
      latency: { label: 'Latency', unit: 'ms', short: 'latency', decimals: 0 },
      jitter: { label: 'Jitter', unit: 'ms', short: 'jitter', decimals: 1 },
      loss: { label: 'Loss', unit: '%', short: 'loss', decimals: 1 }
    },
    continents: ['Africa', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'],
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
