/**
 * WebSocket endpoint: /api/chat
 *
 * Thin pipe between a browser WebSocket and a `pi --mode rpc` child
 * process. The server:
 *   1. accepts a WS connection
 *   2. waits for the client's first `init` message (provider, model,
 *      thinking level, optional sessionId to resume)
 *   3. spawns `pi --mode rpc` with those args (the cwd from config)
 *   4. forwards every parsed NDJSON line from `pi`'s stdout to the
 *      browser as `{type:"event", event:<line>}` — verbatim, the
 *      same event stream the TUI would see
 *   5. translates client messages into `pi` RPC commands and writes
 *      them to the child's stdin
 *   6. on disconnect, SIGTERMs the child (with a 2-second escalation
 *      to SIGKILL so the session JSONL flushes)
 *
 * Session resume works by killing the current child and respawning
 * `pi --session <id>`. The server replays the prior transcript as
 * a single `{type:"transcript", ...}` server message before the
 * live events flow.
 *
 * This is the whole "agent" — the actual coding-agent logic is
 * running inside the `pi` subprocess. The agentchatbox server is
 * the transport layer, nothing more.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { config, getServerApiKey } from "./config.js";
import { spawnPi, type PiProcess } from "./pi-process.js";
import { listPiSessions, readPiSessionMessages } from "./session-list.js";
import type { ClientMessage, ServerMessage, SessionSummary, ThinkingLevel } from "../shared/protocol.js";

/** Every live `pi --mode rpc` child, so SIGTERM can reach all of them. */
const liveChildren = new Set<PiProcess>();

// Register a single SIGTERM handler that kills every child before the
// process exits. This is in addition to the server.close() handler in
// index.ts — both are needed because SIGTERM to the server process
// must propagate to children even if the HTTP server is busy.
process.on("SIGTERM", () => {
	for (const child of liveChildren) {
		try { child.kill(); } catch { /* ignore */ }
	}
});

export function mountChatWs(server: HttpServer): void {
	const wss = new WebSocketServer({ server, path: "/api/chat" });

	wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
		handleConnection(ws).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			sendError(ws, `failed to start session: ${message}`);
			try { ws.close(); } catch { /* ignore */ }
		});
	});

	console.log(`chat: ws listening on /api/chat (pi cwd: ${config.piCwd})`);
}

interface InitMessage {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	sessionId?: string;
}

async function handleConnection(ws: WebSocket): Promise<void> {
	// Per-connection state. We keep these as `let` because `newSession` /
	// `resumeSession` tear down the current child and spawn a new one.
	let pi: PiProcess | null = null;
	let currentInit: InitMessage | null = null;
	let pendingTranscript: { sessionId: string; messages: unknown[] } | null = null;

	// The first message from the client must be an `init` (the protocol
	// requires it; we don't have a sensible default to fall back to).
	const init = await waitForMessage<InitMessage>(ws, "init");
	currentInit = init;

	// If the client is resuming a session, read the prior transcript
	// from disk now so we can replay it as soon as the new child emits
	// its `session` line.
	if (init.sessionId) {
		const messages = readPiSessionMessages(config.piCwd, init.sessionId);
		pendingTranscript = { sessionId: init.sessionId, messages };
	}

	pi = spawnChild(init);
	(ws as WebSocket & { _pi?: PiProcess })._pi = pi;
	attachEventForwarding(ws, pi, init, () => pendingTranscript, (t) => { pendingTranscript = t; });

	// Handle subsequent client messages: forward to `pi` or handle
	// session-control messages locally (those respawn the child).
	ws.on("message", (raw) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw.toString()) as ClientMessage;
		} catch {
			sendError(ws, "malformed JSON");
			return;
		}
		void onClientMessage(ws, msg, currentInit!, (newInit) => {
			currentInit = newInit;
		}, (newChild) => {
			pi = newChild;
		}, (t) => {
			pendingTranscript = t;
		});
	});

	ws.on("close", () => {
		try { pi?.kill(); } catch { /* ignore */ }
	});
	// If the child dies for any reason (e.g. provider key invalid),
	// close the WS so the browser's reconnect logic kicks in.
	// (Per-child handler is attached in attachEventForwarding.)
}

