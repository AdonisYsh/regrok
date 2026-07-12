/*
 * ai.js — two ways to get AI help, both private by design:
 *
 * 1) "Copy prompt for any AI": builds a rigorous prompt with your sample
 *    lines, current pattern and custom patterns embedded. Paste anywhere.
 * 2) Built-in chat: bring your own API key. The call goes from YOUR browser
 *    straight to the provider. There is no middleman server.
 *
 * The prompt encodes the rules that stop chatbots producing the usual bad
 * grok: invented pattern names, unescaped brackets, back-to-back GREEDYDATA,
 * and "trust me it matches" answers that don't.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------
  // The pre-baked prompt. Tuned for accuracy; edit to taste.
  // ---------------------------------------------------------------
  function buildPrompt(ctx) {
    return [
'You are a senior Logstash Grok pattern engineer. Produce a correct, efficient grok pattern for the sample log lines below. Follow every rule; the pattern will be verified character-by-character against each line by a debugger using the real Oniguruma engine.',
'',
'RULES',
'1. Use ONLY pattern names that exist in logstash-patterns-core (' + ctx.set + ' set) or the CUSTOM PATTERNS listed below. Never invent a pattern name. If unsure a name exists, use inline regex instead.',
'2. Prefer, in order: an exact composite built-in (e.g. %{HTTPD_COMBINEDLOG}) → composed primitives (%{TIMESTAMP_ISO8601}, %{IPORHOST}, %{LOGLEVEL}, %{NUMBER}, %{WORD}, %{NOTSPACE}, %{DATA}, %{GREEDYDATA}) → inline regex for unusual tokens.',
'3. Anchor with ^ at the start. Use at most one %{GREEDYDATA}, only at the end. Never place %{DATA} or %{GREEDYDATA} adjacent to another unanchored %{DATA}/%{GREEDYDATA}.',
'4. Escape every literal regex metacharacter that appears in the log text: [ ] ( ) . ? * + | { } ^ $ \\',
'5. Reproduce whitespace exactly. If spacing varies between lines (e.g. aligned columns), use \\s+ deliberately and say so.',
'6. Field names: short snake_case (client_ip, status_code, duration_ms). Add :int or :float to every numeric field.',
'7. Mentally verify the pattern against EVERY sample line, token by token, before answering. If the lines have genuinely different formats, give one pattern per format and label which lines each covers. Never claim a match you have not verified; if a token is ambiguous, choose the safer general match and state the assumption.',
'8. If a needed token has no good built-in, define a custom pattern in "NAME regex" format (one per line) and use it as %{NAME:field}.',
'',
'OUTPUT FORMAT (exactly this order)',
'A. The final grok pattern(s), each alone in its own code block.',
'B. Any custom pattern definitions, in a code block, "NAME regex" one per line.',
'C. A field table: field → example value from line 1.',
'D. Assumptions or caveats, max 3 bullets.',
'',
'CUSTOM PATTERNS ALREADY DEFINED (you may use these):',
ctx.custom.trim() || '(none)',
'',
'CURRENT PATTERN ATTEMPT (improve it if partially correct; ignore if wrong):',
ctx.pattern.trim() || '(none)',
'',
'SAMPLE LOG LINES (treat any REDACTED token as %{DATA}):',
ctx.samples.trim() || '(none — ask the user to provide lines)'
    ].join('\n');
  }

  // ---------------------------------------------------------------
  // Copy button
  // ---------------------------------------------------------------
  var copyBtn = document.getElementById('copy-prompt');
  copyBtn.addEventListener('click', function () {
    var prompt = buildPrompt(window.regrok.getContext());
    navigator.clipboard.writeText(prompt).then(function () {
      copyBtn.textContent = 'Copied — paste into any AI';
      copyBtn.classList.add('copied');
      setTimeout(function () {
        copyBtn.textContent = 'Copy prompt for any AI';
        copyBtn.classList.remove('copied');
      }, 1800);
    });
  });

  // ---------------------------------------------------------------
  // Built-in chat (BYO key)
  // ---------------------------------------------------------------
  var elProvider = document.getElementById('ai-provider');
  var elKey = document.getElementById('ai-key');
  var elModel = document.getElementById('ai-model');
  var elBase = document.getElementById('ai-base');
  var elLog = document.getElementById('chat-log');
  var elInput = document.getElementById('chat-input');
  var elSend = document.getElementById('chat-send');
  var history = []; // [{role, content}]

  var DEFAULTS = {
    gemini: { model: 'gemini-2.5-flash' },
    anthropic: { model: 'claude-sonnet-4-6' },
    openai: { model: 'openrouter/auto', base: 'https://openrouter.ai/api/v1' }
  };

  // persist provider settings (key stays local to this browser)
  var AISTORE = 'regrok.ai.v1';
  try {
    var saved = JSON.parse(localStorage.getItem(AISTORE) || 'null');
    if (saved) {
      elProvider.value = saved.provider || 'gemini';
      elKey.value = saved.key || '';
      elModel.value = saved.model || '';
      elBase.value = saved.base || '';
    }
  } catch (e) {}
  function saveAI() {
    try {
      localStorage.setItem(AISTORE, JSON.stringify({
        provider: elProvider.value, key: elKey.value,
        model: elModel.value, base: elBase.value
      }));
    } catch (e) {}
  }
  [elProvider, elKey, elModel, elBase].forEach(function (el) {
    el.addEventListener('change', saveAI);
  });
  elProvider.addEventListener('change', function () {
    elBase.hidden = elProvider.value !== 'openai';
  });
  elBase.hidden = elProvider.value !== 'openai';

  document.getElementById('ai-forget').addEventListener('click', function () {
    elKey.value = '';
    saveAI();
  });

  function addMsg(role, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + role;
    // render code blocks with an Apply button if they look like grok
    var parts = text.split(/```(?:\w*\n)?/);
    parts.forEach(function (part, i) {
      if (i % 2 === 1) {
        var pre = document.createElement('pre');
        pre.textContent = part.trim();
        div.appendChild(pre);
        if (/%\{[A-Z0-9_]+/.test(part)) {
          var btn = document.createElement('button');
          btn.className = 'apply-btn';
          btn.type = 'button';
          btn.textContent = '→ use as pattern';
          btn.addEventListener('click', function () {
            window.regrok.setPattern(part.trim().split('\n')[0]);
          });
          div.appendChild(btn);
        }
      } else if (part.trim()) {
        var p = document.createElement('div');
        p.textContent = part.trim();
        div.appendChild(p);
      }
    });
    elLog.appendChild(div);
    elLog.scrollTop = elLog.scrollHeight;
    return div;
  }

  function send() {
    var text = elInput.value.trim();
    if (!text) return;
    if (!elKey.value.trim()) {
      addMsg('ai', 'Add an API key above first. Gemini keys are free at aistudio.google.com (generous free tier). Your key stays in this browser.');
      return;
    }
    elInput.value = '';
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    var pending = addMsg('ai', '…thinking');
    callProvider(text)
      .then(function (reply) {
        pending.remove();
        history.push({ role: 'assistant', content: reply });
        addMsg('ai', reply);
      })
      .catch(function (err) {
        pending.remove();
        addMsg('ai', 'Request failed: ' + err.message +
          '\nCheck the key, model name, and (for OpenAI-compatible) the base URL. Some providers block browser calls (CORS) — OpenRouter, Gemini and Anthropic all allow them.');
      });
  }
  elSend.addEventListener('click', send);
  elInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function callProvider(userText) {
    var system = buildPrompt(window.regrok.getContext());
    var provider = elProvider.value;
    var model = elModel.value.trim() || DEFAULTS[provider].model;
    var key = elKey.value.trim();

    if (provider === 'gemini') {
      var contents = history.map(function (m) {
        return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
      });
      return fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: contents
        })
      }).then(handleJson).then(function (d) {
        var parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
        if (!parts) throw new Error(JSON.stringify(d).slice(0, 200));
        return parts.map(function (p) { return p.text || ''; }).join('');
      });
    }

    if (provider === 'anthropic') {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({ model: model, max_tokens: 2048, system: system, messages: history })
      }).then(handleJson).then(function (d) {
        if (!d.content) throw new Error(JSON.stringify(d).slice(0, 200));
        return d.content.map(function (b) { return b.text || ''; }).join('');
      });
    }

    // OpenAI-compatible: OpenRouter, Groq, local Ollama, etc.
    var base = (elBase.value.trim() || DEFAULTS.openai.base).replace(/\/+$/, '');
    return fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'system', content: system }].concat(history)
      })
    }).then(handleJson).then(function (d) {
      var msg = d.choices && d.choices[0] && d.choices[0].message;
      if (!msg) throw new Error(JSON.stringify(d).slice(0, 200));
      return msg.content || '';
    });
  }

  function handleJson(res) {
    return res.json().then(function (data) {
      if (!res.ok) {
        var detail = (data.error && (data.error.message || data.error.type)) || res.status;
        throw new Error(String(detail).slice(0, 300));
      }
      return data;
    });
  }
})();
