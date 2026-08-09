(function () {
  var VML = window.VML = window.VML || {};
  var m = {};

  function arcPath(projection, a, b) {
    var p0 = projection([a.lon, a.lat]);
    var p1 = projection([b.lon, b.lat]);
    return 'M' + p0[0].toFixed(1) + ',' + p0[1].toFixed(1) +
      'L' + p1[0].toFixed(1) + ',' + p1[1].toFixed(1);
  }

  function init(container, state) {
    m.state = state;
    m.transform = d3.zoomIdentity;
    m.svg = d3.select(container).append('svg').attr('class', 'map-svg');
    m.defs = m.svg.append('defs');

    m.worldG = m.svg.append('g').attr('class', 'world');
    m.graticuleG = m.worldG.append('g').attr('class', 'graticule');
    m.landG = m.worldG.append('g').attr('class', 'land');
    m.arcsG = m.worldG.append('g').attr('class', 'arcs');

    m.clipPath = m.defs.append('clipPath').attr('id', 'map-clip');
    m.clipRect = m.clipPath.append('rect');
    m.worldG.attr('clip-path', 'url(#map-clip)');

    m.overlayG = m.svg.append('g').attr('class', 'overlay');
    m.markerG = m.overlayG.append('g').attr('class', 'markers');
    m.labelsG = m.overlayG.append('g').attr('class', 'labels');

    m.projection = d3.geoNaturalEarth1();
    m.path = d3.geoPath(m.projection);
    m.zoom = d3.zoom().scaleExtent([1, 12]).on('zoom', function (e) {
      m.transform = e.transform;
      m.worldG.attr('transform', e.transform);
      positionOverlay();
    }).on('end', function () {
      VML.events.emit('zoom');
    });
    m.svg.call(m.zoom);

    m.resizeObserver = new ResizeObserver(function () { renderLayout(); });
    m.resizeObserver.observe(container);
  }

  function renderLayout() {
    var node = m.svg.node();
    var w = node.clientWidth || 800;
    var h = node.clientHeight || 600;
    m.width = w; m.height = h;
    m.svg.attr('width', w).attr('height', h);
    m.projection.fitSize([w, h], { type: 'Sphere' });
    var yTop = m.projection([0, 84])[1];
    var yBot = m.projection([0, -60])[1];
    m.clipRect.attr('x', 0).attr('y', yTop).attr('width', w).attr('height', Math.max(0, yBot - yTop));
    render();
    applyPendingTransform();
  }

  function applyPendingTransform() {
    if (!m.pendingTransform) return;
    m.transform = d3.zoomIdentity
      .translate(m.pendingTransform.x || 0, m.pendingTransform.y || 0)
      .scale(m.pendingTransform.k);
    m.worldG.attr('transform', m.transform);
    m.svg.call(m.zoom.transform, m.transform);
    m.pendingTransform = null;
  }

  function render() {
    var state = m.state;
    if (!state.world) return;
    renderLayoutOnly();
    drawArcs();
    drawMarkers();
    positionOverlay();
  }

  function renderLayoutOnly() {
    var state = m.state;
    var graticule = d3.geoGraticule10();
    var land = m.landG.selectAll('path').data(state.world.features, function (d) { return d.id; });
    land.join('path')
      .attr('d', m.path)
      .attr('class', 'land-path');
    var grat = m.graticuleG.selectAll('path').data([graticule]);
    grat.join('path').attr('d', m.path).attr('class', 'grat-path');
  }

  function valueOf(d) {
    var state = m.state;
    return state.data.matrices[state.metric].values[state.idx.get(d.src)][state.idx.get(d.dst)];
  }

  function nameOf(code) { return m.state.byCode.get(code).name; }

  function drawArcs() {
    var state = m.state;
    var dsts = VML.util.destSet(state);
    var arcs = state.arcs.filter(function (d) {
      return state.sources.has(d.src) &&
        dsts.has(d.dst) &&
        state.metricMax >= valueOf(d) &&
        state.threshold >= valueOf(d);
    });
    var s = state.colorScale;
    var widthFn = state.widthScale;
    var sel = m.arcsG.selectAll('path.arc').data(arcs, function (d) { return d.src + ':' + d.dst; });
    sel.join('path')
      .attr('class', function (d) {
        return 'arc' + (state.pair && state.pair.src === d.src && state.pair.dst === d.dst ? ' pair' : '');
      })
      .attr('d', function (d) {
        return arcPath(m.projection, state.byCode.get(d.src), state.byCode.get(d.dst));
      })
      .attr('stroke', function (d) { return s(valueOf(d)); })
      .attr('stroke-width', function (d) { return widthFn(valueOf(d)); })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.src, dst: d.dst };
        emitPair();
        showTip(arcTip(d), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; emitPair(); hideTip(); });
  }

  function arcTip(d) {
    var state = m.state;
    var lat = state.data.matrices.latency.values[state.idx.get(d.src)][state.idx.get(d.dst)];
    var jit = state.data.matrices.jitter.values[state.idx.get(d.src)][state.idx.get(d.dst)];
    var loss = state.data.matrices.loss.values[state.idx.get(d.src)][state.idx.get(d.dst)];
    return '<b>' + nameOf(d.src) + ' → ' + nameOf(d.dst) + '</b> (' + d.src + ' → ' + d.dst + ')<br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + jit + '</b> ms · loss <b>' + loss + '</b> %<br>' +
      d.distance.toFixed(0) + ' km';
  }

  function markerRadius(meanLat, extent) {
    var r = 4 + (meanLat - extent[0]) / ((extent[1] - extent[0]) || 1) * 10;
    return Math.max(4, Math.min(16, r));
  }

  function drawMarkers() {
    var state = m.state;
    var visible = state.regions;
    var sel = m.markerG.selectAll('circle.region').data(visible, function (d) { return d.code; });
    sel.join('circle')
      .attr('class', function (d) {
        return 'region' + (state.sources.has(d.code) ? ' checked' : ' unchecked');
      })
      .attr('r', function (d) { return markerRadius(state.centrality[d.code], state.centralityExtent); })
      .attr('fill', function (d) { return state.continentColors[d.continent]; })
      .on('click', function (e, d) {
        toggleSource(d.code, !state.sources.has(d.code));
      })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.code };
        emitPair();
        showTip(markerTip(d), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; emitPair(); hideTip(); });

    var checked = state.data.matrices.latency.order.filter(function (c) {
      return state.sources.has(c);
    });
    var labelData = state.sources.size <= 8 ? checked : [];
    var labels = m.labelsG.selectAll('text.label').data(labelData, function (d) { return d; });
    labels.join('text')
      .attr('class', 'label')
      .text(function (d) { return state.byCode.get(d).name; });
  }

  function positionOverlay() {
    var t = m.transform || d3.zoomIdentity;
    m.markerG.selectAll('circle.region').each(function (d) {
      var p = t.apply(m.projection([d.lon, d.lat]));
      this.setAttribute('cx', p[0]);
      this.setAttribute('cy', p[1]);
    });
    m.labelsG.selectAll('text.label').each(function (code) {
      var r = m.state.byCode.get(code);
      var p = t.apply(m.projection([r.lon, r.lat]));
      this.setAttribute('x', p[0] + 10);
      this.setAttribute('y', p[1] + 4);
    });
  }

  function markerTip(d) {
    var state = m.state;
    var out = [];
    state.regions.forEach(function (o) {
      if (o.code === d.code) return;
      var v = state.data.matrices.latency.values[state.idx.get(d.code)][state.idx.get(o.code)];
      out.push(v);
    });
    var avg = out.reduce(function (a, b) { return a + b; }, 0) / out.length;
    var status = state.sources.has(d.code) ? '<b>checked</b> — outgoing arcs shown' : 'unchecked — click to toggle';
    return '<b>' + d.name + '</b> (' + d.code + ')<br>' +
      d.country + ' · ' + d.continent + '<br>' +
      'avg latency to ' + out.length + ' regions: <b>' + avg.toFixed(0) + '</b> ms<br>' +
      '<i>' + status + '</i>';
  }

  function toggleSource(code, checked) { VML.app.toggleSource(code, checked); }
  function emitRender() { VML.events.emit('render'); }
  function emitPair() { VML.events.emit('pair'); }

  function fitTransform() {
    var codes = m.state.data.matrices.latency.order.filter(function (c) { return m.state.sources.has(c); });
    if (!codes.length) return null;
    var pts = codes.map(function (c) {
      var r = m.state.byCode.get(c);
      return m.projection([r.lon, r.lat]);
    });
    var xs = pts.map(function (p) { return p[0]; });
    var ys = pts.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var w = m.width, h = m.height;
    var bw = Math.max(x1 - x0, w * 0.2), bh = Math.max(y1 - y0, h * 0.2);
    var k = Math.max(1, Math.min(w / bw, h / bh, 12) * 0.75);
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return d3.zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k);
  }

  function showTip(html, e) {
    VML.tooltip.show(html, e.clientX, e.clientY);
  }
  function moveTip(e) { VML.tooltip.move(e.clientX, e.clientY); }
  function hideTip() { VML.tooltip.hide(); }

  m.render = render;
  m.renderLayout = renderLayout;
  m.setTransform = function (t) {
    if (!t || typeof t.k !== 'number') return;
    m.pendingTransform = t;
    if (m.width) applyPendingTransform();
  };
  m.zoomIn = function () {
    if (m.svg) m.svg.transition().duration(300).call(m.zoom.scaleBy, 1.5);
  };
  m.zoomOut = function () {
    if (m.svg) m.svg.transition().duration(300).call(m.zoom.scaleBy, 1 / 1.5);
  };
  m.fitWorld = function () {
    if (m.svg) m.svg.transition().duration(500).call(m.zoom.transform, d3.zoomIdentity);
  };
  m.fitToSelected = function () {
    var t = fitTransform();
    if (m.svg && t) m.svg.transition().duration(500).call(m.zoom.transform, t);
  };
  m.pair = function () { drawArcs(); drawMarkers(); positionOverlay(); };
  m.init = init;

  VML.map = m;
})();
