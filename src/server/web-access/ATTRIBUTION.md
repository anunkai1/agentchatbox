# Web Access (vendored from pi-web-access)

The TypeScript modules in this directory are vendored from the npm package
[`pi-web-access`](https://github.com/nicobailon/pi-web-access) by Nico Bailon
(MIT license). Upstream version: 0.10.7.

## What is vendored

The workhorse modules — search providers, URL extraction, GitHub cloning, PDF
extraction, YouTube handling, and shared helpers. None of these import the
`@mariozechner/pi-coding-agent` extension API; they are pure-Node.

## What is not vendored

- `index.ts` — the upstream extension entry point (uses `ExtensionAPI`).
- `curator-page.ts`, `curator-server.ts` — terminal-windowed curator UI and
  its ephemeral HTTP+SSE server. Replaced in agentchatbox by a WS-based
  curator flow rendered in the existing web modal.
- `storage.ts` — session-aware result store using pi's `ExtensionContext`.
  Replaced by a simple in-memory store keyed by WebSocket session id.
- `summary-review.ts` — model-based summary drafting using pi-ai's `complete`.
  Replaced by a direct call to whichever LLM the user has configured, gated
  behind a feature flag (default off).
- `chrome-cookies.ts`, `gemini-web.ts`, `gemini-web-config.ts` — Chromium
  cookie extraction for "Gemini Web" provider. Out of scope per project
  constraints (local-first, no browser cookies).

## Modifications from upstream

- `gemini-search.ts`: Perplexity provider branch removed (paid-only).
- `gemini-url-context.ts`: Gemini Web branch removed (needs cookies).
- `youtube-extract.ts`: `extractYouTubeWeb` removed (needs cookies).
- `video-extract.ts`: `extractVideoWeb` removed (needs cookies).
- `extract.ts`: callers of the removed `*Web` functions updated to fall through
  to the next strategy.

## License

MIT — see `LICENSE` file in the upstream repo.

```
MIT License

Copyright (c) 2024 Nico Bailon
```
