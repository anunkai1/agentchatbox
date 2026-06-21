# agentchatbox → pi-CLI parity plan

**Repo:** `https://github.com/anunkai1/agentchatbox`
**Branch:** `feature/pi-cli-server-agent` (off `main` @ `9f0af9c`)
**Goal:** the web chat at http://0.0.0.0:3500/ should feel and behave
exactly like the pi CLI. After this lands, future work layers on documents,
files, and two-way voice.

> **Note (2026-06-22):** this plan was rewritten to match the code on
> `feature/pi-cli-server-agent`. The original plan called for the server
> to host the `pi` Agent and implement tools in TypeScript; the actual
> implementation does neither. See "Architecture" below for what was
> built instead, and "Why the architecture changed" at the bottom for
> the rationale.

---

## Architecture

```
Browser (vanilla DOM, no framework — pure renderer)
  │  WS /api/chat         (init handshake, prompt/abort, then forward pi events)
  │  POST /api/upload     (file attachments — base64 passed to multimodal models)
  │  POST /api/transcribe (audio → text via local faster-whisper)
  │  POST /api/tts        (text → audio via local piper)
  │  GET  /api/models     (model picker; only providers with keys)
  │  GET  /api/sessions   (pi session list)
  │  GET  /api/changelog  (git log for /changelog slash)
  │  GET  /api/health     (server liveness + provider list)
  ▼
Node server (this repo) — TRANSPORT LAYER ONLY
  │  one `pi --mode rpc` subprocess per WebSocket connection
  │  forwards every NDJSON line from pi stdout → browser as {type:"event",event:<line>}
  │  translates client WS messages → pi RPC commands on child stdin
  │  session resume: kill child, respawn with --session <id>, replay prior transcript
  │  REST endpoints for upload/transcribe/tts/models/sessions/changelog/health
  ▼
pi --mode rpc subprocess (the actual coding agent — see https://pi.dev)
  │  owns the Agent, tools (bash, read, write, edit, ls, web_search, fetch_content, code_search),
  │  model routing, system prompt, streaming, JSONL session persistence
  │  writes every event to ~/.pi/agent/sessions/--<cwd>--/<ts>_<sessionId>.jsonl
  ▼
LLM providers (Anthropic, OpenAI, Google, DeepSeek, MiniMax, …)
```