// ---------------------------------------------------------------------------
// Child-process lifecycle
// ---------------------------------------------------------------------------

function spawnChild(init: InitMessage): PiProcess {
	const apiKey = getServerApiKey(init.provider);
	if (!apiKey) {
		throw new Error(
			`no API key for provider "${init.provider}" — set one in .env or pick a different provider`,
		);
	}
	const child = spawnPi({
		bin: config.piBin,
		provider: init.provider,
		modelId: init.modelId,
		apiKey,
		cwd: config.piCwd,
		sessionId: init.sessionId,
		thinkingLevel: init.thinkingLevel,
	});
	liveChildren.add(child);
	child.on("exit", () => {
		liveChildren.delete(child);
	});
	return child;
}

function attachEventForwarding(
	ws: WebSocket,
	pi: PiProcess,
	init: InitMessage,
	getPending: () => { sessionId: string; messages: unknown[] } | null,
	setPending: (t: { sessionId: string; messages: unknown[] } | null) => void,
): void {
	let sessionIdSent = false;
	let readySent = false;

	pi.on("event", (line) => {
		// Drop request/response ack frames — the renderer is event-driven,
		// the `pi` RPC docs are explicit that `response` is for
		// request/response correlation, irrelevant to the WS stream.
		if (line.type === "response") return;

		// The first `session` line from `pi` carries the session id and
		// is the natural "I'm ready" signal. Send `ready` once, then
		// replay the prior transcript (if any) before any other events.
		if (line.type === "session" && !readySent) {
			const id = String(line.id ?? "");
			readySent = true;
			send(ws, {
				type: "ready",
				modelId: init.modelId,
				provider: init.provider,
				thinkingLevel: init.thinkingLevel,
				sessionId: id || undefined,
			});
			// Replay the prior transcript, if the client asked to resume
			// one. We send this BEFORE any other event so the browser's
			// renderer can paint the history before the live stream
			// starts.
			const pending = getPending();
			if (pending && pending.messages.length > 0) {
				send(ws, { type: "transcript", sessionId: pending.sessionId, messages: pending.messages });
			}
			setPending(null);
			sessionIdSent = true;
			// Don't forward the `session` line itself to the browser —
			// the `ready` message carries the same info, and the
			// renderer doesn't know what to do with a `session` event.
			return;
		}

		// Forward every other `pi` event verbatim. The renderer's
		// switch ignores unknown event types, so the wider
		// `pi` event surface (e.g. `tool_execution_start`,
		// `message_update` with the `assistantMessageEvent` wrapper)
		// flows through unchanged.
		send(ws, { type: "event", event: line });
	});

	pi.on("error", (err) => {
		sendError(ws, `pi subprocess error: ${err.message}`);
		// The child is going to die on its own after this; close the
		// WS so the browser reconnects.
		try { ws.close(); } catch { /* ignore */ }
	});

	pi.on("exit", (info) => {
		// If we never sent `ready`, the spawn failed (e.g. binary
		// not found). Tell the client.
		if (!readySent) {
			sendError(ws, `pi exited before ready (code=${info.code}, signal=${info.signal}): ${pi.getStderr().slice(-200)}`);
		}
		try { ws.close(); } catch { /* ignore */ }
	});

	// Stash the ws reference on the child for the abort/clear paths.
	// (No-op if already stashed; idempotent.)
	(pi as PiProcess & { _ws?: WebSocket })._ws = ws;
}

// ---------------------------------------------------------------------------
// Client message dispatch
// ---------------------------------------------------------------------------

