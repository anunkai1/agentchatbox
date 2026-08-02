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
import type {
	ClientMessage,
	ProjectSummary,
	PromptImage,
	ServerMessage,
	SessionSummary,
} from "../shared/protocol.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { ProjectRecord } from "./projects.js";
import {
	createProject,
	deleteProject,
	GLOBAL_PROJECT_ID,
	getProject,
	listProjects,
	projectIdForCwd,
	reorderProjects,
	updateProject,
} from "./projects.js";
import {
	deletePiSession,
	findSessionCwd,
	forkPiSession,
	listAllSessions,
	setPiSessionName,
} from "./session-list.js";
import { setPinned } from "./session-pins.js";
import {
	deliver,
	deliverError,
	type InitMessage,
	type LiveSession,
	type PiSocket,
	registry,
} from "./session-registry.js";
import { safeUnref } from "./util.js";

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

// Module-level reference to the chat WS server, set once in mountChatWs.
// Used by broadcastSessions to push an updated session list to every
// connected client (e.g. after a pin toggle, so all devices sync).
let chatWss: WebSocketServer | null = null;

// Server shutdown is driven from the entry point (index.ts), which owns
// the single SIGTERM listener for the process. We expose shutdownChatWs()
// so index.ts can SIGTERM every live child there, alongside server.close().
// Registering `process.on("SIGTERM")` here was an import-time side effect
// that accumulated one listener per module evaluation (tripping
// MaxListenersExceededWarning under the test suite, which re-imports this
// module once per test file) and duplicated index.ts's handler.
export function shutdownChatWs(): void {
	registry.killAll();
}

