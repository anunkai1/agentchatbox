# agentchatbox

A web chat interface for the [pi coding agent](https://pi.dev). The browser is a thin renderer — the server owns the agent, runs the tools, holds the API keys, and pushes every step of the run back over a single WebSocket.

- Streaming responses, model picker, thinking levels
- File / image / voice attachments (image bytes go straight to multimodal models)
- Persistent sessions in browser IndexedDB
- Local TTS (Piper) and STT (faster-whisper) — no paid cloud APIs
- Slash commands, model switching mid-conversation, session history
- Local filesystem and shell tools for the agent (`bash`, `read`, `write`, `edit`, `ls`)
- Built-in web access tools (`web_search`, `fetch_content`, `code_search`)

## Architecture

```
Browser (vanilla DOM, no framework)
  │  WS /api/chat      — bidirectional: prompts ↔ Agent events
  │  POST /api/upload  — multipart file upload
  │  POST /api/transcribe — audio → text (Whisper)
  │  POST /api/tts     — text → audio (Piper)
  │  GET  /api/models  — list of models with configured API keys
  │  GET  /api/health  — liveness + provider list
  │  GET  /api/changelog — last N commits
  ▼
Node server (this repo)
  │  one Agent per WebSocket
  │  local tools: bash, read, write, edit, ls
  │  web tools:  web_search, fetch_content, code_search
  │  streamSimple() → provider SDK
  ▼
LLM providers (Anthropic, OpenAI, Google, DeepSeek, MiniMax, …)
```

The server is the only thing that touches provider APIs. API keys live in `.env`; the browser never sees them.

## Source layout

```
src/
  client/                 # browser-side renderer (bundled to public/app.js)
    main.ts               # boot, send, history, event dispatcher
    render.ts             # renderShell + message renderers + status bar
    slashes.ts            # /model, /think, /clear, /sessions, /export, ...
    voice.ts              # TTS playback + MediaRecorder + file attach
    state.ts              # AppState, PersistedMessage, IndexedDB
    dom.ts                # $ / el / text helpers, uuid fallback
    ws.ts                 # WebSocket client wrapper
    api.ts                # REST helpers (upload, transcribe, tts, models, health)
    styles.css
  server/
    index.ts              # Express bootstrap + route mounting
    chat.ts               # WebSocket /api/chat: one Agent per connection
    agent.ts              # Server-side Agent factory (model + tools + system prompt)
    tools.ts              # bash, read, write, edit, ls
    web-tools.ts          # web_search, fetch_content, code_search
    web-access/           # extracted third-party web tooling
    proxy.ts              # legacy POST /api/stream (SSE) back-compat
    uploads.ts            # /api/upload
    transcribe.ts         # /api/transcribe (faster-whisper)
    tts.ts                # /api/tts (piper)
    paths.ts              # projectRoot (cwd-independent)
    config.ts             # .env → ServerConfig
  shared/
    protocol.ts           # types shared by client and server
tests/                    # vitest, server-side
scripts/                  # build + dev helpers
  build-client.mjs        # esbuild bundler for the client
  _archive/               # throwaway test scripts (gitignored, see .gitignore)
```

## Run locally

Requires Node 20+.

```bash
git clone https://github.com/anunkai1/agentchatbox
cd agentchatbox
npm install
cp .env.example .env
# edit .env to add at least one provider key
npm run dev
```

`npm run dev` runs the server and the client bundler in watch mode — changes to `src/` reload automatically. By default the server listens on `http://0.0.0.0:3000`; set `PORT` in `.env` to change it. The client is served by the server itself (no separate Vite dev server).

## Production build

```bash
npm run build   # bundles client to public/, compiles server to dist/
npm start       # node dist/server/index.js
```

## Environment

Everything goes through `.env`. Keys for the providers you want to use; an empty value means the provider simply isn't shown in the model picker.

| Variable               | Default       | Purpose                                        |
|------------------------|---------------|------------------------------------------------|
| `PORT`                 | `3000`        | HTTP port                                      |
| `HOST`                 | `0.0.0.0`     | Bind address                                   |
| `UPLOADS_DIR`          | `./uploads`   | Where multipart uploads land                   |
| `MAX_UPLOAD_BYTES`     | `52428800`    | 50 MB upload cap                               |
| `*_API_KEY`            | (unset)       | One per provider — see `src/server/config.ts`  |

Provider keys currently recognised: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `MiniMax_API_KEY`, `HUGGINGFACE_API_KEY`, `FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `VERCEL_AI_GATEWAY_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `OPENCODE_API_KEY`. Only providers with a key are exposed via `/api/models`.

## Endpoints

| Method | Path                  | Purpose                                                |
|--------|-----------------------|--------------------------------------------------------|
| POST   | `/api/stream`         | Legacy SSE proxy (single LLM call) — back-compat only  |
| POST   | `/api/upload`         | Multipart file upload                                  |
| GET    | `/uploads/:filename`  | Download a previously uploaded file                    |
| DELETE | `/uploads/:filename`  | Remove an upload                                       |
| POST   | `/api/transcribe`     | Audio → text (faster-whisper)                          |
| POST   | `/api/tts`            | Text → audio (piper)                                   |
| GET    | `/api/health`         | `{ status, providers, whisper, tts, ttsVoice }`        |
| GET    | `/api/models`         | List of available models (only configured providers)   |
| GET    | `/api/changelog?limit=N` | Last N git commits, for `/changelog` slash command  |
| WS     | `/api/chat`           | The main channel — see below                           |
| GET    | `/`                   | Built web UI                                           |

### WebSocket protocol (`/api/chat`)

One connection per session. The server creates an `Agent` on connect, subscribes to its events, and forwards them as JSON frames:

```ts
// client → server
{ type: "prompt", text: string, images?: PromptImage[] }
{ type: "abort" }
{ type: "setModel", modelId: string, provider: string }
{ type: "setThinking", level: ThinkingLevel }

// server → client
{ type: "ready", modelId, provider, thinkingLevel }
{ type: "event", event: AgentEvent }
{ type: "error", message: string }
```

The full union of `AgentEvent` is from `@earendil-works/pi-agent-core`. The client mirrors these to the DOM (message_start, message_update for streaming tokens, tool_execution_start/end, agent_end, etc.).

## Run as a system service

Example `/etc/systemd/system/agentchatbox.service`:

```ini
[Unit]
Description=agentchatbox
After=network.target

[Service]
Type=simple
User=architect
WorkingDirectory=/home/architect/agentchatbox
EnvironmentFile=/home/architect/agentchatbox/.env
ExecStart=/usr/bin/node /home/architect/agentchatbox/dist/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentchatbox
```

## Testing

```bash
npm test          # vitest run (server-side unit + integration)
npm run typecheck # tsc, both server and client configs
npm run build     # full production build
```

CI runs all three on push to `main` and on PRs. Tests live in `tests/`.

## Why a server-side agent?

The original prototype ran the agent in the browser and proxied LLM calls through a small Node server so the API keys never left the machine. That worked, but had two real problems:

1. **Tools can't run in a browser.** Anything that needs a shell, a filesystem, or a database needs Node — so we ended up with two execution models (browser for the agent, server for tools) and a constant back-and-forth over SSE.
2. **Per-connection state is fragile.** WebSocket reconnects, page reloads, and tab throttling all interrupted the agent mid-run.

The current model is the simpler one: the server owns the agent, the browser just renders events. Tools are normal Node code. Reconnects are cheap (new agent, replay messages). API keys are still server-only — the browser still has zero access to them.

## Related

- [pi](https://pi.dev) — the coding agent
- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) — unified LLM API
- [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) — agent loop
- [`@earendil-works/pi-web-ui`](https://github.com/earendil-works/pi) — the upstream project this UI is inspired by. We don't use its components (vanilla DOM, no framework) but its bundled stylesheet (`app.css`, Tailwind v4 + KaTeX) is copied into `public/app.css` at build time.

## License

MIT
