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

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type {
	ClientMessage,
	ServerMessage,
	SessionSummary,
	ThinkingLevel,
	TranscriptPayload,
} from "../shared/protocol.js";
import { config, getServerApiKey } from "./config.js";
import { log } from "./logger.js";
import { type PiProcess, spawnPi } from "./pi-process.js";
import { listPiSessions, readPiSessionMessages } from "./session-list.js";

/** Every live `pi --mode rpc` child, so SIGTERM can reach all of them. */
const liveChildren = new Set<PiProcess>();

// Register a single SIGTERM handler that kills every child before the
// process exits. This is in addition to the server.close() handler in
// index.ts — both are needed because SIGTERM to the server process
// must propagate to children even if the HTTP server is busy.
process.on("SIGTERM", () => {
	for (const child of liveChildren) {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
	}
});

export function mountChatWs(server: HttpServer): void {
	const wss = new WebSocketServer({ server, path: "/api/chat" });

	wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
		handleConnection(ws as PiSocket).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			sendError(ws, `failed to start session: ${message}`);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		});
	});

	log.info("chat ws listening", { path: "/api/chat", piCwd: config.piCwd });
}

interface InitMessage {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	sessionId?: string;
}

/**
 * The single source of truth for the live `pi` child of a WS connection.
 * Stashed on the ws object so every handler (message dispatch, close,
 * respawn) reads the same reference instead of maintaining a parallel
 * closure variable that can drift out of sync during respawn.
 */
interface PiSocket extends WebSocket {
	_pi?: PiProcess;
}

/**
 * Per-send WS output backpressure guard. `ws.bufferedAmount` is the
 * number of bytes Node has accepted but not yet flushed to the kernel.
 * Under heavy `message_update` streaming a slow/stuck tab can let this
 * grow without bound → server OOM. Past the high-water mark we treat the
 * client as wedged and close the socket (the browser reconnects and gets
 * fresh state via transcript replay). This is cheaper than tracking
 * per-connection drain timers and is the standard ws-library pattern.
 */
const WS_BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024; // 16 MiB

