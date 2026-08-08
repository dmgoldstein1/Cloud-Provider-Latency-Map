(function () {
  var VML = window.VML = window.VML || {};
  var m = {};

  function latLonToVec3(lat, lon) {
    var phi = lat * Math.PI / 180;
    var lam = lon * Math.PI / 180;
    return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
  }
  function vec3ToLatLon(v) {
    return [Math.asin(v[2]) * 180 / Math.PI, Math.atan2(v[1], v[0]) * 180 / Math.PI];
  }
  function slerp(a, b, t) {
    var dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    var theta = Math.acos(dot);
    if (theta < 1e-8) return a.slice();
    var w1 = Math.sin((1 - t) * theta) / Math.sin(theta);
    var w2 = Math.sin(t * theta) / Math.sin(theta);
    return [w1 * a[0] + w2 * b[0], w1 * a[1] + w2 * b[1], w1 * a[2] + w2 * b[2]];
  }
  function arcScreenPoints(projection, a, b, samples) {
    var A = latLonToVec3(a.lat, a.lon);
    var B = latLonToVec3(b.lat, b.lon);
    var pts = [];
    for (var i = 0; i <= samples; i++) {
      var t = i / samples;
      var v = slerp(A, B, t);
      var ll = vec3ToLatLon(v);
      pts.push(projection([ll[1], ll[0]]));
    }
    return pts;
  }
  function bowScreenPts(pts, height) {
    if (pts.length < 2) return pts;
    var x0 = pts[0][0], y0 = pts[0][1], x1 = pts[pts.length - 1][0], y1 = pts[pts.length - 1][1];
    var dx = x1 - x0, dy = y1 - y0;
    var L = Math.hypot(dx, dy) || 1;
    var ux = -dy / L, uy = dx / L;
    var n = pts.length - 1;
    return pts.map(function (p, i) {
      var mid = Math.sin(Math.PI * i / n);
      return [p[0] + ux * height * mid, p[1] + uy * height * mid];
    });
  }
  function arcPath(projection, a, b, distKm) {
    var h = Math.max(8, Math.min(110, distKm * 0.02));
    var pts = bowScreenPts(arcScreenPoints(projection, a, b, 64), h);
    return 'M' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('L');
  }

  function init(container, state) {
    m.state = state;
    m.svg = d3.select(container).append('svg').attr('class', 'map-svg');
    m.defs = m.svg.append('defs');
    m.defs.append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 8)
      .attr('refY', 5)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,0 L10,5 L0,10 z')
      .attr('fill', '#f8fafc');
    m.g = m.svg.append('g');
    m.graticuleG = m.g.append('g').attr('class', 'graticule');
    m.landG = m.g.append('g').attr('class', 'land');
    m.arcsG = m.g.append('g').attr('class', 'arcs');
    m.markerG = m.g.append('g').attr('class', 'markers');
    m.labelsG = m.g.append('g').attr('class', 'labels');

    m.projection = d3.geoNaturalEarth1();
    m.path = d3.geoPath(m.projection);
    m.zoom = d3.zoom().scaleExtent([1, 12]).on('zoom', function (e) {
      m.g.attr('transform', e.transform);
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
    render();
  }

  function render() {
    var state = m.state;
    if (!state.world) return;
    renderLayoutOnly();
    drawArcs();
    drawMarkers();
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

  function drawArcs() {
    var state = m.state;
    var arcs = state.arcs.filter(function (d) {
      return d.src === state.source &&
        state.continents.has(state.byCode.get(d.dst).continent) &&
        state.metricMax >= valueOf(d) &&
        state.threshold >= valueOf(d);
    });
    var s = state.colorScale;
    var widthFn = state.widthScale;
    var self = m;
    var sel = m.arcsG.selectAll('path.arc').data(arcs, function (d) { return d.dst; });
    sel.join('path')
      .attr('class', function (d) {
        return 'arc' + (state.pair && state.pair.src === d.src && state.pair.dst === d.dst ? ' pair' : '');
      })
      .attr('d', function (d) {
        return arcPath(m.projection, state.byCode.get(d.src), state.byCode.get(d.dst), d.distance);
      })
      .attr('stroke', function (d) { return s(valueOf(d)); })
      .attr('stroke-width', function (d) { return widthFn(valueOf(d)); })
      .attr('marker-end', 'url(#arrow)')
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
    return '<b>' + d.src + ' → ' + d.dst + '</b><br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + jit + '</b> ms<br>' +
      d.distance.toFixed(0) + ' km';
  }

  function markerRadius(meanLat, extent) {
    var r = 4 + (meanLat - extent[0]) / ((extent[1] - extent[0]) || 1) * 10;
    return Math.max(4, Math.min(16, r));
  }

  function drawMarkers() {
    var state = m.state;
    var s = state.regions.filter(function (r) { return state.continents.has(r.continent); });
    var sel = m.markerG.selectAll('circle.region').data(s, function (d) { return d.code; });
    var self = m;
    var enters = sel.join('circle');
    enters
      .attr('class', 'region')
      .attr('cx', function (d) { return m.projection([d.lon, d.lat])[0]; })
      .attr('cy', function (d) { return m.projection([d.lon, d.lat])[1]; })
      .attr('r', function (d) { return markerRadius(state.centrality[d.code], state.centralityExtent); })
      .attr('fill', function (d) { return state.continentColors[d.continent]; })
      .on('click', function (e, d) {
        state.source = d.code;
        emitRender();
      })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.code };
        emitPair();
        showTip(markerTip(d), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; emitPair(); hideTip(); });

    var rings = m.markerG.selectAll('circle.source-ring').data([state.source], function (d) { return d; });
    rings.join('circle')
      .attr('class', 'source-ring')
      .attr('cx', function (d) { var p = m.projection([state.byCode.get(d).lon, state.byCode.get(d).lat]); return p[0]; })
      .attr('cy', function (d) { var p = m.projection([state.byCode.get(d).lon, state.byCode.get(d).lat]); return p[1]; })
      .attr('r', function (d) { return markerRadius(state.centrality[d], state.centralityExtent) + 5; });

    var labels = m.labelsG.selectAll('text.label').data([state.source], function (d) { return d; });
    labels.join('text')
      .attr('class', 'label')
      .attr('x', function (d) { return m.projection([state.byCode.get(d).lon, state.byCode.get(d).lat])[0] + 10; })
      .attr('y', function (d) { return m.projection([state.byCode.get(d).lon, state.byCode.get(d).lat])[1] + 4; })
      .text(function (d) { return state.byCode.get(d).name; });
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
    return '<b>' + d.name + '</b> (' + d.code + ')<br>' +
      d.country + ' · ' + d.continent + '<br>' +
      'avg latency to ' + out.length + ' regions: <b>' + avg.toFixed(0) + '</b> ms<br>' +
      '<i>click to set as source</i>';
  }

  function emitRender() { VML.events.emit('render'); }
  function emitPair() { VML.events.emit('pair'); }

  function showTip(html, e) {
    VML.tooltip.show(html, e.clientX, e.clientY);
  }
  function moveTip(e) { VML.tooltip.move(e.clientX, e.clientY); }
  function hideTip() { VML.tooltip.hide(); }

  m.render = render;
  m.renderLayout = renderLayout;
  m.pair = function () { drawArcs(); drawMarkers(); };
  m.init = init;

  VML.map = m;
})();
