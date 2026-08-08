(function () {
  var VML = window.VML = window.VML || {};
  var c = {};

  function valueAt(state, src, dst) {
    return state.data.matrices[state.metric].values[state.idx.get(src)][state.idx.get(dst)];
  }
  function nameOf(state, code) { return state.byCode.get(code).name; }

  var heatSvg, barSvg, scatterSvg;
  var heatLayout = null;

  function init() {
    heatSvg = d3.select('#heatmap').append('svg');
    barSvg = d3.select('#bars').append('svg');
    scatterSvg = d3.select('#scatter').append('svg');
  }

  function maxNameLen(state) {
    return state.data.matrices[state.metric].order.reduce(function (mx, c) {
      return Math.max(mx, nameOf(state, c).length);
    }, 0);
  }

  function renderHeatmap() {
    var state = VML.state;
    var order = state.data.matrices[state.metric].order;
    var n = order.length;
    var maxPx = maxNameLen(state) * 5.5;
    var padL = Math.max(60, maxPx + 22);
    var padT = Math.max(60, maxPx * 0.71 + 20);
    var cell = 13;
    var w = padL + n * cell, h = padT + n * cell;
    heatLayout = { padL: padL, padT: padT, cell: cell };
    heatSvg
      .attr('width', w)
      .attr('height', h)
      .attr('viewBox', '0 0 ' + w + ' ' + h);

    var xLabels = heatSvg.selectAll('text.col').data(order, function (d) { return d; });
    xLabels.join('text')
      .attr('class', 'axis-label col')
      .attr('transform', function (d, i) {
        return 'translate(' + (padL + i * cell + cell / 2) + ',' + (padT - 6) + ') rotate(-45)';
      })
      .attr('text-anchor', 'start')
      .text(function (d) { return nameOf(state, d); });

    var yLabels = heatSvg.selectAll('text.row').data(order, function (d) { return d; });
    yLabels.join('text')
      .attr('class', function (d) { return 'axis-label row' + (state.sources.has(d) ? '' : ' off'); })
      .attr('transform', function (d, i) { return 'translate(' + (padL - 6) + ',' + (padT + i * cell + cell / 2) + ')'; })
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return nameOf(state, d); });

    var rows = heatSvg.selectAll('g.heat-row').data(order, function (d) { return d; });
    var rowEnters = rows.join('g')
      .attr('class', 'heat-row')
      .attr('transform', function (d, i) { return 'translate(' + padL + ',' + (padT + i * cell) + ')'; });

    rowEnters.selectAll('rect.cell').data(order, function (d) { return d; })
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
    var items = [];
    order.forEach(function (dst) {
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
      var empty = barSvg.selectAll('text.empty').data([1]);
      empty.join('text')
        .attr('class', 'empty')
        .attr('x', padL)
        .attr('y', padT + 14)
        .text('check at least one source above');
      return;
    }
    barSvg.selectAll('text.empty').remove();

    var bars = barSvg.selectAll('g.bar').data(items, function (d) { return d.dst; });
    var enter = bars.join('g')
      .attr('class', function (d) {
        return 'bar' + (state.pair && state.pair.dst === d.dst ? ' pair' : '');
      })
      .attr('transform', function (d, i) { return 'translate(0,' + (padT + i * (barH + gap)) + ')'; })
      .style('cursor', 'pointer');

    enter.append('text')
      .attr('class', 'bar-code')
      .attr('x', padL - 6)
      .attr('y', barH / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return nameOf(state, d.dst); });

    enter.append('rect')
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

    enter.append('text')
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

  function renderScatter() {
    var state = VML.state;
    var w = Math.max(300, (scatterSvg.node().parentElement.clientWidth || 360));
    var h = 260, padL = 44, padR = 14, padT = 10, padB = 30;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var x = d3.scaleLinear().domain([0, state.distanceMax]).range([padL, w - padR]);
    var y = d3.scaleLinear().domain([0, state.metricMax]).range([padT + innerH, padT]);
    scatterSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    var dots = scatterSvg.selectAll('circle.dot').data(state.arcs.filter(function (d) { return state.sources.has(d.src); }), function (d) { return d.src + ':' + d.dst; });
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
        .attr('y2', y(state.fit.intercept + state.fit.slope * state.distanceMax));
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
  }

  function showTip(html, e) { VML.tooltip.show(html, e.clientX, e.clientY); }
  function moveTip(e) { VML.tooltip.move(e.clientX, e.clientY); }
  function hideTip() { VML.tooltip.hide(); }

  c.render = function () {
    renderHeatmap();
    renderBars();
    renderScatter();
  };
  c.pair = function () {
    var state = VML.state;
    barSvg.selectAll('g.bar').classed('pair', function (d) {
      return state.pair && state.pair.dst === d.dst;
    });
    scatterSvg.selectAll('circle.dot').classed('pair', function (d) {
      return state.pair && state.pair.src === d.src && state.pair.dst === d.dst;
    });
    var hlData = state.pair && heatLayout ? [state.pair] : [];
    var hl = heatSvg.selectAll('rect.pair-hl').data(hlData, function (d) { return d.src + ':' + d.dst; });
    hl.join('rect')
      .attr('class', 'pair-hl')
      .attr('x', function (d) { return heatLayout.padL + state.idx.get(d.dst) * heatLayout.cell + 1; })
      .attr('y', function (d) { return heatLayout.padT + state.idx.get(d.src) * heatLayout.cell + 1; })
      .attr('width', heatLayout.cell - 2)
      .attr('height', heatLayout.cell - 2);
  };
  c.init = init;

  VML.charts = c;
})();
