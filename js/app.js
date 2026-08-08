(function () {
  var VML = window.VML = window.VML || {};

  VML.events = {
    fns: [],
    on: function (fn) { this.fns.push(fn); return fn; },
    emit: function (name) { this.fns.forEach(function (f) { f(name); }); }
  };

  var state;
  var sourceListEl, metricButtons, thresholdSlider, thresholdLabel, statsEl;
  var sourceCheckboxes = {};
  var groupCountEls = {};
  var continentCodes = {};

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
  function nameOf(code) { return state.byCode.get(code).name; }

  function buildState(regionsRaw, dataset) {
    var order = dataset.matrices.latency.order;
    state = {
      data: dataset,
      regions: regionsRaw.regions,
      byCode: new Map(regionsRaw.regions.map(function (r) { return [r.code, r]; })),
      idx: new Map(order.map(function (c, i) { return [c, i]; })),
      metric: VML.config.defaults.metric,
      sources: new Set(order),
      threshold: null,
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

    var arcs = state.arcs.filter(function (d) { return state.sources.has(d.src); });
    var n = arcs.length;
    var mx = d3.mean(arcs, function (d) { return d.distance; });
    var my = d3.mean(arcs, function (d) {
      return state.data.matrices[state.metric].values[state.idx.get(d.src)][state.idx.get(d.dst)];
    });
    var num = 0, den = 0;
    arcs.forEach(function (d) {
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
    return d3.scaleLinear().domain([state.metricMax * 0.2, state.metricMax]).range([0.6, 2.6]);
  }

  function emitRender() {
    computeScale();
    state.widthScale = widthScaleFn();
    syncSourceList();
    VML.events.emit('render');
  }

  function toggleSource(code, checked) {
    if (checked) state.sources.add(code);
    else state.sources.delete(code);
    emitRender();
  }

  function buildSourceList() {
    sourceListEl.innerHTML = '';
    sourceCheckboxes = {};
    groupCountEls = {};
    continentCodes = {};

    var order = state.data.matrices.latency.order;
    order.forEach(function (code) {
      var cont = state.byCode.get(code).continent || 'Unknown';
      (continentCodes[cont] = continentCodes[cont] || []).push(code);
    });

    var contOrder = VML.config.continents.concat(
      Object.keys(continentCodes).filter(function (c) { return VML.config.continents.indexOf(c) === -1; }).sort()
    );

    contOrder.forEach(function (cont) {
      var codes = continentCodes[cont];
      if (!codes) return;
      codes.sort(function (a, b) { return nameOf(a).localeCompare(nameOf(b)); });

      var group = document.createElement('div');
      group.className = 'src-group';

      var head = document.createElement('div');
      head.className = 'src-group-head';
      var sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = state.continentColors[cont] || '#94a3b8';
      var title = document.createElement('span');
      title.appendChild(sw);
      title.appendChild(document.createTextNode(cont));
      var seg = document.createElement('span');
      seg.className = 'src-group-btns';
      var allBtn = document.createElement('button');
      allBtn.type = 'button';
      allBtn.className = 'src-group-all';
      allBtn.textContent = 'All';
      allBtn.title = 'Select all ' + cont + ' sources';
      allBtn.addEventListener('click', function () {
        continentCodes[cont].forEach(function (c) { state.sources.add(c); });
        emitRender();
      });
      var noneBtn = document.createElement('button');
      noneBtn.type = 'button';
      noneBtn.className = 'src-group-none';
      noneBtn.textContent = 'None';
      noneBtn.title = 'Unselect all ' + cont + ' sources';
      noneBtn.addEventListener('click', function () {
        continentCodes[cont].forEach(function (c) { state.sources.delete(c); });
        emitRender();
      });
      seg.appendChild(allBtn);
      seg.appendChild(noneBtn);
      title.appendChild(seg);
      var count = document.createElement('span');
      count.className = 'src-group-count';
      head.appendChild(title);
      head.appendChild(count);
      group.appendChild(head);
      groupCountEls[cont] = count;

      codes.forEach(function (code) {
        var label = document.createElement('label');
        label.className = 'src';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = state.sources.has(code);
        input.addEventListener('change', function () {
          toggleSource(code, input.checked);
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(nameOf(code)));
        group.appendChild(label);
        sourceCheckboxes[code] = input;
      });

      sourceListEl.appendChild(group);
    });
    syncGroupCounts();
  }

  function syncGroupCounts() {
    Object.keys(groupCountEls).forEach(function (cont) {
      var n = continentCodes[cont].filter(function (c) { return state.sources.has(c); }).length;
      groupCountEls[cont].textContent = n + '/' + continentCodes[cont].length;
    });
  }

  function syncSourceList() {
    state.data.matrices.latency.order.forEach(function (code) {
      var cb = sourceCheckboxes[code];
      if (cb) cb.checked = state.sources.has(code);
    });
    syncGroupCounts();
    var label = document.getElementById('sources-label');
    if (label) label.textContent = 'Sources (' + state.sources.size + ' checked)';
  }

  function buildControls() {
    sourceListEl = document.getElementById('source-list');
    metricButtons = document.querySelectorAll('.metric-btn');
    thresholdSlider = document.getElementById('threshold');
    thresholdLabel = document.getElementById('threshold-label');
    statsEl = document.getElementById('stats');

    buildSourceList();

    metricButtons.forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.metric === b.dataset.metric) return;
        state.metric = b.dataset.metric;
        state.threshold = null;
        metricButtons.forEach(function (x) { x.classList.toggle('active', x === b); });
        emitRender();
      });
    });

    thresholdSlider.addEventListener('input', function () {
      state.threshold = +thresholdSlider.value;
      thresholdLabel.textContent = state.threshold.toFixed(0) + ' ' + unit();
      VML.events.emit('render');
    });

    var tab = document.getElementById('side-tab');
    if (tab) {
      tab.addEventListener('click', function () {
        document.body.classList.toggle('panel-hidden');
        tab.textContent = document.body.classList.contains('panel-hidden') ? '◂' : '▸';
        VML.events.emit('render');
      });
    }

    var srcTab = document.getElementById('src-tab');
    if (srcTab) {
      srcTab.addEventListener('click', function () {
        document.body.classList.toggle('src-hidden');
        srcTab.textContent = document.body.classList.contains('src-hidden') ? '▴' : '▾';
        VML.events.emit('render');
      });
    }

    window.addEventListener('resize', onResize);
  }

  var resizeTimeout = null;
  function onResize() {
    document.body.classList.add('resizing');
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function () {
      document.body.classList.remove('resizing');
    }, 200);
  }

  function renderStats() {
    var metric = state.metric;
    var vals = state.arcs.filter(function (d) { return state.sources.has(d.src); })
      .map(function (d) { return state.data.matrices[metric].values[state.idx.get(d.src)][state.idx.get(d.dst)]; });
    var shown = vals.filter(function (v) { return state.threshold >= v; }).length;
    var avg = d3.mean(vals);
    var nSrc = state.sources.size;
    var first = state.data.matrices.latency.order.find(function (c) { return state.sources.has(c); });
    var header = first != null
      ? 'from <b>' + nSrc + '</b> checked source' + (nSrc === 1 ? '' : 's') +
        ' (e.g. ' + nameOf(first) + ')'
      : 'no sources checked';
    statsEl.innerHTML =
      header +
      ' · avg ' + metric + ' across ' + (nSrc ? vals.length / nSrc : 0) +
      ' targets: <b>' + (avg != null ? avg.toFixed(0) : '—') + '</b> ' + unit() +
      ' · showing <b>' + shown + '</b> arc' + (shown === 1 ? '' : 's') + ' ≤ <b>' + state.threshold.toFixed(0) + '</b> ' + unit();
  }

  function renderLegend() {
    var html = '';
    VML.config.continents.forEach(function (c) {
      html += '<span class="lg"><span class="sw" style="background:' + state.continentColors[c] + '"></span>' + c + '</span>';
    });
    html += '<span class="lg" title="Dot size = a source region\'s average latency to all other selected regions, rescaled to the current selection">' +
      '<svg width="30" height="10" style="vertical-align:middle">' +
      '<circle cx="5" cy="5" r="3" fill="' + state.continentColors['Europe'] + '"/>' +
      '<circle cx="25" cy="5" r="7" fill="' + state.continentColors['Europe'] + '"/>' +
      '</svg>' +
      ' <b>Dot size = avg latency</b> (8–32px diameter)</span>';
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
    var D = window.VML_DATA;
    if (!D || !D.world || !D.regions || !D.synthetic) {
      document.getElementById('stats').textContent = 'error: data/data.js missing — re-run python3 scripts/build_data_js.py';
      return;
    }
    state = {
      world: topojson.feature(D.world, D.world.objects.countries)
    };
    state.world.features = state.world.features.filter(function (f) {
      return f.properties.name !== 'Antarctica' && f.properties.name !== 'Fr. S. Antarctic Lands';
    });
    buildState(D.regions, VML.normalize.loadDataset());
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
    });
    emitRender();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.body.classList.remove('booting');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', main);

  VML.app = { toggleSource: toggleSource };
})();