The server is a pipe. It owns the WebSocket framing, subprocess lifecycle,
session listing/resume (reading pi's JSONL files), and the upload / transcribe
/ tts HTTP endpoints. The browser never touches provider APIs — API keys live
in `.env` and are passed to each `pi` child via `--api-key`. Tool calls
emitted by the model are executed inside the `pi` subprocess (with pi's own
sandbox policy), not in the browser.

---

## Locked-in decisions (user-confirmed 2026-06-13)

| # | Decision | Value |
|---|----------|-------|
| 1 | Sandbox | **None.** Tools run inside `pi`, which has its own policy; the server does not implement or restrict tool execution. Bash inherits full env. |
| 2 | Default model | `MiniMax-M3` (provider `minimax`, `reasoning: true`). Env: `MiniMax_API_KEY`. |
| 3 | Default thinking | `high` |
| 4 | CLI parity | Match the real pi CLI for every tool interaction — no "good enough" shortcuts |
| 5 | Voice transcription | **Local** via `faster-whisper` on CPU (no OpenAI key, no paid API) |
| 6 | TTS / voice receive | **Local** via `piper-tts` on CPU (no paid API) |
| 7 | Bash permission prompt | **No** — matches "feels like CLI" priority (model just runs) |
| 8 | Server bind | `0.0.0.0:3500` (code default is `3000`, overridden via `PORT=3500` in `.env` because grafana already owns 3000 on this host) |
| 9 | Old browser-side Agent code | **Delete entirely**, no fallback path |
| 10 | Old SSE `/api/stream` proxy | **Kept** as a no-op back-compat shim (not removed) |

These decisions are final. Implementation mirrors them.

---

## What's done (as of 2026-06-22)

- ✅ Audited the SDK: `Agent` from `@earendil-works/pi-agent-core@0.75.3`
  accepts arbitrary `Tool[]` and emits the 8 lifecycle event types. The
  Agent has **no built-in tools** — must register them. But: rather than
  re-implementing them in the server, we let `pi --mode rpc` host them
  (it ships them built in). See "Why the architecture changed" below.
- ✅ Confirmed `pi-tui` is the terminal *reference* (differential renderer),
  not a browser library. The renderer ports pi's visual conventions to the
  DOM without using the pi-tui runtime.
- ✅ Fixed the broken `.env`: provider key was being looked up as
  `MiniMax_API_KEY` (mixed case) in `src/server/config.ts`. The example
  used the same mixed case. Renamed consistently. Server now reports
  `providers: ["minimax"]` in `/api/health` and the model picker shows
  the configured providers.
- ✅ WebSocket transport at `/api/chat` with one `pi --mode rpc` subprocess
  per connection. Init handshake, prompt/abort/setModel/setThinking/
  listSessions/newSession/resumeSession/renameSession all round-trip
  through the `pi` RPC protocol. Events from `pi` are forwarded verbatim.
- ✅ Session persistence is `pi`'s JSONL files under
  `~/.pi/agent/sessions/--<cwd>--/<ts>_<sessionId>.jsonl`. The server
  reads these for `/api/sessions`, `/api/sessions/:id`, and resume's
  transcript replay. No IndexedDB in the browser.
- ✅ Local TTS (piper) at `/api/tts` and `/api/tts/voices`. 1.4×
  playback in the browser; auto-speak on assistant-message-end
  (toggleable in the UI).
- ✅ Local STT (faster-whisper) at `/api/transcribe`. Browser
  `MediaRecorder` records webm → server → text back. Same pattern as
  before but the model now runs locally.
- ✅ Model picker driven by `/api/models` (server-side, not browser-side).
  Only providers with a configured API key are returned. Includes the
  custom `minimax` provider and a hand-listed `glm-5.2` zai model
  that's newer than the SDK's built-in registry.
- ✅ `/sessions` picker: shows pi sessions for the current cwd,
  resume via `chatClient.resumeSession(id)`, replays the prior
  transcript before live events flow.
- ✅ Vanilla DOM renderer in `src/client/{render,main,dom,slashes,voice,state,ws,api,styles.css}.ts`.
  No framework, no IndexedDB. Visual conventions follow `pi-tui`:
  monospace, dark surfaces, `› <role>` lines, expandable thinking
  blocks, tool cards with pending→result transitions, cost-aware
  status bar.
- ✅ Status bar with model label, thinking level, token total, cost,
  streaming/tts/playing indicators, and connection status.
- ✅ Slash menu: 20 commands — see `SLASH_COMMANDS` in
  `src/client/slashes.ts`.
- ✅ History (↑/↓) for prior user messages in the current session
  (in-memory ring buffer, not persisted).
- ✅ Welcome / empty state, collapsible session sidebar, mobile
  overflow menu, dark-mode theme.
- 🔧 One known issue: `pi --mode rpc` requires the user's `pi` CLI
  to be installed and on `$PATH` (or `PI_BIN`). Not a bug per se,
  but it does mean `npm start` on a fresh box without `pi` will
  fail at first WS connect, not at server boot.

---

## Build steps (as actually taken)

### Step 1 — Server: subprocess wrapper

**New file:** `src/server/pi-process.ts`

`PiProcess` is a strongly-typed wrapper over a `pi --mode rpc` child:
- spawns the binary with `--mode rpc --provider <p> --model <m>
  --api-key <k> [--thinking <lvl>] [--session <id>]`
- parses stdout as a **strict `\n` NDJSON splitter** (Node `readline`
  is not protocol-compliant — it splits on U+2028/U+2029, which are
  valid inside JSON strings; the `pi` team explicitly warns about this)
- exposes an `EventEmitter` (`"event"` with parsed object, `"exit"`,
  `"error"`)
- `send(cmd)` JSON.stringify's + `"\n"` to stdin
- `kill()` SIGTERMs and escalates to SIGKILL after 2s, giving `pi`
  a chance to flush its session JSONL before dying

**New file:** `src/server/session-list.ts`

`listPiSessions(cwd)` and `readPiSessionMessages(cwd, id)` read pi's
JSONL files from `~/.pi/agent/sessions/--<cwd>--/` (the `pi` 0.79.x
convention is `--<cwd>--` wrapping the cwd with `--` delimiters, with
all `/` replaced by `-`). Used by:
- `chat.ts` for resume's transcript replay (read messages back from
  the JSONL before live events flow)
