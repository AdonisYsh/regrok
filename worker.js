/*
 * worker.js — all parsing work happens here, off the UI thread.
 *
 * Two engines:
 *   grok    — Oniguruma WASM regex (same family Logstash uses), LRU-cached
 *   dissect — pure delimiter parsing (dissect.js), no regex at all
 *
 * Grok misses get DIAGNOSED: the pattern is split into tokens, prefix
 * regexes are compiled (lazily, once per pattern), and we report the last
 * token that matched plus the token where the line broke.
 */
'use strict';

importScripts('vendor/onig.js', 'vendor/patterns.js', 'grok.js', 'dissect.js');

var ready = fetch('vendor/onig.wasm')
  .then(function (r) { return r.arrayBuffer(); })
  .then(function (buf) { return self.onig.loadWASM(buf); })
  .then(function () { self.postMessage({ type: 'ready' }); });

// --- tiny LRU cache for compiled grok patterns ---------------------------
var cache = new Map();
var CACHE_MAX = 64;

function getCompiled(set, customText, pattern) {
  var key = set + '\u0000' + customText + '\u0000' + pattern;
  if (cache.has(key)) {
    var hit = cache.get(key);
    cache.delete(key); cache.set(key, hit);
    hit.cached = true;
    return hit;
  }
  var t0 = performance.now();
  var defs = self.GROK_PATTERN_SETS[set] || self.GROK_PATTERN_SETS['ecs-v1'];
  var custom = Grok.parsePatternsText(customText);
  var expanded = Grok.expand(pattern, defs, custom);
  var groupMap = Grok.mapGroupIndices(expanded.regex);
  var scanner = new self.onig.OnigScanner([expanded.regex]);
  var entry = {
    scanner: scanner, groupMap: groupMap, fields: expanded.fields,
    regexLength: expanded.regex.length, regex: expanded.regex,
    compileMs: performance.now() - t0, cached: false,
    defs: defs, custom: custom, pattern: pattern,
    prefixes: null // built lazily on first miss (see diagnose)
  };
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) {
    // evicted scanners hold native WASM memory — free it explicitly
    var oldestKey = cache.keys().next().value;
    disposeEntry(cache.get(oldestKey));
    cache.delete(oldestKey);
  }
  return entry;
}

function disposeEntry(entry) {
  try { entry.scanner.dispose(); } catch (e) {}
  if (entry.prefixes) {
    entry.prefixes.forEach(function (p) {
      if (p.scanner) { try { p.scanner.dispose(); } catch (e) {} }
    });
  }
}

// --- partial-match diagnosis ---------------------------------------------
// Split the raw grok pattern into alternating literal / %{TOKEN} parts.
function tokenize(pattern) {
  var re = new RegExp(Grok.GROK_TOKEN.source, 'g');
  var parts = [];
  var last = 0, m;
  while ((m = re.exec(pattern)) !== null) {
    if (m.index > last) parts.push({ kind: 'lit', text: pattern.slice(last, m.index) });
    parts.push({ kind: 'tok', text: m[0] });
    last = re.lastIndex;
  }
  if (last < pattern.length) parts.push({ kind: 'lit', text: pattern.slice(last) });
  return parts;
}

var MAX_DIAG_PARTS = 80;

// Build (lazily) one scanner per pattern prefix: ^part0, ^part0part1, ...
// Some prefixes are invalid regex mid-group (e.g. "(?:%{A} ") — those are
// skipped; diagnosis just gets a little coarser around them.
function buildPrefixes(entry) {
  var parts = tokenize(entry.pattern).slice(0, MAX_DIAG_PARTS);
  var prefixes = [];
  var acc = '';
  for (var i = 0; i < parts.length; i++) {
    acc += parts[i].text;
    var scanner = null;
    try {
      var ex = Grok.expand(acc, entry.defs, entry.custom);
      scanner = new self.onig.OnigScanner(['\\A(?:' + ex.regex + ')']);
    } catch (e) { /* invalid mid-structure prefix — skip */ }
    prefixes.push({ scanner: scanner, index: i, parts: parts });
  }
  entry.prefixes = prefixes;
  return prefixes;
}