async function handleConnection(ws: PiSocket): Promise<void> {
	// Per-connection mutable state. `currentInit` and `pendingTranscript`
	// are `let` because newSession / resumeSession swap them; the live
	// child itself is NOT kept here — it lives on `ws._pi` so every
	// handler (including the message dispatcher) reads one reference.
	let currentInit: InitMessage | null = null;
	let pendingTranscript: TranscriptPayload | null = null;

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

	ws._pi = spawnChild(init);
	// attachEventForwarding synchronously subscribes to pi's events.
	// There's no race because we attach before yielding to any async
	// wait — pi is a Node EventEmitter that drops events for late
	// subscribers, so we must subscribe synchronously after spawn.
	attachEventForwarding(
		ws,
		ws._pi,
		init,
		() => pendingTranscript,
		(t) => {
			pendingTranscript = t;
		},
	);

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
		void onClientMessage(
			ws,
			msg,
			currentInit!,
			(newInit) => {
				currentInit = newInit;
			},
			(t) => {
				pendingTranscript = t;
			},
		);
	});

	ws.on("close", () => {
		try {
			ws._pi?.kill();
		} catch {
			/* ignore */
		}
	});
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
	ws: PiSocket,
	pi: PiProcess,
	init: InitMessage,
	getPending: () => TranscriptPayload | null,
	setPending: (t: TranscriptPayload | null) => void,
): void {
	let readySent = false;

	pi.on("event", (line) => {
		// Request/response ack frames: the renderer is event-driven, so
		// success acks are noise (pi's events are the real confirmation)
		// and are dropped. The ONE exception is get_state (used to harvest
		// the sessionId on init) and failure responses — a success:false
		// frame signals an undelivered command and is forwarded to the
		// client so it can react. Forwarding failures is what makes this
		// a transparent pipe rather than a silent dropper.
		if (line.type === "response") {
			// Pull sessionId out of get_state's response. The pi
			// process doesn't emit a "session" line on startup the
			// way the TUI does — instead, the session id is buried
			// inside the response to a get_state call. We send that
			// on init so the client gets its sessionId promptly.
			if (line.command === "get_state" && !readySent) {
				const data = line.data as { sessionId?: string } | undefined;
				const id = String(data?.sessionId ?? "");
				if (id) {
					readySent = true;
					send(ws, {
						type: "ready",
						modelId: init.modelId,
						provider: init.provider,
						thinkingLevel: init.thinkingLevel,
						sessionId: id,
					});
					// Replay the prior transcript, if the client asked to resume one.
					const pending = getPending();
					if (pending && pending.messages.length > 0) {
						send(ws, {
							type: "transcript",
							sessionId: pending.sessionId,
							messages: pending.messages,
						});
					}
					setPending(null);
				}
			}
			// Success acks are noise — drop them. But fall through for
			// success:false so the failure reaches the client.
			if (line.success !== false) {
				return;
			}
		}

		// Forward every other `pi` event verbatim. The renderer's
		// switch ignores unknown event types, so the wider
		// `pi` event surface (e.g. `tool_execution_start`,
		// `message_update` with the `assistantMessageEvent` wrapper)
		// flows through unchanged.
		send(ws, { type: "event", event: line });
	});

	pi.on("error", (err) => {
		// The child is going to die on its own after this. Send an
		// error so the client knows what happened, but DO NOT close
		// the WS — the client may still be holding the connection
		// for an upcoming respawn (resumeSession / newSession kill
		// the old child to start a new one, and that respawn races
		// the WS close).
		sendError(ws, `pi subprocess error: ${err.message}`);
	});

	pi.on("exit", (info) => {
		// If we never sent `ready`, the spawn failed (e.g. binary
		// not found, or get_state never returned a sessionId). Tell
		// the client so it doesn't hang on the initial connect.
		//
		// If we DID send `ready` already, the child died after
		// running for a while. Don't auto-close the WS — this is
		// a normal occurrence during resumeSession / newSession,
		// where the handler is in the middle of respawning. The
		// client will receive a new `ready` once the new child
		// is up. If the new child also fails, it will emit
		// its own error/exit and the client will see the chain.
		if (!readySent) {
			sendError(
				ws,
				`pi exited before ready (code=${info.code}, signal=${info.signal}): ${pi.getStderr().slice(-200)}`,
			);
		}
	});

	// Ask pi for its session id. pi doesn't acknowledge get_state
	// immediately — it emits the response after the AgentSession is
	// constructed, which may take a few hundred ms. Retry on a schedule
	// until we get a sessionId (handled above) or the child exits.
	// Bounded attempts prevent an unbounded retry loop if pi is wedged;
	// the retry is also cleared by the exit handler implicitly (once the
	// child is gone, `pi.send` is a no-op and `readySent` never flips).
	requestSessionId(pi, () => readySent);
}

/**
 * Send `get_state` on a bounded retry schedule until `isDone()` returns
 * true. pi doesn't ack get_state until its AgentSession is constructed,
 * so a single send isn't enough. Retries stop after `maxAttempts` to
 * avoid an unbounded loop on a wedged child; the per-child exit handler
 * sends the error frame in that case.
 */
function requestSessionId(pi: PiProcess, isDone: () => boolean): void {
	const intervalMs = 200;
	const maxAttempts = 50; // ~10s ceiling — pi startup is normally <1s
	let attempts = 0;
	const retry = () => {
		if (isDone() || attempts >= maxAttempts) return;
		attempts++;
		pi.send({ type: "get_state" });
		setTimeout(retry, intervalMs);
	};
	pi.send({ type: "get_state" });
	attempts++;
	setTimeout(retry, intervalMs);
}

// ---------------------------------------------------------------------------
// Client message dispatch
// ---------------------------------------------------------------------------

