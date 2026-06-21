# agentchatbox

A web chat interface for the [pi coding agent](https://pi.dev). The browser is a thin renderer — the server is a thin transport layer that spawns a `pi --mode rpc` subprocess per WebSocket connection, forwards its events to the browser, and translates client messages into pi RPC commands. The actual agent logic (tools, model routing, system prompt, streaming) lives entirely inside the `pi` subprocess.

- Streaming responses, model picker, thinking levels
- File / image / voice attachments (image bytes go straight to multimodal models)
- Persistent sessions on disk (`pi` manages JSONL files — survive page reloads and server restarts)
- Local TTS (Piper, 1.4× playback) and STT (faster-whisper) — no paid cloud APIs
- Slash commands, model switching mid-conversation, session history / resume / rename
- Session list / transcript replay via `/api/sessions`

## Architecture

```
Browser (vanilla DOM, no framework)
  │  WS /api/chat       — bidirectional: init handshake, prompts ↔ pi events
  │  POST /api/upload   — multipart file upload
  │  POST /api/transcribe — audio → text (Whisper)
  │  POST /api/tts      — text → audio (Piper)
  │  GET  /api/models   — list of models with configured API keys
  │  GET  /api/sessions — list pi sessions for the server's cwd
  │  GET  /api/health   — liveness + provider list
  │  GET  /api/changelog — last N commits
  ▼
Node server (this repo) — TRANSPORT LAYER
  │  one `pi --mode rpc` subprocess per WebSocket connection
  │  forwards pi stdout NDJSON → browser as {type:"event", event:<line>}
  │  translates client WS messages → pi RPC commands on stdin
  │  session resume: kill child, respawn with --session <id>, replay transcript
  ▼
pi --mode rpc subprocess (the actual coding agent)
  │  tools: bash, read, write, edit, ls, web_search, fetch_content, code_search
  │  writes session JSONL to ~/.pi/agent/sessions/
  │  model routing, system prompt, streaming — all inside pi
  ▼
LLM providers (Anthropic, OpenAI, Google, DeepSeek, MiniMax, …)
```

The server is just a pipe. It owns the WebSocket framing, subprocess lifecycle, session listing/resume (reading pi's JSONL files), and the upload/transcribe/tts HTTP endpoints. The browser never touches provider APIs — API keys live in `.env` and are passed to each `pi` child via `--api-key`.

## Source layout

```
src/
  client/                 # browser-side renderer (bundled to public/app.js)
    main.ts               # boot, send, history, event dispatcher, init handshake
    render.ts             # renderShell + message renderers + status bar
    slashes.ts            # /model, /think, /clear, /sessions, /export, ...
    voice.ts              # TTS playback (1.4×) + MediaRecorder + file attach
    state.ts              # AppState, PromptImage map (no IndexedDB — sessions on disk)
    dom.ts                # $ / el / text helpers, uuid fallback
    ws.ts                 # WebSocket client (init, listSessions, resumeSession, ...)
    api.ts                # REST helpers (upload, transcribe, tts, models, health)
    styles.css
  server/
    index.ts              # Express bootstrap + route mounting
    chat.ts               # WS /api/chat: thin pipe to pi --mode rpc subprocess
    pi-process.ts         # PiProcess: spawns pi, strict \n NDJSON splitter, kill with SIGTERM→SIGKILL
    session-list.ts       # listPiSessions / readPiSessionMessages (reads pi JSONL files)
    config.ts             # .env → ServerConfig (piBin, piCwd, apiKeys)
    paths.ts              # projectRoot (cwd-independent)
    providers.ts          # SDK_PROVIDERS + KNOWN_PROVIDERS (source of truth for provider list)
    uploads.ts            # /api/upload
    transcribe.ts         # /api/transcribe (faster-whisper)
    tts.ts                # /api/tts (piper)
    proxy.ts              # legacy POST /api/stream (SSE) — back-compat only
  shared/
    protocol.ts           # types shared by client and server
tests/                    # vitest, server-side
scripts/                  # build + dev helpers
  build-client.mjs        # esbuild bundler for the client
  _archive/               # throwaway test scripts (gitignored, see .gitignore)
```

## Run locally

Requires Node 20+ and the `pi` CLI on your `$PATH`.

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

| Variable                       | Default                       | Purpose                                        |
|--------------------------------|-------------------------------|------------------------------------------------|
| `PORT`                         | `3000`                        | HTTP port                                      |
| `HOST`                         | `0.0.0.0`                     | Bind address                                   |
| `UPLOADS_DIR`                  | `<root>/uploads`              | Where multipart uploads land                   |
| `MAX_UPLOAD_BYTES`             | `52428800`                    | 50 MB upload cap                               |
| `PI_BIN`                       | `pi`                          | Path to the `pi` CLI binary (overridable for tests) |
| `PI_CWD`                       | `process.cwd()`               | Working directory passed to `pi` as project root |
| `PYTHON_BIN`                   | `python3`                     | Python binary for Piper (TTS) + Whisper (STT)  |
| `PIPER_VOICE`                  | `en_US-amy-medium`            | Piper TTS voice model                           |
| `PI_CODING_AGENT_SESSION_DIR`  | `~/.pi/agent/sessions`        | Where pi stores JSONL session files             |
| `*_API_KEY`                    | (unset)                       | One per provider — see `src/server/config.ts`  |

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
| GET    | `/api/health`         | `{ status, commit, providers, whisper, tts, ttsVoice }` |
| GET    | `/api/models`         | List of available models (only configured providers)   |
| GET    | `/api/sessions`       | List pi sessions for the server's cwd (`?cwd=<path>`)  |
| GET    | `/api/sessions/:id`   | Full message transcript for a session                  |
| GET    | `/api/changelog?limit=N` | Last N git commits, for `/changelog` slash command  |
| WS     | `/api/chat`           | The main channel — see below                           |
| GET    | `/`                   | Built web UI                                           |

### WebSocket protocol (`/api/chat`)

One connection per session. The client must send `init` as its first message; the server spawns a `pi --mode rpc` child, waits for its session id via `get_state` polling, then sends `ready`. From then on, every pi event is forwarded as a JSON frame.

```ts
// client → server
{ type: "init", provider, modelId, thinkingLevel, sessionId? }  // FIRST message — spawns pi child
{ type: "prompt", text: string, images?: PromptImage[] }
{ type: "abort" }
{ type: "setModel", modelId: string, provider: string }
{ type: "setThinking", level: ThinkingLevel }
{ type: "listSessions" }
{ type: "newSession" }          // kill child, spawn fresh
{ type: "resumeSession", sessionId: string }  // kill child, respawn with --session <id>
{ type: "renameSession", name: string }

// server → client
{ type: "ready", modelId, provider, thinkingLevel, sessionId }  // child spawned, ready for prompts
{ type: "event", event: <piRpcLine> }      // every NDJSON line from pi stdout, verbatim
{ type: "sessions", sessions: SessionSummary[] }  // response to listSessions
{ type: "transcript", sessionId, messages: Message[] }  // prior transcript on resume
{ type: "sessionResumed", sessionId, modelId, provider, thinkingLevel }
{ type: "error", message: string }
```

The `event` frames are whatever `pi --mode rpc` emits on stdout — the same event stream the TUI would see (`message_update` for streaming tokens, `tool_execution_start`/`end`, `agent_end`, etc.). The client's renderer handles the full `pi` event surface; unknown types are ignored.

**Session lifecycle:** `newSession` kills the current child and spawns a fresh one (no `--session`). `resumeSession` kills the current child, spawns with `--session <id>`, and replays the prior transcript (read from disk) as a `transcript` message before live events flow. The WS is NOT closed during respawn — the client gets a new `ready` when the new child comes up.

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

## Why a subprocess architecture?

The original prototype ran the agent in-process (Node-side Agent factory with local tools). That worked, but coupling the agent lifecycle to the web server meant:

1. **Tool dependencies leaked into the server.** Every tool (bash, web access, file ops) was server code that had to be maintained, tested, and kept compatible with the agent SDK — duplicating what `pi` already does natively.
2. **Agent crashes took down the server.** An unhandled error in the agent loop killed the whole process, including unrelated connections.

The current model is simpler: the server spawns `pi --mode rpc` per connection, forwards its stdout to the browser, and translates client messages into pi RPC commands on stdin. The server is just a pipe — the actual agent logic (tools, model routing, streaming, system prompt) lives inside `pi`, where it belongs. If a child crashes, only that WS connection sees it; the server and other connections are unaffected.

## Related

- [pi](https://pi.dev) — the coding agent
- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) — unified LLM API
- [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) — agent loop
- [`@earendil-works/pi-web-ui`](https://github.com/earendil-works/pi) — the upstream project this UI is inspired by. We don't use its components (vanilla DOM, no framework) but its bundled stylesheet (`app.css`, Tailwind v4 + KaTeX) is copied into `public/app.css` at build time.

## License

MIT
