/**
 * WebSocket endpoint: /api/chat
 *
 * Thin pipe between a browser WebSocket and a `pi --mode rpc` child
 * process. The server:
 *   1. accepts a WS connection
 *   2. waits for the client's first `init` message (provider, model,
 *      thinking level, optional sessionId to resume)
 *   3. asks the session registry for a session — reattaching to a
 *      still-live one if `init.sessionId` matches, otherwise spawning
 *      a fresh `pi --mode rpc` child (see session-registry.ts)
 *   4. forwards every parsed NDJSON line from `pi`'s stdout to the
 *      browser as `{type:"event", event:<line>}` — verbatim, the same
 *      event stream the TUI would see
 *   5. translates client messages into `pi` RPC commands and writes
 *      them to the child's stdin
 *   6. on disconnect, DETACHES rather than kills the child — the agent
 *      keeps running. The registry reaps it only after it has gone idle
 *      (turn ended) AND stayed unattached past a grace period, so
 *      backgrounding the tab on Android no longer interrupts work.
 *
 * Session resume / new-session respawn the child. The server replays
 * the prior transcript as a single `{type:"transcript", ...}` server
 * message before the live events flow; a reattach to a mid-turn
 * session also replays the buffered current-turn events.
 *
 * This is the whole "agent" — the actual coding-agent logic is running
 * inside the `pi` subprocess. The agentchatbox server is the transport
 * layer, nothing more. The registry makes that transport reattachable;
 * it does not add agent logic.
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { join } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage, SessionSummary } from "../shared/protocol.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { listPiSessions } from "./session-list.js";
import {
	deliver,
	deliverError,
	type InitMessage,
	type LiveSession,
	type PiSocket,
	registry,
} from "./session-registry.js";

/**
 * Heartbeat interval. Every connection gets a ws-level ping every
 * HEARTBEAT_INTERVAL_MS; if no pong comes back before the next tick we
 * terminate the socket. This is what catches the Android case: when the
 * OS backgrounds the tab it suspends JS, so the browser stops responding
 * to ping frames, and we forcibly close the dead connection so the
 * registry can detach the view (NOT kill the agent). The client's own
 * watchdog also pings at the app level.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

// On SIGTERM to the server process, kill every live child so they don't
// orphan. The registry tracks them all.
process.on("SIGTERM", () => {
	registry.killAll();
});

export function mountChatWs(server: HttpServer): void {
	const wss = new WebSocketServer({ server, path: "/api/chat" });

	// Server-wide heartbeat. pings every client on a fixed cadence and
	// terminates any that haven't ponged back within the timeout. Each
	// connection also tracks `isAlive` flipped to false on ping and back
	// to true on the pong handler below. Terminating a socket here triggers
	// its close handler → registry.detach — the agent survives.
	const heartbeatTimer = setInterval(() => {
		for (const ws of wss.clients) {
			const s = ws as PiSocket & { isAlive?: boolean };
			if (s.isAlive === false) {
				// No pong since last ping — the client is gone (Android
				// suspended the tab, network dropped, etc.). Terminate so
				// the registry detaches; the agent is NOT killed.
				try {
					ws.terminate();
				} catch {
					/* ignore */
				}
				continue;
			}
			s.isAlive = false;
			try {
				ws.ping();
			} catch {
				/* socket may have just closed */
			}
		}
	}, HEARTBEAT_INTERVAL_MS);
	// Don't keep the event loop alive just for the heartbeat.
	if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

	wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
		const s = ws as PiSocket & { isAlive?: boolean };
		s.isAlive = true;
		// Browser automatically replies to ping frames with pong. Flip
		// isAlive back so the next heartbeat cycle doesn't terminate us.
		ws.on("pong", () => {
			s.isAlive = true;
		});
		// Also send an app-level ping so the client watchdog (which only
		// sees application messages, not ping frames) can measure liveness
		// independently of the ws library's frame-level pings.
		const appPing = setInterval(() => {
			send(ws as PiSocket, { type: "ping" });
		}, HEARTBEAT_INTERVAL_MS);
		ws.on("close", () => clearInterval(appPing));

		handleConnection(ws as PiSocket).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			deliverError(ws as PiSocket, `failed to start session: ${message}`);
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		});
	});

	wss.on("close", () => clearInterval(heartbeatTimer));

	log.info("chat ws listening", { path: "/api/chat", piCwd: config.piCwd });
}

/**
 * The single source of truth for the live session bound to a WS
 * connection. Stashed on the ws object as `ws._session` (set by
 * registry.attach) so every handler reads the same reference.
 */
// (PiSocket._session is declared in session-registry.ts.)