- `index.ts` for the `/api/sessions` and `/api/sessions/:id` REST
  endpoints

### Step 2 — Server: WebSocket endpoint

**New file:** `src/server/chat.ts`

`ws` server mounted at `/api/chat`. One `pi` subprocess per connection.

Lifecycle:
1. Client connects, sends `{type:"init", provider, modelId,
   thinkingLevel, sessionId?}`. Server resolves the API key from its
   `.env` (or throws if not configured) and spawns `pi` via
   `spawnPi()`.
2. Server sends `{type:"get_state"}` to `pi` and polls every 200ms
   (until reply) to get the session id, then sends `{type:"ready"}`
   to the client. On resume, replays the prior transcript as
   `{type:"transcript", ...}` first.
3. Client sends `{type:"prompt"}`, `{type:"abort"}`,
   `{type:"setModel"}`, `{type:"setThinking"}`,
   `{type:"listSessions"}`, `{type:"newSession"}`,
   `{type:"resumeSession"}`, or `{type:"renameSession"}`. Server
   translates each into the equivalent `pi` RPC command on the
   child's stdin.
4. Every line of `pi` stdout is forwarded verbatim as
   `{type:"event", event: <line>}` to the client. The renderer's
   switch ignores unknown event types.
5. Client disconnects → server SIGTERMs the child (2s SIGKILL
   escalation). The `pi` subprocess flushes its session JSONL
   before dying.

Session resume: kills the current child, respawns with
`--session <id>`, replays the JSONL as a `transcript` message
before the live events start flowing. The WS connection is NOT
closed during respawn — the client gets a new `ready` when the
new child is up.

### Step 3 — Server: wire the WS into `index.ts`

`src/server/index.ts` mounts the WS server, the static-file
serving, the upload/transcribe/tts routers, and the
sessions/changelog/models/health REST endpoints. `/api/stream`
remains as a back-compat shim.

### Step 4 — Client: WebSocket client

**New file:** `src/client/ws.ts`

`createChatClient()` returns a `ChatClient` with: `init`, `prompt`,
`abort`, `setModel`, `setThinking`, `renameSession`, `listSessions`,
`newSession`, `resumeSession`, plus listeners: `onEvent`, `onReady`,
`onError`, `onStatus`, `onSessionsUpdated`, `onTranscript`,
`onSessionResumed`. Reconnects on close with jittered exponential
backoff (500ms / 1s / 2s / 5s / 10s, ±20%).

**`src/client/api.ts` (rewritten)** — kept for the non-WS
endpoints: `uploadFile`, `transcribeAudio`, `synthesizeSpeech`,
`listVoices`, `getHealth`, `getModels`. `proxiedStreamFn`,
`createAgent`, `attachAgentListeners`, `seedProviders`,
`getCustomProviders`, `pickDefaultModel`, `resolveModel` are all
gone.

### Step 5 — Client: renderer rewrite

**`src/client/render.ts`** (new) — pure rendering. `renderShell`
wires the UI event handlers; `renderMessageNode` projects a
`PersistedMessage` to a DOM node; `appendAssistantPlaceholder`,
`appendToolCall`, `finalizeToolCall` support in-place streaming
updates without re-rendering the whole list. Status bar
(`refreshStatus`), auto-scroll-when-pinned, welcome empty state,
mobile overflow menu.

**`src/client/main.ts`** (rewritten) — orchestrator. Boots, probes
`/api/health` + `/api/models`, opens the WebSocket, dispatches
events to the renderer. On `message_update`, mutates the last
assistant's text/thinking nodes in place. On `message_end`, fires
TTS if auto-speak is on. ↑/↓ history. Image-attach wiring:
`/uploads/<id>.<ext>` URLs in the prompt are matched against
`state.uploadedImages` and the base64 bytes are sent alongside the
text.

**`src/client/state.ts`** (new) — `AppState` + `PersistedMessage`.
No IndexedDB: the server's JSONL is the source of truth, the
browser's `state.messages` is just a renderer cache.

**`src/client/slashes.ts`** (new) — slash-command parser + picker
modals (model, thinking, voice, sessions, mobile overflow).

