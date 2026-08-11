(function () {
  var VML = window.VML = window.VML || {};
  var c = {};

  function nameOf(state, code) { return state.byCode.get(code).name; }

  function valueAt(state, src, dst, metric) {
    return state.data.matrices[metric || state.metric].values[state.idx.get(src)][state.idx.get(dst)];
  }

  function inRange(state, v) {
    return v != null && !isNaN(v) && v >= state.thresholdMin && v <= state.threshold;
  }

  function matrixLive(state, srcRows, dsts) {
    var liveRows = new Set();
    var liveDsts = new Set();
    srcRows.forEach(function (src) {
      dsts.forEach(function (dst) {
        if (src !== dst && inRange(state, valueAt(state, src, dst))) {
          liveRows.add(src);
          liveDsts.add(dst);
        }
      });
    });
    return {
      rows: srcRows.filter(function (c) { return liveRows.has(c); }),
      dsts: dsts.filter(function (c) { return liveDsts.has(c); })
    };
  }

  var heatSvg, boxSvg, scatterSvg;
  var heatLayout = null;
  var scatterLayout = null;
  var lastMatrixW = 0;

  function init() {
    heatSvg = d3.select('#heatmap').append('svg');
    boxSvg = d3.select('#boxes').append('svg');
    scatterSvg = d3.select('#scatter').append('svg');
    scatterSvg.append('g').attr('class', 'grid');
    boxSvg.append('g').attr('class', 'grid');
    // the pane's width change is animated (0.35s), so charts rendered at the
    // moment the pane was re-pinned would measure a mid-transition width:
    // re-render once the pane settles at its final size
    var pane = document.getElementById('side-pane');
    if (pane && typeof ResizeObserver !== 'undefined') {
      var paneTimer = null;
      new ResizeObserver(function () {
        clearTimeout(paneTimer);
        paneTimer = setTimeout(function () { VML.events.emit('render'); }, 120);
      }).observe(pane);
    }
    // when the viewport crosses the pane's width cap (window resize), the
    // pane must be re-pinned so the matrix keeps fitting its frame; if the
    // pin actually changes, the observer above turns it into a re-render
    window.addEventListener('resize', function () {
      if (lastMatrixW > 0 &&
          !document.body.classList.contains('chart-expanded') &&
          !document.body.classList.contains('panel-hidden')) {
        fitPaneToMatrix(lastMatrixW);
      }
    });
    document.addEventListener('click', function () {
      VML.tooltip.hide();
    });
    document.addEventListener('mousemove', function (e) {
      var el = VML.tooltip.el;
      if (parseFloat(el.style.opacity || 0) < 0.5) return;
      var r = el.getBoundingClientRect();
      var m = 24;
      if (e.clientX < r.left - m || e.clientX > r.right + m ||
          e.clientY < r.top - m || e.clientY > r.bottom + m) {
        VML.tooltip.hide();
      }
    });
  }

  function maxNameLen(state) {
    return state.data.matrices[state.metric].order.reduce(function (mx, code) {
      return Math.max(mx, nameOf(state, code).length);
    }, 0);
  }

  // the pane's content width minus the matrix frame's content width: the
  // pane's padding/border plus the card's padding/border. It is constant, so
  // it can be measured at any pane width.
  function paneChrome() {
    var pane = document.getElementById('side-pane');
    var heat = document.getElementById('heatmap');
    return pane && heat ? pane.clientWidth - heat.clientWidth : 0;
  }

  // RULE: there must NEVER be a vertical or horizontal scroll bar within the
  // pair matrix frame (#heatmap). The right pane's width follows the matrix
  // grid: this pins #side-pane to the matrix's intrinsic width (at the
  // label-safe cell pitch) plus the pane/card chrome, so the matrix always
  // fits its frame at 1:1. The pin is capped at the viewport — on narrower
  // screens the cells shrink (renderHeatmap) instead; the frame itself never
  // scrolls, and the page never scrolls sideways.
  function fitPaneToMatrix(w) {
    lastMatrixW = w;
    var pane = document.getElementById('side-pane');
    if (!pane) return;
    if (document.body.classList.contains('chart-expanded')) return;
    if (document.body.classList.contains('panel-hidden')) {
      // collapsed: drop the inline width so the CSS width:0 rule can apply
      pane.style.width = '';
      return;
    }
    var target = Math.min(w + paneChrome(), window.innerWidth - 24);
    var px = Math.max(0, Math.round(target)) + 'px';
    if (pane.style.width !== px) pane.style.width = px;
  }

  // the matrix frame's available width: the pane's pinned (or current) width
  // minus the pane/card chrome
  function paneContentWidth() {
    var pane = document.getElementById('side-pane');
    var heat = document.getElementById('heatmap');
    if (!pane || !heat) return 0;
    var inline = parseFloat(pane.style.width);
    var paneW = inline > 0 ? inline : pane.clientWidth;
    return paneW - paneChrome();
  }

  function renderHeatmap() {
    var state = VML.state;
    var order = state.data.matrices[state.metric].order;
    var srcRows = state.destMode === 'checked'
      ? order.filter(function (c) { return state.sources.has(c); })
      : order;
    var dsts = order.filter(function (c) { return VML.util.destSet(state).has(c); });
    var live = matrixLive(state, srcRows, dsts);
    srcRows = live.rows;
    dsts = live.dsts;
    var n = srcRows.length;
    var nCols = dsts.length;
    var maxPx = maxNameLen(state) * 5.5;
    // round every layout coordinate to a whole pixel: the cell strokes are
    // 0.5px wide, so any fractional position (padT comes out to e.g. 114.4 at
    // maxPx = 77) rasterizes with uneven anti-aliasing — some grid lines
    // render a pixel thick, others two, and the cells look misaligned
    var padL = Math.round(Math.max(60, maxPx + 22));
    var padT = Math.round(Math.max(76, maxPx * 1.2 + 22));
    var padR = Math.round(Math.max(40, maxPx * 0.71 + 20));
    // the cell pitch must keep the axis labels apart: the row labels are
    // 12.6px text on that same pitch, and the rotated column labels sit on a
    // perpendicular pitch of cell * sin(45deg), so cells smaller than ~20px
    // make the horizontal and vertical labels cover each other. In card mode
    // the pane's width follows the matrix (fitPaneToMatrix), so the matrix
    // renders 1:1 at this pitch and the frame never scrolls; in full-page
    // mode the cells grow/shrink to fit the viewport instead, like the
    // other charts
    var minCell = state.expanded === 'heatmap' ? 10 : 20;
    var cell = minCell;
    if (nCols > 0) {
      if (state.expanded !== 'heatmap') {
        fitPaneToMatrix(padL + nCols * minCell + padR);
      }
      // fill the space the pane now provides: the pinned pane width minus
      // the pane/card chrome. When the pane hit the viewport cap the cells
      // shrink below the label-safe pitch rather than the frame scrolling
      // (the frame must NEVER scroll — see fitPaneToMatrix)
      var target = paneContentWidth();
      if (target > 0) {
        var fillW = Math.floor((target - padL - padR) / nCols);
        var fillH = state.expanded === 'heatmap'
          ? Math.floor((target - padT) / Math.max(1, n))
          : Infinity;
        cell = Math.max(state.expanded === 'heatmap' ? minCell : 1,
          Math.min(state.expanded === 'heatmap' ? 40 : minCell, fillW, fillH));
      }
    }
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
        if (src !== d && !inRange(state, valueAt(state, src, d))) cls += ' cut';
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
    var loss = state.data.matrices.loss.values[state.idx.get(src)][state.idx.get(dst)];
    return '<b>' + nameOf(state, src) + ' → ' + nameOf(state, dst) + '</b> (' + src + ' → ' + dst + ')<br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + jit + '</b> ms · loss <b>' + loss + '</b> %<br>' +
      '<i>click to toggle source</i>';
  }

  function barTip(state, d, footer) {
    var unit = VML.config.metrics[state.metric].unit;
    var fmt = function (v) {
      var dec = VML.config.metrics[state.metric].decimals;
      return dec === 0 ? v.toFixed(0) : v.toFixed(dec);
    };
    var lines = state.data.matrices[state.metric].order
      .filter(function (s) {
        return state.sources.has(s) && s !== d.dst && inRange(state, valueAt(state, s, d.dst));
      })
      .map(function (s) {
        return { v: valueAt(state, s, d.dst), text: nameOf(state, s) + ' → ' + nameOf(state, d.dst) };
      })
      .sort(function (a, b) { return a.v - b.v; })
      .map(function (p) {
        return p.text + ': <b>' + fmt(p.v) + '</b> ' + unit;
      });
    return '<b>' + nameOf(state, d.dst) + '</b> — mean ' + fmt(d.v) + ' ' + unit + '<br>' +
      'min <b>' + fmt(d.min) + '</b> · max <b>' + fmt(d.max) + '</b> · range <b>' + fmt(d.range) + '</b> ' + unit + '<br>' +
      lines.join('<br>') + '<br><i>' + (footer || 'click to toggle source') + '</i>';
  }

  function geoRankMap(state) {
    var configConts = VML.config.continents;
    var extras = [];
    state.data.matrices.latency.order.forEach(function (code) {
      var cont = state.byCode.get(code).continent || 'Unknown';
      if (configConts.indexOf(cont) === -1 && extras.indexOf(cont) === -1) extras.push(cont);
    });
    extras.sort();
    var contOrder = configConts.concat(extras);
    return new Map(contOrder.map(function (c, i) { return [c, i]; }));
  }

  function geoCompare(state) {
    var rank = geoRankMap(state);
    return function (a, b) {
      var ac = state.byCode.get(a.dst).continent || 'Unknown';
      var bc = state.byCode.get(b.dst).continent || 'Unknown';
      if (ac !== bc) return rank.get(ac) - rank.get(bc);
      return nameOf(state, a.dst).localeCompare(nameOf(state, b.dst));
    };
  }

  function renderBoxes() {
    var state = VML.state;
    var order = state.data.matrices[state.metric].order;
    var srcs = order.filter(function (c) { return state.sources.has(c); });
    var dsts = order.filter(function (c) { return VML.util.destSet(state).has(c); });
    var items = [];
    dsts.forEach(function (dst) {
      var vs = srcs.filter(function (s) { return s !== dst; })
        .map(function (s) { return valueAt(state, s, dst); })
        .filter(function (v) { return inRange(state, v); });
      if (!vs.length) return;
      vs.sort(function (a, b) { return a - b; });
      items.push({
        dst: dst,
        min: vs[0],
        q1: d3.quantile(vs, 0.25),
        med: d3.quantile(vs, 0.5),
        q3: d3.quantile(vs, 0.75),
        max: vs[vs.length - 1],
        mean: d3.mean(vs),
        n: vs.length,
        range: vs[vs.length - 1] - vs[0]
      });
    });
    if (state.boxSort === 'geo') {
      items.sort(geoCompare(state));
    } else if (state.boxSort === 'alpha') {
      items.sort(function (a, b) { return nameOf(state, a.dst).localeCompare(nameOf(state, b.dst)); });
    } else {
      var sortKey = state.boxSort || 'med';
      items.sort(function (a, b) { return a[sortKey] - b[sortKey]; });
    }
    if (state.boxSortDir === 'desc') items.reverse();

    var titleEl = document.getElementById('boxes-title');
    if (titleEl) titleEl.textContent = srcs.length
      ? '· distribution across ' + srcs.length + ' checked source' + (srcs.length === 1 ? '' : 's')
      : '';

    var rowH = 30, gap = 2;
    var maxPx = maxNameLen(state) * 5.5;
    var padL = Math.max(40, maxPx + 14), padR = 52, padT = 0, padB = 52;
    var w = Math.max(300, (boxSvg.node().parentElement.clientWidth || 360));

    var xDomain;
    if (items.length) {
      var lo = d3.min(items, function (d) { return d.min; });
      var hi = d3.max(items, function (d) { return Math.max(d.max, d.mean); });
      xDomain = paddedDomain(lo, hi);
    } else {
      xDomain = [state.thresholdMin, Math.max(state.threshold, state.thresholdMin + 0.0001)];
    }

    // a single column of rows spanning the whole chart width; expanding the
    // chart simply widens it to the viewport, keeping the one-column layout
    var colGap = 0;
    var nCols = 1;
    var colW = w - padL - padR;
    var colX0 = function (i) { return padL + i * (colW + colGap); };
    var colScale = function (i) {
      return d3.scaleLinear().domain(xDomain).range([colX0(i), colX0(i) + colW]);
    };
    items.forEach(function (d, i) { d._col = i % nCols; d._row = Math.floor(i / nCols); });

    var nRows = Math.max(Math.ceil(items.length / nCols), 1);
    var plotBottom = padT + nRows * (rowH + gap) - gap;
    var h = plotBottom + padB;
    boxSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    var ticks = gridTicks(colScale(0), 6, 4);
    var minorData = [], majorData = [];
    var minorVs = ticks.minor.filter(function (v) { return v >= xDomain[0] && v <= xDomain[1]; });
    var majorVs = ticks.major.filter(function (v) { return v >= xDomain[0] && v <= xDomain[1]; });
    for (var ci = 0; ci < nCols; ci++) {
      minorVs.forEach(function (v) { minorData.push({ v: v, i: ci }); });
      majorVs.forEach(function (v) { majorData.push({ v: v, i: ci }); });
    }
    var grid = boxSvg.select('g.grid');
    grid.selectAll('line.box-grid.minor')
      .data(minorData, function (d) { return d.i + ':' + d.v; })
      .join('line')
      .attr('class', 'box-grid minor')
      .attr('x1', function (d) { return colScale(d.i)(d.v); })
      .attr('x2', function (d) { return colScale(d.i)(d.v); })
      .attr('y1', padT)
      .attr('y2', plotBottom);
    grid.selectAll('line.box-grid.major')
      .data(majorData, function (d) { return d.i + ':' + d.v; })
      .join('line')
      .attr('class', 'box-grid major')
      .attr('x1', function (d) { return colScale(d.i)(d.v); })
      .attr('x2', function (d) { return colScale(d.i)(d.v); })
      .attr('y1', padT)
      .attr('y2', plotBottom);
    var colScales = [];
    for (var ci = 0; ci < nCols; ci++) colScales.push(colScale(ci));
    boxSvg.selectAll('g.box-axis')
      .data(colScales)
      .join('g')
      .attr('class', 'axis box-axis')
      .attr('transform', 'translate(0,' + plotBottom + ')')
      .each(function (s) {
        d3.select(this).call(d3.axisBottom(s).ticks(6).tickFormat(metricTickFormat(state.metric)));
      });
    var metric = VML.config.metrics[state.metric];
    boxSvg.selectAll('text.box-x-label')
      .data([1])
      .join('text')
      .attr('class', 'axis-label box-x-label')
      .attr('x', padL + (w - padL - padR) / 2)
      .attr('y', h - 12)
      .attr('text-anchor', 'middle')
      .text(metric.label.toLowerCase() + ' (' + metric.unit + ')');

    if (!items.length) {
      boxSvg.selectAll('g.box').remove();
      var empty = boxSvg.selectAll('text.empty').data([1]);
      empty.join('text')
        .attr('class', 'empty')
        .attr('x', padL)
        .attr('y', padT + 14)
        .text(srcs.length ? 'No data in range' : 'No sources selected');
      return;
    }
    boxSvg.selectAll('text.empty').remove();

    var labLeft = function (d) { return nCols === 1 ? padL : colX0(d._col) + 4; };
    var labRight = function (d) { return nCols === 1 ? w - padR : colX0(d._col) + colW - 4; };

    var g = boxSvg.selectAll('g.box')
      .data(items, function (d) { return d.dst; })
      .join('g')
      .attr('class', function (d) {
        return 'box' + (state.pair && state.pair.dst === d.dst ? ' pair' : '');
      })
      .attr('transform', function (d) { return 'translate(0,' + (padT + d._row * (rowH + gap)) + ')'; })
      .style('cursor', 'pointer')
      .on('click', function (e, d) {
        e.stopPropagation();
        showTip(barTip(state, { dst: d.dst, v: d.mean, min: d.min, max: d.max, range: d.range }, 'move cursor away to dismiss'), e);
      });

    g.selectAll('rect.box-hit')
      .data(function (d) { return [d]; })
      .join('rect')
      .attr('class', 'box-hit')
      .attr('x', function (d) { return nCols === 1 ? 0 : colX0(d._col) - maxPx - 10; })
      .attr('y', -2)
      .attr('width', function (d) { return nCols === 1 ? w : colW + maxPx + 10; })
      .attr('height', rowH + 4)
      .on('mouseenter', function (e, d) {
        var src = srcs.find(function (s) { return s !== d.dst; });
        state.pair = src ? { src: src, dst: d.dst } : { dst: d.dst };
        VML.events.emit('pair');
      })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); });

    g.selectAll('text.box-code')
      .data(function (d) { return [d]; })
      .join('text')
      .attr('class', 'box-code')
      .attr('x', function (d) { return colX0(d._col) - 6; })
      .attr('y', rowH / 2)
      .attr('text-anchor', 'end')
      .attr('dominant-baseline', 'middle')
      .text(function (d) { return nameOf(state, d.dst); });

    g.selectAll('rect.box-rect')
      .data(function (d) { return [d]; })
      .join('rect')
      .attr('class', 'box-rect')
      .attr('x', function (d) { return colScale(d._col)(d.q1); })
      .attr('y', rowH / 2 - 7)
      .attr('width', function (d) { return Math.max(2, colScale(d._col)(d.q3) - colScale(d._col)(d.q1)); })
      .attr('height', 14)
      .attr('fill', function (d) { return state.colorScale(d.med); });

    g.selectAll('line.box-whisker')
      .data(function (d) { return [d]; })
      .join('line')
      .attr('class', 'box-whisker')
      .attr('x1', function (d) { return colScale(d._col)(d.min); })
      .attr('x2', function (d) { return colScale(d._col)(d.max); })
      .attr('y1', rowH / 2)
      .attr('y2', rowH / 2);

    g.selectAll('line.box-cap')
      .data(function (d) { return [colScale(d._col)(d.min), colScale(d._col)(d.max)]; })
      .join('line')
      .attr('class', 'box-cap')
      .attr('x1', function (v) { return v; })
      .attr('x2', function (v) { return v; })
      .attr('y1', rowH / 2 - 3)
      .attr('y2', rowH / 2 + 3);

    g.selectAll('line.box-med')
      .data(function (d) { return [d]; })
      .join('line')
      .attr('class', 'box-med')
      .attr('x1', function (d) { return colScale(d._col)(d.med); })
      .attr('x2', function (d) { return colScale(d._col)(d.med); })
      .attr('y1', rowH / 2 - 7)
      .attr('y2', rowH / 2 + 7);

    g.selectAll('circle.box-mean')
      .data(function (d) { return [d]; })
      .join('circle')
      .attr('class', 'box-mean')
      .attr('cx', function (d) { return colScale(d._col)(d.mean); })
      .attr('cy', rowH / 2)
      .attr('r', 2.2);

    g.selectAll('g.box-lab')
      .data(function (d) { return boxLabels(state, d, labLeft(d), labRight(d), d._row, rowH); }, function (d) { return d.t; })
      .join('g')
      .attr('class', function (d, i) { return 'box-lab' + (i % 2 ? ' alt' : ''); })
      .each(function (d) {
        var g = d3.select(this);
        g.selectAll('rect').data([d]).join('rect')
          .attr('x', function (d) { return d.left - 2; })
          .attr('y', function (d) { return d.y - 7; })
          .attr('width', function (d) { return d.w + 4; })
          .attr('height', 14)
          .attr('rx', 3);
        g.selectAll('text').data([d]).join('text')
          .attr('x', function (d) { return d.left + d.w / 2; })
          .attr('y', function (d) { return d.y; })
          .attr('text-anchor', 'middle')
          .attr('dominant-baseline', 'middle')
          .style('font-size', function (d) { return (d.fs || 13) + 'px'; })
          .text(function (d) { return d.text; });
      });
  }

  function boxLabels(state, d, left0, right, rowIndex, rowH) {
    var fmt = function (v) {
      var dec = VML.config.metrics[state.metric].decimals;
      return dec === 0 ? v.toFixed(0) : v.toFixed(dec);
    };
    var entries = [
      { t: 'min', v: d.min },
      { t: 'Q1', v: d.q1 },
      { t: 'med', v: d.med },
      { t: 'mean', v: d.mean },
      { t: 'Q3', v: d.q3 },
      { t: 'max', v: d.max },
      { t: 'range', v: d.range }
    ];

    var gap = 3;
    // the first row sits at the very top of the chart (no padT), so its
    // statistics are drawn BELOW its box (in the gap before the next row)
    // instead of above; the first row changes whenever the data is sorted
    // or filtered, so this must be decided per row at render time
    var labelY = rowIndex === 0 ? rowH - 1 : -7.5;
    var baseFs = 13;
    var minFs = 5;
    var charW = 0.54;
    var padW = 4;
    var n = entries.length;
    var lens = entries.map(function (it) { return (it.t + ' ' + fmt(it.v)).length; });
    var sumLen = lens.reduce(function (s, l) { return s + l; }, 0);
    var total = function (fs) {
      return sumLen * charW * fs + padW * n + gap * (n - 1);
    };
    var fs = baseFs;
    if (total(fs) > right - left0) {
      fs = Math.max(minFs, (right - left0 - padW * n - gap * (n - 1)) / (sumLen * charW));
    }

    var left = left0;
    return entries.map(function (it) {
      var text = it.t + ' ' + fmt(it.v);
      it.text = text;
      it.w = text.length * charW * fs + padW;
      it.left = left;
      it.y = labelY;
      it.fs = fs;
      left += it.w + gap;
      return it;
    });
  }

  function metricColorScale(state, metric) {
    var values = state.data.matrices[metric].values.flat().filter(function (v) { return v > 0; });
    var max = d3.quantile(values, VML.config.defaults.thresholdFactor) || d3.max(values) || 1;
    return d3.scaleSequential(d3.interpolateRgbBasis(d3.schemeRdYlGn[11].slice().reverse())).domain([0, max]);
  }

  function paddedDomain(min, max) {
    if (min === undefined) return [0, 1];
    var pad = min === max
      ? (min === 0 ? 1 : Math.abs(min) * 0.1)
      : (max - min) * 0.05;
    return [Math.max(0, min - pad), max + pad];
  }

  function metricTickFormat(metric) {
    var dec = VML.config.metrics[metric].decimals;
    return function (d) { return dec === 0 ? d.toFixed(0) : d.toFixed(dec); };
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

  function pairPos(p) {
    return {
      x: scatterLayout.x(valueAt(VML.state, p.src, p.dst, VML.state.graphX)),
      y: scatterLayout.y(valueAt(VML.state, p.src, p.dst, VML.state.graphY))
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

  function tip(state, d, xMetric, yMetric) {
    var lat = valueAt(state, d.src, d.dst, 'latency');
    var jit = valueAt(state, d.src, d.dst, 'jitter');
    var loss = valueAt(state, d.src, d.dst, 'loss');
    return '<b>' + nameOf(state, d.src) + ' → ' + nameOf(state, d.dst) + '</b> (' + d.src + ' → ' + d.dst + ')<br>' +
      xMetric + ' <b>' + valueAt(state, d.src, d.dst, xMetric) + '</b> · ' +
      yMetric + ' <b>' + valueAt(state, d.src, d.dst, yMetric) + '</b><br>' +
      'latency <b>' + lat + '</b> ms · jitter <b>' + jit + '</b> ms · loss <b>' + loss + '</b> %<br>' +
      '<i>latency = round-trip time · jitter = variation in latency · loss = % packets lost</i><br>' +
      '<i>click to toggle source</i>';
  }

  // builds the axis generator for the scatter chart. When expanded, a tick is
  // placed on every minor grid line too (not just the majors), with minor
  // ticks dimmed so the hierarchy stays readable; the values are taken from
  // the same gridTicks call that draws the grid so labels and lines always
  // align.
  function buildAxis(axis, scale, n, metric) {
    var fmt = metricTickFormat(metric);
    return function (sel) {
      if (VML.state && VML.state.expanded === 'scatter') {
        var g = gridTicks(scale, n, 4);
        var minor = new Set(g.minor);
        sel.call(axis.tickValues(g.major.concat(g.minor)).tickFormat(fmt));
        sel.selectAll('g.tick').classed('tick-minor', function (d) { return minor.has(d); });
      } else {
        sel.call(axis.ticks(n).tickFormat(fmt));
      }
    };
  }

  function renderScatter() {
    var state = VML.state;
    var xMetric = state.graphX;
    var yMetric = state.graphY;
    var w = Math.max(300, (scatterSvg.node().parentElement.clientWidth || 360));
    // full-page mode: size the plot to the viewport's smallest dimension like
    // the other expanded charts (the sources panel flows above it as part of
    // the same page, so the plot no longer fills leftover card space)
    var h = 260;
    if (state.expanded === 'scatter') {
      h = Math.max(260, Math.min(window.innerWidth, window.innerHeight) - 40);
    }
    // padL reserves room for the rotated y-axis label (~58px) plus the tick
    // labels (~27px + d3's 9px text offset), so the label never sits on top
    // of the tick numbers
    var padL = 104, padR = 14, padT = 10, padB = 52;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var arcs = VML.util.activeArcs(state).filter(function (d) {
      return inRange(state, valueAt(state, d.src, d.dst));
    });
    var xOf = function (d) { return valueAt(state, d.src, d.dst, xMetric); };
    var yOf = function (d) { return valueAt(state, d.src, d.dst, yMetric); };
    var xValues = arcs.map(xOf);
    var yValues = arcs.map(yOf);
    var xd = paddedDomain(d3.min(xValues), d3.max(xValues));
    var yd = paddedDomain(d3.min(yValues), d3.max(yValues));
    var x = d3.scaleLinear().domain(xd).range([padL, w - padR]);
    var y = d3.scaleLinear().domain(yd).range([padT + innerH, padT]);
    var color = metricColorScale(state, yMetric);
    scatterLayout = { x: x, y: y, padL: padL, padR: padR, padT: padT, innerW: innerW, innerH: innerH };
    scatterSvg.attr('width', w).attr('height', h).attr('viewBox', '0 0 ' + w + ' ' + h);

    renderGrid(scatterLayout, scatterSvg);

    var dots = scatterSvg.selectAll('circle.dot').data(arcs, function (d) { return d.src + ':' + d.dst; });
    dots.join('circle')
      .attr('class', function (d) {
        var cls = 'dot';
        if (state.sources.has(d.src)) cls += ' src';
        if (state.pair && state.pair.src === d.src && state.pair.dst === d.dst) cls += ' pair';
        return cls;
      })
      .attr('cx', function (d) { return x(xOf(d)); })
      .attr('cy', function (d) { return y(yOf(d)); })
      .attr('r', function (d) { return state.sources.has(d.src) ? 3.2 : 2.2; })
      .attr('fill', function (d) { return color(yOf(d)); })
      .on('mouseenter', function (e, d) {
        state.pair = { src: d.src, dst: d.dst };
        VML.events.emit('pair');
        showTip(tip(state, d, xMetric, yMetric), e);
      })
      .on('mousemove', function (e) { moveTip(e); })
      .on('mouseleave', function () { state.pair = null; VML.events.emit('pair'); hideTip(); })
      .on('click', function (e, d) {
        VML.app.toggleSource(d.src, !state.sources.has(d.src));
      });

    var mx = d3.mean(arcs, xOf);
    var my = d3.mean(arcs, yOf);
    var num = 0, den = 0;
    arcs.forEach(function (d) {
      var xv = xOf(d), yv = yOf(d);
      num += (xv - mx) * (yv - my);
      den += (xv - mx) * (xv - mx);
    });
    var slope = den ? num / den : null;
    var fitLine = scatterSvg.selectAll('line.fit').data([1]);
    if (slope !== null) {
      fitLine.join('line')
        .attr('class', 'fit')
        .attr('x1', padL)
        .attr('y1', y(my + slope * (x.domain()[0] - mx)))
        .attr('x2', w - padR)
        .attr('y2', y(my + slope * (x.domain()[1] - mx)));
    } else {
      scatterSvg.selectAll('line.fit').remove();
    }

    var xAxis = scatterSvg.selectAll('g.x-axis').data([1]);
    xAxis.join('g')
      .attr('class', 'axis x-axis')
      .attr('transform', 'translate(0,' + (padT + innerH) + ')')
      .call(buildAxis(d3.axisBottom(x), x, 6, xMetric));

    var yAxis = scatterSvg.selectAll('g.y-axis').data([1]);
    yAxis.join('g')
      .attr('class', 'axis y-axis')
      .attr('transform', 'translate(' + padL + ',0)')
      .call(buildAxis(d3.axisLeft(y), y, 5, yMetric));

    var axY = padT + innerH;
    var xBreak = scatterSvg.selectAll('path.x-break').data(x.domain()[0] > 0 ? [1] : []);
    xBreak.join('path')
      .attr('class', 'break x-break')
      .attr('d', 'M ' + (padL + 3) + ' ' + (axY - 3) +
        ' L ' + (padL + 5) + ' ' + (axY + 3) +
        ' L ' + (padL + 7) + ' ' + (axY - 3) +
        ' L ' + (padL + 9) + ' ' + (axY + 3));

    var yBreak = scatterSvg.selectAll('path.y-break').data(y.domain()[0] > 0 ? [1] : []);
    yBreak.join('path')
      .attr('class', 'break y-break')
      .attr('d', 'M ' + (padL - 3) + ' ' + (axY - 2) +
        ' L ' + (padL + 3) + ' ' + (axY - 4) +
        ' L ' + (padL - 3) + ' ' + (axY - 6) +
        ' L ' + (padL + 3) + ' ' + (axY - 8));

    var xm = VML.config.metrics[xMetric];
    var ym = VML.config.metrics[yMetric];
    var xLabel = scatterSvg.selectAll('text.x-label').data([1]);
    xLabel.join('text')
      .attr('class', 'axis-label x-label')
      .attr('x', padL + innerW / 2)
      .attr('y', h - 12)
      .attr('text-anchor', 'middle')
      .text(xm.label.toLowerCase() + ' (' + xm.unit + ')');

    var yLabel = scatterSvg.selectAll('text.y-label').data([1]);
    yLabel.join('text')
      .attr('class', 'axis-label y-label')
      .attr('transform', 'translate(33,' + (padT + innerH / 2) + ') rotate(-90)')
      .attr('text-anchor', 'middle')
      .text(ym.label.toLowerCase() + ' (' + ym.unit + ')');

    var title = document.getElementById('scatter-title');
    if (title) title.textContent = ym.label + ' vs ' + xm.label;

    renderPairGrid(scatterSvg, scatterLayout, pairPos);
  }

  function showTip(html, e) { VML.tooltip.show(html, e.clientX, e.clientY); }
  function moveTip(e) { VML.tooltip.move(e.clientX, e.clientY); }
  function hideTip() { VML.tooltip.hide(); }

  c.render = function () {
    renderHeatmap();
    renderBoxes();
    renderScatter();
  };
  c.pair = function () {
    var state = VML.state;
    boxSvg.selectAll('g.box').classed('pair', function (d) {
      return state.pair && state.pair.dst === d.dst;
    });
    scatterSvg.selectAll('circle.dot').classed('pair', function (d) {
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
    renderPairGrid(scatterSvg, scatterLayout, pairPos);
  };
  c.init = init;

  VML.charts = c;
})();
