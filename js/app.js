(function () {
  var VML = window.VML = window.VML || {};

  VML.events = {
    fns: [],
    on: function (fn) { this.fns.push(fn); return fn; },
    emit: function (name) { this.fns.forEach(function (f) { f(name); }); }
  };

  var state;
  var sourceListEl, metricButtons, thresholdSlider, thresholdMinSlider, thresholdLabel, knobLabelMin, knobLabelMax, statsEl;
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
      graphX: state.graphX,
      graphY: state.graphY,
      threshold: state.threshold,
      thresholdMin: state.thresholdMin,
      thresholds: state.thresholds,
      destMode: state.destMode,
      boxSort: state.boxSort,
      boxSortDir: state.boxSortDir,
      panelHidden: document.body.classList.contains('panel-hidden'),
      srcHidden: document.body.classList.contains('src-hidden'),
      footerHidden: document.body.classList.contains('footer-hidden'),
      zoom: VML.map && VML.map.transform
        ? { k: VML.map.transform.k, x: VML.map.transform.x, y: VML.map.transform.y }
        : null
    });
  }

  function restoreState(saved) {
    if (!saved) return;
    var order = state.data.matrices.latency.order;
    if (saved.destMode === 'all' || saved.destMode === 'checked') state.destMode = saved.destMode;
    if (saved.boxSort && ['min', 'q1', 'med', 'mean', 'q3', 'max', 'range', 'geo', 'alpha'].indexOf(saved.boxSort) !== -1) state.boxSort = saved.boxSort;
    if (saved.boxSortDir === 'asc' || saved.boxSortDir === 'desc') state.boxSortDir = saved.boxSortDir;
    if (Array.isArray(saved.sources)) {
      state.sources = new Set(saved.sources.filter(function (c) { return order.indexOf(c) !== -1; }));
    }
    if (saved.metric && VML.config.metrics[saved.metric]) state.metric = saved.metric;
    if (saved.graphX && VML.config.metrics[saved.graphX]) state.graphX = saved.graphX;
    if (saved.graphY && VML.config.metrics[saved.graphY]) state.graphY = saved.graphY;
    if (saved.thresholds && typeof saved.thresholds === 'object') {
      Object.keys(state.thresholds).forEach(function (m) {
        var t = saved.thresholds[m];
        if (t && typeof t.min === 'number' && typeof t.max === 'number') {
          state.thresholds[m] = { min: t.min, max: t.max };
        }
      });
      var cur = state.thresholds[state.metric];
      if (cur) {
        state.threshold = cur.max;
        state.thresholdMin = cur.min;
      }
    } else if (typeof saved.threshold === 'number' || typeof saved.thresholdMin === 'number') {
      if (typeof saved.threshold === 'number') state.threshold = saved.threshold;
      if (typeof saved.thresholdMin === 'number') state.thresholdMin = saved.thresholdMin;
      state.thresholds[state.metric] = { min: state.thresholdMin, max: state.threshold };
    }
    if (saved.panelHidden) document.body.classList.add('panel-hidden');
    if (saved.srcHidden) document.body.classList.add('src-hidden');
    if (saved.footerHidden) document.body.classList.add('footer-hidden');
    state.savedZoom = saved.zoom || null;
  }

  function applyRestoredUI() {
    metricButtons.forEach(function (x) { x.classList.toggle('active', x.dataset.metric === state.metric); });
    document.querySelectorAll('.dest-btn').forEach(function (x) { x.classList.toggle('active', x.dataset.dest === state.destMode); });
    var sideTab = document.getElementById('side-tab');
    if (sideTab) sideTab.textContent = document.body.classList.contains('panel-hidden') ? '◂' : '▸';
    var srcTab = document.getElementById('src-tab');
    if (srcTab) srcTab.textContent = document.body.classList.contains('src-hidden') ? '▴' : '▾';
    var footerTab = document.getElementById('map-footer-tab');
    if (footerTab) footerTab.textContent = document.body.classList.contains('footer-hidden') ? '▾' : '▴';
  }

  function buildState(regionsRaw, dataset) {
    var order = dataset.matrices.latency.order;
    state = {
      data: dataset,
      regions: regionsRaw.regions,
      byCode: new Map(regionsRaw.regions.map(function (r) { return [r.code, r]; })),
      idx: new Map(order.map(function (c, i) { return [c, i]; })),
      metric: VML.config.defaults.metric,
      graphX: 'latency',
      graphY: 'jitter',
      destMode: 'all',
      boxSort: 'med',
      boxSortDir: 'asc',
      expanded: null,
      sources: new Set(order),
      threshold: null,
      thresholdMin: 1,
      thresholds: { latency: null, jitter: null, loss: null },
      pair: null,
      world: state && state.world ? state.world : null,
      arcs: [],
      centrality: {},
      centralityExtent: [0, 1],
      distanceMax: 1,
      metricMax: 1,
      metricTrueMax: 1,
      colorScale: d3.scaleSequential(d3.interpolateRgbBasis(d3.schemeRdYlGn[11].slice().reverse())),
      continentColors: VML.config.continentColors
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

    state.metricTrueMaxes = {};
    Object.keys(dataset.matrices).forEach(function (metric) {
      var vals = dataset.matrices[metric].values.flat().filter(function (v) { return v > 0; });
      state.metricTrueMaxes[metric] = Math.ceil(d3.max(vals) || 1);
    });

    VML.state = state;
  }

  function computeScale() {
    var values = state.data.matrices[state.metric].values.flat().filter(function (v) { return v > 0; });
    var q = d3.quantile(values, VML.config.defaults.thresholdFactor);
    var raw = q || d3.max(values) || 1;
    state.metricMax = Math.round(raw * 10) / 10;
    state.metricTrueMax = state.metricTrueMaxes[state.metric];
    state.colorScale.domain([0, state.metricMax]);

    var step = state.metric === 'latency' ? 1 : 0.1;

    if (state.threshold == null || state.threshold > state.metricTrueMax) {
      state.threshold = state.metricTrueMax;
    }
    if (state.thresholdMin == null || state.thresholdMin > state.metricTrueMax) {
      state.thresholdMin = Math.min(1, state.metricTrueMax);
    }
    if (state.threshold < state.thresholdMin) {
      state.threshold = state.thresholdMin;
    }
    if (thresholdSlider) {
      thresholdSlider.min = 0;
      thresholdSlider.max = state.metricTrueMax;
      thresholdSlider.step = step;
      thresholdSlider.value = state.threshold;
    }
    if (thresholdMinSlider) {
      thresholdMinSlider.min = 0;
      thresholdMinSlider.max = state.metricTrueMax;
      thresholdMinSlider.step = step;
      thresholdMinSlider.value = state.thresholdMin;
    }
    syncThresholdLabel();
  }

  function syncThresholdLabel() {
    if (thresholdLabel) thresholdLabel.textContent = fmt(state.thresholdMin) + '–' + fmt(state.threshold) + ' ' + unit();
    if (thresholdSlider) {
      var m = state.metricTrueMax || 1;
      thresholdSlider.style.setProperty('--min-pct', (state.thresholdMin / m) * 100 + '%');
      thresholdSlider.style.setProperty('--max-pct', (state.threshold / m) * 100 + '%');
    }
    if (knobLabelMin && knobLabelMax) {
      var mm = state.metricTrueMax || 1;
      var dual = thresholdSlider ? thresholdSlider.parentElement : null;
      var rw = (dual && dual.clientWidth) || 1;
      // clamp the label's left so it stays fully inside the dual-range: the
      // label is translateX(-50%)-centered on its knob, so the knob may never
      // sit closer to an edge than half the label width, or the label pokes
      // past the viewport and the page scrolls horizontally
      function clampPct(el, pct) {
        var half = ((el.offsetWidth || 0) / 2 / rw) * 100;
        return Math.max(half, Math.min(100 - half, pct));
      }
      knobLabelMin.textContent = fmt(state.thresholdMin) + ' ' + unit();
      knobLabelMax.textContent = fmt(state.threshold) + ' ' + unit();
      knobLabelMin.style.left = clampPct(knobLabelMin, (state.thresholdMin / mm) * 100) + '%';
      knobLabelMax.style.left = clampPct(knobLabelMax, (state.threshold / mm) * 100) + '%';
    }
  }

  function syncKnobLabelVisibility(show) {
    if (!knobLabelMin || !knobLabelMax) return;
    show = !!show;
    knobLabelMin.classList.toggle('show', show);
    knobLabelMax.classList.toggle('show', show);
    var title = document.getElementById('threshold-title');
    if (title) title.classList.toggle('hidden', show);
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
    thresholdMinSlider = document.getElementById('threshold-min');
    knobLabelMin = document.getElementById('knob-label-min');
    knobLabelMax = document.getElementById('knob-label-max');
    statsEl = document.getElementById('stats');

    buildSourceList();

    metricButtons.forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.metric === b.dataset.metric) return;
        state.thresholds[state.metric] = { min: state.thresholdMin, max: state.threshold };
        state.metric = b.dataset.metric;
        var t = state.thresholds[state.metric];
        state.threshold = t ? t.max : null;
        state.thresholdMin = t ? t.min : 1;
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

    var selectAll = document.getElementById('src-select-all');
    if (selectAll) {
      selectAll.addEventListener('click', function () {
        state.data.matrices.latency.order.forEach(function (c) { state.sources.add(c); });
        emitRender();
      });
    }
    var selectNone = document.getElementById('src-select-none');
    if (selectNone) {
      selectNone.addEventListener('click', function () {
        state.sources.clear();
        emitRender();
      });
    }

    function syncThresholdState() {
      var a = +thresholdSlider.value;
      var b = thresholdMinSlider ? +thresholdMinSlider.value : a;
      state.threshold = Math.max(a, b);
      state.thresholdMin = Math.min(a, b);
      state.thresholds[state.metric] = { min: state.thresholdMin, max: state.threshold };
    }

    thresholdSlider.addEventListener('input', function () {
      syncThresholdState();
      syncThresholdLabel();
      VML.events.emit('render');
    });

    if (thresholdMinSlider) {
      thresholdMinSlider.addEventListener('input', function () {
        syncThresholdState();
        syncThresholdLabel();
        VML.events.emit('render');
      });
    }

    var knobDragging = false;
    [thresholdSlider, thresholdMinSlider].forEach(function (el) {
      if (!el) return;
      el.addEventListener('pointerdown', function () {
        knobDragging = true;
        syncKnobLabelVisibility(true);
      });
      el.addEventListener('keydown', function () { syncKnobLabelVisibility(true); });
      el.addEventListener('keyup', function () { syncKnobLabelVisibility(false); });
      el.addEventListener('blur', function () { if (!knobDragging) syncKnobLabelVisibility(false); });
    });
    document.addEventListener('pointerup', function () { knobDragging = false; syncKnobLabelVisibility(false); });
    document.addEventListener('pointercancel', function () { knobDragging = false; syncKnobLabelVisibility(false); });

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

    var footerTab = document.getElementById('map-footer-tab');
    if (footerTab) {
      footerTab.addEventListener('click', function () {
        document.body.classList.toggle('footer-hidden');
        footerTab.textContent = document.body.classList.contains('footer-hidden') ? '▾' : '▴';
        VML.events.emit('render');
      });
    }

    window.addEventListener('resize', onResize);
    wireChartHelp();
    wireChartExpand();
    wireMapControls();
    wireFooterLayout();
    wireAxisButtons();
    wireBoxSortButtons();
    wireBoxSortChecker();
  }

  function wireBoxSortButtons() {
    var group = document.getElementById('box-sort-btns');
    var dirGroup = document.getElementById('box-sort-dir-btns');
    function sync() {
      group.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('active', state.boxSort === b.dataset.sort);
      });
      if (dirGroup) {
        dirGroup.querySelectorAll('button').forEach(function (b) {
          b.classList.toggle('active', state.boxSortDir === b.dataset.dir);
        });
      }
    }
    if (dirGroup) {
      dirGroup.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          if (state.boxSortDir === b.dataset.dir) return;
          state.boxSortDir = b.dataset.dir;
          sync();
          emitRender();
        });
      });
    }
    group.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.boxSort === b.dataset.sort) return;
        state.boxSort = b.dataset.sort;
        sync();
        emitRender();
      });
    });
    VML.events.on(sync);
    sync();
  }

  function wireBoxSortChecker() {
    var group = document.getElementById('box-sort-btns');
    if (!group || typeof ResizeObserver === 'undefined') return;
    var raf = null;
    function rowCounts() {
      var rows = [];
      var prevTop = null, row = -1;
      group.querySelectorAll('button').forEach(function (b) {
        var top = b.offsetTop;
        if (top !== prevTop) { row++; rows.push(0); prevTop = top; }
        rows[row]++;
      });
      return rows;
    }
    function apply() {
      raf = null;
      var btns = group.querySelectorAll('button');
      // Rule: never leave a lone button on its own row. Flex line
      // breaking uses each button's natural width, so at some widths the
      // last row holds exactly one button. Widen the flex-basis (fewer
      // buttons per row) until the lone button joins the row above.
      btns.forEach(function (b) { b.style.flexBasis = ''; });
      var rows = rowCounts();
      var n = btns.length, perRow = rows[0], lastRow = rows[rows.length - 1];
      if (perRow > 2 && lastRow === 1) {
        var k = perRow - 1;
        for (; k >= 2 && n % k === 1; k--) {}
        if (k >= 2) {
          btns.forEach(function (b) { b.style.flexBasis = 'calc(100% / ' + k + ')'; });
        }
      }
      var prevTop = null, row = -1, col = -1;
      btns.forEach(function (b) {
        var top = b.offsetTop;
        if (top !== prevTop) { row++; col = 0; prevTop = top; } else { col++; }
        b.classList.toggle('shade', (row + col) % 2 === 1);
      });
    }
    function schedule() {
      if (raf != null) return;
      raf = requestAnimationFrame(apply);
    }
    new ResizeObserver(schedule).observe(group);
    schedule();
  }

  function wireAxisButtons() {
    var axes = ['x', 'y'];
    function keyOf(axis) { return 'graph' + axis.toUpperCase(); }
    function otherOf(axis) { return axis === 'x' ? 'y' : 'x'; }
    function syncAxisButtons() {
      axes.forEach(function (axis) {
        var group = document.getElementById(axis + '-metric-btns');
        if (!group) return;
        group.querySelectorAll('.axis-metric-btn').forEach(function (b) {
          b.classList.toggle('active', state[keyOf(axis)] === b.dataset.metric);
        });
      });
    }
    axes.forEach(function (axis) {
      var group = document.getElementById(axis + '-metric-btns');
      if (!group) return;
      group.querySelectorAll('.axis-metric-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = keyOf(axis);
          if (state[key] === b.dataset.metric) return;
          var other = otherOf(axis);
          if (state[keyOf(other)] === b.dataset.metric) {
            state[keyOf(other)] = state[key];
            state[key] = b.dataset.metric;
          } else {
            state[key] = b.dataset.metric;
          }
          syncAxisButtons();
          emitRender();
        });
      });
    });
    VML.events.on(syncAxisButtons);
    syncAxisButtons();
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

  // **********************************************************************
  // NOTE TO FUTURE CODERS AND AGENTS: the map-footer layout must NEVER
  // flicker. The buttons sit to the right of the two-row legend when the
  // pane is wide enough, and move below it when it isn't (see
  // syncFooterLayout). This used to flicker because some measurements
  // depended on the current layout: toggling the mode changed the inputs,
  // which re-toggled the mode — an endless visual oscillation (see git
  // history for the .zoom-btn flex:1 measurement bug). To keep that from
  // happening again:
  //   * Measure ONLY intrinsic sizes: nowrap content scrollWidth and fixed
  //     CSS sizes (the zoom buttons are locked to 30px squares). NEVER
  //     measure an element whose size a layout mode changes.
  //   * Keep hysteresis around the width threshold and only toggle classes
  //     when the decision actually changes.
  // The legend itself is always exactly two rows and never re-lays out;
  // only the button placement switches.
  // **********************************************************************
  // reference width of the widest legend row at the base font (15.4px)
  function baseLegendWidth(legend) {
    var maxRow = 0;
    legend.querySelectorAll('.legend-row').forEach(function (row) {
      var items = row.querySelectorAll('.lg');
      var s = 0;
      items.forEach(function (el) { s += el.scrollWidth; });
      if (items.length) s += (items.length - 1) * 12; // .legend-row gap
      if (s > maxRow) maxRow = s;
    });
    return maxRow;
  }

  // reference width of the widest fit button at the base font (includes padding)
  function baseFitWidth(ctrl) {
    var maxW = 0;
    ctrl.querySelectorAll('.fit-btn').forEach(function (b) {
      var w = b.scrollWidth;
      if (w > maxW) maxW = w;
    });
    return maxW;
  }

  // scale baseW to fit inside avail, clamped so text never becomes unreadable
  function fitFont(baseW, avail) {
    if (!baseW || avail <= 0) return 15.4;
    return Math.max(8, Math.min(15.4, 15.4 * avail / baseW));
  }

  function resetFooterFonts() {
    var legend = document.getElementById('legend');
    var ctrl = document.getElementById('map-controls');
    if (legend) legend.style.fontSize = '';
    if (ctrl) ctrl.querySelectorAll('.fit-btn').forEach(function (b) { b.style.fontSize = ''; });
  }

  function syncFooterLayout() {
    var footer = document.getElementById('map-footer-body');
    var legend = document.getElementById('legend');
    var ctrl = document.getElementById('map-controls');
    if (!footer || !legend || !ctrl) return;
    if (!legend.querySelectorAll('.legend-row').length) return;
    var avail = footer.clientWidth;
    if (!avail) return;

    // Always decide layout and font from the base-font reference widths
    // (measured in renderLegend), never from a measurement that changes with
    // the current font or layout — otherwise the layout could oscillate.
    var baseW = state.legendBaseW || baseLegendWidth(legend);
    var fitBaseW = state.fitBaseW || baseFitWidth(ctrl);

    // width of the 2×2 grid: zoom column (fixed 30px squares) + gap + widest
    // fit button
    var controlsNeed = 30 + 6 + fitBaseW;

    var cs = getComputedStyle(legend);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
               parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);

    // 8 = #map-footer-body gap
    var needed = baseW + padX + 8 + controlsNeed;
    var prevBelow = footer.classList.contains('controls-below');
    var M = 6; // hysteresis: only switch once the width clearly crosses
    var below = prevBelow ? needed > avail - M : needed > avail + M;
    footer.classList.toggle('controls-below', below);

    // RULE: the legend and button text must NEVER trail off invisibly. When
    // the buttons are below the legend (stacked), shrink the font so the
    // legend's two rows and the fit-button labels fit the full footer width
    // instead of being clipped. Beside the legend, the base font already fits
    // by construction (that is what beside mode requires), so reset it.
    var fitButtons = ctrl.querySelectorAll('.fit-btn');
    if (below) {
      legend.style.fontSize = fitFont(baseW, avail - padX) + 'px';
      var btnAvail = Math.max(0, (avail - 6) / 2);
      var fsb = fitFont(fitBaseW, btnAvail) + 'px';
      fitButtons.forEach(function (b) { b.style.fontSize = fsb; });
    } else {
      legend.style.fontSize = '';
      fitButtons.forEach(function (b) { b.style.fontSize = ''; });
    }

    // Collapse/expand must be a physical slide, not a fade. Pin max-height to
    // the exact content height (scrollHeight reports it even while clipped at
    // 0), so the 0.35s transition moves the real content instead of idling
    // while a 300px cap shrinks down to the content edge. The guard skips
    // no-op writes so a ResizeObserver round-trip can't restart a running
    // transition or feed a stale measurement back in.
    var hidden = document.body.classList.contains('footer-hidden');
    var maxH = hidden ? 0 : Math.min(footer.scrollHeight, 300);
    var px = maxH + 'px';
    if (footer.style.maxHeight !== px) footer.style.maxHeight = px;
  }

  function wireFooterLayout() {
    var footer = document.getElementById('map-footer-body');
    if (!footer || typeof ResizeObserver === 'undefined') return;
    new ResizeObserver(syncFooterLayout).observe(footer);
  }

  function wireChartHelp() {
    [['scatter-help-btn', 'scatter-help-pop', 'scatter-help-close'],
     ['boxes-help-btn', 'boxes-help-pop', 'boxes-help-close']].forEach(function (ids) {
      var btn = document.getElementById(ids[0]);
      var pop = document.getElementById(ids[1]);
      var close = document.getElementById(ids[2]);
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
    });
  }

  function wireChartExpand() {
    var ids = ['heatmap', 'boxes', 'scatter'];
    function sync() {
      var expanded = state.expanded;
      document.body.classList.toggle('chart-expanded', !!expanded);
      ids.forEach(function (id) {
        var card = document.getElementById(id + '-card');
        var btn = document.getElementById(id + '-expand');
        if (card) card.classList.toggle('expanded', expanded === id);
        if (!btn) return;
        var is = expanded === id;
        btn.title = is ? 'Exit full page' : 'Expand to full page';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', is ? 'true' : 'false');
      });
    }
    ids.forEach(function (id) {
      var btn = document.getElementById(id + '-expand');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.expanded = state.expanded === id ? null : id;
        sync();
        VML.events.emit('render');
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state && state.expanded) {
        state.expanded = null;
        sync();
        VML.events.emit('render');
      }
    });
  }

  var resizeTimeout = null;
  var expandResizeTimeout = null;
  function onResize() {
    document.body.classList.add('resizing');
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function () {
      document.body.classList.remove('resizing');
    }, 200);
    // an expanded chart follows the viewport: once the resize settles,
    // re-render so the svg picks up the new full-page size
    if (state && state.expanded) {
      clearTimeout(expandResizeTimeout);
      expandResizeTimeout = setTimeout(function () {
        VML.events.emit('render');
      }, 150);
    }
  }

  function renderStats() {
    var metric = state.metric;
    var vals = activeArcs(state)
      .map(function (d) { return state.data.matrices[metric].values[state.idx.get(d.src)][state.idx.get(d.dst)]; });
    var shown = vals.filter(function (v) { return v >= state.thresholdMin && state.threshold >= v; }).length;
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
      ' · showing <b>' + shown + '</b> arc' + (shown === 1 ? '' : 's') + ' between <b>' + fmt(state.thresholdMin) + '</b>–<b>' + fmt(state.threshold) + '</b> ' + unit();
  }

  function renderLegend() {
    var html = '';
    VML.config.continents.forEach(function (c) {
      html += '<button type="button" class="lg continent-btn" data-continent="' + c + '" title="Zoom to ' + c + '">' +
        '<span class="sw" style="background:' + state.continentColors[c] + '"></span>' + c + '</button>';
    });
    html += '<span class="lg" title="Dot size = a source region\'s average latency to all other selected regions, rescaled to the current selection">' +
      '<svg width="10" height="10" style="vertical-align:middle">' +
      '<circle cx="5" cy="5" r="3" fill="' + state.continentColors['Europe'] + '"/>' +
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
    var legend = document.getElementById('legend');
    var ctrl = document.getElementById('map-controls');
    legend.innerHTML = html;
    // clear any responsive font shrink first so the row balancing and the
    // base-width references below are measured at the base font (15.4px)
    resetFooterFonts();
    legend.querySelectorAll('.continent-btn').forEach(function (el) {
      el.addEventListener('click', function () {
        if (VML.map && VML.map.fitToContinent) VML.map.fitToContinent(el.dataset.continent);
      });
    });

    // lay the legend out as exactly two rows. Items are balanced by intrinsic
    // width, then each row's items spread across the full width via the
    // .legend-row CSS (justify-content: space-between). This is a static
    // layout — the number of rows never changes with viewport width, so the
    // footer can never flicker between row counts (see note above).
    var items = Array.prototype.slice.call(legend.querySelectorAll('.lg'));
    var sums = [0, 0];
    var rows = [[], []];
    items.forEach(function (el) {
      var j = sums[0] <= sums[1] ? 0 : 1;
      rows[j].push(el);
      sums[j] += el.scrollWidth;
    });
    rows.forEach(function (row) {
      if (!row.length) return;
      var div = document.createElement('div');
      div.className = 'legend-row';
      row.forEach(function (el) { div.appendChild(el); });
      legend.appendChild(div);
    });
    // remember the content widths at the base font so syncFooterLayout can
    // decide layout and font scaling from inputs that never change with the
    // current font or layout (deterministic, no oscillation)
    state.legendBaseW = baseLegendWidth(legend);
    state.fitBaseW = baseFitWidth(ctrl);
    syncFooterLayout();
  }

  function main() {
    var D = window.VML_DATA;
    if (!D || !D.world || !D.regions || !D.measured) {
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
