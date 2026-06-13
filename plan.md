# agentchatbox → pi-CLI parity plan

**Repo:** `https://github.com/anunkai1/agentchatbox`
**Branch:** `feature/pi-cli-server-agent` (off `main` @ `9f0af9c`)
**Goal:** the web chat at http://192.168.0.148:3500/ should feel and behave
exactly like the pi CLI. After this lands, future work layers on documents,
files, and two-way voice.

---

## Why this is a refactor, not a skin

Today:

```
Browser (vanilla-DOM chat, runs the pi Agent in JS)
  │ fetch /api/stream  (SSE — raw LLM tokens)
  ▼
Node server (Express, LLM proxy)
  │ streamSimple() → provider SDK
  ▼
LLM providers
```

The browser owns the `Agent`. The server is just a key-hiding proxy. That's
fine for a chat toy, but pi is fundamentally a **tool-using** agent — it
reads files, edits them, runs bash, etc. Those tools can't run in a browser
sandbox. Tool calls emitted by the model go nowhere today (`tools: []`).

The pi-CLI parity we want needs the agent (with its tools) on the server,
and the browser as a thin WebSocket renderer:

```
Browser (renderer only — paints events)
  │ ws /api/chat  (events out, prompts in)
  ▼
Node server (owns the pi Agent + tools)
  │ streamSimple() → provider SDK
  │ tool calls: bash, read, write, edit, ls (local fs + child_process)
  ▼
LLM providers + local filesystem
```

This is the only architecture that lets slash commands like `/read`, `/edit`,
`/bash` actually do anything, and it's what makes the web chat feel like the
CLI instead of "a chat box with rounded corners."

---

## Locked-in decisions (user-confirmed 2026-06-13)

| # | Decision | Value |
|---|----------|-------|
| 1 | Sandbox | **None.** Tools accept absolute paths, bash inherits full env. |
| 2 | Default model | `MiniMax-M3` (provider `minimax`, base URL `https://api.minimax.io/anthropic`, `reasoning: true`) |
| 3 | Default thinking | `high` |
| 4 | CLI parity | Match the real pi CLI for every tool interaction — no "good enough" shortcuts |
| 5 | Voice transcription | **Local** via `faster-whisper` on CPU (no OpenAI key, no paid API) |
| 6 | TTS / voice receive | Deferred to a later branch |
| 7 | Bash permission prompt | **No** — matches "feels like CLI" priority (model just runs) |
| 8 | Server bind | `0.0.0.0:3500` (unchanged) |
| 9 | Old browser-side Agent code | **Delete entirely**, no fallback path |

These decisions are final. Implementation mirrors them.

---

## What's done already (2026-06-13)

- ✅ Audited the SDK: `Agent` from `@earendil-works/pi-agent-core@0.75.3`
  accepts arbitrary `Tool[]` (Typebox schemas), emits 8 lifecycle event
  types (`agent_start | agent_end | turn_start | turn_end | message_start |
  message_update | message_end | tool_execution_start/update/end`).
- ✅ Confirmed the Agent has **no built-in tools** — must register them.
- ✅ Confirmed `pi-tui` is the terminal *reference* (differential renderer),
  not a browser library. We port its conventions to the DOM, not the runtime.
- ✅ Committed the uncommitted debug-log changes on `main` as `9f0af9c`.
- ✅ Created branch `feature/pi-cli-server-agent`.
- ✅ Fixed the broken `.env`: provider key was being looked up as
  `MiniMax_API_KEY` (mixed case) in `src/server/config.ts:43`, but the example
  used `MINIMAX_API_KEY`. Renamed in `.env`. Server now reports
  `providers: ["minimax"]` in `/api/health` and the LLM proxy streams
  successfully without the in-browser key dialog.
- 🔧 One bug discovered: `src/client/main.ts:276`
  (`renderLatestAssistant`) uses
  `:scope > .msg-assistant:last-of-type` and overwrites its text on every
  `message_update` — this clobbers any blocks that come after an assistant
  message in the same turn (tool calls, follow-up text). Renderer rewrite
  will fix this.

---

## Build steps (in order)

### Step 1 — Server: agent module with tools

**New file:** `src/server/agent.ts`

A factory that builds a single `Agent` instance per WebSocket session, with
these tools registered:

| Tool      | Purpose                                              | Risk class |
|-----------|------------------------------------------------------|------------|
| `bash`    | Run a shell command in the sandbox CWD               | high       |
| `read`    | Cat a file (with line-range support)                 | low        |
| `write`   | Create/overwrite a file (refuses if outside sandbox) | medium     |
| `edit`    | String-replace in a file (with before/after preview) | medium     |
| `ls`      | List a directory                                     | low        |