async function onClientMessage(
	ws: PiSocket,
	msg: ClientMessage,
	currentInit: InitMessage,
	setInit: (i: InitMessage) => void,
	setPending: (t: TranscriptPayload | null) => void,
): Promise<void> {
	// The live child is stashed on the socket — the single source of
	// truth shared with attachEventForwarding and the close handler.
	const pi = ws._pi ?? null;

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
			// Translate /uploads/<file> web URLs to absolute filesystem paths
			// so pi's read tool can access uploaded files. The browser inserts
			// markdown links like [/uploads/<uuid>.csv] in the prompt, but pi
			// treats the path literally — /uploads/ doesn't exist on disk; the
			// files live in config.uploadsDir.
			const message = rewriteUploadUrls(msg.text);
			pi.send({
				type: "prompt",
				message,
				...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
			});
			break;
		}
		case "steer": {
			if (!pi) return;
			// Steering messages are queued while the agent runs and
			// delivered after the current assistant turn finishes its
			// tool calls, before the next LLM call. Same upload-URL
			// rewriting as `prompt` so attached files resolve on disk.
			// Note: pi always accepts a steer (it queues it). If the agent
			// goes idle before draining the queue, the client recovers by
			// re-sending the stranded text as a prompt (see recoverStrandedSteer).
			const message = rewriteUploadUrls(msg.text);
			pi.send({
				type: "steer",
				message,
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
			pi.send({
				type: "set_model",
				provider: msg.provider,
				modelId: msg.modelId,
			});
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
			try {
				pi?.kill();
			} catch {
				/* ignore */
			}
			const newInit: InitMessage = {
				provider: currentInit.provider,
				modelId: currentInit.modelId,
				thinkingLevel: currentInit.thinkingLevel,
			};
			const newChild = spawnChild(newInit);
			ws._pi = newChild;
			attachEventForwarding(
				ws,
				newChild,
				newInit,
				() => null,
				() => {
					/* no pending transcript */
				},
			);
			setInit(newInit);
			break;
		}
		case "resumeSession": {
			// Kill current child, spawn with --session <id>, replay
			// the prior transcript before live events.
			try {
				pi?.kill();
			} catch {
				/* ignore */
			}
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
			ws._pi = newChild;
			attachEventForwarding(ws, newChild, newInit, () => pending, setPending);
			setInit(newInit);
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

/**
 * Rewrite /uploads/<filename> web URLs in prompt text to the absolute
 * filesystem path where the uploaded file actually lives. The browser
 * inserts markdown links like `[file: foo.csv](/uploads/<uuid>.csv)`;
 * pi's `read` tool treats the path literally and fails with ENOENT
 * because /uploads/ is a web route, not a filesystem path.
 */
function rewriteUploadUrls(text: string): string {
	return text.replace(
		/\(\/uploads\/([A-Za-z0-9._-]+)\)/g,
		(_, filename) => `(${join(config.uploadsDir, filename)})`,
	);
}

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

/**
 * Send a message to the client. Guards on readyState and applies a
 * backpressure check: if the socket has buffered more than
 * `WS_BACKPRESSURE_HIGH_WATER` bytes (a stuck/slow tab under heavy
 * streaming), we terminate the connection rather than let the buffer
 * grow unbounded into OOM. The browser reconnects and replays state.
 */
function send(ws: WebSocket, msg: ServerMessage): void {
	if (ws.readyState !== ws.OPEN) return;
	if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER) {
		// Client isn't draining. Close so it reconnects cleanly
		// rather than letting us OOM buffering for it.
		try {
			ws.close(1011, "backpressure: client not draining");
		} catch {
			/* ignore */
		}
		return;
	}
	try {
		ws.send(JSON.stringify(msg));
	} catch {
		/* socket may have closed between the check and the send */
	}
}

function sendError(ws: WebSocket, message: string): void {
	send(ws, { type: "error", message });
}
