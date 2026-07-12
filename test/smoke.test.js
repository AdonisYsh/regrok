// Node smoke test: run with `node test/smoke.test.js`
const fs = require('fs');
const path = require('path');
const onig = require('vscode-oniguruma');
const Grok = require('../grok.js');

function loadPatternSets() {
  const src = fs.readFileSync(path.join(__dirname, '../vendor/patterns.js'), 'utf8');
  const json = src.slice(src.indexOf('= ') + 2, src.lastIndexOf(';'));
  return JSON.parse(json);
}

async function main() {
  const wasm = fs.readFileSync(path.join(__dirname, '../vendor/onig.wasm'));
  await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));

  // Quirk check: do plain groups still get capture indices alongside named ones?
  let s = new onig.OnigScanner(['(a)(?<x>b)']);
  let r = s.findNextMatchSync(new onig.OnigString('ab'), 0);
  console.log('capture indices for (a)(?<x>b) on "ab":', JSON.stringify(r.captureIndices));

  const sets = loadPatternSets();
  const defs = sets['ecs-v1'];

  const cases = [
    {
      name: 'Apache combined log',
      pattern: '%{HTTPD_COMBINEDLOG}',
      line: '127.0.0.1 - frank [10/Oct/2000:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://example.com/start.html" "Mozilla/4.08 [en] (Win98; I ;Nav)"',
      expectField: '[http][response][status_code]', expectValue: 200
    },
    {
      name: 'Syslog line',
      pattern: '%{SYSLOGTIMESTAMP:ts} %{SYSLOGHOST:host} %{DATA:program}(?:\\[%{POSINT:pid:int}\\])?: %{GREEDYDATA:msg}',
      line: 'Mar 16 08:12:04 web-01 sshd[2453]: Failed password for invalid user admin from 203.0.113.9 port 4242 ssh2',
      expectField: 'pid', expectValue: 2453
    },
    {
      name: 'Custom pattern + type coercion',
      pattern: '%{ORDERID:order} took %{NUMBER:ms:float}ms',
      custom: 'ORDERID ORD-[0-9]{6}',
      line: 'ORD-004217 took 12.75ms',
      expectField: 'ms', expectValue: 12.75
    },
    {
      name: 'User-written inline named group',
      pattern: '(?<level>INFO|WARN|ERROR) %{GREEDYDATA:rest}',
      line: 'WARN disk usage at 91%',
      expectField: 'level', expectValue: 'WARN'
    }
  ];

  let failed = 0;
  for (const c of cases) {
    const custom = c.custom ? Grok.parsePatternsText(c.custom) : {};
    const t0 = Date.now();
    const { regex, fields } = Grok.expand(c.pattern, defs, custom);
    const groupMap = Grok.mapGroupIndices(regex);
    const scanner = new onig.OnigScanner([regex]);
    const m = scanner.findNextMatchSync(new onig.OnigString(c.line), 0);
    const ms = Date.now() - t0;
    if (!m) { console.log('FAIL (no match):', c.name); failed++; continue; }
    const caps = Grok.buildCaptures(c.line, m.captureIndices, groupMap, fields);
    const hit = caps.find(x => x.field === c.expectField);
    const ok = hit && hit.value === c.expectValue;
    console.log((ok ? 'PASS' : 'FAIL'), c.name, `(expand+compile+match ${ms}ms, regex ${regex.length} chars, ${caps.length} fields)`);
    if (!ok) { failed++; console.log('  got:', JSON.stringify(hit), 'want:', c.expectField, '=', c.expectValue); }
  }

  // Error paths
  try { Grok.expand('%{NOPE:x}', defs, {}); console.log('FAIL unknown pattern did not throw'); failed++; }
  catch (e) { console.log('PASS unknown pattern throws:', e.message.slice(0, 40) + '…'); }
  try { Grok.expand('%{A:x}', defs, { A: '%{B}', B: '%{A}' }); console.log('FAIL cycle did not throw'); failed++; }
  catch (e) { console.log('PASS circular custom pattern throws'); }

  console.log(failed ? `\n${failed} FAILURES` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });

// ---- appended: dissect engine tests (run separately) ----
if (process.env.SKIP_DISSECT !== '1') {
  const Dissect = require('../dissect.js');
  let dFailed = 0;
  const dt = (name, fn) => { try { fn(); console.log('PASS', name); } catch (e) { dFailed++; console.log('FAIL', name, '—', e.message); } };
  const assert = (c, m) => { if (!c) throw new Error(m); };

  dt('dissect basic syslog shape', () => {
    const c = Dissect.compile('%{ts} %{+ts} %{+ts} %{host} %{prog}[%{pid}]: %{msg}');
    const r = Dissect.match(c, 'Mar 16 08:12:04 web-01 sshd[2453]: Failed password for admin');
    assert(r.matched, 'should match');
    assert(r.event.ts === 'Mar 16 08:12:04', 'append got: ' + r.event.ts);
    assert(r.event.pid === '2453', 'pid');
    assert(r.event.msg === 'Failed password for admin', 'msg');
  });
  dt('dissect skip + padding', () => {
    const c = Dissect.compile('%{level->} %{?skipme} %{msg}');
    const r = Dissect.match(c, 'WARN    disk usage high');
    assert(r.matched && r.event.msg === 'usage high', JSON.stringify(r.event));
    assert(!('skipme' in r.event), 'skipped field leaked');
  });
  dt('dissect miss reports failure point', () => {
    const c = Dissect.compile('%{a}: %{b}');
    const r = Dissect.match(c, 'no colon here');
    assert(!r.matched && /delimiter/.test(r.diag), r.diag);
  });
  dt('dissect adjacent fields rejected', () => {
    let threw = false;
    try { Dissect.compile('%{a}%{b}'); } catch (e) { threw = true; }
    assert(threw, 'should reject %{a}%{b}');
  });
  if (dFailed) { console.log(dFailed + ' DISSECT FAILURES'); process.exitCode = 1; }
  else console.log('DISSECT ALL PASS');
}
