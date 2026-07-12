# regrok

[![Security scans](https://github.com/AdonisYsh/regrok/actions/workflows/security.yml/badge.svg)](https://github.com/AdonisYsh/regrok/actions/workflows/security.yml)
[![CodeQL](https://github.com/AdonisYsh/regrok/actions/workflows/codeql.yml/badge.svg)](https://github.com/AdonisYsh/regrok/actions/workflows/codeql.yml)
[![Deploy](https://github.com/AdonisYsh/regrok/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/AdonisYsh/regrok/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**A grok & dissect debugger that keeps up.** 100% in-browser, works offline, private by construction — running the same regex engine family as real Logstash.

Paste log lines, type a pattern, and watch every line light up live. Each extracted field gets its own color, identical in the highlighted log line and the results table. Lines that *don't* match tell you exactly where they broke.

**Try it:** deploy to GitHub Pages in two clicks (below), or run locally with one command.

## Features

- **Grok engine** — [vscode-oniguruma](https://github.com/microsoft/vscode-oniguruma) compiled to WebAssembly: the Oniguruma regex family Logstash's grok uses, so behavior matches production. Patterns are expanded and compiled once, then LRU-cached; matching runs in a Web Worker so the page never freezes, even on pathological patterns.
- **Dissect engine** — a second tab implementing Logstash-style [Dissect](https://www.elastic.co/guide/en/logstash/current/plugins-filters-dissect.html): no regex at all, just delimiter splitting (`%{field}`, `%{}` skip, `%{f->}` padding, `%{+f}` append). Dramatically faster for fixed-shape logs; production pipelines often try Dissect first and fall back to grok.
- **Partial-match diagnosis** — when a line doesn't match, regrok compiles prefix patterns token by token and reports: *"matches up to here, then fails at `%{NUMBER:status:int}`"*, with the matching prefix highlighted right in the line. No more staring at a silent "no match".
- **Full offline support (PWA)** — after one visit, every asset is cached; the app works with zero internet and can be installed from the browser menu like a native app. Matching was always local anyway.
- **Complete official pattern library** — both ECS v1 and legacy sets from [logstash-patterns-core](https://github.com/logstash-plugins/logstash-patterns-core) (678 patterns), searchable, click-to-insert, core primitives listed first.
- **Custom patterns without ceremony** — a plain textarea in the exact `NAME regex` format Logstash pattern files use. Comments allowed, auto-saved, import/export as a file.
- **Type coercion** — `:int` / `:float` produce real numbers; results as a table or copy-ready JSON (one-click **copy json** / **copy pattern** buttons).
- **Built for big pastes** — the match bench and results panels scroll in place instead of stretching the page, so hundreds of log lines stay manageable.
- **Expanded regex viewer** — see exactly what your grok expands to.
- **AI assist, privacy-first**:
  - *Copy prompt for any AI*: one click builds a rigorously engineered prompt (with rules against invented pattern names, unescaped metacharacters, GREEDYDATA abuse, and unverified answers) that embeds your sample lines, current pattern, and custom patterns. Paste into any chatbot.
  - *Built-in chat (optional, bring your own key)*: Google Gemini, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq, local Ollama). Keys live in your browser's localStorage; calls go straight from your browser to the provider. There is no backend server, period. AI replies containing grok patterns get a one-click **→ use as pattern** button — and regrok immediately *verifies* what the AI claimed.

## Privacy

The debugger has no server. Log lines, patterns, and API keys never leave your browser. The only feature that can send data anywhere is the AI assist, using your own key, to your chosen provider — review and redact sample lines first (replace secrets with the literal word `REDACTED`; the prompt tells the AI to treat those as `%{DATA}`).

## Security

**Threat model.** regrok is a static site with no backend: no accounts, no cookies, no analytics, no data collection. What runs is what you see in this repo — no build step, no minification of first-party code. The attack surface reduces to three things, each with a specific defense:

1. **Cross-site scripting** — sample lines, patterns, custom pattern files, and AI chat replies are all untrusted input that gets rendered. Every interpolation into HTML goes through an escaper (or `textContent`), and a Content-Security-Policy meta tag pins scripts to same-origin and network access to the known AI endpoints only.
2. **Regex denial of service** — grok compiles to real Oniguruma regex, which can backtrack catastrophically. Matching runs in a Web Worker, so the page never freezes; a watchdog terminates and restarts the worker if a job exceeds 5 seconds.
3. **Supply chain** — the only bundled third-party code is `vendor/` (vscode-oniguruma + the official Logstash patterns), committed and reviewed rather than fetched from a CDN at runtime. The CSP would block any external script regardless. CI runs npm audit, Trivy, Semgrep (javascript + OWASP Top Ten), gitleaks, and CodeQL on every push.

**API keys** (optional AI assist) live in your browser's `localStorage` and are sent directly to the provider you configured, over TLS. Nothing proxies them. Treat them like any browser-stored credential: use the "forget key" button on shared machines.

Found something? See [SECURITY.md](SECURITY.md) for private reporting.

## Run it

**Locally** — any static file server works:

```bash
python3 -m http.server 8000        # or: npx serve .
# then open http://localhost:8000
```

> Don't open `index.html` via `file://` — browsers block Web Workers and WASM on the file protocol.

**GitHub Pages** — free hosting straight from the repo:

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. Push to `main` — the included workflow (`.github/workflows/deploy-pages.yml`) deploys automatically. Visit the site once and it's cached for offline use forever after.

## AI provider suggestions

For free usage with generous limits: **Google Gemini** (free API key at [AI Studio](https://aistudio.google.com)) works with the built-in chat out of the box. **OpenRouter** lists free models (use the OpenAI-compatible provider option). Or skip keys entirely and use *Copy prompt for any AI* with whatever chatbot you already have.

## Architecture

All client-side, no build step — view source and edit:

```
pattern ──▶ grok.js     expands %{NAME:field:type} recursively into one
                        Oniguruma regex (cycle-safe), or
            dissect.js  compiles a delimiter plan (no regex)
        ──▶ worker.js   compiles/caches and matches every line off the
                        main thread; diagnoses misses via prefix patterns
        ──▶ app.js      paints capture spans + field tables, one color
                        per field; debounces input; discards stale results
            ai.js       prompt builder + direct-to-provider API calls
            sw.js       offline cache (PWA)
            vendor/     onig.wasm engine + bundled official patterns
```

## Tests

```bash
npm install   # dev-only: pulls vscode-oniguruma so tests can run in Node
npm test
```

## License

MIT for this code. Bundled grok patterns are Apache-2.0 from Elastic; the regex engine is MIT from Microsoft (embedding the BSD-2-Clause Oniguruma C library) — see `NOTICE` and [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full texts.