**`src/client/voice.ts`** (new) — `speakText` (TTS playback,
1.4× rate, single shared `<audio>`), `toggleAutoSpeak`,
`handleFileAttach` (multipart upload + base64 for multimodal
models), `handleVoiceRecord` (MediaRecorder → `/api/transcribe`
→ paste transcript into input).

**`src/client/dom.ts`** (new) — `$`, `el`, `text` helpers, uuid
fallback for Android WebViews without `crypto.randomUUID`.

**`src/client/styles.css`** (new) — dark theme (z.ai-inspired),
sans-serif body, monospace code, soft surfaces, rounded composer
pill, collapsible sidebar, welcome/empty state. Design tokens are
CSS custom properties so the palette can be tweaked in one place.

### Step 6 — Client: slash menu

20 slash commands (see `SLASH_COMMANDS` in `src/client/slashes.ts`):

| Cmd | Action |
|-----|--------|
| `/model` | open model picker |
| `/think [level]` | set thinking level (`off`/`minimal`/`low`/`medium`/`high`) or open picker |
| `/clear`, `/new` | start a new chat (server-side) |
| `/sessions`, `/resume` | open the sessions list (or `/resume <id>` to resume directly) |
| `/help` | show the menu |
| `/cost` | session token/cost totals |
| `/abort` | abort the current run |
| `/name <name>` | rename the current session (server-side via `set_session_name`) |
| `/session` | show session info (id, model, thinking, tokens, cost) |
| `/copy` | copy the last assistant message to clipboard |
| `/export` | download the session as a self-contained HTML file |
| `/hotkeys` | show keyboard shortcuts |
| `/changelog` | show recent git commits (via `/api/changelog`) |
| `/reload` | reload the page |
| `/quit` | close the tab |
| `/websearch <q>` | inject a pre-formatted web_search prompt |
| `/fetch <url>` | inject a pre-formatted fetch_content prompt |
| `/codesearch <q>` | inject a pre-formatted code_search prompt |
| `/voice` | open TTS voice picker (also reachable from the header) |

The input handler checks if the trimmed value starts with `/`,
parses `command + args`, and routes locally. If unknown, the slash
falls through to the model as a regular prompt.

### Step 7 — Client: history

Up-arrow in the empty input: cycle through previous user messages
in this session (in-memory ring buffer, not persisted). Down-arrow
reverses. `/` opens the slash menu.

### Step 8 — Client: status bar

Bottom row, always visible. Format from `refreshStatus()` in
`src/client/render.ts`:

```
[<model name> · think: <level> · <input+output> tok · $<cost> · ● streaming · ♪ playing · [open]]
```

Updated on every `message_update` / `message_end` (tokens, cost)
and on user action (model change, level change, TTS toggle).
Status indicators for streaming, tts in flight, audio playing,
and connection state.

### Step 9 — Build, test, push

```bash
cd /home/architect/agentchatbox
npm run build
# stop any running server, restart:
sudo fuser -k 3500/tcp
PORT=3500 nohup node dist/server/index.js > /tmp/agentchatbox.log 2>&1 &
curl -s http://127.0.0.1:3500/api/health
# browser test
git add -A
git commit -m "feat: pi --mode rpc subprocess transport + vanilla-DOM renderer"
git push -u origin feature/pi-cli-server-agent
```

---

## Verification checklist

Before merging, all of these must pass on a real browser session:

- [x] Open the page, see the welcome/empty state
- [x] Send a message, see streaming text appear with a `▍` cursor
  (rendered as the `.text` `<pre>` getting its `streaming` class
  removed on `message_end`)
- [x] Thinking block is dim/collapsed-by-default, click expands
- [x] Tool calls from the model render as cards (`bash`, `read`,
  `write`, `edit`, `ls`, `web_search`, `fetch_content`,
  `code_search`) with the tool name + a one-line summary of args
  + a result `<pre>` once the tool finishes
- [x] Parallel tool calls: each gets its own row keyed by
  `data-tool-call-id` (the "last pending" fallback from before
  was buggy when two tools fired in parallel — see commit history
  for the rewrite)
- [x] `> /model` opens picker; pick a different model; next
  message uses it (optimistic UI + `pendingModelSet` round-trip
  with the server's `ready` event to avoid clobbering the user's
  pick on every reconnect)
