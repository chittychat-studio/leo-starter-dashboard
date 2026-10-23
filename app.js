/*
  app.js: Spreadsheet dashboard (Leo's starter).
  Reads a CSV in the browser, detects column types and builds KPI tiles,
  a time chart, a grouped bar chart and a sortable, searchable table.
  Nothing is sent anywhere: there are no network calls except loading the
  bundled sample file from this same folder.
  Original code, MIT licence (see LICENSE).
*/
(function () {
  "use strict";

  var Papa = window.Papa;
  var Chart = window.Chart;
  // All DOM motion lives in motion.js (Web Animations API, no library).
  var motion = window.LeoMotion || { on: function () { return false; }, count: function (a, b, u, done) { done(); return { stop: function () {} }; }, fadeIn: function () {}, rise: function () {}, entrance: function () {} };

  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var MAX_BYTES = 100 * 1024 * 1024; // 100 MB, larger files make the tab sluggish
  var TOP_GROUPS = 12;

  var state = null;          // the loaded dataset
  var charts = { line: null, bar: null };
  var view = { sortCol: -1, sortDir: 1, page: 0, pageSize: 25, search: "" };
  var lastKpis = {};         // previous KPI values, for count-ups
  var kpiTweens = {};

  /* ================= parsing helpers ================= */

  function parseNumber(raw) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (s === "") return NaN;
    var negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    s = s.replace(/[\s ]/g, "").replace(/^[$€£¥₹]|[$€£¥₹%]$/g, "");
    if (/^[+-]?[$€£¥₹]/.test(s)) s = s.replace(/[$€£¥₹]/, "");
    var hasDot = s.indexOf(".") !== -1;
    var hasComma = s.indexOf(",") !== -1;
    if (hasDot && hasComma) {
      // The separator that appears last is the decimal one.
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasComma) {
      if (/^[+-]?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
      else if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
      else return NaN;
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
    var n = parseFloat(s);
    return negative ? -n : n;
  }

  var ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?.*)?$/;
  var YMD_SLASH = /^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})$/;
  var XY_SLASH = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/;

  function validDay(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return NaN;
    var t = Date.UTC(y, m - 1, d);
    var check = new Date(t);
    return check.getUTCDate() === d ? t : NaN;
  }

  // dayFirst: true for d/m/y columns, false for m/d/y.
  function parseDate(raw, dayFirst) {
    if (raw == null) return NaN;
    var s = String(raw).trim();
    if (s === "") return NaN;
    var m = s.match(ISO_DATE) || s.match(YMD_SLASH);
    if (m) return validDay(+m[1], +m[2], +m[3]);
    m = s.match(XY_SLASH);
    if (m) {
      var y = +m[3]; if (y < 100) y += 2000;
      return dayFirst ? validDay(y, +m[2], +m[1]) : validDay(y, +m[1], +m[2]);
    }
    // Written dates such as "5 Jan 2025" or "January 5, 2025".
    if (/[a-z]/i.test(s) && /\d{4}/.test(s) && s.length < 40) {
      var t = Date.parse(s);
      if (!isNaN(t)) { var d = new Date(t); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
    }
    return NaN;
  }

  function detectColumn(name, values) {
    var nonEmpty = values.filter(function (v) { return v != null && String(v).trim() !== ""; });
    var n = nonEmpty.length;
    var col = { name: name, type: "text", dayFirst: false, distinct: 0 };
    var distinct = new Set(nonEmpty);
    col.distinct = distinct.size;
    if (n === 0) { col.type = "text"; return col; }

    var numOk = 0;
    nonEmpty.forEach(function (v) { if (!isNaN(parseNumber(v))) numOk++; });
    // Four digit years and ISO dates should not count as numbers.
    var looksLikeDate = nonEmpty.slice(0, 50).every(function (v) { return ISO_DATE.test(String(v).trim()) || YMD_SLASH.test(String(v).trim()) || XY_SLASH.test(String(v).trim()); });
    if (!looksLikeDate && numOk / n >= 0.95) { col.type = "number"; return col; }

    // Day first if any value has a first part above 12 (for example 25/03/2025).
    col.dayFirst = nonEmpty.some(function (v) {
      var m = String(v).trim().match(XY_SLASH);
      return m && +m[1] > 12;
    });
    var dateOk = 0;
    nonEmpty.forEach(function (v) { if (!isNaN(parseDate(v, col.dayFirst))) dateOk++; });
    if (dateOk / n >= 0.95) { col.type = "date"; return col; }

    col.type = (distinct.size <= 100 && distinct.size <= Math.max(20, n * 0.6)) ? "category" : "text";
    return col;
  }

  function cleanHeaders(fields) {
    var seen = {};
    return fields.map(function (f, i) {
      var name = String(f == null ? "" : f).replace(/^﻿/, "").trim() || "Column " + (i + 1);
      var base = name, k = 2;
      while (seen[name]) name = base + " (" + (k++) + ")";
      seen[name] = true;
      return name;
    });
  }

  function buildDataset(text, label) {
    if (!text || !text.trim()) throw new Error("That file is empty.");
    var result = Papa.parse(text, {
      header: false,
      skipEmptyLines: "greedy",
      delimitersToGuess: [",", ";", "\t", "|"]
    });
    var data = result.data;
    if (!data.length) throw new Error("No rows found. Check that the file is a CSV.");
    var headers = cleanHeaders(data[0]);
    var body = data.slice(1);
    if (!body.length) throw new Error("The file has a header row but no data rows.");

    var width = headers.length;
    var rows = body.map(function (r) {
      var out = new Array(width);
      for (var j = 0; j < width; j++) out[j] = r[j] == null ? "" : String(r[j]);
      return out;
    });
    var ragged = body.filter(function (r) { return r.length !== width; }).length;

    var columns = headers.map(function (h, j) {
      return detectColumn(h, rows.map(function (r) { return r[j]; }));
    });
    // Pre-parse numbers and dates once.
    columns.forEach(function (c, j) {
      if (c.type === "number") c.values = rows.map(function (r) { return parseNumber(r[j]); });
      if (c.type === "date") c.values = rows.map(function (r) { return parseDate(r[j], c.dayFirst); });
    });

    return {
      label: label,
      delimiter: result.meta.delimiter,
      columns: columns,
      rows: rows,
      ragged: ragged,
      byType: function (t) {
        var list = [];
        columns.forEach(function (c, j) { if (c.type === t) list.push(j); });
        return list;
      }
    };
  }

  /* ================= formatting ================= */

  var nf2 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  var nfCompact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  function fmt(n) {
    if (!isFinite(n)) return "-";
    return Math.abs(n) >= 1000 ? nf0.format(n) : nf2.format(n);
  }
  var monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  var dayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  function isoDay(t) { return new Date(t).toISOString().slice(0, 10); }

  var AGG_LABEL = { sum: "Sum", avg: "Average", count: "Count" };

  /* ================= colours from CSS tokens ================= */

  // Chart.js needs plain rgb colours, so convert the oklch tokens through a canvas.
  var colorCanvas = document.createElement("canvas");
  colorCanvas.width = colorCanvas.height = 1;
  var colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
  function toRgb(value, alpha) {
    colorCtx.clearRect(0, 0, 1, 1);
    colorCtx.fillStyle = "#000";
    colorCtx.fillStyle = value;
    colorCtx.fillRect(0, 0, 1, 1);
    var d = colorCtx.getImageData(0, 0, 1, 1).data;
    return "rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + (alpha == null ? 1 : alpha) + ")";
  }
  function palette() {
    var s = getComputedStyle(root);
    var v = function (name, a) { return toRgb(s.getPropertyValue(name).trim(), a); };
    return {
      ink: v("--ink"), muted: v("--muted"), line: v("--line"), panel: v("--panel"),
      accent: v("--accent"), accentFill: v("--accent", 0.14)
    };
  }

  /* ================= filtering and grouping ================= */

  function controls() {
    return {
      x: +$("x-col").value,
      y: $("y-col").value === "" ? -1 : +$("y-col").value,
      agg: $("agg").value,
      fCol: $("filter-col").value === "" ? -1 : +$("filter-col").value,
      fVal: $("filter-val").value,
      from: $("date-from").value ? Date.parse($("date-from").value + "T00:00:00Z") : -Infinity,
      to: $("date-to").value ? Date.parse($("date-to").value + "T00:00:00Z") : Infinity
    };
  }

  // Indexes of rows that pass the filter panel (not the table search).
  function filteredIndexes(c) {
    var out = [];
    var dateCol = state.dateCol;
    var dv = dateCol >= 0 ? state.columns[dateCol].values : null;
    for (var i = 0; i < state.rows.length; i++) {
      if (c.fCol >= 0 && c.fVal !== "" && state.rows[i][c.fCol] !== c.fVal) continue;
      if (dv && (c.from !== -Infinity || c.to !== Infinity)) {
        var t = dv[i];
        if (isNaN(t) || t < c.from || t > c.to) continue;
      }
      out.push(i);
    }
    return out;
  }

  function aggregate(values, agg) {
    if (agg === "count") return values.length;
    var nums = values.filter(function (v) { return isFinite(v); });
    if (!nums.length) return 0;
    var sum = nums.reduce(function (a, b) { return a + b; }, 0);
    return agg === "avg" ? sum / nums.length : sum;
  }

  function pickGranularity(min, max) {
    var days = (max - min) / 86400000;
    if (days > 180) return "month";
    if (days > 60) return "week";
    return "day";
  }
  function bucketOf(t, gran) {
    var d = new Date(t);
    if (gran === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    if (gran === "week") {
      var dow = (d.getUTCDay() + 6) % 7; // Monday start
      return t - dow * 86400000;
    }
    return t;
  }
  function bucketLabel(t, gran) {
    return gran === "month" ? monthFmt.format(t) : dayFmt.format(t);
  }

  function groupByDate(idx, dateCol, c, granOverride) {
    var dv = state.columns[dateCol].values;
    var yv = c.y >= 0 ? state.columns[c.y].values : null;
    var min = Infinity, max = -Infinity;
    idx.forEach(function (i) { var t = dv[i]; if (!isNaN(t)) { if (t < min) min = t; if (t > max) max = t; } });
    if (min === Infinity) return { labels: [], values: [], gran: "day" };
    var gran = granOverride || pickGranularity(min, max);
    var groups = new Map();
    idx.forEach(function (i) {
      var t = dv[i]; if (isNaN(t)) return;
      var b = bucketOf(t, gran);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(yv ? yv[i] : 1);
    });
    var keys = Array.from(groups.keys()).sort(function (a, b) { return a - b; });
    return {
      labels: keys.map(function (k) { return bucketLabel(k, gran); }),
      values: keys.map(function (k) { return aggregate(groups.get(k), c.agg); }),
      gran: gran
    };
  }

  function groupByCategory(idx, col, c) {
    var yv = c.y >= 0 ? state.columns[c.y].values : null;
    var groups = new Map();
    idx.forEach(function (i) {
      var key = state.rows[i][col].trim() || "(blank)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(yv ? yv[i] : 1);
    });
    var items = Array.from(groups.entries()).map(function (e) {
      return { label: e[0], value: aggregate(e[1], c.agg), raw: e[1] };
    }).sort(function (a, b) { return b.value - a.value; });
    if (items.length > TOP_GROUPS) {
      var rest = items.slice(TOP_GROUPS - 1);
      var restRaw = [].concat.apply([], rest.map(function (r) { return r.raw; }));
      items = items.slice(0, TOP_GROUPS - 1).concat([{ label: "Other (" + rest.length + ")", value: aggregate(restRaw, c.agg) }]);
    }
    return { labels: items.map(function (r) { return r.label; }), values: items.map(function (r) { return r.value; }) };
  }

  /* ================= motion helpers (motion.js) ================= */

  // Changes made from the keyboard apply instantly: no count-ups, no chart motion, no
  // cross-fade. Shortcuts are repeated many times a day and motion would make them feel slow.
  var quiet = false;
  function animate() { return motion.on() && !quiet; }
  function instantly(fn) { quiet = true; try { fn(); } finally { quiet = false; } }

  function countTo(node, key, to) {
    var from = lastKpis[key];
    lastKpis[key] = to;
    if (kpiTweens[key]) kpiTweens[key].stop();
    if (!isFinite(to)) { node.textContent = fmt(to); return; }
    if (quiet) { node.textContent = fmt(to); return; }
    kpiTweens[key] = motion.count(from == null || !isFinite(from) ? 0 : from, to,
      function (v) { node.textContent = fmt(v); },
      function () { node.textContent = fmt(to); });
  }

  /* Smooth swaps between chart groupings. The View Transitions API cross-fades
     the old chart into the new one where the browser supports it; elsewhere
     Chart.js's own bar growth is the only motion. Reduced motion: instant. */
  function withTransition(fn) {
    if (!document.startViewTransition || reduceMotion.matches) { fn(); return; }
    document.startViewTransition(fn);
  }

  /* ================= rendering ================= */

  function renderKpis(idx) {
    var list = $("kpis");
    var nums = state.byType("number").filter(function (j) {
      return !/(^|[\s_])(id|zip|postcode|phone|year)$/i.test(state.columns[j].name);
    }).slice(0, 3);
    var tiles = [{ key: "rows", label: "Rows", value: idx.length, sub: "of " + fmt(state.rows.length) + " in the file" }];
    nums.forEach(function (j) {
      var vals = idx.map(function (i) { return state.columns[j].values[i]; }).filter(isFinite);
      var sum = vals.reduce(function (a, b) { return a + b; }, 0);
      tiles.push({ key: "sum" + j, label: "Total " + state.columns[j].name, value: sum,
        sub: vals.length ? "Average " + fmt(sum / vals.length) + " per row" : "No rows to average" });
    });

    var fresh = list.children.length !== tiles.length;
    if (fresh) {
      list.textContent = "";
      lastKpis = {};
      tiles.forEach(function (t) {
        var li = document.createElement("li"); li.className = "kpi";
        var l = document.createElement("p"); l.className = "kpi-label"; l.textContent = t.label; l.title = t.label;
        var v = document.createElement("p"); v.className = "kpi-value";
        var s = document.createElement("p"); s.className = "kpi-sub";
        li.append(l, v, s);
        list.appendChild(li);
      });
    }
    tiles.forEach(function (t, k) {
      var li = list.children[k];
      li.querySelector(".kpi-label").textContent = t.label;
      li.querySelector(".kpi-sub").textContent = t.sub;
      countTo(li.querySelector(".kpi-value"), t.key, t.value);
    });
  }

  function chartOptions(p, horizontal) {
    var compact = function (v) { return nfCompact.format(v); };
    // The category axis keeps Chart.js's own label callback; only the value axis is compacted.
    var xTicks = { color: p.muted, maxRotation: 0, autoSkipPadding: 16 };
    var yTicks = { color: p.muted };
    if (horizontal) xTicks.callback = compact; else yTicks.callback = compact;
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reduceMotion.matches || quiet ? false : { duration: 400, easing: "easeOutQuart" },
      indexAxis: horizontal ? "y" : "x",
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: p.ink, titleColor: p.panel, bodyColor: p.panel,
          padding: 10, cornerRadius: 8, displayColors: false,
          callbacks: { label: function (ctx) { return fmt(horizontal ? ctx.parsed.x : ctx.parsed.y); } }
        }
      },
      scales: {
        x: {
          grid: { display: horizontal, color: p.line }, border: { color: p.line },
          ticks: xTicks
        },
        y: {
          grid: { display: !horizontal, color: p.line }, border: { display: false },
          beginAtZero: true,
          ticks: yTicks
        }
      }
    };
  }

  function upsertChart(key, canvas, config, fresh) {
    var existing = charts[key];
    if (existing && !fresh && existing.config.type === config.type) {
      existing.data.labels = config.data.labels;
      existing.data.datasets[0].data = config.data.datasets[0].data;
      Object.assign(existing.data.datasets[0], config.data.datasets[0], { data: existing.data.datasets[0].data });
      existing.options = config.options;
      existing.update();
      return existing;
    }
    if (existing) existing.destroy();
    charts[key] = new Chart(canvas, config);
    return charts[key];
  }

  var lastGrouping = "";
  function renderCharts(idx, c) {
    var p = palette();
    var grouping = c.x + "|" + c.y + "|" + c.agg;
    var regroup = grouping !== lastGrouping;
    lastGrouping = grouping;
    var measure = c.y >= 0 ? state.columns[c.y].name : "rows";
    var aggText = c.agg === "count" ? "Count of rows" : AGG_LABEL[c.agg] + " of " + measure;

    // Time chart
    var linePanel = $("line-panel");
    if (state.dateCol >= 0) {
      linePanel.hidden = false;
      var g = groupByDate(idx, state.dateCol, c);
      $("line-title").textContent = aggText + " by " + g.gran;
      var line = upsertChart("line", $("line-chart"), {
        type: "line",
        data: { labels: g.labels, datasets: [{
          data: g.values, borderColor: p.accent, backgroundColor: p.accentFill, fill: true,
          cubicInterpolationMode: "monotone", borderWidth: 2, pointRadius: g.values.length > 40 ? 0 : 3,
          pointHoverRadius: 5, pointBackgroundColor: p.accent
        }] },
        options: chartOptions(p, false)
      });
      describeChart(line.canvas, "Line chart of " + aggText.toLowerCase() + " by " + g.gran, g.labels, g.values);
    } else {
      linePanel.hidden = true;
    }

    // Grouped bar chart
    var xCol = state.columns[c.x];
    var grouped = xCol.type === "date" ? groupByDate(idx, c.x, c) : groupByCategory(idx, c.x, c);
    $("bar-title").textContent = aggText + " by " + xCol.name;
    var horizontal = xCol.type !== "date" && grouped.labels.length > 6;
    var bar = upsertChart("bar", $("bar-chart"), {
      type: "bar",
      data: { labels: grouped.labels, datasets: [{
        data: grouped.values,
        backgroundColor: p.accent, hoverBackgroundColor: p.ink,
        borderRadius: 4, maxBarThickness: 44
      }] },
      options: chartOptions(p, horizontal)
    }, regroup);
    describeChart(bar.canvas, "Bar chart of " + aggText.toLowerCase() + " by " + xCol.name, grouped.labels, grouped.values);
  }

  function describeChart(canvas, title, labels, values) {
    var empty = canvas.parentElement.querySelector(".chart-empty");
    if (empty) empty.hidden = values.length > 0;
    if (!values.length) { canvas.setAttribute("aria-label", title + ". No data."); return; }
    var max = 0;
    values.forEach(function (v, k) { if (v > values[max]) max = k; });
    canvas.setAttribute("aria-label", title + ". " + values.length + " points. Highest: " + labels[max] + ", " + fmt(values[max]) + ".");
  }

  /* ---------- table ---------- */

  function tableIndexes(idx) {
    var q = view.search.trim().toLowerCase();
    var out = q ? idx.filter(function (i) {
      return state.rows[i].some(function (cell) { return cell.toLowerCase().indexOf(q) !== -1; });
    }) : idx.slice();
    if (view.sortCol >= 0) {
      var col = state.columns[view.sortCol], j = view.sortCol, dir = view.sortDir;
      var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      out.sort(function (a, b) {
        if (col.values) {
          var va = col.values[a], vb = col.values[b];
          if (isNaN(va)) return 1; if (isNaN(vb)) return -1;
          return (va - vb) * dir;
        }
        return collator.compare(state.rows[a][j], state.rows[b][j]) * dir;
      });
    }
    return out;
  }

  function renderTableHead() {
    var thead = document.querySelector("#table thead");
    thead.textContent = "";
    var tr = document.createElement("tr");
    state.columns.forEach(function (c, j) {
      var th = document.createElement("th");
      th.scope = "col";
      if (c.type === "number") th.className = "num";
      th.setAttribute("aria-sort", view.sortCol === j ? (view.sortDir > 0 ? "ascending" : "descending") : "none");
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = c.name;
      b.title = "Sort by " + c.name;
      var arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 10 10"); arrow.setAttribute("class", "arrow"); arrow.setAttribute("aria-hidden", "true");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M1 3l4 4 4-4"); path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.5");
      arrow.appendChild(path); b.appendChild(arrow);
      b.addEventListener("click", function () {
        if (view.sortCol === j) view.sortDir = -view.sortDir;
        else { view.sortCol = j; view.sortDir = c.type === "number" || c.type === "date" ? -1 : 1; }
        view.page = 0;
        renderTableHead();
        renderTable(true);
      });
      th.appendChild(b);
      tr.appendChild(th);
    });
    thead.appendChild(tr);
  }

  function renderTable(soft) {
    var idx = tableIndexes(state.filtered);
    var tbody = document.querySelector("#table tbody");
    var pages = Math.max(1, Math.ceil(idx.length / view.pageSize));
    view.page = Math.min(view.page, pages - 1);
    var start = view.page * view.pageSize;
    var slice = idx.slice(start, start + view.pageSize);
    var frag = document.createDocumentFragment();
    if (!slice.length) {
      var tr0 = document.createElement("tr");
      var td0 = document.createElement("td");
      td0.colSpan = state.columns.length; td0.className = "empty";
      var msg = document.createElement("p");
      msg.textContent = view.search ? "No rows match “" + view.search + "”." : "No rows match the current filters.";
      var clear = document.createElement("button");
      clear.type = "button"; clear.className = "btn btn-secondary btn-small";
      clear.textContent = view.search ? "Clear search" : "Clear filters";
      clear.addEventListener("click", function () {
        if (view.search) { $("search").value = ""; view.search = ""; renderTable(true); }
        else clearFilters();
      });
      td0.append(msg, clear);
      tr0.appendChild(td0); frag.appendChild(tr0);
    }
    slice.forEach(function (i) {
      var tr = document.createElement("tr");
      state.rows[i].forEach(function (cell, j) {
        var td = document.createElement("td");
        if (state.columns[j].type === "number") {
          td.className = "num";
          var n = state.columns[j].values[i];
          td.textContent = isFinite(n) ? fmt(n) : cell;
        } else {
          td.textContent = cell;
        }
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    });
    tbody.textContent = "";
    tbody.appendChild(frag);
    if (soft && !quiet) motion.fadeIn(tbody);

    $("page-info").textContent = idx.length
      ? "Showing " + fmt(start + 1) + " to " + fmt(start + slice.length) + " of " + fmt(idx.length) + " rows"
      : "0 rows";
    $("prev-page").disabled = view.page === 0;
    $("next-page").disabled = view.page >= pages - 1;
    state.tableIdx = idx;
  }

  /* ---------- controls ---------- */

  function option(value, text) {
    var o = document.createElement("option");
    o.value = value; o.textContent = text;
    return o;
  }

  function setupControls() {
    var cats = state.byType("category");
    var dates = state.byType("date");
    var nums = state.byType("number");
    state.dateCol = dates.length ? dates[0] : -1;

    var x = $("x-col"); x.textContent = "";
    cats.concat(dates).forEach(function (j) {
      x.appendChild(option(j, state.columns[j].name + (state.columns[j].type === "date" ? " (date)" : "")));
    });
    if (!x.options.length) {
      // No obvious grouping column: fall back to the column with fewest distinct values.
      var best = 0;
      state.columns.forEach(function (c, j) { if (c.distinct < state.columns[best].distinct) best = j; });
      state.columns[best].type = state.columns[best].type === "number" ? "number" : "category";
      x.appendChild(option(best, state.columns[best].name));
    }

    renderGroupChips();

    var y = $("y-col"); y.textContent = "";
    nums.forEach(function (j) { y.appendChild(option(j, state.columns[j].name)); });
    if (!nums.length) y.appendChild(option("", "No number columns"));
    y.disabled = !nums.length;
    // Prefer a revenue or amount style column as the default measure.
    var preferred = nums.find(function (j) { return /revenue|sales|amount|total|price|value/i.test(state.columns[j].name); });
    if (preferred != null) y.value = preferred;
    var agg = $("agg");
    agg.value = nums.length ? "sum" : "count";
    Array.prototype.forEach.call(agg.options, function (o) { o.disabled = !nums.length && o.value !== "count"; });

    var fc = $("filter-col"); fc.textContent = "";
    fc.appendChild(option("", "No filter"));
    cats.forEach(function (j) { fc.appendChild(option(j, state.columns[j].name)); });
    fillFilterValues();

    var dr = $("date-range");
    if (state.dateCol >= 0) {
      var dv = state.columns[state.dateCol].values.filter(function (t) { return !isNaN(t); });
      var min = Math.min.apply(null, dv), max = Math.max.apply(null, dv);
      ["date-from", "date-to"].forEach(function (id) {
        $(id).min = isoDay(min); $(id).max = isoDay(max); $(id).value = "";
      });
      $("date-from").placeholder = isoDay(min);
      $("date-to").placeholder = isoDay(max);
      dr.hidden = false;
    } else {
      dr.hidden = true;
    }

    var summary = $("type-summary");
    summary.textContent = "";
    var groupsByType = { number: [], date: [], category: [], text: [] };
    state.columns.forEach(function (c) { groupsByType[c.type].push(c.name); });
    [["number", "Numbers"], ["date", "Dates"], ["category", "Categories"], ["text", "Text"]].forEach(function (pair) {
      if (!groupsByType[pair[0]].length) return;
      var line = document.createElement("span");
      var b = document.createElement("b"); b.textContent = pair[1] + ": ";
      line.append(b, document.createTextNode(groupsByType[pair[0]].join(", ")), document.createElement("br"));
      summary.appendChild(line);
    });
  }

  // Quick grouping chips above the bar chart (the same choice as "Group by").
  function renderGroupChips() {
    var box = $("group-switch");
    box.textContent = "";
    var x = $("x-col");
    var opts = Array.prototype.slice.call(x.options, 0, 6);
    if (opts.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.setAttribute("role", "radio");
      b.textContent = state.columns[+o.value].name;
      b.title = state.columns[+o.value].name;
      b.dataset.value = o.value;
      b.addEventListener("click", function () { setGrouping(o.value); });
      box.appendChild(b);
    });
    syncGroupChips();
  }
  function syncGroupChips() {
    var current = $("x-col").value;
    $("group-switch").querySelectorAll(".chip").forEach(function (b) {
      var on = b.dataset.value === current;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  function setGrouping(value) {
    if ($("x-col").value === String(value)) return;
    $("x-col").value = value;
    syncGroupChips();
    withTransition(function () { update(true); });
  }
  function cycleSelect(id, dir) {
    var sel = $(id);
    var opts = Array.prototype.filter.call(sel.options, function (o) { return !o.disabled; });
    if (sel.disabled || opts.length < 2) return false;
    var i = opts.findIndex(function (o) { return o.value === sel.value; });
    sel.value = opts[(i + dir + opts.length) % opts.length].value;
    return true;
  }

  function fillFilterValues() {
    var fv = $("filter-val"); fv.textContent = "";
    var col = $("filter-col").value;
    fv.appendChild(option("", "All values"));
    fv.disabled = col === "";
    if (col === "") return;
    var j = +col;
    var vals = Array.from(new Set(state.rows.map(function (r) { return r[j]; })))
      .sort(new Intl.Collator(undefined, { numeric: true }).compare);
    vals.forEach(function (v) { fv.appendChild(option(v, v === "" ? "(blank)" : v)); });
  }

  function filterNote(c) {
    var note = $("filter-note");
    note.textContent = "";
    var parts = [];
    if (c.fCol >= 0 && c.fVal !== "") parts.push(state.columns[c.fCol].name + " is " + c.fVal);
    if (c.from !== -Infinity) parts.push("from " + dayFmt.format(c.from));
    if (c.to !== Infinity) parts.push("to " + dayFmt.format(c.to));
    if (!parts.length) { note.textContent = "Showing all " + fmt(state.rows.length) + " rows."; return; }
    var strong = document.createElement("strong");
    strong.textContent = fmt(state.filtered.length) + " rows";
    note.append("Filtered to ", strong, " where " + parts.join(", ") + ".");
  }

  function update(soft) {
    var c = controls();
    state.filtered = filteredIndexes(c);
    filterNote(c);
    renderKpis(state.filtered);
    renderCharts(state.filtered, c);
    view.page = 0;
    renderTable(soft);
  }

  /* ================= loading ================= */

  function showError(message) {
    var e = $("load-error");
    e.textContent = message;
    e.hidden = false;
  }

  function load(text, label) {
    var ds;
    try {
      ds = buildDataset(text, label);
    } catch (err) {
      showDashboard(false);
      showError(err.message || "Could not read that file.");
      return;
    }
    state = ds;
    view = { sortCol: -1, sortDir: 1, page: 0, pageSize: +$("page-size").value, search: "" };
    $("search").value = "";
    $("load-error").hidden = true;

    var lbl = $("dataset-label");
    lbl.textContent = "";
    var name = document.createElement("strong"); name.textContent = label;
    var delim = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" }[ds.delimiter] || "custom";
    lbl.append(name, " · " + fmt(ds.rows.length) + " rows, " + ds.columns.length + " columns, " + delim + " separated" +
      (ds.ragged ? ", " + fmt(ds.ragged) + " rows had missing or extra cells" : ""));
    lbl.title = lbl.textContent; // the full name stays readable when the bar truncates it
    lbl.hidden = false;

    setupControls();
    showDashboard(true);
    renderTableHead();
    update(false);
    motion.entrance();
  }

  function showDashboard(on) {
    $("start").hidden = on;
    $("dash").hidden = !on;
    $("new-data").hidden = !on;
    if (!on) $("dataset-label").hidden = true;
  }

  function setReading(name) {
    var dz = $("dropzone");
    dz.classList.toggle("is-reading", !!name);
    $("reading-name").textContent = name ? "Reading " + name : "";
    $("drop-overlay").classList.remove("is-active");
  }

  function readFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) { showDashboard(false); showError("That file is larger than 100 MB. Try a smaller export."); return; }
    setReading(file.name);
    var reader = new FileReader();
    reader.onload = function () {
      // Let the "Reading" state paint before parsing a large file.
      setTimeout(function () { load(String(reader.result), file.name); setReading(""); }, 30);
    };
    reader.onerror = function () { setReading(""); showDashboard(false); showError("Could not read that file. Try saving it again as CSV."); };
    reader.readAsText(file);
  }

  function loadSample() {
    var label = "Sample sales (fictional data)";
    var fallback = function () {
      if (window.LEO_SAMPLE_CSV) load(window.LEO_SAMPLE_CSV, label);
      else showError("The sample file is missing. Check that sample-sales.csv sits next to index.html.");
    };
    // Browsers block fetch() for pages opened straight from disk, so use the embedded copy there.
    if (location.protocol === "file:" || !window.fetch) { fallback(); return; }
    fetch("sample-sales.csv", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (t) { load(t, label); }, fallback);
  }

  /* ================= exports ================= */

  function download(href, filename) {
    var a = document.createElement("a");
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart"; }

  // Paint the panel colour behind charts so exported PNGs are not transparent.
  Chart.register({
    id: "panelBackground",
    beforeDraw: function (chart) {
      var ctx = chart.ctx;
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = palette().panel;
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    }
  });

  document.querySelectorAll("[data-export]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-export");
      var chart = charts[key];
      if (!chart) return;
      var title = $(key === "line" ? "line-title" : "bar-title").textContent;
      download(chart.toBase64Image("image/png", 1), slug(title) + ".png");
    });
  });

  // Cells that start with = + - @ can run as formulas in spreadsheet apps; neutralise them.
  function safeCell(v) {
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(parseNumber(s))) return "'" + s;
    return s;
  }

  $("export-csv").addEventListener("click", function () {
    if (!state) return;
    var idx = state.tableIdx || state.filtered;
    var csv = Papa.unparse({
      fields: state.columns.map(function (c) { return safeCell(c.name); }),
      data: idx.map(function (i) { return state.rows[i].map(safeCell); })
    });
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    download(url, slug(state.label.replace(/\.[a-z]+$/i, "")) + "-filtered.csv");
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });

  /* ================= events ================= */

  $("file-input").addEventListener("change", function (e) { readFile(e.target.files[0]); e.target.value = ""; });
  $("load-sample").addEventListener("click", loadSample);
  $("paste-go").addEventListener("click", function () {
    var t = $("paste-input").value;
    if (!t.trim()) { showError("Paste some CSV text first. The first row should be the column names."); return; }
    load(t, "Pasted data");
  });
  $("new-data").addEventListener("click", function () {
    showDashboard(false);
    motion.rise($("start"));
    $("dropzone").focus();
  });

  var form = $("controls-form");
  form.addEventListener("submit", function (e) { e.preventDefault(); });
  $("filter-col").addEventListener("change", function () { fillFilterValues(); update(true); });
  ["x-col", "y-col", "agg"].forEach(function (id) {
    $(id).addEventListener("change", function () { syncGroupChips(); withTransition(function () { update(true); }); });
  });
  ["filter-val", "date-from", "date-to"].forEach(function (id) {
    $(id).addEventListener("change", function () { update(true); });
  });
  function clearFilters() {
    $("filter-col").value = ""; fillFilterValues();
    $("date-from").value = ""; $("date-to").value = "";
    update(true);
  }
  $("reset-filters").addEventListener("click", clearFilters);

  var searchTimer;
  $("search").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { view.search = e.target.value; view.page = 0; renderTable(true); }, 150);
  });
  $("page-size").addEventListener("change", function (e) { view.pageSize = +e.target.value; view.page = 0; if (state) renderTable(true); });
  $("prev-page").addEventListener("click", function () { view.page = Math.max(0, view.page - 1); renderTable(true); });
  $("next-page").addEventListener("click", function () { view.page += 1; renderTable(true); });

  // Drag and drop anywhere on the page.
  var dropzone = $("dropzone"), overlay = $("drop-overlay"), dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1; }
  window.addEventListener("dragenter", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth++;
    if ($("start").hidden) {
      $("drop-current").textContent = state ? "This replaces " + state.label + "." : "";
      overlay.classList.add("is-active");
    } else dropzone.classList.add("is-over");
  });
  window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) { overlay.classList.remove("is-active"); dropzone.classList.remove("is-over"); }
  });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0;
    overlay.classList.remove("is-active"); dropzone.classList.remove("is-over");
    readFile(e.dataTransfer.files[0]);
  });

  // Theme
  var themeBtn = $("theme-toggle");
  function syncTheme() {
    var dark = root.getAttribute("data-theme") === "dark";
    themeBtn.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    if (state) renderCharts(state.filtered, controls());
  }
  themeBtn.addEventListener("click", function () {
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("leo-dash-theme", next); } catch (e) {}
    syncTheme();
  });
  var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", function (e) {
    var saved = null;
    try { saved = localStorage.getItem("leo-dash-theme"); } catch (err) {}
    if (!saved) { root.setAttribute("data-theme", e.matches ? "dark" : "light"); syncTheme(); }
  });
  syncTheme();

  // Settings panel: always open on wide screens, folded away on phones to put the numbers first.
  var wide = window.matchMedia("(min-width: 1040px)");
  function syncControlsPanel() { $("controls-details").open = wide.matches; }
  if (wide.addEventListener) wide.addEventListener("change", syncControlsPanel);
  syncControlsPanel();
  $("controls-details").addEventListener("toggle", function () {
    if (wide.matches && !this.open) this.open = true;
  });

  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  /* ================= keyboard shortcuts ================= */

  var help = $("shortcuts");
  function openHelp(e) {
    if (help.open) return;
    help.classList.toggle("is-instant", !!(e && e.type === "keydown"));
    if (help.showModal) help.showModal(); else help.setAttribute("open", "");
  }
  function closeHelp() { if (help.close) help.close(); else help.removeAttribute("open"); }
  $("help-btn").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", closeHelp);
  help.addEventListener("click", function (e) { if (e.target === help) closeHelp(); });

  function typing(t) {
    return t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));
  }
  var shortcuts = {
    "?": openHelp,
    "/": function () { if (state) { $("search").focus(); $("search").select(); } },
    "g": function (e) { if (state && cycleSelect("x-col", e.shiftKey ? -1 : 1)) { syncGroupChips(); instantly(function () { update(true); }); } },
    "m": function (e) { if (state && cycleSelect("y-col", e.shiftKey ? -1 : 1)) instantly(function () { update(true); }); },
    "c": function (e) { if (state && cycleSelect("agg", e.shiftKey ? -1 : 1)) instantly(function () { update(true); }); },
    "f": function () { if (state) { $("controls-details").open = true; $("filter-col").focus(); } },
    "x": function () { if (state) instantly(clearFilters); },
    "[": function () { if (state && !$("prev-page").disabled) instantly(function () { $("prev-page").click(); }); },
    "]": function () { if (state && !$("next-page").disabled) instantly(function () { $("next-page").click(); }); },
    "e": function () { if (state) $("export-csv").click(); },
    "t": function () { themeBtn.click(); },
    "o": function () { $("file-input").click(); },
    "s": function () { if (!$("start").hidden) loadSample(); }
  };
  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key === "Escape") {
      if (help.open) return; // the dialog closes itself
      if (document.activeElement === $("search")) $("search").blur();
      return;
    }
    if (typing(e.target) || help.open) return;
    var fn = shortcuts[e.key.length === 1 ? e.key.toLowerCase() : ""] || shortcuts[e.key];
    if (!fn) return;
    e.preventDefault();
    fn(e);
  });

  /* ================= 3D start field (three.js, lazy loaded) =================
     Only when WebGL works, reduced motion is off and the page is served over http(s):
     browsers load ES modules (three.js) only over http. The CSS drawing stays otherwise. */
  function webglAvailable() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  }
  function loadStartField() {
    if (reduceMotion.matches || location.protocol === "file:" || !webglAvailable()) return;
    var stage = document.querySelector(".dropzone-preview");
    if (!stage) return;
    import("./start3d.js")
      .then(function (mod) { mod.startField(stage, $("dropzone")); })
      .catch(function (err) { if (window.console) console.info("3D start field not started:", err && err.message); });
  }
  if ("requestIdleCallback" in window) requestIdleCallback(loadStartField, { timeout: 1500 });
  else setTimeout(loadStartField, 400);

  // Handy for testing and for adding your own data source: window.leoDashboard.load(csvText, "Name")
  window.leoDashboard = { load: load, loadSample: loadSample, parseNumber: parseNumber, parseDate: parseDate };
})();