async function onClientMessage(
	ws: WebSocket,
	msg: ClientMessage,
	currentInit: InitMessage,
	setInit: (i: InitMessage) => void,
	setPi: (p: PiProcess | null) => void,
	setPending: (t: { sessionId: string; messages: unknown[] } | null) => void,
): Promise<void> {
	// Get the current child off the WS (we stashed it in attachEventForwarding).
	const pi = (ws as WebSocket & { _pi?: PiProcess })._pi ?? null;

	switch (msg.type) {
		case "init": {
			// A second `init` from the same client is a protocol
			// violation — the spec says `init` is only the first
			// message. Ignore silently; the original child keeps
			// running.
			break;
		}
		case "prompt": {
			if (!pi) return;
			pi.send({
				type: "prompt",
				message: msg.text,
				...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
			});
			break;
		}
		case "abort": {
			if (!pi) return;
			pi.send({ type: "abort" });
			break;
		}
		case "setModel": {
			if (!pi) return;
			pi.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
			break;
		}
		case "setThinking": {
			if (!pi) return;
			pi.send({ type: "set_thinking_level", level: msg.level });
			break;
		}
		case "renameSession": {
			if (!pi) return;
			pi.send({ type: "set_session_name", name: msg.name });
			break;
		}
		case "listSessions": {
			const sessions: SessionSummary[] = listPiSessions(config.piCwd);
			send(ws, { type: "sessions", sessions });
			break;
		}
		case "newSession": {
			// Kill the current child, spawn fresh (no --session).
			try { pi?.kill(); } catch { /* ignore */ }
			const newInit: InitMessage = {
				provider: currentInit.provider,
				modelId: currentInit.modelId,
				thinkingLevel: currentInit.thinkingLevel,
			};
			const newChild = spawnChild(newInit);
			attachEventForwarding(ws, newChild, newInit, () => null, () => { /* no pending transcript */ });
			setInit(newInit);
			setPi(newChild);
			(ws as WebSocket & { _pi?: PiProcess })._pi = newChild;
			break;
		}
		case "resumeSession": {
			// Kill current child, spawn with --session <id>, replay
			// the prior transcript before live events.
			try { pi?.kill(); } catch { /* ignore */ }
			const newInit: InitMessage = {
				provider: currentInit.provider,
				modelId: currentInit.modelId,
				thinkingLevel: currentInit.thinkingLevel,
				sessionId: msg.sessionId,
			};
			const messages = readPiSessionMessages(config.piCwd, msg.sessionId);
			const pending = { sessionId: msg.sessionId, messages };
			setPending(pending);
			const newChild = spawnChild(newInit);
			attachEventForwarding(ws, newChild, newInit, () => pending, setPending);
			setInit(newInit);
			setPi(newChild);
			(ws as WebSocket & { _pi?: PiProcess })._pi = newChild;
			break;
		}
		default: {
			// Exhaustiveness check.
			const _exhaustive: never = msg;
			void _exhaustive;
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the first message from the WS that matches the given type. */
function waitForMessage<T>(ws: WebSocket, type: ClientMessage["type"]): Promise<T> {
	return new Promise((resolve, reject) => {
		const onMessage = (raw: WebSocket.RawData) => {
			cleanup();
			try {
				const parsed = JSON.parse(raw.toString()) as ClientMessage;
				if (parsed.type !== type) {
					reject(new Error(`expected first message to be "${type}", got "${parsed.type}"`));
					return;
				}
				resolve(parsed as unknown as T);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		};
		const onClose = () => {
			cleanup();
			reject(new Error("ws closed before init"));
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			ws.off("message", onMessage);
			ws.off("close", onClose);
			ws.off("error", onError);
		};
		ws.on("message", onMessage);
		ws.on("close", onClose);
		ws.on("error", onError);
	});
}

function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* socket may have closed between the check and the send */
	}
}

function sendError(ws: WebSocket, message: string): void {
	send(ws, { type: "error", message });
}
