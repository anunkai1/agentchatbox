# agentchatbox

A web chat interface for the [pi coding agent](https://pi.dev). Run the pi agent in your browser, with support for images, file uploads, and voice notes.

Built on top of the official [`@earendil-works/pi-web-ui`](https://www.npmjs.com/package/@earendil-works/pi-web-ui) components. The agent runs in the browser; LLM API calls are proxied through a small Node server so the keys never leave the machine.

## Features

- Full chat UI: streaming responses, model picker, thinking levels, slash commands
- Persistent sessions in browser IndexedDB (history survives reloads)
- Image attachments (paste, drag-and-drop, or pick)
- File uploads (PDF, DOCX, XLSX, PPTX, code, etc.) with text extraction
- Voice notes: record → transcribe via Whisper → send to the agent
- All major LLM providers, configurable via env vars

## Architecture

```
Browser (pi-web-ui components, Agent in JS)
  │
  │ fetch /api/stream  (SSE)
  │ fetch /api/upload  (multipart)
  │ fetch /api/transcribe (multipart)
  ▼
Node server (this repo)
  │
  │ streamSimple() → provider SDK
  ▼
LLM providers (Anthropic, OpenAI, Google, …)
```

API keys live in the server's `.env` file. The browser never sees them.

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

Then open <http://localhost:3000>.

`npm run dev` runs the server and the client bundler in watch mode, so changes to `src/` reload automatically. The server runs on port 3000; the client is served by the server itself (no separate Vite dev server needed).

## Production build

```bash
npm run build   # bundles client to public/, compiles server to dist/
npm start       # node dist/server/index.js
```

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

## Endpoints

| Method | Path                | Purpose                                |
|--------|---------------------|----------------------------------------|
| POST   | `/api/stream`       | LLM streaming proxy (SSE out)          |
| POST   | `/api/upload`       | Multipart file upload                  |
| GET    | `/uploads/:filename`| Download a previously uploaded file    |
| DELETE | `/uploads/:filename`| Remove an upload                       |
| POST   | `/api/transcribe`   | Audio → text (Whisper)                 |
| GET    | `/api/health`       | Liveness + list of configured providers|
| GET    | `/`                 | Built web UI (after `npm run build`)   |

## Why a server proxy?

The official pi-web-ui runs the agent in the browser and would normally call LLM providers directly with a user-supplied API key. Two problems with that for a self-hosted setup:

1. The key would be exposed in the browser, so anyone with the URL could lift it.
2. CORS: many providers don't allow direct browser calls.

This server sits in between: the browser uses a custom `streamFn` that POSTs to `/api/stream`; the server injects the key and forwards the call. CORS is solved because the browser only talks to us.

## Related

- [pi](https://pi.dev) — the coding agent
- [`@earendil-works/pi-web-ui`](https://github.com/earendil-works/pi) — official web UI components
- [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) — unified LLM API
- [openclaw](https://github.com/openclaw/openclaw) — a real-world SDK integration

## License

MIT
