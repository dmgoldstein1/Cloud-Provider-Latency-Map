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
  function decimals() { return VML.config.metrics[state.metric].decimals; }
  function fmt(v) {
    if (v == null || isNaN(v)) return '—';
    var d = decimals();
    return d === 0 ? v.toFixed(0) : v.toFixed(d);
  }
  function nameOf(code) { return state.byCode.get(code).name; }

  function destSet(state) {
    if (state.destMode === 'checked') {
      var s = new Set();
      state.data.matrices.latency.order.forEach(function (c) {
        if (state.sources.has(c)) s.add(c);
      });
      return s;
    }
    return new Set(state.data.matrices.latency.order);
  }

  function activeArcs(state) {
    var dsts = destSet(state);
    return state.arcs.filter(function (d) {
      return state.sources.has(d.src) && dsts.has(d.dst);
    });
  }

  VML.util = { destSet: destSet, activeArcs: activeArcs };

  var STORE_KEY = 'vml_state';

  function writeStore(obj) {
    var json = JSON.stringify(obj);
    try {
      document.cookie = STORE_KEY + '=' + encodeURIComponent(json) + ';max-age=31536000;path=/';
      if (new RegExp('(?:^|;\\s*)' + STORE_KEY + '=').test(document.cookie)) return;
    } catch (e) {}
    try { localStorage.setItem(STORE_KEY, json); } catch (e) {}
  }

  function readStore() {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + STORE_KEY + '=([^;]*)'));
      if (m && m[1]) return JSON.parse(decodeURIComponent(m[1]));
    } catch (e) {}
    try {
      var v = localStorage.getItem(STORE_KEY);
      if (v != null) return JSON.parse(v);
    } catch (e) {}
    return null;
  }

  function persist() {
    writeStore({
      sources: Array.from(state.sources),
      metric: state.metric,
      threshold: state.threshold,
      destMode: state.destMode,
      panelHidden: document.body.classList.contains('panel-hidden'),
      srcHidden: document.body.classList.contains('src-hidden'),
      zoom: VML.map && VML.map.transform
        ? { k: VML.map.transform.k, x: VML.map.transform.x, y: VML.map.transform.y }
        : null
    });
  }

  function restoreState(saved) {
    if (!saved) return;
    var order = state.data.matrices.latency.order;
    if (saved.destMode === 'all' || saved.destMode === 'checked') state.destMode = saved.destMode;
    if (Array.isArray(saved.sources)) {
      state.sources = new Set(saved.sources.filter(function (c) { return order.indexOf(c) !== -1; }));
    }
    if (saved.metric && VML.config.metrics[saved.metric]) state.metric = saved.metric;
    if (typeof saved.threshold === 'number') state.threshold = saved.threshold;
    if (saved.panelHidden) document.body.classList.add('panel-hidden');
    if (saved.srcHidden) document.body.classList.add('src-hidden');
    state.savedZoom = saved.zoom || null;
  }

  function applyRestoredUI() {
    metricButtons.forEach(function (x) { x.classList.toggle('active', x.dataset.metric === state.metric); });
    document.querySelectorAll('.dest-btn').forEach(function (x) { x.classList.toggle('active', x.dataset.dest === state.destMode); });
    var sideTab = document.getElementById('side-tab');
    if (sideTab) sideTab.textContent = document.body.classList.contains('panel-hidden') ? '◂' : '▸';
    var srcTab = document.getElementById('src-tab');
    if (srcTab) srcTab.textContent = document.body.classList.contains('src-hidden') ? '▴' : '▾';
  }

  function buildState(regionsRaw, dataset) {
    var order = dataset.matrices.latency.order;
    state = {
      data: dataset,
      regions: regionsRaw.regions,
      byCode: new Map(regionsRaw.regions.map(function (r) { return [r.code, r]; })),
      idx: new Map(order.map(function (c, i) { return [c, i]; })),
      metric: VML.config.defaults.metric,
      destMode: 'all',
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

    var arcs = activeArcs(state);
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
    if (thresholdLabel) thresholdLabel.textContent = fmt(state.threshold) + ' ' + unit();
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

    document.querySelectorAll('.dest-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.destMode === b.dataset.dest) return;
        state.destMode = b.dataset.dest;
        document.querySelectorAll('.dest-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        emitRender();
      });
    });

    thresholdSlider.addEventListener('input', function () {
      state.threshold = +thresholdSlider.value;
      thresholdLabel.textContent = fmt(state.threshold) + ' ' + unit();
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
    wireChartHelp();
    wireMapControls();
    wireLegendWrap();
  }

  function wireMapControls() {
    var ids = {
      'map-zoom-in': 'zoomIn',
      'map-zoom-out': 'zoomOut',
      'map-fit-world': 'fitWorld',
      'map-fit-selected': 'fitToSelected'
    };
    Object.keys(ids).forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', function () { VML.map[ids[id]](); });
    });
  }

  function setControlsWidth() {
    var ctrl = document.getElementById('map-controls');
    if (!ctrl) return;
    var rows = ctrl.querySelectorAll('.ctrl-row');
    if (!rows.length) return;
    var w = 0;
    rows.forEach(function (r) { w += r.getBoundingClientRect().width; });
    w += (rows.length - 1) * 6;
    var target = Math.ceil(w) + 'px';
    if (ctrl.style.width !== target) ctrl.style.width = target;
  }

  function syncLegendWrap() {
    var legend = document.getElementById('legend');
    var footer = document.getElementById('map-footer');
    if (!legend || !footer) return;
    setControlsWidth();
    var tops = {};
    legend.querySelectorAll('.lg').forEach(function (el) {
      tops[Math.round(el.getBoundingClientRect().top)] = true;
    });
    footer.classList.toggle('legend-wrapped', Object.keys(tops).length > 1);
  }

  function wireLegendWrap() {
    var footer = document.getElementById('map-footer');
    if (!footer) return;
    var ro = new ResizeObserver(function () { syncLegendWrap(); });
    ro.observe(footer);
    syncLegendWrap();
  }

  function wireChartHelp() {
    var btn = document.getElementById('scatter-help-btn');
    var pop = document.getElementById('scatter-help-pop');
    var close = document.getElementById('scatter-help-close');
    if (!btn || !pop) return;
    function setOpen(open) {
      pop.classList.toggle('open', open);
      pop.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!pop.classList.contains('open'));
    });
    if (close) close.addEventListener('click', function (e) { e.stopPropagation(); setOpen(false); });
    document.addEventListener('click', function (e) {
      if (pop.classList.contains('open') && !pop.contains(e.target) && !btn.contains(e.target)) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });
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
    var vals = activeArcs(state)
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
      ' targets: <b>' + (avg != null ? fmt(avg) : '—') + '</b> ' + unit() +
      ' · showing <b>' + shown + '</b> arc' + (shown === 1 ? '' : 's') + ' ≤ <b>' + fmt(state.threshold) + '</b> ' + unit();
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
      ' <b>0</b> – <b>' + fmt(state.metricMax) + '</b> ' + unit() +
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
    restoreState(readStore());
    buildControls();
    applyRestoredUI();
    renderLegend();
    VML.map.init(document.getElementById('map'), state);
    if (state.savedZoom) VML.map.setTransform(state.savedZoom);
    VML.charts.init();
    VML.events.on(function (name) {
      if (name === 'render') {
        VML.map.render();
        VML.charts.render();
        renderStats();
        renderLegend();
        syncLegendWrap();
      } else if (name === 'pair') {
        VML.map.pair();
        VML.charts.pair();
      }
    });
    VML.events.on(function (name) {
      if (name === 'render' || name === 'zoom') persist();
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
