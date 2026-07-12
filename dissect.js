/*
 * dissect.js — a Logstash-style Dissect implementation.
 *
 * Dissect is grok's faster sibling: no regex at all. You describe the line
 * as fields separated by literal delimiters, and parsing is just a series
 * of indexOf() calls. For logs with a fixed shape it's dramatically faster
 * and can never backtrack. Production pipelines often try Dissect first
 * and fall back to grok for the weird lines.
 *
 * Supported syntax (same as Logstash dissect):
 *   %{field}      capture
 *   %{}           skip (unnamed)
 *   %{?name}      skip (named, for readability)
 *   %{field->}    after this field, eat repeated delimiters (padding)
 *   %{+field}     append to an earlier field (joined with a space)
 *   %{+field/2}   append with explicit ordering
 * Not supported (rarely used): %{&key} value references.
 *
 * Environment-agnostic: runs in the worker and in Node tests.
 */
(function (root) {
  'use strict';

  var TOKEN = /%\{([^}]*)\}/g;

  /** Parse a dissect pattern into { leading, parts:[{key, delim, ...}] }. */
  function compile(pattern) {
    TOKEN.lastIndex = 0;
    var parts = [];
    var last = 0;
    var leading = null;
    var m;
    while ((m = TOKEN.exec(pattern)) !== null) {
      var lit = pattern.slice(last, m.index);
      if (leading === null) leading = lit;
      else parts[parts.length - 1].delim = lit;
      parts.push(parseKey(m[1]));
      last = TOKEN.lastIndex;
    }
    if (leading === null) {
      throw dissectError('No %{fields} found. A dissect pattern looks like: %{ts} %{level} %{msg}');
    }
    var trailing = pattern.slice(last);
    parts[parts.length - 1].delim = null;       // last field runs to end of line
    parts[parts.length - 1].trailing = trailing;

    // adjacent fields with an empty delimiter are ambiguous
    for (var i = 0; i < parts.length - 1; i++) {
      if (parts[i].delim === '') {
        throw dissectError('Fields %{' + parts[i].raw + '} and %{' + parts[i + 1].raw +
          '} have no delimiter between them — dissect needs literal text between fields.');
      }
    }
    return { leading: leading, parts: parts };
  }

  function parseKey(raw) {
    var key = raw;
    var p = { raw: raw, skip: false, append: false, order: 0, pad: false };
    if (key.endsWith('->')) { p.pad = true; key = key.slice(0, -2); }
    if (key.startsWith('+')) {
      p.append = true; key = key.slice(1);
      var slash = key.lastIndexOf('/');
      if (slash > 0 && /^\d+$/.test(key.slice(slash + 1))) {
        p.order = parseInt(key.slice(slash + 1), 10);
        key = key.slice(0, slash);
      }
    } else if (key.startsWith('?')) {
      p.skip = true; key = key.slice(1);
    } else if (key.startsWith('&')) {
      throw dissectError('%{&' + key.slice(1) + '} value references are not supported here.');
    }
    if (key === '') p.skip = true;
    p.field = key;
    return p;
  }

  /**
   * Match one line. Returns null on no-match, otherwise:
   * { captures: [{field, value, start, end}], event: {field: value} }
   * `diag` explains the failure point when it doesn't match.
   */
  function match(compiled, line) {
    var pos = 0;
    if (compiled.leading) {
      if (!line.startsWith(compiled.leading)) {
        return { matched: false, diag: 'line does not start with "' + compiled.leading + '"', failAt: 0 };
      }
      pos = compiled.leading.length;
    }

    var spans = [];
    for (var i = 0; i < compiled.parts.length; i++) {
      var part = compiled.parts[i];
      var value, start = pos, end;

      if (part.delim === null) {
        // last field: consume to end (minus required trailing literal)
        var tail = part.trailing || '';
        if (tail && !line.endsWith(tail)) {
          return { matched: false, diag: 'line does not end with "' + tail + '"', failAt: pos };
        }
        end = line.length - tail.length;
        if (end < pos) return { matched: false, diag: 'ran out of line before %{' + part.raw + '}', failAt: pos };
        value = line.slice(pos, end);
        pos = line.length;
      } else {
        var idx = line.indexOf(part.delim, pos);
        if (idx === -1) {
          return {
            matched: false, failAt: pos,
            diag: 'delimiter "' + part.delim + '" (after %{' + part.raw + '}) not found from position ' + pos
          };
        }
        end = idx;
        value = line.slice(pos, idx);
        pos = idx + part.delim.length;
        if (part.pad) {
          while (line.startsWith(part.delim, pos)) pos += part.delim.length;
        }
      }
      if (!part.skip) spans.push({ part: part, value: value, start: start, end: end });
    }

    // assemble event: appends join with a space, honoring /order
    var event = {};
    var appends = {};
    spans.forEach(function (s) {
      if (s.part.append) {
        (appends[s.part.field] = appends[s.part.field] || []).push({ order: s.part.order, value: s.value });
      } else {
        event[s.part.field] = s.value;
      }
    });
    Object.keys(appends).forEach(function (f) {
      var pieces = appends[f].sort(function (a, b) { return a.order - b.order; }).map(function (x) { return x.value; });
      event[f] = (event[f] !== undefined ? [event[f]].concat(pieces) : pieces).join(' ');
    });

    return {
      matched: true,
      event: event,
      captures: spans.map(function (s) {
        return { field: s.part.field, value: s.value, raw: s.value, type: null, start: s.start, end: s.end };
      })
    };
  }

  function dissectError(message) {
    var e = new Error(message);
    e.isGrokError = true; // reuse the same error display path
    return e;
  }

  var api = { compile: compile, match: match };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dissect = api;
})(typeof self !== 'undefined' ? self : this);