export function mountChatWs(server: HttpServer): void {
	const wss = new WebSocketServer({ server, path: "/api/chat" });
	chatWss = wss;

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
	safeUnref(heartbeatTimer);

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

	wss.on("close", () => {
		clearInterval(heartbeatTimer);
		chatWss = null;
	});

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
	//
	// For a BRAND-NEW session (no sessionId — a freshly opened tab),
	// override the client's model/provider/thinking with the Global
	// project's configured defaults, if any. The client always sends a
	// concrete modelId (it can't know the configured default before the
	// projects list loads), but for a new tab that model is never a
	// deliberate choice — it's the client's fallback — so the server,
	// which owns project defaults, is authoritative here. A reconnect
	// (sessionId present) keeps the client's model: we're resuming and
	// the client knows the live model. See resolveInitDefaults.
	const resolvedInit = resolveInitDefaults(resolveInitCwd(init), getProject(GLOBAL_PROJECT_ID));
	const session = registry.acquire(resolvedInit);
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
		// A synchronous throw here (e.g. registry.acquire rejecting a
		// logged-out provider, a disk error in a sidecar write) would
		// otherwise propagate out of the ws "message" listener as an
		// uncaughtException and crash the whole server — taking every
		// active session and every pi child with it (the exact failure
		// the registry exists to prevent). Surface it to the client as an
		// error frame instead. The per-command guards below own their
		// own, more specific, recovery (e.g. replaceSession clearing
		// ws._session on a failed acquire); this is the catch-all backstop.
		try {
			onClientMessage(ws, msg, current);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log.error("client message handler threw", { error: message });
			deliverError(ws, `internal error: ${message}`);
		}
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

/** Shape `PromptImage`s into pi's `ImageContent` wire format.
 *
 * pi's RPC `ImageContent` requires a `type: "image"` discriminator on
 * every block; the browser's `PromptImage` only carries `{data, mimeType}`.
 * Forwarding the browser shape verbatim means pi persists a block with no
 * `type` field into the session transcript — the live vision-proxy call
 * still works (it intercepts before the provider sees the block), but on
 * resume the replayed history is sent straight to the model and rejected:
 * `400 messages.content.type is invalid, allowed values: ['text']`, which
 * silently bricks the whole session (every future turn 400s). Stamping the
 * discriminator here at the transport boundary is the fix. */
function toImageContent(images: PromptImage[] | undefined) {
	return images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
}

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
			// exist on disk; the files live in config.uploadsDir. Image
			// links are reduced to a bare label when their bytes also ride
			// in the structured `images` field (see rewriteUploadUrls).
			const hasImages = !!msg.images && msg.images.length > 0;
			const message = rewriteUploadUrls(msg.text, hasImages);
			pi.send({
				type: "prompt",
				message,
				...(hasImages ? { images: toImageContent(msg.images) } : {}),
			});
			break;
		}
		case "steer": {
			// Steering messages are queued while the agent runs and delivered
			// after the current assistant turn finishes its tool calls,
			// before the next LLM call. Same upload-URL rewriting as `prompt`.
			const hasImages = !!msg.images && msg.images.length > 0;
			const message = rewriteUploadUrls(msg.text, hasImages);
			pi.send({
				type: "steer",
				message,
				...(hasImages ? { images: toImageContent(msg.images) } : {}),
			});
			break;
		}
		case "abort": {
			pi.send({ type: "abort" });
			break;
		}
		case "abortRetry": {
			// Cancel an in-flight auto-retry backoff (the CLI's "interrupt to
			// cancel" during a retry countdown). Mirrors pi rpc's
			// `abort_retry` command — pure forwarding, no server logic.
			pi.send({ type: "abort_retry" });
			break;
		}
		case "setModel": {
			// Stash the request in session.pendingModel and send the RPC.
			// Do NOT update session.init here — that is the job of
			// session-registry.ts's onEvent, which only mutates init when
			// pi's `set_model` response comes back with `success: true`.
			// The old optimistic update was the bug behind silent-fail
			// model switches: when pi rejected an id (e.g. a model
			// advertised in EXTRA_MODELS but not registered with pi's
			// model-registry, or a typo), session.init was already
			// pointing at the rejected model, so a refresh/reconnect
			// made the picker lie about the current model and the next
			// prompt still went to the old one.
			session.pendingModel = { provider: msg.provider, modelId: msg.modelId };
			pi.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
			break;
		}
		case "extensionUiResponse": {
			// Forward the browser's response to a pi extension_ui_request
			// dialog (select/confirm/input) straight to pi's stdin. This is
			// the generic relay — pi extensions ask the user questions via
			// ctx.ui.select() etc., ACB renders the dialog in the browser,
			// and the answer flows back through this channel. No server-side
			// logic; pure transport.
			pi.send({
				type: "extension_ui_response",
				id: msg.id,
				...(msg.value !== undefined ? { value: msg.value } : {}),
				...(msg.confirmed !== undefined ? { confirmed: msg.confirmed } : {}),
				...(msg.cancelled ? { cancelled: true } : {}),
			});
			break;
		}
		case "setThinking": {
			// Same pessimistic pattern as setModel — see the comment
			// there. The actual init update happens in
			// session-registry.ts when pi's set_thinking_level response
			// arrives with success:true.
			session.pendingThinking = msg.level;
			pi.send({ type: "set_thinking_level", level: msg.level });
			break;
		}
		case "renameSession": {
			pi.send({ type: "set_session_name", name: msg.name });
			break;
		}
		case "renameSessionById": {
			// Append a session_info line to the target session's JSONL (pi's
			// own format) so ANY session can be renamed from the sidebar,
			// not just the one bound to this connection's live pi child.
			// Resolve the session's actual cwd — a session in a project
			// folder is NOT under config.piCwd, so hardcoding the global cwd
			// (as forkSession used to) silently failed the rename for every
			// non-global chat. Rebroadcast so every device's sidebar updates.
			const renameCwd = findSessionCwd(msg.sessionId, projectCwds()) ?? config.piCwd;
			const renamed = setPiSessionName(renameCwd, msg.sessionId, msg.name);
			if (!renamed) {
				deliverError(ws, "could not rename session (not found on disk)");
				break;
			}
			broadcastSessions();
			break;
		}
		case "setSessionPinned": {
			// Pin state is agentchatbox UI state, not pi state — there is no
			// pi RPC for it, so we persist it ourselves (data/pins.json) and
			// rebroadcast the session list to EVERY connected client so the
			// pin/unpin syncs across all browsers/devices live, not just the
			// one that made the change. (Session rename, by contrast, rides
			// pi's set_session_name and shows up everywhere via the JSONL.)
			setPinned(msg.sessionId, msg.pinned);
			broadcastSessions();
			break;
		}
		case "deleteSession": {
			// Deletion is asynchronous because a live pi child must finish its
			// graceful shutdown (and final JSONL flush) before the transcript is
			// unlinked. Keep dispatch non-blocking; the helper catches and reports
			// every failure itself.
			void deleteSessionAndTranscript(ws, msg.sessionId);
			break;
		}
		case "forkSession": {
			// Fork the source session's JSONL into a new session file (a
			// truncated copy of pi's own persistence format — see
			// forkPiSession). Tell the requesting client the new id so it
			// can resumeSession the fork; broadcast the session list so
			// every sidebar picks up the new chat. No agent logic here —
			// just filesystem copying + routing, the transport layer's job.
			const cwd = findSessionCwd(msg.sessionId, projectCwds()) ?? config.piCwd;
			const newId = forkPiSession(cwd, msg.sessionId, msg.messageCount);
			if (!newId) {
				deliverError(ws, "could not fork session (source session not found)");
				break;
			}
			send(ws, { type: "forked", sessionId: newId });
			broadcastSessions();
			break;
		}
		// --- Projects -------------------------------------------------------
		case "listProjects": {
			send(ws, { type: "projects", projects: listProjects() as ProjectSummary[] });
			break;
		}
		case "createProject": {
			createProject({
				name: msg.name,
				icon: msg.icon,
				instructions: msg.instructions,
				defaultModelId: msg.defaultModelId,
				defaultProvider: msg.defaultProvider,
				defaultThinkingLevel: msg.defaultThinkingLevel,
			});
			broadcastProjects();
			broadcastSessions();
			break;
		}
		case "updateProject": {
			updateProject(msg.id, {
				name: msg.name,
				icon: msg.icon,
				instructions: msg.instructions,
				defaultModelId: msg.defaultModelId,
				defaultProvider: msg.defaultProvider,
				defaultThinkingLevel: msg.defaultThinkingLevel,
			});
			broadcastProjects();
			break;
		}
		case "deleteProject": {
			deleteProject(msg.id);
			broadcastProjects();
			broadcastSessions();
			break;
		}
		case "reorderProjects": {
			reorderProjects(msg.order);
			broadcastProjects();
			break;
		}
		case "listSessions": {
			const sessions = gatherSessions();
			send(ws, { type: "sessions", sessions });
			break;
		}
		case "getCapabilities": {
			// Pure forward: ask the live pi child for its loaded commands /
			// skills / extensions. The response is reshaped to
			// {type:"capabilities"} in session-registry.ts (it must be
			// intercepted there because a `response` with success:true would
			// otherwise be dropped as a noisy ack before reaching the client).
			session.pi.send({ type: "get_commands" });
			break;
		}
		case "getSessionStats": {
			// Pure forward: ask pi for `get_session_stats` so the browser can
			// render the context-window fill meter. The response is reshaped
			// to {type:"sessionStats"} in session-registry.ts (same
			// success-ack-interception reason as getCapabilities above).
			session.pi.send({ type: "get_session_stats" });
			break;
		}
		case "newSession": {
			// Discard the current session and start a fresh one. newSession
			// is an explicit user action ("new chat"), so killing the old
			// child is expected — this is NOT the phone-lock case. `projectId`
			// selects which project folder the new `pi` runs in (defaults to
			// Global); pi auto-loads that folder's AGENTS.md as instructions.
			// When no projectId is given, fall back to the Global project so
			// "+ New chat" respects its configured default model (if any)
			// instead of silently inheriting the current session's model.
			const project = msg.projectId ? getProject(msg.projectId) : getProject(GLOBAL_PROJECT_ID);
			const cwd = project?.cwd ?? config.piCwd;
			void replaceSession(ws, session, {
				provider: project?.defaultProvider ?? session.init.provider,
				modelId: project?.defaultModelId ?? session.init.modelId,
				thinkingLevel: project?.defaultThinkingLevel ?? session.init.thinkingLevel,
				cwd,
			});
			break;
		}
		case "resumeSession": {
			// Switch to a different session: reattach if it is still live in
			// the registry, otherwise spawn `pi --session <id>` fresh. The
			// session's project is derived from its recorded cwd so pi runs
			// in the folder whose AGENTS.md shaped that conversation.
			const cwd = findSessionCwd(msg.sessionId, projectCwds());
			void replaceSession(ws, session, {
				provider: session.init.provider,
				modelId: session.init.modelId,
				thinkingLevel: session.init.thinkingLevel,
				sessionId: msg.sessionId,
				cwd: cwd ?? config.piCwd,
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
 * Transactionally swap the ws from one session to another (newSession /
 * resumeSession). The current child stays attached and usable while the
 * candidate starts. Only after pi proves the candidate is ready by returning
 * a real session id do we detach/kill the old child and bind the replacement.
 * A missing provider key, spawn failure, or pre-ready child exit therefore
 * leaves the current session untouched instead of stranding the browser.
 */
async function replaceSession(ws: PiSocket, old: LiveSession, init: InitMessage): Promise<void> {
	if (ws._switching) {
		deliverError(ws, "a session switch is already in progress");
		return;
	}
	ws._switching = true;
	let next: LiveSession | null = null;
	try {
		next = registry.acquire(init);
		if (next === old) return;

		await registry.waitUntilReady(next);

		// The socket may have closed or been displaced by another tab while
		// the candidate was starting. Never steal it back after that race.
		if (ws._session !== old) return;

		registry.detach(old, ws);
		try {
			registry.attach(next, ws);
		} catch (err) {
			// attach is synchronous, but preserve the old binding if a future
			// transport check ever makes it throw.
			registry.attach(old, ws);
			throw err;
		}
		registry.kill(old);
	} catch (err) {
		// A failed candidate is unattached; terminate it so a never-ready
		// process cannot linger in the registry. Natural exits are already
		// marked killed, making this cleanup idempotent.
		if (next && next !== old && !next.ready) registry.kill(next);
		const message = err instanceof Error ? err.message : String(err);
		log.warn("session replacement failed; keeping current session", {
			sessionId: old.sessionId,
			error: message,
		});
		if (ws._session === old) {
			deliverError(ws, `could not switch session; current session is still active: ${message}`);
		}
	} finally {
		ws._switching = false;
	}
}

/**
 * Stop any live owner of a session before removing its persisted transcript.
 * Pi intentionally flushes on SIGTERM, so the ordering here is the deletion
 * guarantee: wait for exit first, unlink second. A live empty session may not
 * have a JSONL yet; terminating it still counts as a successful deletion.
 */
async function deleteSessionAndTranscript(ws: PiSocket, sessionId: string): Promise<void> {
	try {
		const live = await registry.terminateById(sessionId);
		const cwd = live?.init.cwd ?? findSessionCwd(sessionId, projectCwds()) ?? config.piCwd;
		const deletedFromDisk = deletePiSession(cwd, sessionId);
		if (!live && !deletedFromDisk) {
			deliverError(ws, "could not delete session (not found on disk)");
			return;
		}
		setPinned(sessionId, false);
		// Search is a derived, pluggable index. Its helper catches failures so
		// transcript deletion remains authoritative even without the module.
		void purgeSessionFromSearchIndex(sessionId);
		broadcastSessions();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		log.error("session deletion failed", { sessionId, error: message });
		deliverError(ws, `could not delete session: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Image file extensions — delivered as structured `images` attachments,
 * so their markdown link must NOT be left as a readable on-disk path (see
 * `rewriteUploadUrls`). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i;

/**
 * Rewrite /uploads/<filename> web URLs in prompt text to the absolute
 * filesystem path where the uploaded file actually lives. The browser
 * inserts markdown links like `[file: foo.csv](/uploads/<uuid>.csv)`;
 * pi's `read` tool treats the path literally and fails with ENOENT
 * because /uploads/ is a web route, not a filesystem path.
 *
 * Images are a special case: their bytes are ALSO delivered as a
 * structured `images` attachment. Leaving a readable filesystem path in
 * the text on top of that makes pi's multimodal-proxy (which gathers
 * images from BOTH `event.images` AND paths it detects in the prompt)
 * re-read the same file from disk and analyze it twice — one attachment
 * shows up as "Analyzing 2 images". So when structured image bytes are
 * present, the image link is reduced to a bare `[image: name]` label
 * (no path). Non-image files have no structured equivalent, so their
 * links are still rewritten to the real path for pi's `read` tool.
 */
export function rewriteUploadUrls(text: string, hasStructuredImages: boolean): string {
	return text.replace(
		/\[(image|file):\s*([^\]]*)\]\(\/uploads\/([A-Za-z0-9._-]+)\)/g,
		(_full, kind: string, label: string, filename: string) => {
			const name = (label ?? "").trim();
			if (kind === "image" && hasStructuredImages && IMAGE_EXT_RE.test(filename)) {
				return `[image: ${name}]`;
			}
			return `[${kind}: ${name}](${join(config.uploadsDir, filename)})`;
		},
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

/**
 * Purge a session from the optional semantic-search index
 * (`data/search.db`). The search module is PLUGGABLE — deleting
 * `src/server/search/` leaves the core server compiling — so we use a
 * dynamic import with a non-literal specifier (TypeScript won't try to
 * resolve it) and wrap it in try/catch. A failure (module missing, native
 * `better-sqlite3` load error, ONNX init error) degrades to "index not
 * purged" rather than failing the delete: the JSONL is already gone, the
 * pin is cleared, and stale search hits are a recoverable nuisance, not a
 * data-loss event. Same try-guarded-dynamic-import pattern the
 * `/api/sessions/search` route in index.ts uses.
 */
async function purgeSessionFromSearchIndex(sessionId: string): Promise<void> {
	const searchPath = "./search/index.js";
	try {
		const mod = (await import(searchPath)) as {
			deleteIndexedSession?: (id: string) => Promise<void>;
		};
		await mod.deleteIndexedSession?.(sessionId);
	} catch (e) {
		log.warn("search index purge failed (non-fatal)", {
			sessionId,
			error: String(e),
		});
	}
}

/**
 * Push a freshly-read session list to every connected client. Used after
 * a pin/unpin so all open browsers/devices update live — pin state lives
 * on the server (data/pins.json), so this is how a pin done on the phone
 * reaches the desktop and vice versa. Also fires on the original client,
 * so the caller doesn't need a separate reply.
 */
function broadcastSessions(): void {
	const sessions = gatherSessions();
	broadcast({ type: "sessions", sessions });
}

/**
 * Build the sidebar session list, merging in any live `pi` child whose
 * JSONL isn't on disk yet. pi only persists a session file once the
 * first message lands — so a brand-new empty chat (just spawned, no
 * messages) is invisible to `listAllSessions`, which scans the disk.
 * Without this merge the new chat doesn't appear in the sidebar until
 * the next page refresh (by which point pi has finally written the
 * file). The synthetic entry is replaced by the real on-disk one as
 * soon as pi flushes and the list is next gathered.
 */
function gatherSessions(): SessionSummary[] {
	const sessions = listAllSessions(projectCwds());
	const onDisk = new Set(sessions.map((s) => s.id));
	const now = new Date().toISOString();
	for (const live of registry.liveSessions()) {
		if (onDisk.has(live.sessionId)) continue;
		const cwd = live.cwd ?? config.piCwd;
		const pid = projectIdForCwd(cwd);
		sessions.push({
			id: live.sessionId,
			cwd,
			createdAt: now,
			modifiedAt: now,
			title: "New chat",
			messageCount: 0,
			projectId: pid === GLOBAL_PROJECT_ID ? "global" : pid,
		});
	}
	// Newest first so a freshly-created chat floats to the top of its
	// folder even though `now` ties its createdAt/modifiedAt.
	sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return sessions;
}

/**
 * Push the current project list to every connected client. Fired after
 * any project CRUD/reorder so all open sidebars refresh their folder
 * structure live (mirrors broadcastSessions).
 */
function broadcastProjects(): void {
	const projects: ProjectSummary[] = listProjects() as ProjectSummary[];
	broadcast({ type: "projects", projects });
}

/**
 * Send `msg` to every open client. Shared by broadcastSessions /
 * broadcastProjects (and any future server-pushed list refresh) so the
 * "iterate chatWss.clients, gate on OPEN, deliver" loop lives once.
 */
function broadcast(msg: ServerMessage): void {
	if (!chatWss) return;
	for (const ws of chatWss.clients) {
		if (ws.readyState === ws.OPEN) {
			deliver(ws as PiSocket, msg);
		}
	}
}

/** The cwds of all known projects (for multi-cwd session listing/lookup). */
function projectCwds(): string[] {
	return listProjects().map((p) => p.cwd);
}

/**
 * If the client's `init` names a sessionId but no cwd, resolve the cwd
 * from the session JSONL so a reconnect/resume spawns `pi` in the right
 * project folder (and loads that project's AGENTS.md). Falls back to
 * config.piCwd when the session can't be found (e.g. a stale link).
 */
function resolveInitCwd(init: InitMessage): InitMessage {
	if (init.cwd) return init;
	if (!init.sessionId) return init;
	const cwd = findSessionCwd(init.sessionId, projectCwds());
	return cwd ? { ...init, cwd } : init;
}

/**
 * For a brand-new session (no sessionId), fill in the Global project's
 * configured default model/provider/thinking when the user has set one.
 * A reconnect (sessionId present) is left untouched — the client's
 * model is the live one we want to resume with. Pure + exported so the
 * resolution can be unit-tested without spawning a `pi` child.
 */
export function resolveInitDefaults(
	init: InitMessage,
	global: ProjectRecord | undefined,
): InitMessage {
	if (init.sessionId) return init;
	if (!global) return init;
	const provider = global.defaultProvider ?? init.provider;
	const modelId = global.defaultModelId ?? init.modelId;
	const thinkingLevel = global.defaultThinkingLevel ?? init.thinkingLevel;
	if (
		provider === init.provider &&
		modelId === init.modelId &&
		thinkingLevel === init.thinkingLevel
	) {
		return init;
	}
	return { ...init, provider, modelId, thinkingLevel };
}
