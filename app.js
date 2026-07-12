/*
 * app.js — UI wiring. No frameworks, no build step: view source, learn, edit.
 *
 * Flow: input change → debounce 120ms → post job to worker → worker expands
 * (cached), compiles (cached), matches every line → render highlighted
 * bench + results. Stale worker replies (older job ids) are ignored, so
 * fast typing never paints out-of-date results.
 */
(function () {
  'use strict';

  // ---------- elements ----------
  var $ = function (id) { return document.getElementById(id); };
  var elSamples = $('samples'), elPattern = $('pattern'), elCustom = $('custom');
  var elBench = $('bench-lines'), elResults = $('results');
  var elStatusMatch = $('status-match'), elStatusTiming = $('status-timing');
  var elError = $('pattern-error'), elExpanded = $('expanded-regex'), elToggleRegex = $('toggle-regex');
  var elLibSearch = $('lib-search'), elLibList = $('lib-list'), elLibCount = $('lib-count');

  // ---------- state ----------
  var state = {
    set: 'ecs-v1',
    engine: 'grok',          // grok | dissect
    view: 'table',           // results view: table | json
    jobId: 0,
    lastDoneId: 0,
    lastResponse: null
  };

  // ---------- persistence (plain localStorage; this is a normal website) ----------
  var STORE = 'regrok.v1';
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        samples: elSamples.value, pattern: elPattern.value,
        custom: elCustom.value, set: state.set, engine: state.engine
      }));
    } catch (e) { /* storage may be unavailable; the app still works */ }
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!s) return false;
      elSamples.value = s.samples || '';
      elPattern.value = s.pattern || '';
      elCustom.value = s.custom || '';
      if (s.set) setPatternSet(s.set, true);
      if (s.engine) setEngine(s.engine, true);
      return !!(s.samples || s.pattern);
    } catch (e) { return false; }
  }

  // ---------- worker (with hang watchdog) ----------
  // Oniguruma matching is synchronous inside the worker; a catastrophically
  // backtracking pattern would hang it forever. Every job arms a watchdog;
  // if no reply comes back in time we terminate and restart the worker.
  var worker = null;
  var workerReady = false;
  var watchdog = null;
  var WATCHDOG_MS = 5000;

  function startWorker() {
    workerReady = false;
    worker = new Worker('worker.js');
    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'ready') {
        workerReady = true;
        // a job may have been queued while the WASM engine was loading
        if (state.jobId > state.lastDoneId) armWatchdog();
        return;
      }
      if (msg.id > state.lastDoneId) state.lastDoneId = msg.id;
      if (msg.id !== state.jobId) { armWatchdog(); return; } // stale; newer job still running
      clearTimeout(watchdog);
      state.lastResponse = msg;
      render(msg);
    };
    worker.onerror = function (e) {
      clearTimeout(watchdog);
      showError('Worker failed to start: ' + e.message +
        '. If you opened index.html directly from disk, serve it instead: python3 -m http.server');
    };
  }

  function armWatchdog() {
    clearTimeout(watchdog);
    if (!workerReady) return; // don't count WASM download time against the pattern
    watchdog = setTimeout(function () {
      worker.terminate();
      startWorker();
      showError('Stopped after ' + (WATCHDOG_MS / 1000) + 's — this pattern likely backtracks ' +
        'catastrophically (nested quantifiers, or DATA/GREEDYDATA next to each other). ' +
        'Simplify it and try again.');
    }, WATCHDOG_MS);
  }

  startWorker();

  var debounceTimer = null;
  function schedule() {
    save();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(dispatch, 120);
  }

  function dispatch() {
    var pattern = elPattern.value.trim();
    var lines = elSamples.value.split('\n');
    if (!pattern) {
      clearOutput('Add a grok pattern to start matching.');
      return;
    }
    state.jobId++;
    worker.postMessage({
      type: 'match', id: state.jobId, pattern: pattern, engine: state.engine,
      lines: lines, customText: elCustom.value, set: state.set
    });
    armWatchdog();
  }

  // ---------- field → color assignment (the signature system) ----------
  // Deterministic per response: fields get hues in order of first appearance,
  // spaced around the wheel so neighbors stay distinguishable.
  function buildFieldColors(results) {
    var order = [];
    var seen = {};
    results.forEach(function (r) {
      (r.captures || []).forEach(function (c) {
        if (!seen[c.field]) { seen[c.field] = true; order.push(c.field); }
      });
    });
    var colors = {};
    var n = Math.max(order.length, 1);
    order.forEach(function (f, i) {
      var hue = Math.round((i * 360 / Math.min(n, 12) + i * 37) % 360);
      colors[f] = 'hsl(' + hue + ' 62% 62%)';
    });
    return colors;
  }

  // ---------- rendering ----------
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function render(msg) {
    elError.hidden = true;
    if (!msg.ok) { showError(msg.error); return; }

    var results = msg.results;
    var colors = buildFieldColors(results);
    var lines = elSamples.value.split('\n');

    // status
    var total = results.filter(function (r) { return !r.empty; }).length;
    var hits = results.filter(function (r) { return r.matched; }).length;
    elStatusMatch.textContent = hits + '/' + total + ' lines matched';
    elStatusMatch.className = 'status-chip ' +
      (total === 0 ? '' : hits === total ? 'is-ok' : hits === 0 ? 'is-none' : 'is-partial');
    if (msg.engine === 'dissect') {
      elStatusTiming.textContent = 'parsed in ' + msg.matchMs.toFixed(2) + 'ms · no regex involved';
      elToggleRegex.hidden = true;
      elExpanded.hidden = true;
    } else {
      elStatusTiming.textContent =
        (msg.cachedCompile ? 'compile cached' : 'compiled in ' + msg.compileMs.toFixed(1) + 'ms') +
        ' · matched in ' + msg.matchMs.toFixed(1) + 'ms · regex ' + msg.regexLength + ' chars';
      elToggleRegex.hidden = false;
      elExpanded.textContent = msg.expandedRegex;
    }

    renderBench(lines, results, colors);
    renderResults(lines, results, colors);
  }

  function renderBench(lines, results, colors) {
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var r = results[i] || {};
      if (r.empty) continue;
      if (!r.matched) {
        var d = r.diag;
        if (d && d.matchEnd > 0) {
          html += '<div class="bench-line is-miss has-diag">' +
            '<span class="diag-ok" title="this part matches">' + esc(lines[i].slice(0, d.matchEnd)) + '</span>' +
            esc(lines[i].slice(d.matchEnd)) +
            '<span class="diag-note">⟵ matches up to here, then fails at ' + esc(d.failing) + '</span></div>';
        } else if (d) {
          html += '<div class="bench-line is-miss has-diag">' + esc(lines[i]) +
            '<span class="diag-note">⟵ fails immediately: ' + esc(d.failing) + '</span></div>';
        } else {
          html += '<div class="bench-line is-miss">' + esc(lines[i]) + '</div>';
        }
      } else {
        html += '<div class="bench-line is-hit">' + highlightLine(lines[i], r.captures, colors, i) + '</div>';
      }
    }
    elBench.innerHTML = html || '<div class="empty-state">No sample lines yet.</div>';
  }

  /**
   * Wrap capture ranges in colored spans. Captures can nest (a timestamp
   * inside a bigger capture), so we segment the line at every capture
   * boundary and color each segment by its innermost covering capture.
   */
  function highlightLine(line, captures, colors, lineIndex) {
    if (!captures.length) return esc(line);
    var bounds = [0, line.length];
    captures.forEach(function (c) { bounds.push(c.start, c.end); });
    bounds = Array.from(new Set(bounds)).sort(function (a, b) { return a - b; });

    var out = '';
    for (var b = 0; b < bounds.length - 1; b++) {
      var s = bounds[b], e = bounds[b + 1];
      if (s >= e) continue;
      var covering = captures.filter(function (c) { return c.start <= s && c.end >= e; });
      var text = esc(line.slice(s, e));
      if (!covering.length) { out += text; continue; }
      // innermost = smallest span
      covering.sort(function (a, bb) { return (a.end - a.start) - (bb.end - bb.start); });
      var top = covering[0];
      var title = covering.map(function (c) { return c.field; }).join(' ⊂ ');
      out += '<span class="cap" data-field="' + esc(top.field) + '" data-line="' + lineIndex +
        '" style="--cap-color:' + colors[top.field] + '" title="' + esc(title) + '">' + text + '</span>';
    }
    return out;
  }

  function renderResults(lines, results, colors) {
    var html = '';
    var shown = 0;
    for (var i = 0; i < lines.length; i++) {
      var r = results[i];
      if (!r || r.empty || !r.matched) continue;
      shown++;
      html += '<div class="result-block"><h3>line ' + (i + 1) + '</h3>';
      if (state.view === 'json') {
        var obj = {};
        r.captures.forEach(function (c) {
          obj[c.field] = (c.field in obj) ? obj[c.field] + ' ' + c.value : c.value;
        });
        html += '<pre class="json-view">' + esc(JSON.stringify(obj, null, 2)) + '</pre>';
      } else {
        html += '<table class="result-table"><tbody>';
        r.captures.forEach(function (c) {
          html += '<tr data-field="' + esc(c.field) + '" data-line="' + i + '">' +
            '<td class="f"><span class="dot" style="--cap-color:' + colors[c.field] + '"></span>' +
            esc(c.field) + (c.type ? '<span class="type-tag">:' + esc(String(c.type)) + '</span>' : '') + '</td>' +
            '<td>' + esc(String(c.value)) + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    }
    elResults.innerHTML = html ||
      '<div class="empty-state">' + (results.some(function (r) { return r && !r.empty; })
        ? 'No lines matched. Tip: build the pattern left to right — start with the first token, end with %{GREEDYDATA:rest}, then replace it piece by piece.'
        : 'Matched fields will appear here.') + '</div>';
  }

  // hover linking: span in bench ↔ row in results (color = identity)
  document.addEventListener('mouseover', function (e) {
    var t = e.target.closest('[data-field]');
    if (!t) return;
    setHot(t.dataset.field, t.dataset.line, true);
  });
  document.addEventListener('mouseout', function (e) {
    var t = e.target.closest('[data-field]');
    if (!t) return;
    setHot(t.dataset.field, t.dataset.line, false);
  });
  function setHot(field, line, on) {
    document.querySelectorAll('[data-field]').forEach(function (el) {
      if (el.dataset.field === field && el.dataset.line === line) {
        el.classList.toggle('is-hot', on);
      }
    });
  }

  function clearOutput(message) {
    elBench.innerHTML = '<div class="empty-state">' + esc(message) + '</div>';
    elResults.innerHTML = '';
    elStatusMatch.textContent = '–';
    elStatusMatch.className = 'status-chip';
    elStatusTiming.textContent = '';
    elToggleRegex.hidden = true;
    elExpanded.hidden = true;
    elError.hidden = true;
  }

  function showError(text) {
    elError.textContent = text;
    elError.hidden = false;
    elStatusMatch.textContent = 'pattern error';
    elStatusMatch.className = 'status-chip is-none';
    elStatusTiming.textContent = '';
  }

  // ---------- pattern set toggle ----------
  function setPatternSet(set, silent) {
    state.set = set;
    document.querySelectorAll('[data-set]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.set === set);
    });
    renderLibrary(elLibSearch.value);
    if (!silent) schedule();
  }
  document.querySelectorAll('[data-set]').forEach(function (b) {
    b.addEventListener('click', function () { setPatternSet(b.dataset.set); });
  });

  // ---------- results view toggle ----------
  document.querySelectorAll('[data-view]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.view = b.dataset.view;
      document.querySelectorAll('[data-view]').forEach(function (x) {
        x.classList.toggle('is-on', x === b);
      });
      if (state.lastResponse) render(state.lastResponse);
    });
  });

  // ---------- expanded regex toggle ----------
  elToggleRegex.addEventListener('click', function () {
    elExpanded.hidden = !elExpanded.hidden;
    elToggleRegex.textContent = elExpanded.hidden ? 'view expanded regex' : 'hide expanded regex';
  });

  // ---------- pattern library ----------
  function renderLibrary(query) {
    var defs = window.GROK_PATTERN_SETS[state.set];
    var names = Object.keys(defs).sort(function (a, b) {
      var ca = defs[a].src === 'grok-patterns' ? 0 : 1;   // core primitives first,
      var cb = defs[b].src === 'grok-patterns' ? 0 : 1;   // product packs after
      return ca - cb || (ca === 1 && defs[a].src !== defs[b].src
        ? (defs[a].src < defs[b].src ? -1 : 1) : 0) || (a < b ? -1 : 1);
    });
    var q = (query || '').trim().toUpperCase();
    var shown = 0, html = '';
    for (var i = 0; i < names.length && shown < 200; i++) {
      var n = names[i];
      var def = defs[n];
      if (q && n.indexOf(q) === -1 && def.src.toUpperCase().indexOf(q) === -1) continue;
      shown++;
      html += '<li data-insert="' + esc(n) + '" title="click to insert %{' + esc(n) + '}">' +
        '<span class="lib-name">%{' + esc(n) + '}</span><span class="lib-src">' + esc(def.src) + '</span>' +
        '<div class="lib-def">' + esc(def.p) + '</div></li>';
    }
    elLibList.innerHTML = html || '<li><div class="lib-def">no patterns match "' + esc(query) + '"</div></li>';
    elLibCount.textContent = names.length + ' patterns';
  }
  elLibSearch.addEventListener('input', function () { renderLibrary(elLibSearch.value); });
  elLibList.addEventListener('click', function (e) {
    var li = e.target.closest('[data-insert]');
    if (!li) return;
    insertAtCursor(elPattern, '%{' + li.dataset.insert + '}');
    schedule();
  });
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart || ta.value.length, e = ta.selectionEnd || s;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    ta.focus();
  }

  // ---------- copy buttons ----------
  function wireCopy(btnId, getText) {
    var btn = $(btnId);
    btn.addEventListener('click', function () {
      var text = getText();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        var old = btn.textContent;
        btn.textContent = 'copied ✓';
        setTimeout(function () { btn.textContent = old; }, 1500);
      });
    });
  }
  wireCopy('copy-pattern', function () { return elPattern.value.trim(); });
  wireCopy('copy-json', function () {
    var msg = state.lastResponse;
    if (!msg || !msg.ok) return '';
    var out = [];
    msg.results.forEach(function (r, i) {
      if (!r || r.empty || !r.matched) return;
      var obj = {};
      r.captures.forEach(function (c) {
        obj[c.field] = (c.field in obj) ? obj[c.field] + ' ' + c.value : c.value;
      });
      out.push({ line: i + 1, fields: obj });
    });
    return out.length ? JSON.stringify(out, null, 2) : '';
  });

  // ---------- custom pattern import/export ----------
  $('custom-export').addEventListener('click', function () {
    var blob = new Blob([elCustom.value], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'custom-patterns.grok';
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $('custom-import').addEventListener('change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    f.text().then(function (t) {
      elCustom.value = elCustom.value ? elCustom.value + '\n' + t : t;
      schedule();
    });
  });

  // ---------- engine toggle (grok | dissect) ----------
  function setEngine(engine, silent) {
    state.engine = engine;
    document.querySelectorAll('[data-engine]').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.engine === engine);
    });
    var hint = document.getElementById('pattern-hint');
    var label = document.getElementById('pattern-label');
    if (engine === 'dissect') {
      label.textContent = 'Dissect pattern';
      hint.textContent = '%{field} · %{} skip · %{f->} pad · %{+f} append';
      elPattern.placeholder = '%{ts} %{+ts} %{+ts} %{host} %{prog}[%{pid}]: %{msg}';
    } else {
      label.textContent = 'Grok pattern';
      hint.textContent = '%{PATTERN:field:type} · type is int or float';
      elPattern.placeholder = '%{IPORHOST:client_ip} %{WORD:method} %{URIPATH:path}';
    }
    if (!silent) schedule();
  }
  document.querySelectorAll('[data-engine]').forEach(function (b) {
    b.addEventListener('click', function () { setEngine(b.dataset.engine); });
  });

  // ---------- inputs + auto-grow ----------
  // Textareas grow with their content (capped) but never auto-shrink, so a
  // manual drag-resize sticks. Drag smaller anytime; typing more grows again.
  var GROW_CAP = { samples: 0.5, pattern: 0.35, custom: 0.35 }; // of viewport
  function autoGrow(el) {
    var cap = Math.floor(window.innerHeight * (GROW_CAP[el.id] || 0.35));
    var needed = Math.min(el.scrollHeight + 2, cap);
    if (needed > el.clientHeight) el.style.height = needed + 'px';
  }
  [elSamples, elPattern, elCustom].forEach(function (el) {
    el.addEventListener('input', function () { autoGrow(el); schedule(); });
  });

  // ---------- boot ----------
  renderLibrary('');
  var hadSaved = load();
  if (!hadSaved) {
    // friendly first-run example
    elSamples.value = [
      '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)"',
      '203.0.113.9 - - [10/Oct/2000:13:55:37 -0700] "POST /login HTTP/1.1" 401 199 "-" "curl/8.4.0"'
    ].join('\n');
    elPattern.value = '%{HTTPD_COMBINEDLOG}';
  }
  [elSamples, elPattern, elCustom].forEach(autoGrow);
  dispatch();

  // expose bits the AI panel needs
  // ---------- offline (PWA) ----------
  // After the first visit over http(s), every asset is cached; the app then
  // works with no internet at all, and can be installed from the browser menu.
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      var note = document.getElementById('offline-note');
      if (navigator.serviceWorker.controller && note) note.hidden = false;
      else navigator.serviceWorker.ready.then(function () { if (note) note.hidden = false; });
    }).catch(function () { /* http on a LAN IP etc. — app still works online */ });
  }

  window.regrok = {
    getContext: function () {
      return {
        samples: elSamples.value, pattern: elPattern.value,
        custom: elCustom.value, set: state.set
      };
    },
    setPattern: function (p) {
      elPattern.value = p;
      autoGrow(elPattern);
      schedule();
      elPattern.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
})();
