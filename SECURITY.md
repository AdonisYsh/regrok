# Security Policy

## Threat model

regrok is a fully client-side static site. There is no backend, no database,
no accounts, no cookies, and no analytics. Consequences of that:

- **Log lines and patterns never leave the browser.** All matching runs in a
  Web Worker via WebAssembly (Oniguruma).
- **API keys** for the optional AI assist are stored in the browser's
  `localStorage` and sent directly to the provider you choose (Anthropic,
  Google, or an OpenAI-compatible endpoint). They are never sent to any
  server operated by this project — there isn't one. Anyone with access to
  your browser profile can read them; use the "forget key" button on shared
  machines.
- The main risks we defend against are **cross-site scripting** (all
  user- and AI-supplied strings are escaped before rendering; a CSP meta tag
  restricts scripts to same-origin and network calls to the known AI
  endpoints), **regex denial of service** (a watchdog terminates and restarts
  the worker if a pattern runs longer than 5 seconds), and **supply-chain
  tampering** (vendored assets are committed to the repo and reviewed;
  Dependabot, CodeQL, Semgrep, Trivy, and gitleaks run in CI).

## Supported versions

Only the latest deployed version (the tip of `main`) is supported. The
service worker updates clients automatically on their next online visit
after a release.

## Reporting a vulnerability

Please **do not open a public issue for security reports.** Instead:

- Use GitHub's private vulnerability reporting
  (*Security → Report a vulnerability* on the repository) — **preferred**;
  reports sent this way are triaged automatically, or
- Email **regrok.security.reports@gmail.com** with a description,
  reproduction steps, and impact.

You can expect an acknowledgment within 7 days. Fixes for confirmed issues
are released as fast as severity warrants; you'll be credited in the release
notes unless you prefer otherwise.

## Scope notes

- ReDoS against your **own** browser tab via a pattern you typed yourself is
  handled by the watchdog but is not considered a vulnerability.
- Issues requiring a compromised browser, extension, or machine are out of
  scope (localStorage key theft by other software on the same profile, etc.).