- [x] `> /think high` swaps thinking level; server rebuilds
  the agent with `--thinking high` (in-process via
  `set_thinking_level`, NOT a respawn)
- [x] `> /clear` starts a new session (with confirm); server
  kills the old `pi` child and spawns a fresh one
- [x] `> /sessions` lists prior sessions for the cwd; click
  one to resume
- [x] Resume replays the prior transcript (read from JSONL
  via `readPiSessionMessages`) before live events flow
- [x] ↑/↓ in empty input cycles through prior user messages
- [x] Stop button (or `/abort`) aborts mid-stream
- [x] Reload the page, sessions survive (server-side JSONL
  is the source of truth)
- [x] Status bar updates with token counts after each turn
- [x] File attachments: upload → markdown link in input → send
  → multimodal model sees the base64 bytes (not just the link)
- [x] Voice record: `MediaRecorder` → `/api/transcribe` →
  text pastes into input
- [x] TTS playback: speak button on each assistant message,
  auto-speak toggle, voice picker
- [x] `/export` downloads a styled HTML file
- [x] `/changelog` shows the last 20 git commits
- [x] `/health` reports provider keys, whisper/tts availability,
  and the running commit hash

---

## Deferred (post-merge, in this order)

1. **Documents** — PDF/DOCX/PPTX/XLSX parsing. The current
   `/api/upload` accepts these but stores only the raw bytes.
   Add text extraction (probably via `pdf-parse`, `mammoth`,
   `xlsx`) and feed extracted text into the user prompt
   alongside the base64 (for vision-capable models) or instead
   of the base64 (for text-only models).
2. **`/compact`** — implement via the harness
   (`AgentHarness.compact()`) instead of the bare Agent. Bigger
   change, but the right tool for long-session history pruning.
   The slash command is reserved but currently prints
   "unknown — will be sent as a prompt" when used.
3. **Multimodal upload preview** — currently we upload to disk,
   link the URL, and (for images) stash base64 in
   `state.uploadedImages`. A real preview thumbnail next to the
   composer would be nice.
4. ~~Permissioned bash~~ — out of scope. No modal prompts. Model
   commands run unconfirmed. This is the user's explicit choice.

---

## Files touched

### Server (new + rewritten)
| File | Action |
|------|--------|
| `src/server/chat.ts` | new — WS endpoint, one `pi` per connection |
| `src/server/pi-process.ts` | new — subprocess wrapper, strict `\n` NDJSON splitter, SIGTERM→SIGKILL |
| `src/server/session-list.ts` | new — read pi's JSONL files for `/api/sessions` and resume replay |
| `src/server/python-runner.ts` | new — shared `runPython()` with bounded buffers + timeout |
| `src/server/transcribe.ts` | new — `/api/transcribe` (faster-whisper via Python helper) |
| `src/server/tts.ts` | new — `/api/tts` and `/api/tts/voices` (piper via Python helper) |
| `src/server/uploads.ts` | new — `/api/upload` with sidecar metadata JSON |
| `src/server/providers.ts` | new — `SDK_PROVIDERS`, `KNOWN_PROVIDERS`, `EXTRA_MODELS` |
| `src/server/paths.ts` | new — `projectRoot` derived from this file's location, not `process.cwd()` |
| `src/server/config.ts` | rewritten — all env-driven; `piBin`, `piCwd`, `apiKeys` |
| `src/server/index.ts` | rewritten — Express bootstrap, route mounting, WS mount, /api/health with commit hash |
| `src/shared/protocol.ts` | rewritten — WS message shapes, server message types, upload/transcribe/voices types |

### Client (new + rewritten)
| File | Action |
|------|--------|
| `src/client/ws.ts` | new — `createChatClient()` with reconnect/backoff |
| `src/client/render.ts` | new — `renderShell`, message renderers, status bar, pickers |
| `src/client/slashes.ts` | new — 20 slash commands + picker modals |
| `src/client/state.ts` | new — `AppState` + `PersistedMessage` |
| `src/client/dom.ts` | new — `$`, `el`, `text`, uuid fallback |
| `src/client/voice.ts` | new — TTS playback + file attach + voice record |
| `src/client/main.ts` | rewritten — boot, send, history, event dispatcher, init handshake |
| `src/client/api.ts` | rewritten — kept for non-WS endpoints (upload, transcribe, tts, models, health) |
| `src/client/styles.css` | new — dark theme, design tokens, mobile-responsive |

