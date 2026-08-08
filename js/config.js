(function () {
  var VML = window.VML = window.VML || {};
  VML.config = {
    metrics: {
      latency: { label: 'Latency', unit: 'ms', short: 'latency' },
      jitter: { label: 'Jitter', unit: 'ms', short: 'jitter' }
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
      dataset: 'synthetic',
      thresholdFactor: 0.98
    }
  };
})();
