(function () {
  var VML = window.VML = window.VML || {};

// Raw datasets share the "measured via ..." shape: a region list where each
// entry carries per-destination latency/jitter/loss maps. Normalizing
// turns each provider's raw object into square value matrices keyed by the
// provider's own region order. A provider that did not measure a metric
// simply has no matrix for it; lookups on missing metrics resolve to NaN so
// every chart filters those pairs out.
// (Historical note: the v2 Linode mesh measured no packet loss; the v3 mesh
// does, so loss data arrives via the same path as Vultr's.)
  function fromMeasured(raw) {
    if (!raw || !raw.regions) return null;
    var srcRegions = raw.regions;
    var order = srcRegions.map(function (r) { return r.code; });
    var idx = new Map(order.map(function (c, i) { return [c, i]; }));
    function build(metricKey) {
      var values = order.map(function () { return new Array(order.length).fill(NaN); });
      srcRegions.forEach(function (r, i) {
        var m = r[metricKey] || {};
        for (var dst in m) {
          if (idx.has(dst)) values[i][idx.get(dst)] = +m[dst];
        }
      });
      return { order: order, values: values };
    }
    var matrices = {};
    ['latency', 'jitter', 'loss'].forEach(function (k) {
      if (srcRegions.some(function (r) { return r[k]; })) matrices[k] = build(k);
    });
    return {
      meta: { source: raw.source, retrieved_at: raw.retrieved_at },
      regions: srcRegions,
      matrices: matrices,
      metrics: Object.keys(matrices),
      // canonical region ordering shared by every metric matrix
      order: matrices.latency ? matrices.latency.order : Object.values(matrices)[0].order
    };
  }

  // provider id -> the D.<id> keys of window.VML_DATA. Measured meshes live
  // under D.<id>Measured (D.measured for the original Vultr set); display
  // metadata (city coordinates, continents) under D.<id>Regions / D.regions.
  function findRaw(D, pid) {
    if (D[pid + 'Measured']) return D[pid + 'Measured'];
    if (pid === 'vultr' && D.measured) return D.measured;
    return null;
  }

  function findMeta(D, pid) {
    if (D[pid + 'Regions']) return D[pid + 'Regions'];
    if (pid === 'vultr' && D.regions) return D.regions;
    return null;
  }

  // cross-provider links measured by the NA full-mesh run (data/xmesh.json):
  // directed pairs keyed by GLOBAL region codes, e.g.
  // pairs['us-east']['US-east'] = {latency, jitter, loss}. Only pairs whose
  // endpoints belong to different providers live here; same-provider pairs
  // stay in their provider's own matrix.
  function loadXMesh(D) {
    var raw = D.xmesh;
    if (!raw || !raw.pairs) return { pairs: {}, meta: {} };
    return {
      pairs: raw.pairs,
      meta: { source: raw.source, retrieved_at: raw.retrieved_at }
    };
  }

  function loadDataset() {
    var D = window.VML_DATA || {};
    var providers = {};
    VML.config.providers.forEach(function (p) {
      var raw = findRaw(D, p.id);
      var norm = fromMeasured(raw);
      if (!norm) return;
      // the measured rows carry only code/location/country keys; overlay the
      // richer metadata (name, lat/lon, continent) when it is available
      var metaRaw = findMeta(D, p.id);
      var metaById = new Map(((metaRaw && metaRaw.regions) || []).map(function (r) { return [r.code, r]; }));
      norm.regions = norm.regions.map(function (r) {
        return Object.assign({}, r, metaById.get(r.code) || {});
      });
      providers[p.id] = norm;
    });
    if (!Object.keys(providers).length) {
      throw new Error('no measured dataset found in data/data.js');
    }
    return {
      meta: { format: 'providers-v1' },
      providers: providers,
      xmesh: loadXMesh(D)
    };
  }

  VML.normalize = {
    fromMeasured: fromMeasured,
    loadDataset: loadDataset
  };
})();
