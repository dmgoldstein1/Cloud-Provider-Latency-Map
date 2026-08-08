(function () {
  var VML = window.VML = window.VML || {};

  function fromVultrStatus(raw) {
    var srcRegions = raw.regions;
    var order = srcRegions.map(function (r) { return r.code; });
    var idx = new Map(order.map(function (c, i) { return [c, i]; }));
    function build(metricKey) {
      var values = order.map(function () { return new Array(order.length).fill(0); });
      srcRegions.forEach(function (r, i) {
        var m = r[metricKey] || {};
        for (var dst in m) {
          if (idx.has(dst)) values[i][idx.get(dst)] = +m[dst];
        }
      });
      return { order: order, values: values };
    }
    return {
      meta: { source: raw.source, retrieved_at: raw.retrieved_at, format: 'vultr-status' },
      matrices: { latency: build('latency'), jitter: build('jitter') }
    };
  }

  function parseMatrixCsv(csv) {
    var lines = csv.trim().split(/\r?\n/);
    var header = lines[0].split(',');
    var order = header.slice(1).filter(function (c) { return c; });
    var idx = new Map(order.map(function (c, i) { return [c, i]; }));
    var values = order.map(function () { return new Array(order.length).fill(NaN); });
    for (var i = 1; i < lines.length; i++) {
      var parts = lines[i].split(',');
      var src = parts[0];
      if (!idx.has(src)) continue;
      for (var j = 1; j < header.length && j < parts.length; j++) {
        var dst = header[j];
        if (idx.has(dst) && parts[j] !== '') {
          values[idx.get(src)][idx.get(dst)] = parseFloat(parts[j]);
        }
      }
    }
    for (var k = 0; k < order.length; k++) values[k][k] = 0;
    return { order: order, values: values };
  }

  function fromNetlatRun(run, knownRegions) {
    var known = {};
    (knownRegions || []).forEach(function (r) { known[r.code] = r; });
    var matrices = {};
    if (run.latency_matrix_csv) matrices.latency = parseMatrixCsv(run.latency_matrix_csv);
    if (run.jitter_matrix_csv) matrices.jitter = parseMatrixCsv(run.jitter_matrix_csv);
    if (run.loss_matrix_csv) matrices.loss = parseMatrixCsv(run.loss_matrix_csv);
    var regions = null;
    var manifestRegions = run.manifest && run.manifest.regions;
    if (manifestRegions) {
      regions = Object.keys(manifestRegions).map(function (code) {
        var meta = manifestRegions[code];
        var knownR = known[code] || {};
        return {
          code: code,
          name: knownR.name || meta.name || code,
          city: knownR.city || meta.city || meta.name || code,
          country: knownR.country || meta.country || '',
          country_code: knownR.country_code || meta.country_code || '',
          lat: knownR.lat != null ? knownR.lat : (meta.lat != null ? meta.lat : 0),
          lon: knownR.lon != null ? knownR.lon : (meta.lon != null ? meta.lon : 0),
          continent: knownR.continent || meta.continent || 'Unknown'
        };
      });
    }
    return {
      meta: { source: 'netlat.sh', format: 'netlat', run_dir: run.run_dir || null },
      regions: regions,
      matrices: matrices
    };
  }

  async function loadDataset(name) {
    if (name === 'synthetic') {
      var raw = await (await fetch('data/locations_synthetic.json')).json();
      return fromVultrStatus(raw);
    }
    if (name === 'netlat') {
      var base = 'data/netlat/latest';
      var manifestResp = await fetch(base + '/manifest.json');
      var latencyResp = await fetch(base + '/latency_matrix.csv');
      if (!manifestResp.ok || !latencyResp.ok) {
        throw new Error('no netlat run found under ' + base + ' — run tools/import_run.sh after a netlat.sh run completes');
      }
      var regionsRaw = await (await fetch('data/regions.json')).json();
      var manifest = await manifestResp.json();
      var run = { run_dir: base, manifest: manifest };
      try {
        run.latency_matrix_csv = await latencyResp.text();
        run.jitter_matrix_csv = await (await fetch(base + '/jitter_matrix.csv')).text();
        run.loss_matrix_csv = await (await fetch(base + '/loss_matrix.csv')).text();
      } catch (e) { }
      return fromNetlatRun(run, regionsRaw.regions);
    }
    throw new Error('unknown dataset: ' + name);
  }

  VML.normalize = {
    fromVultrStatus: fromVultrStatus,
    fromNetlatRun: fromNetlatRun,
    parseMatrixCsv: parseMatrixCsv,
    loadDataset: loadDataset
  };
})();