All tools return `ToolResultMessage` with `isError: true` on failure.

**No sandbox.** Tools accept absolute paths; `bash` uses
`child_process.spawn` with `shell: '/bin/bash'` and inherits the full
process env. This matches the user's decision to treat the agent as
a fully-trusted local process, like the real pi CLI. The user owns
the consequences of what the model does (it's their server, their
key, their files).

Each tool's `execute` returns `{ content: TextContent[], details }` and
sets `isError` on failure. Errors include the actual exception message —
this is what the model uses to retry.

### Step 2 — Server: WebSocket endpoint

**New file:** `src/server/chat.ts`

`ws` server mounted at `/api/chat`. One `Agent` per connection.

Lifecycle:
1. Client connects, sends `{type:"init", modelId, provider, apiKey?}`. Server
   resolves the model via `getModel()`, picks API key (server env wins over
   client), constructs the Agent.
2. Client sends `{type:"prompt", text}` or `{type:"abort"}`. Server feeds
   `agent.prompt(text)` or `agent.abort()`.
3. Server forwards every Agent event as `{type:"event", event: AgentEvent}`
   to the client.
4. Client disconnects → server calls `agent.abort()` and lets the GC pick
   it up.

Session persistence stays in browser IndexedDB for now (matches current
behavior). Server is stateless across connections.

### Step 3 — Server: wire the WS into `index.ts`

Edit `src/server/index.ts` to mount the WS server. Keep `/api/stream` for
back-compat during the migration. Keep `/api/upload`, `/api/transcribe`,
`/api/health`, and the static-file serving unchanged.

### Step 4 — Client: drop the browser-side Agent

The renderer no longer constructs an `Agent`. It opens a WebSocket and
paints events. Delete:
- `createAgent()`, `attachAgentListeners()`, `agent.state.*` reads
- The whole `proxiedStreamFn` flow in `src/client/api.ts`
- `seedProviders` / `getCustomProviders` / `pickDefaultModel` /
  `resolveModel` (model resolution moves to server)

Keep:
- IndexedDB session store (titles, transcripts) — the server only sees
  the current run, the browser owns the history
- API-key dialog — sends a `key` in the WS `init` message as a fallback
  for providers not in the server's env

### Step 5 — Client: renderer rewrite

**`src/client/main.ts`** — new file. Vanilla DOM, no framework.

