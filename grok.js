/*
 * grok.js — the heart of regrok.
 *
 * Grok is just a macro language on top of regex. A grok expression like
 *     %{IPORHOST:client_ip} %{NUMBER:bytes:int}
 * gets "expanded" into one big regex with named capture groups. Logstash
 * does this with the Oniguruma regex engine (via joni); we use the exact
 * same engine compiled to WebAssembly (vscode-oniguruma), so results here
 * match real Logstash behavior.
 *
 * This file is environment-agnostic: it runs in the Web Worker and in Node
 * (for tests). It has no DOM dependencies.
 */
(function (root) {
  'use strict';

  // %{NAME}  |  %{NAME:field}  |  %{NAME:field:type}
  // field may contain dots or [bracket][notation]; type is int|float.
  var GROK_TOKEN = /%\{([A-Z0-9_]+)(?::([^:}]+))?(?::(int|float))?\}/;

  var MAX_ITERATIONS = 1000; // hard stop for recursive/cyclic definitions

  /**
   * Parse a "patterns file" text (the same NAME REGEX format Logstash uses)
   * into { NAME: regexString }. Lines starting with # are comments.
   */
  function parsePatternsText(text) {
    var out = {};
    var lines = (text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || /^\s*#/.test(line)) continue;
      var m = line.match(/^([A-Z0-9_]+)\s+(.*\S)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  }

  /**
   * Expand a grok expression into a raw Oniguruma regex.
   *
   * Named fields become generated group names (g0, g1, ...) because grok
   * field names may contain characters (dots, brackets) that regex group
   * names don't allow. `fields` maps generated name -> { field, type }.
   *
   * Returns { regex, fields, iterations } or throws GrokError.
   */
  function expand(expression, defs, customDefs) {
    var fields = {};
    var counter = 0;
    var regex = expression;
    var iterations = 0;

    var lookup = function (name) {
      if (customDefs && Object.prototype.hasOwnProperty.call(customDefs, name)) {
        return customDefs[name];
      }
      if (defs && Object.prototype.hasOwnProperty.call(defs, name)) {
        var d = defs[name];
        return typeof d === 'string' ? d : d.p;
      }
      return null;
    };

    while (true) {
      var m = GROK_TOKEN.exec(regex);
      if (!m) break;
      if (++iterations > MAX_ITERATIONS) {
        throw grokError('Pattern expansion exceeded ' + MAX_ITERATIONS +
          ' steps — you likely have a circular custom pattern definition.');
      }
      var name = m[1], field = m[2], type = m[3];
      var body = lookup(name);
      if (body == null) {
        throw grokError('Unknown pattern %{' + name + '}. Check the spelling, the selected pattern set, or define it under Custom patterns.', { pattern: name });
      }
      var replacement;
      if (field) {
        var gname = 'g' + (counter++);
        fields[gname] = { field: field, type: type || null };
        replacement = '(?<' + gname + '>' + body + ')';
      } else {
        replacement = '(?:' + body + ')';
      }
      regex = regex.slice(0, m.index) + replacement + regex.slice(m.index + m[0].length);
    }
    return { regex: regex, fields: fields, iterations: iterations };
  }

  /**
   * Walk a regex and map every named capture group to its capture index
   * (1-based, in order of opening parens). Handles escapes, character
   * classes, and non-capturing/lookaround/atomic groups.
   *
   * Needed because the Oniguruma WASM API returns captures by index only.
   */
  function mapGroupIndices(regex) {
    var map = {}; // name -> index
    var idx = 0;
    var inClass = false;
    for (var i = 0; i < regex.length; i++) {
      var c = regex[i];
      if (c === '\\') { i++; continue; }
      if (inClass) { if (c === ']') inClass = false; continue; }
      if (c === '[') { inClass = true; continue; }
      if (c !== '(') continue;

      if (regex[i + 1] === '?') {
        // Named groups: (?<name>...) or (?'name'...) — but NOT lookbehind (?<= (?<!
        var rest = regex.slice(i);
        var nm = rest.match(/^\(\?<([A-Za-z_][A-Za-z0-9_]*)>/) ||
                 rest.match(/^\(\?'([A-Za-z_][A-Za-z0-9_]*)'/);
        if (nm) {
          idx++;
          map[nm[1]] = idx;
        }
        // everything else starting with (? is non-capturing: (?: (?= (?! (?<= (?<! (?> (?i) ...
      } else {
        idx++; // plain capturing group
      }
    }
    return map;
  }

  /** Coerce a captured string according to grok's :int / :float suffix. */
  function coerce(value, type) {
    if (type === 'int') {
      var n = parseInt(value, 10);
      return isNaN(n) ? value : n;
    }
    if (type === 'float') {
      var f = parseFloat(value);
      return isNaN(f) ? value : f;
    }
    return value;
  }

  function grokError(message, extra) {
    var e = new Error(message);
    e.isGrokError = true;
    if (extra) Object.assign(e, extra);
    return e;
  }

  /**
   * Build the per-line result from Oniguruma capture indices.
   * `groupMap` maps regex group name -> capture index;
   * `fields` maps generated group name -> { field, type }.
   */
  function buildCaptures(line, captureIndices, groupMap, fields) {
    var caps = [];
    for (var gname in groupMap) {
      var ci = captureIndices[groupMap[gname]];
      if (!ci || ci.length === 0 && ci.start === 0 && ci.end === 0 && !within(ci, captureIndices[0])) {
        // Oniguruma reports non-participating groups as 0/0; filter those
        // unless the whole match genuinely starts at 0 with an empty group.
      }
      if (!ci) continue;
      if (ci.start === 4294967295 || ci.end === 4294967295) continue; // did not participate
      var meta = fields[gname];
      var field = meta ? meta.field : gname; // user-written (?<name>...) groups keep their name
      var raw = line.slice(ci.start, ci.end);
      caps.push({
        field: field,
        type: meta ? meta.type : null,
        value: coerce(raw, meta ? meta.type : null),
        raw: raw,
        start: ci.start,
        end: ci.end
      });
    }
    caps.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    return caps;
  }

  function within(inner, outer) {
    return outer && inner.start >= outer.start && inner.end <= outer.end;
  }

  var api = {
    parsePatternsText: parsePatternsText,
    expand: expand,
    mapGroupIndices: mapGroupIndices,
    coerce: coerce,
    buildCaptures: buildCaptures,
    GROK_TOKEN: GROK_TOKEN
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Grok = api;
})(typeof self !== 'undefined' ? self : this);
