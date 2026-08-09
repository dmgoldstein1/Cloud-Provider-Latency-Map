(function () {
  var VML = window.VML = window.VML || {};
  var c = {};

  function valueAt(state, src, dst, metric) {
    return state.data.matrices[metric || state.metric].values[state.idx.get(src)][state.idx.get(dst)];
  }
  function nameOf(state, code) { return state.byCode.get(code).name; }

  var heatSvg, barSvg, scatterSvg, jitterSvg;
  var heatLayout = null;
  var scatterLayout = null;
  var jitterLayout = null;

  function init() {
    heatSvg = d3.select('#heatmap').append('svg');
    barSvg = d3.select('#bars').append('svg');
    scatterSvg = d3.select('#scatter').append('svg');
    scatterSvg.append('g').attr('class', 'grid');
    jitterSvg = d3.select('#jitter').append('svg');
    jitterSvg.append('g').attr('class', 'grid');
  }

  function maxNameLen(state) {
    return state.data.matrices[state.metric].order.reduce(function (mx, c) {
      return Math.max(mx, nameOf(state, c).length);
    }, 0);
  }

  function renderHeatmap() {
    var state = VML.state;
    var order = state.data.matrices[state.metric].order;
    var srcRows = state.destMode === 'checked'
      ? order.filter(function (c) { return state.sources.has(c); })
      : order;
    var dsts = order.filter(function (c) { return VML.util.destSet(state).has(c); });
    var n = srcRows.length;
    var nCols = dsts.length;
    var maxPx = maxNameLen(state) * 5.5;
    var padL = Math.max(60, maxPx + 22);
    var padT = Math.max(60, maxPx * 0.71 + 20);
    var cell = 13;
    var padR = Math.max(40, maxPx * 0.71 + 20);
    var w = padL + nCols * cell + padR, h = padT + n * cell;
    heatLayout = {
      padL: padL, padT: padT, cell: cell,
      srcIdx: new Map(srcRows.map(function (c, i) { return [c, i]; })),
      dstIdx: new Map(dsts.map(function (c, i) { return [c, i]; }))
    };
    heatSvg
      .attr('width', w)
      .attr('height', h)
      .attr('viewBox', '0 0 ' + w + ' ' + h);

    var xLabels = heatSvg.selectAll('text.col').data(dsts, function (d) { return d; });
    xLabels.join('text')
      .attr('class', 'axis-label col')
      .attr('transform', function (d, i) {
        return 'translate(' + (padL + i * cell + cell / 2) + ',' + (padT - 6) + ') rotate(-45)';
      })
      .attr('text-anchor', 'start')
      .text(function (d) { return nameOf(state, d); });

    var yLabels = heatSvg.selectAll('text.row').data(srcRows, function (d) { return d; });
    yLabels.join('text')
      .attr('class', function (d) { return 'axis-label row' + (state.sources.has(d) ? '' : ' off'); })
      .attr('transform', function (d, i) { return 'translate(' + (padL - 6) + ',' + (padT + i * cell + cell / 2) + ')'; })
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return nameOf(state, d); });

    var rows = heatSvg.selectAll('g.heat-row').data(srcRows, function (d) { return d; });
    var rowEnters = rows.join('g')
      .attr('class', 'heat-row')
      .attr('transform', function (d, i) { return 'translate(' + padL + ',' + (padT + i * cell) + ')'; });

    rowEnters.selectAll('rect.cell').data(dsts, function (d) { return d; })
      .join('rect')
      .attr('class', function (d) {
        var src = this.parentNode.__data__;
        var cls = 'cell';
        if (src === d) cls += ' diag';
        if (!state.sources.has(src)) cls += ' off';
        return cls;
      })
      .attr('x', function (d, j) { return j * cell; })
      .attr('y', 0)
      .attr('width', cell)
      .attr('height', cell)
      .attr('fill', function (d) {
        var src = this.parentNode.__data__;
        return src === d ? 'transparent' : state.colorScale(valueAt(state, src, d));
      })
      .on('mouseenter', function (e, d) {
        var src = this.parentNode.__data__, dst = d;
        if (src === dst) return;
        state.pair = { src: src, dst: dst };
        VML.events.emit('pair');
        showTip(heatTip(state, src, dst), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); hideTip(); })
      .on('click', function (e, d) {
        var src = this.parentNode.__data__;
        if (src === d) return;
        VML.app.toggleSource(src, !state.sources.has(src));
      });
  }

  function heatTip(state, src, dst) {
    var lat = state.data.matrices.latency.values[state.idx.get(src)][state.idx.get(dst)];
    var jit = state.data.matrices.jitter.values[state.idx.get(src)][state.idx.get(dst)];
    return '<b>' + nameOf(state, src) + ' → ' + nameOf(state, dst) + '</b> (' + src + ' → ' + dst + ')<br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + jit + '</b> ms<br><i>click to toggle source</i>';
  }

  function renderBars() {
    var state = VML.state;
    var order = state.data.matrices[state.metric].order;
    var srcs = order.filter(function (c) { return state.sources.has(c); });
    var dsts = order.filter(function (c) { return VML.util.destSet(state).has(c); });
    var items = [];
    dsts.forEach(function (dst) {
      var vs = srcs.filter(function (s) { return s !== dst; })
        .map(function (s) { return valueAt(state, s, dst); });
      if (vs.length) items.push({ dst: dst, v: d3.mean(vs) });
    });
    items.sort(function (a, b) { return a.v - b.v; });

    var titleEl = document.getElementById('bars-title');
    if (titleEl) titleEl.textContent = srcs.length ? '· mean of ' + srcs.length + ' checked source' + (srcs.length === 1 ? '' : 's') : '';

    var n = Math.max(items.length, 1);
    var barH = 13, gap = 2;
    var maxPx = maxNameLen(state) * 5.5;
    var padL = Math.max(40, maxPx + 14), padR = 52, padT = 8, padB = 4;
    var w = Math.max(300, (barSvg.node().parentElement.clientWidth || 360));
    var h = padT + n * (barH + gap) + padB;
    var x = d3.scaleLinear().domain([0, state.metricMax]).range([padL, w - padR]);
    barSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    if (!items.length) {
      barSvg.selectAll('g.bar').remove();
      var empty = barSvg.selectAll('text.empty').data([1]);
      empty.join('text')
        .attr('class', 'empty')
        .attr('x', padL)
        .attr('y', padT + 14)
        .text('No sources selected');
      return;
    }
    barSvg.selectAll('text.empty').remove();

    var g = barSvg.selectAll('g.bar')
      .data(items, function (d) { return d.dst; })
      .join('g')
      .attr('class', function (d) {
        return 'bar' + (state.pair && state.pair.dst === d.dst ? ' pair' : '');
      })
      .attr('transform', function (d, i) { return 'translate(0,' + (padT + i * (barH + gap)) + ')'; })
      .style('cursor', 'pointer');

    g.selectAll('text.bar-code')
      .data(function (d) { return [d]; })
      .join('text')
      .attr('class', 'bar-code')
      .attr('x', padL - 6)
      .attr('y', barH / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return nameOf(state, d.dst); });

    g.selectAll('rect.bar-rect')
      .data(function (d) { return [d]; })
      .join('rect')
      .attr('class', 'bar-rect')
      .attr('x', padL)
      .attr('y', 0)
      .attr('width', function (d) { return Math.max(2, x(d.v) - padL); })
      .attr('height', barH)
      .attr('fill', function (d) { return state.colorScale(d.v); })
      .on('mouseenter', function (e, d) {
        var src = srcs.find(function (s) { return s !== d.dst; });
        state.pair = src ? { src: src, dst: d.dst } : { dst: d.dst };
        VML.events.emit('pair');
        showTip(barTip(state, d), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); hideTip(); })
      .on('click', function (e, d) {
        VML.app.toggleSource(d.dst, !state.sources.has(d.dst));
      });

    g.selectAll('text.bar-val')
      .data(function (d) { return [d]; })
      .join('text')
      .attr('class', 'bar-val')
      .attr('x', function (d) { return Math.max(padL + 4, x(d.v) + 4); })
      .attr('y', barH / 2)
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return d.v.toFixed(d.v >= 10 ? 0 : 1); });
  }

  function barTip(state, d) {
    var lines = state.data.matrices[state.metric].order
      .filter(function (s) { return state.sources.has(s) && s !== d.dst; })
      .map(function (s) {
        return nameOf(state, s) + ' → ' + nameOf(state, d.dst) + ': <b>' + valueAt(state, s, d.dst) + '</b> ms';
      });
    return '<b>' + nameOf(state, d.dst) + '</b> — mean ' + d.v.toFixed(0) + ' ms<br>' +
      lines.join('<br>') + '<br><i>click to toggle source</i>';
  }

  function gridTicks(scale, n, divisions) {
    var major = scale.ticks(n);
    var minor = [];
    for (var i = 0; i < major.length - 1; i++) {
      var step = (major[i + 1] - major[i]) / divisions;
      for (var j = 1; j < divisions; j++) minor.push(major[i] + step * j);
    }
    return { major: major, minor: minor };
  }

  function renderGrid(layout, svg) {
    var g = svg.select('g.grid');
    var gx = gridTicks(layout.x, 6, 4);
    var gy = gridTicks(layout.y, 5, 4);

    g.selectAll('line.x-major').data(gx.major.filter(function (v) { return v > 0; }), String)
      .join('line')
      .attr('class', 'grid x-major')
      .attr('x1', function (d) { return layout.x(d); })
      .attr('x2', function (d) { return layout.x(d); })
      .attr('y1', layout.padT)
      .attr('y2', layout.padT + layout.innerH);

    g.selectAll('line.x-minor').data(gx.minor.filter(function (v) { return v > 0; }), String)
      .join('line')
      .attr('class', 'grid x-minor')
      .attr('x1', function (d) { return layout.x(d); })
      .attr('x2', function (d) { return layout.x(d); })
      .attr('y1', layout.padT)
      .attr('y2', layout.padT + layout.innerH);

    g.selectAll('line.y-major').data(gy.major.filter(function (v) { return v > 0; }), String)
      .join('line')
      .attr('class', 'grid y-major')
      .attr('y1', function (d) { return layout.y(d); })
      .attr('y2', function (d) { return layout.y(d); })
      .attr('x1', layout.padL)
      .attr('x2', layout.padL + layout.innerW);

    g.selectAll('line.y-minor').data(gy.minor.filter(function (v) { return v > 0; }), String)
      .join('line')
      .attr('class', 'grid y-minor')
      .attr('y1', function (d) { return layout.y(d); })
      .attr('y2', function (d) { return layout.y(d); })
      .attr('x1', layout.padL)
      .attr('x2', layout.padL + layout.innerW);
  }

  function scatterPairPos(p) {
    var a = VML.state.byCode.get(p.src), b = VML.state.byCode.get(p.dst);
    return {
      x: scatterLayout.x(d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 6371),
      y: scatterLayout.y(valueAt(VML.state, p.src, p.dst))
    };
  }

  function jitterPairPos(p) {
    return {
      x: jitterLayout.x(valueAt(VML.state, p.src, p.dst, 'jitter')),
      y: jitterLayout.y(valueAt(VML.state, p.src, p.dst, 'latency'))
    };
  }

  function renderPairGrid(svg, layout, posFn) {
    if (!layout) return;
    var state = VML.state;
    var p = state.pair;
    var data = p ? [p] : [];
    var key = function (d) { return d.src + ':' + d.dst; };
    var g = svg.select('g.grid');
    var pos = p ? posFn(p) : null;
    g.selectAll('line.pair-v').data(data, key)
      .join('line')
      .attr('class', 'grid pair-v')
      .attr('x1', pos && pos.x)
      .attr('x2', pos && pos.x)
      .attr('y1', layout.padT)
      .attr('y2', layout.padT + layout.innerH);
    g.selectAll('line.pair-h').data(data, key)
      .join('line')
      .attr('class', 'grid pair-h')
      .attr('y1', pos && pos.y)
      .attr('y2', pos && pos.y)
      .attr('x1', layout.padL)
      .attr('x2', layout.padL + layout.innerW);
  }

  function renderScatter() {
    var state = VML.state;
    var w = Math.max(300, (scatterSvg.node().parentElement.clientWidth || 360));
    var h = 260, padL = 44, padR = 14, padT = 10, padB = 30;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var arcs = VML.util.activeArcs(state);
    var xMax = d3.max(arcs, function (d) { return d.distance; }) || 1;
    var yMax = d3.max(arcs, function (d) { return valueAt(state, d.src, d.dst); }) || 1;
    var x = d3.scaleLinear().domain([0, xMax]).range([padL, w - padR]);
    var y = d3.scaleLinear().domain([0, yMax]).range([padT + innerH, padT]);
    scatterLayout = { x: x, y: y, padL: padL, padR: padR, padT: padT, innerW: innerW, innerH: innerH };
    scatterSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    renderGrid(scatterLayout, scatterSvg);

    var dots = scatterSvg.selectAll('circle.dot').data(VML.util.activeArcs(state), function (d) { return d.src + ':' + d.dst; });
    dots.join('circle')
      .attr('class', function (d) {
        var cls = 'dot';
        if (state.sources.has(d.src)) cls += ' src';
        if (state.pair && state.pair.src === d.src && state.pair.dst === d.dst) cls += ' pair';
        return cls;
      })
      .attr('cx', function (d) { return x(d.distance); })
      .attr('cy', function (d) { return y(valueAt(state, d.src, d.dst)); })
      .attr('r', function (d) { return state.sources.has(d.src) ? 3.2 : 2.2; })
      .attr('fill', function (d) { return state.colorScale(valueAt(state, d.src, d.dst)); })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.src, dst: d.dst };
        VML.events.emit('pair');
        showTip(heatTip(state, d.src, d.dst) + '<br>' + d.distance.toFixed(0) + ' km', e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); hideTip(); })
      .on('click', function (e, d) {
        VML.app.toggleSource(d.src, !state.sources.has(d.src));
      });

    if (state.fit && state.fit.slope !== null) {
      var line = scatterSvg.selectAll('line.fit').data([1]);
      line.join('line')
        .attr('class', 'fit')
        .attr('x1', padL)
        .attr('y1', y(state.fit.intercept))
        .attr('x2', w - padR)
        .attr('y2', y(state.fit.intercept + state.fit.slope * xMax));
    } else {
      scatterSvg.selectAll('line.fit').remove();
    }

    var xAxis = scatterSvg.selectAll('g.x-axis').data([1]);
    xAxis.join('g')
      .attr('class', 'axis x-axis')
      .attr('transform', 'translate(0,' + (padT + innerH) + ')')
      .call(d3.axisBottom(x).ticks(6).tickFormat(function (d) { return d >= 1000 ? (d / 1000).toFixed(1) + 'k' : d; }));

    var yAxis = scatterSvg.selectAll('g.y-axis').data([1]);
    yAxis.join('g')
      .attr('class', 'axis y-axis')
      .attr('transform', 'translate(' + padL + ',0)')
      .call(d3.axisLeft(y).ticks(5));

    var xLabel = scatterSvg.selectAll('text.x-label').data([1]);
    xLabel.join('text')
      .attr('class', 'axis-label')
      .attr('x', padL + innerW / 2)
      .attr('y', h - 6)
      .attr('text-anchor', 'middle')
      .text('great-circle distance (km)');

    renderPairGrid(scatterSvg, scatterLayout, scatterPairPos);
  }

  function jitterTip(state, d) {
    var lat = valueAt(state, d.src, d.dst, 'latency');
    var jit = valueAt(state, d.src, d.dst, 'jitter');
    return '<b>' + nameOf(state, d.src) + ' → ' + nameOf(state, d.dst) + '</b> (' + d.src + ' → ' + d.dst + ')<br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + Math.round(jit * 100) / 100 + '</b> ms<br>' +
      'distance ' + d.distance.toFixed(0) + ' km<br><i>click to toggle source</i>';
  }

  function latencyColorScale(state) {
    var values = state.data.matrices.latency.values.flat().filter(function (v) { return v > 0; });
    var max = d3.quantile(values, VML.config.defaults.thresholdFactor) || d3.max(values) || 1;
    return d3.scaleSequential(d3.interpolateRgbBasis(d3.schemeRdYlGn[11].slice().reverse())).domain([0, max]);
  }

  function renderJitterScatter() {
    var state = VML.state;
    var w = Math.max(300, (jitterSvg.node().parentElement.clientWidth || 360));
    var h = 260, padL = 44, padR = 14, padT = 10, padB = 30;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var arcs = VML.util.activeArcs(state);
    var jitterOf = function (d) { return valueAt(state, d.src, d.dst, 'jitter'); };
    var latencyOf = function (d) { return valueAt(state, d.src, d.dst, 'latency'); };
    var xMax = d3.max(arcs, jitterOf) || 1;
    var yMax = d3.max(arcs, latencyOf) || 1;
    var x = d3.scaleLinear().domain([0, xMax]).range([padL, w - padR]);
    var y = d3.scaleLinear().domain([0, yMax]).range([padT + innerH, padT]);
    var color = latencyColorScale(state);
    jitterLayout = { x: x, y: y, padL: padL, padR: padR, padT: padT, innerW: innerW, innerH: innerH };
    jitterSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    renderGrid(jitterLayout, jitterSvg);

    var dots = jitterSvg.selectAll('circle.dot').data(arcs, function (d) { return d.src + ':' + d.dst; });
    dots.join('circle')
      .attr('class', function (d) {
        var cls = 'dot';
        if (state.sources.has(d.src)) cls += ' src';
        if (state.pair && state.pair.src === d.src && state.pair.dst === d.dst) cls += ' pair';
        return cls;
      })
      .attr('cx', function (d) { return x(jitterOf(d)); })
      .attr('cy', function (d) { return y(latencyOf(d)); })
      .attr('r', function (d) { return state.sources.has(d.src) ? 3.2 : 2.2; })
      .attr('fill', function (d) { return color(latencyOf(d)); })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.src, dst: d.dst };
        VML.events.emit('pair');
        showTip(jitterTip(state, d), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); hideTip(); })
      .on('click', function (e, d) {
        VML.app.toggleSource(d.src, !state.sources.has(d.src));
      });

    var mx = d3.mean(arcs, jitterOf);
    var my = d3.mean(arcs, latencyOf);
    var num = 0, den = 0;
    arcs.forEach(function (d) {
      var xv = jitterOf(d), yv = latencyOf(d);
      num += (xv - mx) * (yv - my);
      den += (xv - mx) * (xv - mx);
    });
    var slope = den ? num / den : null;
    var fitLine = jitterSvg.selectAll('line.fit').data([1]);
    if (slope !== null) {
      fitLine.join('line')
        .attr('class', 'fit')
        .attr('x1', padL)
        .attr('y1', y(my - slope * mx))
        .attr('x2', w - padR)
        .attr('y2', y(my - slope * mx + slope * xMax));
    } else {
      fitLine.remove();
    }

    var xAxis = jitterSvg.selectAll('g.x-axis').data([1]);
    xAxis.join('g')
      .attr('class', 'axis x-axis')
      .attr('transform', 'translate(0,' + (padT + innerH) + ')')
      .call(d3.axisBottom(x).ticks(6));

    var yAxis = jitterSvg.selectAll('g.y-axis').data([1]);
    yAxis.join('g')
      .attr('class', 'axis y-axis')
      .attr('transform', 'translate(' + padL + ',0)')
      .call(d3.axisLeft(y).ticks(5));

    var xLabel = jitterSvg.selectAll('text.x-label').data([1]);
    xLabel.join('text')
      .attr('class', 'axis-label')
      .attr('x', padL + innerW / 2)
      .attr('y', h - 6)
      .attr('text-anchor', 'middle')
      .text('jitter (ms)');

    var yLabel = jitterSvg.selectAll('text.y-label').data([1]);
    yLabel.join('text')
      .attr('class', 'axis-label')
      .attr('transform', 'translate(12,' + (padT + innerH / 2) + ') rotate(-90)')
      .attr('text-anchor', 'middle')
      .text('latency (ms)');

    renderPairGrid(jitterSvg, jitterLayout, jitterPairPos);
  }

  function showTip(html, e) { VML.tooltip.show(html, e.clientX, e.clientY); }
  function moveTip(e) { VML.tooltip.move(e.clientX, e.clientY); }
  function hideTip() { VML.tooltip.hide(); }

  c.render = function () {
    renderHeatmap();
    renderBars();
    renderScatter();
    renderJitterScatter();
  };
  c.pair = function () {
    var state = VML.state;
    barSvg.selectAll('g.bar').classed('pair', function (d) {
      return state.pair && state.pair.dst === d.dst;
    });
    scatterSvg.selectAll('circle.dot').classed('pair', function (d) {
      return state.pair && state.pair.src === d.src && state.pair.dst === d.dst;
    });
    jitterSvg.selectAll('circle.dot').classed('pair', function (d) {
      return state.pair && state.pair.src === d.src && state.pair.dst === d.dst;
    });
    var hlData = state.pair && heatLayout &&
      heatLayout.srcIdx.has(state.pair.src) && heatLayout.dstIdx.has(state.pair.dst)
      ? [state.pair] : [];
    var hl = heatSvg.selectAll('rect.pair-hl').data(hlData, function (d) { return d.src + ':' + d.dst; });
    hl.join('rect')
      .attr('class', 'pair-hl')
      .attr('x', function (d) { return heatLayout.padL + heatLayout.dstIdx.get(d.dst) * heatLayout.cell + 1; })
      .attr('y', function (d) { return heatLayout.padT + heatLayout.srcIdx.get(d.src) * heatLayout.cell + 1; })
      .attr('width', heatLayout.cell - 2)
      .attr('height', heatLayout.cell - 2);
    renderPairGrid(scatterSvg, scatterLayout, scatterPairPos);
    renderPairGrid(jitterSvg, jitterLayout, jitterPairPos);
  };
  c.init = init;

  VML.charts = c;
})();