Visual conventions (ported from `pi-tui`'s choices):
- Background `#0b0b0b`, foreground `#d4d4d4`, accent `#7aa2f7`,
  dim `#5a5a5a`, error `#f7768e`, success `#9ece6a`, tool `#bb9af7`
- Monospace stack: `ui-monospace, SF Mono, Menlo, monospace`
- No bubbles. No rounded corners. No background tint per message.
- Each message is a `› <role> <body>` line, role colored:
  - `You › <text>` in white
  - `Pi › <text>` in default grey, text in white
  - `Pi * <thinking>` in dim grey, collapsed by default, click ▸ to expand
  - `Tool › bash $ <command>` in purple, then `↳ <output>` in dim grey
  - `Tool › read <path>` in purple, then `↳ <file body>` in monospace
  - `Tool › write <path>` in purple, then `↳ wrote 42 lines` in dim
  - `Tool › edit <path>` in purple, then `↳ -3 +1 @@ …` unified diff in dim
  - Errors in red

Streaming: incremental `text_delta` events append to a `<span class="stream">`
inside the last assistant message node. A blinking `▍` cursor shows during
streaming. When `message_end` fires, the cursor is removed.

Interleaving: a single assistant turn can have multiple `text_start/delta/end`
AND multiple `toolcall_start/delta/end` cycles. The renderer keys nodes by
`contentIndex` (text blocks) and `toolCall.id` (tool calls) within the
current assistant message — it does NOT use `:last-of-type` selectors
(anymore).

### Step 6 — Client: slash menu

`/model` — open model picker
`/think <level>` — set thinking level (off/minimal/low/medium/high)
`/clear` — start new chat (with confirm)
/sessions` — open sessions dialog
`/compact` — placeholder (pi has compaction; the harness supports it but
the bare Agent doesn't. Defer or implement a client-side summary pass.)
`/help` — show the menu
`/cost` — show token/cost totals for the current session

Implementation: the input handler checks if the trimmed value starts with
`/`, parses `command + args`, and routes locally. If unknown, fall through
to sending it as a regular prompt (so users can still say
`"/something not a command"` and the model handles it).

### Step 7 — Client: history

Up-arrow in the empty input: cycle through previous user messages in this
session (in-memory ring buffer, not persisted). Down-arrow reverses.
Ctrl+R or `/` opens the slash menu.

### Step 8 — Client: status bar

Bottom row, always visible:
```
[MiniMax-M3 · think: off · 1.2k/340 tok · $0.0042 · ●  idle]
```

Updated on every `message_end` (token count) and on user action (model
change, level change). Right-aligned.

### Step 9 — Build, test, push

```bash
sudo -u architect bash -c 'cd /home/architect/agentchatbox && npm run build'
sudo fuser -k 3500/tcp
sudo -u architect bash -c 'cd /home/architect/agentchatbox && PORT=3500 nohup node dist/server/index.js > /tmp/agentchatbox.log 2>&1 & echo $! > /tmp/agentchatbox.pid'
curl -s http://127.0.0.1:3500/api/health
# browser test
sudo -u architect bash -c 'cd /home/architect/agentchatbox && git add -A && git commit -m "feat: server-side agent with bash/read/write/edit/ls tools + pi-CLI renderer" && git push -u origin feature/pi-cli-server-agent'
```

---

## Verification checklist

Before merging, all of these must pass on a real browser session:

- [ ] Send a message, see streaming text appear with `▍` cursor
- [ ] Thinking block is dim/collapsed, click expands
- [ ] `> cat package.json` from the model triggers `Tool › read` with
      the file body, model comments on it
- [ ] `> run npm install` triggers `Tool › bash`, output streams live,
      exit code 0 shown
- [ ] `> write a hello.txt file containing "hi"` triggers `Tool › write`,
      file appears on disk in `./workspace/`
- [ ] `> /model` opens picker; pick a different model; next message uses it
- [ ] `> /think high` swaps thinking level; model uses reasoning_effort
- [ ] `> /clear` starts a new session (with confirm)
- [ ] ↑/↓ in empty input cycles through prior user messages
- [ ] Stop button aborts mid-stream
- [ ] Reload the page, click `/sessions`, prior session is listed
- [ ] Status bar updates with token counts after each turn

---

## Deferred (post-merge, in this order)

1. **Documents** — PDF/DOCX/PPTX/XLSX parsing. The current `/api/upload`
   already accepts these but `uploads.ts` only stores the raw bytes.
   Add text extraction (probably via `pdf-parse`, `mammoth`, `xlsx`).
2. **Voice send** — recorder is already there. Swap `/api/transcribe`
   from "disabled, needs OPENAI_API_KEY" to local `faster-whisper`
   on CPU. One-time install: `pip install faster-whisper` (model
   auto-downloads on first use, ~1GB for `small`). Then the
   existing `transcribe.ts` calls into a Python sidecar (or a Node
   binding if one exists) instead of hitting OpenAI's API.
3. **Voice receive** — server-side TTS of the model's final text, played
   in the browser. Use Piper or faster-whisper per user preference for
   local-first / CPU-only. Maybe `pocket-tts` if it ships soon.
4. **`/compact`** — implement via the harness (`AgentHarness.compact()`)
   instead of the bare Agent. Bigger change, but the right tool for
   long-session history pruning.
5. ~~Permissioned bash~~ — out of scope. No modal prompts. Model
   commands run unconfirmed. This is the user's explicit choice.

---

## Files touched

| File | Action |
|------|--------|
| `.env` (new) | one-line: `MiniMax_API_KEY=*** (DONE) |
| `src/server/agent.ts` (new) | Agent factory + 5 tools |
| `src/server/chat.ts` (new) | WS endpoint |
| `src/server/index.ts` | mount WS, keep `/api/stream` for back-compat |
| `src/server/tools.ts` (new) | bash/read/write/edit/ls with no path whitelist |
| `src/client/main.ts` (rewrite) | renderer, slash menu, history, status bar |
| `src/client/api.ts` | remove proxiedStreamFn, add WS client |
| `src/client/seed-providers.ts` | remove (model resolution moved server-side) |
| `src/client/styles.css` | new monospace theme |
| `src/shared/protocol.ts` | add WS message shapes |
| `README.md` | update run instructions + screenshot |

---

## Out of scope (do not do in this branch)

- Moving the Anthropic/Ollama/etc. model registry to the server. The server
  uses `getModel(provider, id)` from `@earendil-works/pi-ai` directly; the
  client doesn't pick model ids anymore.
- OAuth flows (the seeded custom-provider flow is gone in this branch).
- Multi-user auth. The server is single-tenant per process; if we need
  multi-user, that's a separate branch.
- Rate limiting. The pi CLI doesn't have it, neither does the web chat.
  LLM cost is the natural rate limit.
