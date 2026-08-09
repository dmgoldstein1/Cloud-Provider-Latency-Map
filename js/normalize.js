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
      matrices: { latency: build('latency'), jitter: build('jitter'), loss: build('loss') }
    };
  }

  function loadDataset() {
    return fromVultrStatus(window.VML_DATA.synthetic);
  }

  VML.normalize = {
    fromVultrStatus: fromVultrStatus,
    loadDataset: loadDataset
  };
})();
