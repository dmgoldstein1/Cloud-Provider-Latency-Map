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
    // Measured meshes shown side by side. Each measured dataset is loaded
    // measured dataset is loaded by js/normalize.js into a per-provider
    // matrix; every location belongs to exactly one provider and arcs are
    // only ever drawn within one provider's mesh (no cross-provider links are
    // measured). `color` rings the map markers so the meshes stay apart.
    // The NA Mesh provider is itself one measured mesh spanning two clouds
    // (11 Linode NA regions + 3 existing Contabo VMs, every pair measured
    // both ways), so the single-provider-mesh invariant still holds.
    providers: [
      { id: 'vultr', label: 'Vultr', color: '#8aadf4' },
      { id: 'linode', label: 'Linode', color: '#f5bde6' },
      { id: 'contabo', label: 'Contabo', color: '#8bd5ca' },
      { id: 'na', label: 'NA Mesh', color: '#a6da95' }
    ],
    continentColors: {
      'Africa': '#f5a97f',
      'Asia': '#ed8796',
      'Europe': '#8bd5ca',
      'North America': '#b7bdf8',
      'Oceania': '#91d7e3',
      'South America': '#eed49f',
      'Unknown': '#8087a2'
    },
    defaults: {
      metric: 'latency',
      source: 'ams',
      thresholdFactor: 0.98
    },
    // Catppuccin Macchiato sequential scale (worst -> best): Red -> Maroon
    // -> Peach -> Yellow -> Green -> Teal. The app reverses it via
    // slice().reverse() so low values render Teal/Green (good) and high
    // values render Red (bad).
    schemeRdYlGn: [
      '#ed8796', '#ee99a0', '#f5a97f', '#eed49f', '#a6da95', '#8bd5ca'
    ]
  };
})();
