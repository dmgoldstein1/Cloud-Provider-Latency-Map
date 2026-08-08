(function () {
  var VML = window.VML = window.VML || {};

  VML.events = {
    fns: [],
    on: function (fn) { this.fns.push(fn); return fn; },
    emit: function (name) { this.fns.forEach(function (f) { f(name); }); }
  };

  var state;
  var sourceSelect, metricButtons, thresholdSlider, thresholdLabel, datasetSelect, statsEl;
  var continentsBuilt = false;

  VML.tooltip = {
    el: document.getElementById('tooltip'),
    show: function (html, x, y) {
      this.el.innerHTML = html;
      this.el.style.opacity = 1;
      this.move(x, y);
    },
    move: function (x, y) {
      var pad = 12;
      var left = Math.min(window.innerWidth - this.el.offsetWidth - pad, x + pad);
      var top = Math.max(0, y - this.el.offsetHeight - pad);
      this.el.style.left = left + 'px';
      this.el.style.top = top + 'px';
    },
    hide: function () { this.el.style.opacity = 0; }
  };

  function unit() { return VML.config.metrics[state.metric].unit; }

  function buildState(regionsRaw, dataset) {
    state = {
      data: dataset,
      regions: regionsRaw.regions,
      byCode: new Map(regionsRaw.regions.map(function (r) { return [r.code, r]; })),
      idx: new Map(dataset.matrices.latency.order.map(function (c, i) { return [c, i]; })),
      metric: VML.config.defaults.metric,
      source: VML.config.defaults.source,
      threshold: null,
      continents: new Set(VML.config.continents),
      dataset: state && state.dataset ? state.dataset : VML.config.defaults.dataset,
      pair: null,
      world: state && state.world ? state.world : null,
      arcs: [],
      centrality: {},
      centralityExtent: [0, 1],
      distanceMax: 1,
      metricMax: 1,
      colorScale: d3.scaleSequential(d3.interpolateRgbBasis(d3.schemeRdYlGn[11].slice().reverse())),
      continentColors: VML.config.continentColors,
      fit: { slope: null, intercept: null }
    };

    var order = dataset.matrices.latency.order;
    order.forEach(function (src) {
      var avg = 0, cnt = 0;
      order.forEach(function (dst) {
        if (src === dst) return;
        avg += dataset.matrices.latency.values[state.idx.get(src)][state.idx.get(dst)];
        cnt++;
        var a = state.byCode.get(src), b = state.byCode.get(dst);
        state.arcs.push({
          src: src, dst: dst,
          distance: d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 6371
        });
      });
      state.centrality[src] = avg / cnt;
    });
    state.centralityExtent = d3.extent(order, function (c) { return state.centrality[c]; });
    state.distanceMax = d3.max(state.arcs, function (d) { return d.distance; });

    VML.state = state;
  }

  function computeScale() {
    var values = state.data.matrices[state.metric].values.flat().filter(function (v) { return v > 0; });
    var q = d3.quantile(values, VML.config.defaults.thresholdFactor);
    var raw = q || d3.max(values) || 1;
    state.metricMax = Math.round(raw * 10) / 10;
    state.colorScale.domain([0, state.metricMax]);

    var n = state.arcs.length;
    var mx = d3.mean(state.arcs, function (d) { return d.distance; });
    var my = d3.mean(state.arcs, function (d) {
      return state.data.matrices[state.metric].values[state.idx.get(d.src)][state.idx.get(d.dst)];
    });
    var num = 0, den = 0;
    state.arcs.forEach(function (d) {
      var y = state.data.matrices[state.metric].values[state.idx.get(d.src)][state.idx.get(d.dst)];
      num += (d.distance - mx) * (y - my);
      den += (d.distance - mx) * (d.distance - mx);
    });
    state.fit = { slope: den ? num / den : null, intercept: my - (den ? num / den : 0) * mx };

    if (state.threshold == null || state.threshold > state.metricMax) {
      state.threshold = state.metricMax;
    }
    if (thresholdSlider) {
      thresholdSlider.max = state.metricMax;
      thresholdSlider.step = state.metric === 'latency' ? 1 : 0.1;
      thresholdSlider.value = state.threshold;
    }
    if (thresholdLabel) thresholdLabel.textContent = state.threshold.toFixed(0) + ' ' + unit();
  }

  function widthScaleFn() {
    return d3.scaleLinear().domain([state.metricMax * 0.2, state.metricMax]).range([0.8, 3.5]);
  }

  function emitRender() {
    computeScale();
    state.widthScale = widthScaleFn();
    if (sourceSelect && sourceSelect.value !== state.source) sourceSelect.value = state.source;
    VML.events.emit('render');
  }

  function updateSourceOptions() {
    sourceSelect.innerHTML = '';
    state.data.matrices.latency.order.forEach(function (code) {
      var o = document.createElement('option');
      o.value = code;
      o.textContent = state.byCode.get(code).name + ' (' + code + ')';
      sourceSelect.appendChild(o);
    });
    if (state.data.matrices.latency.order.indexOf(state.source) === -1) {
      state.source = state.data.matrices.latency.order[0];
    }
    sourceSelect.value = state.source;
  }

  function buildControls() {
    sourceSelect = document.getElementById('source');
    metricButtons = document.querySelectorAll('.metric-btn');
    thresholdSlider = document.getElementById('threshold');
    thresholdLabel = document.getElementById('threshold-label');
    datasetSelect = document.getElementById('dataset');
    statsEl = document.getElementById('stats');

    updateSourceOptions();
    sourceSelect.addEventListener('change', function () {
      state.source = sourceSelect.value;
      emitRender();
    });

    metricButtons.forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.metric === b.dataset.metric) return;
        state.metric = b.dataset.metric;
        metricButtons.forEach(function (x) { x.classList.toggle('active', x === b); });
        emitRender();
      });
    });

    thresholdSlider.addEventListener('input', function () {
      state.threshold = +thresholdSlider.value;
      thresholdLabel.textContent = state.threshold.toFixed(0) + ' ' + unit();
      VML.events.emit('render');
    });

    if (!continentsBuilt) {
      var contWrap = document.getElementById('continents');
      VML.config.continents.forEach(function (c) {
        var label = document.createElement('label');
        label.className = 'cont';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = true;
        input.addEventListener('change', function () {
          if (input.checked) state.continents.add(c);
          else state.continents.delete(c);
          emitRender();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(c));
        contWrap.appendChild(label);
      });
      continentsBuilt = true;
    }

    datasetSelect.addEventListener('change', function () {
      if (datasetSelect.value === state.dataset) return;
      state.dataset = datasetSelect.value;
      reload();
    });
  }

  function reload() {
    VML.normalize.loadDataset(state.dataset).then(function (dataset) {
      return fetch('data/regions.json').then(function (r) { return r.json(); }).then(function (rr) {
        buildState(rr, dataset);
        updateSourceOptions();
        emitRender();
      });
    }).catch(function (err) {
      console.error(err);
      state.dataset = 'synthetic';
      datasetSelect.value = 'synthetic';
      reload();
    });
  }

  function renderStats() {
    var metric = state.metric;
    var vals = state.arcs.filter(function (d) { return d.src === state.source; })
      .map(function (d) { return state.data.matrices[metric].values[state.idx.get(d.src)][state.idx.get(d.dst)]; });
    var shown = vals.filter(function (v) { return state.threshold >= v; }).length;
    var avg = d3.mean(vals);
    var srcName = state.byCode.get(state.source).name;
    statsEl.innerHTML =
      '<b>' + srcName + '</b> (' + state.source + ') · avg ' + metric + ' to ' + vals.length +
      ' regions: <b>' + avg.toFixed(0) + '</b> ' + unit() +
      ' · showing <b>' + shown + '</b> arc' + (shown === 1 ? '' : 's') + ' ≤ <b>' + state.threshold.toFixed(0) + '</b> ' + unit();
  }

  function renderLegend() {
    var html = '';
    VML.config.continents.forEach(function (c) {
      html += '<span class="lg"><span class="sw" style="background:' + state.continentColors[c] + '"></span>' + c + '</span>';
    });
    var c0 = state.colorScale(0), c1 = state.colorScale(state.metricMax);
    var gid = 'mcolor';
    html += '<span class="lg" title="' + VML.config.metrics[state.metric].label + ' scale">' +
      '<svg width="86" height="10" style="vertical-align:middle">' +
      '<defs><linearGradient id="' + gid + '" x1="0" x2="1">' +
      '<stop offset="0%" stop-color="' + c0 + '"/><stop offset="100%" stop-color="' + c1 + '"/>' +
      '</linearGradient></defs>' +
      '<rect width="86" height="10" rx="2" fill="url(#' + gid + ')"/></svg>' +
      ' <b>0</b> – <b>' + state.metricMax.toFixed(0) + '</b> ' + unit() +
      '</span>';
    document.getElementById('legend').innerHTML = html;
  }

  function main() {
    Promise.all([
      fetch('data/regions.json').then(function (r) { return r.json(); }),
      fetch('data/countries-110m.json').then(function (r) { return r.json(); }),
      VML.normalize.loadDataset(VML.config.defaults.dataset)
    ]).then(function (res) {
      var regionsRaw = res[0];
      state = {
        world: topojson.feature(res[1], res[1].objects.countries)
      };
      buildState(regionsRaw, res[2]);
      buildControls();
      renderLegend();
      VML.map.init(document.getElementById('map'), state);
      VML.charts.init();
      VML.events.on(function (name) {
        if (name === 'render') {
          VML.map.render();
          VML.charts.render();
          renderStats();
          renderLegend();
        } else if (name === 'pair') {
          VML.map.pair();
          VML.charts.pair();
        }
        if (name === 'render' && sourceSelect && sourceSelect.value !== state.source) {
          sourceSelect.value = state.source;
        }
      });
      emitRender();
    });
  }

  document.addEventListener('DOMContentLoaded', main);
})();