function diagnose(entry, line) {
  var prefixes = entry.prefixes || buildPrefixes(entry);
  if (!prefixes.length) return null;
  var os = new self.onig.OnigString(line);
  var lastOk = -1, matchEnd = 0;
  for (var i = 0; i < prefixes.length; i++) {
    var p = prefixes[i];
    if (!p.scanner) continue;
    var m = p.scanner.findNextMatchSync(os, 0);
    if (m) { lastOk = i; matchEnd = m.captureIndices[0].end; }
    else break; // prefixes only grow; first failure is THE failure
  }
  os.dispose(); // OnigString allocates WASM heap; never GC'd on its own
  var parts = prefixes[0].parts;
  var failing = parts[Math.min(lastOk + 1, parts.length - 1)];
  return {
    matchEnd: matchEnd,
    okCount: lastOk + 1,
    total: parts.length,
    failing: failing.kind === 'tok' ? failing.text : 'literal ' + JSON.stringify(failing.text)
  };
}

// --- message handling ------------------------------------------------------
self.onmessage = function (e) {
  var msg = e.data;
  ready.then(function () {
    if (msg.type !== 'match') return;
    if (msg.engine === 'dissect') return handleDissect(msg);
    return handleGrok(msg);
  }).catch(function (err) {
    self.postMessage({ id: msg.id, ok: false, error: 'Engine failed to load: ' + err.message });
  });
};

function handleGrok(msg) {
  var out = { id: msg.id, ok: true, engine: 'grok', results: [] };
  var compiled;
  try {
    compiled = getCompiled(msg.set, msg.customText || '', msg.pattern);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err.message, isGrokError: !!err.isGrokError });
    return;
  }
  out.compileMs = compiled.compileMs;
  out.cachedCompile = compiled.cached;
  out.regexLength = compiled.regexLength;
  out.expandedRegex = compiled.regex;

  var t0 = performance.now();
  for (var i = 0; i < msg.lines.length; i++) {
    var line = msg.lines[i];
    if (line === '') { out.results.push({ empty: true }); continue; }
    var os = new self.onig.OnigString(line);
    var m = compiled.scanner.findNextMatchSync(os, 0);
    os.dispose(); // capture indices are already extracted; free the WASM heap
    if (!m) {
      var d = null;
      try { d = diagnose(compiled, line); } catch (e) { /* diagnosis is best-effort */ }
      out.results.push({ matched: false, diag: d });
    } else {
      out.results.push({
        matched: true,
        captures: Grok.buildCaptures(line, m.captureIndices, compiled.groupMap, compiled.fields)
      });
    }
  }
  out.matchMs = performance.now() - t0;
  self.postMessage(out);
}

function handleDissect(msg) {
  var out = { id: msg.id, ok: true, engine: 'dissect', results: [] };
  var compiled;
  var t0 = performance.now();
  try {
    compiled = Dissect.compile(msg.pattern);
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err.message, isGrokError: true });
    return;
  }
  out.compileMs = performance.now() - t0;
  out.cachedCompile = false;
  out.regexLength = 0; // no regex — that's the point

  t0 = performance.now();
  for (var i = 0; i < msg.lines.length; i++) {
    var line = msg.lines[i];
    if (line === '') { out.results.push({ empty: true }); continue; }
    var r = Dissect.match(compiled, line);
    if (!r.matched) {
      out.results.push({ matched: false, diag: { matchEnd: r.failAt || 0, failing: r.diag, dissect: true } });
    } else {
      out.results.push({ matched: true, captures: r.captures });
    }
  }
  out.matchMs = performance.now() - t0;
  self.postMessage(out);
}