### Removed
| File | Action |
|------|--------|
| `src/client/seed-providers.ts` | deleted — model resolution moved to server |
| `src/client/proxiedStreamFn` (was in `api.ts`) | deleted — SSE proxy is gone from the client |

### Build / config
| File | Action |
|------|--------|
| `package.json` | added `tsx` (dev), `concurrently` (dev), `esbuild` (dev) for `npm run dev` |
| `tsconfig.client.json` | separate config for the browser bundle |
| `scripts/build-client.mjs` | esbuild bundler — `src/client/main.ts` → `public/app.js` |
| `scripts/transcribe.py` | Python helper for faster-whisper |
| `scripts/tts.py` | Python helper for piper |
| `scripts/browser-smoke.mjs`, `ws-smoke.mjs`, `tts-smoke.mjs`, `check-page.mjs`, `check-providers.mjs`, `android-smoke.mjs` | smoke tests |
| `tests/chat.test.ts`, `paths.test.ts`, `session-list.test.ts`, `unified-diff.test.ts` | vitest unit + integration |
| `README.md` | rewritten — explains the subprocess architecture, full env table, WS protocol |
| `plan.md` | this file |
| `.env` | one line per provider key (mixed-case `MiniMax_API_KEY` matches `config.ts`) |
| `.env.example` | same shape, all values empty |

---

## Out of scope (do not do in this branch)

- **OAuth flows** — the seeded custom-provider flow is gone; the
  custom `minimax` provider is hand-built in `src/server/providers.ts`
  as `EXTRA_MODELS`.
- **Multi-user auth** — the server is single-tenant per process; if
  we need multi-user, that's a separate branch.
- **Rate limiting** — the pi CLI doesn't have it, neither does the
  web chat. LLM cost is the natural rate limit.
- **In-server tool implementations** — bash/read/write/edit/ls run
  inside `pi`, not in the server. The server does not have its own
  sandbox; the `pi` subprocess does (well, it doesn't sandbox by
  default — that matches "no sandbox" in the locked-in decisions).

---

## Why the architecture changed

The original plan called for the server to construct an
`Agent` from `@earendil-works/pi-agent-core`, register 5 TypeScript
tools (`bash`, `read`, `write`, `edit`, `ls`) in
`src/server/agent.ts` + `src/server/tools.ts`, and use
`streamSimple()` from `@earendil-works/pi-ai` to talk to providers
directly. The browser would be a thin renderer over a WebSocket.

What was actually built: the server spawns a `pi --mode rpc`
subprocess per WebSocket connection and forwards its events. The
"agent" lives inside that subprocess.

Why the pivot:

1. **Tool parity for free.** `pi` ships with the exact tools the
   plan was going to re-implement (bash, read, write, edit, ls,
   plus web_search, fetch_content, code_search). Re-implementing
   them in TypeScript against the bare Agent SDK would have meant
   duplicating `pi`'s tool layer and then chasing it as `pi` evolves.
   Running the same `pi` binary the TUI uses means the web chat
   inherits every tool change, every new tool, every bugfix, with
   zero work on this side.
2. **Session persistence solved.** `pi` already writes every event
   to a JSONL file. Reusing that file format for resume (`/sessions`
   picker, transcript replay) means we get persistence, replay, and
   resume in ~150 lines of session-list.ts, instead of building
   a new persistence layer in the server.
3. **Process isolation.** An unhandled error in a Node-side Agent
   kills the whole server process (and every other WS connection).
   A `pi` subprocess crash only kills that one connection — the
   server and other sessions keep working.
4. **One source of truth.** When the user reports a bug ("the
   model didn't see my image", "the bash tool gave the wrong
   cwd"), the answer is always the same: it's a `pi` bug, file
   it upstream. Two implementations would have meant a
   constant stream of "is this a server bug or a CLI bug?".

The cost: a per-connection child process, a thin RPC layer to
keep in sync with `pi`'s protocol, and the requirement that
`pi` is installed on the host. Trade accepted.