async function handleConnection(ws: PiSocket): Promise<void> {
	// The first message from the client must be an `init` (the protocol
	// requires it; we don't have a sensible default to fall back to).
	const init = await waitForMessage<InitMessage>(ws, "init");

	// Reattach to a still-live session if the client named one (the
	// normal reconnect path), otherwise spawn a fresh child. Binding the
	// ws sends `ready` + catch-up immediately if the session is already
	// up (reattach), or once `get_state` reports back (fresh spawn).
	const session = registry.acquire(init);
	registry.attach(session, ws);

	// Handle subsequent client messages: forward to `pi` or handle
	// session-control messages locally (those swap the bound session).
	ws.on("message", (raw) => {
		let msg: ClientMessage;
		try {
			msg = JSON.parse(raw.toString()) as ClientMessage;
		} catch {
			deliverError(ws, "malformed JSON");
			return;
		}
		// Read the CURRENTLY bound session off the socket — NOT the
		// `session` captured at init time. newSession / resumeSession swap
		// the bound session via registry.attach (which sets ws._session);
		// the captured variable would still point at the now-killed old
		// child, whose pi.send() silently drops commands (PiProcess.killed),
		// and the prompt would vanish into the void — the hang bug.
		const current = ws._session;
		if (!current) {
			deliverError(ws, "no active session");
			return;
		}
		onClientMessage(ws, msg, current);
	});

	// Detach on disconnect — the agent keeps running. The registry reaps
	// it later only if it goes idle and stays unattached. This is the line
	// that used to read `ws._pi?.kill()` and interrupted every phone lock.
	ws.on("close", () => {
		const bound = ws._session;
		if (bound) registry.detach(bound, ws);
	});
}

// ---------------------------------------------------------------------------
// Client message dispatch
// ---------------------------------------------------------------------------

function onClientMessage(ws: PiSocket, msg: ClientMessage, session: LiveSession): void {
	const pi = session.pi;

	switch (msg.type) {
		case "init": {
			// A second `init` from the same client is a protocol violation —
			// the spec says `init` is only the first message. Ignore
			// silently; the original session keeps running.
			break;
		}
		case "prompt": {
			// Translate /uploads/<file> web URLs to absolute filesystem paths
			// so pi's read tool can access uploaded files. The browser
			// inserts markdown links like [/uploads/<uuid>.csv] in the
			// prompt, but pi treats the path literally — /uploads/ doesn't
			// exist on disk; the files live in config.uploadsDir.
			const message = rewriteUploadUrls(msg.text);
			pi.send({
				type: "prompt",
				message,
				...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
			});
			break;
		}
		case "steer": {
			// Steering messages are queued while the agent runs and delivered
			// after the current assistant turn finishes its tool calls,
			// before the next LLM call. Same upload-URL rewriting as `prompt`.
			const message = rewriteUploadUrls(msg.text);
			pi.send({
				type: "steer",
				message,
				...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
			});
			break;
		}
		case "abort": {
			pi.send({ type: "abort" });
			break;
		}
		case "setModel": {
			pi.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
			break;
		}
		case "setThinking": {
			pi.send({ type: "set_thinking_level", level: msg.level });
			break;
		}
		case "renameSession": {
			pi.send({ type: "set_session_name", name: msg.name });
			break;
		}
		case "listSessions": {
			const sessions: SessionSummary[] = listPiSessions(config.piCwd);
			send(ws, { type: "sessions", sessions });
			break;
		}
		case "newSession": {
			// Discard the current session and start a fresh one. newSession
			// is an explicit user action ("new chat"), so killing the old
			// child is expected — this is NOT the phone-lock case.
			replaceSession(ws, session, {
				provider: session.init.provider,
				modelId: session.init.modelId,
				thinkingLevel: session.init.thinkingLevel,
			});
			break;
		}
		case "resumeSession": {
			// Switch to a different session: reattach if it is still live in
			// the registry, otherwise spawn `pi --session <id>` fresh.
			replaceSession(ws, session, {
				provider: session.init.provider,
				modelId: session.init.modelId,
				thinkingLevel: session.init.thinkingLevel,
				sessionId: msg.sessionId,
			});
			break;
		}
		default: {
			// Exhaustiveness check.
			const _exhaustive: never = msg;
			void _exhaustive;
		}
	}
}

/**
 * Swap the ws from one session to another (newSession / resumeSession).
 * Kills the old child (these are explicit user actions, not the
 * phone-lock case) and binds the new one, which may be a reattach to a
 * still-live session.
 */
function replaceSession(ws: PiSocket, old: LiveSession, init: InitMessage): void {
	registry.detach(old, ws);
	registry.kill(old);
	const next = registry.acquire(init);
	registry.attach(next, ws);
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
 * Send a server-originated message (sessions list, app-level ping,
 * protocol error) straight to the ws. Live `pi` events and ready /
 * transcript frames go through the registry's `deliver`, which routes
 * to whatever ws is currently bound to the session. This wrapper is for
 * messages that originate from this connection handler itself.
 */
function send(ws: PiSocket, msg: ServerMessage): void {
	deliver(ws, msg);
}
