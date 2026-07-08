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
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
	const resolvedInit = resolveInitCwd(init);
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

/**
 * Atomically write `modelId` (or remove the file when null) to the
 * image-model override file. Used by the `setImageModel` RPC handler so
 * the pi-venice-image extension can read the user's chosen default on
 * each `venice_generate_image` tool call. Separate from this file's
 * main switch so the fire-and-forget call site stays readable.
 */
async function persistImageModel(
	modelId: string | null,
	file: string,
): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	if (modelId === null) {
		await rm(file, { force: true });
		return;
	}
	const tmp = file + ".tmp";
	await writeFile(tmp, modelId + "\n", "utf8");
	await rename(tmp, file);
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
			// exist on disk; the files live in config.uploadsDir.
			const message = rewriteUploadUrls(msg.text);
			pi.send({
				type: "prompt",
				message,
				...(msg.images && msg.images.length > 0 ? { images: toImageContent(msg.images) } : {}),
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
				...(msg.images && msg.images.length > 0 ? { images: toImageContent(msg.images) } : {}),
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
			pi.send({ type: "set_model", provider: msg.provider, modelId: msg.modelId });
			// Record the change on the session so a later reattach (page
			// refresh, reconnect) reports the CURRENT model in `ready`, not
			// the one the session was spawned with. Without this, refreshing
			// after switching models reverts the displayed model to the
			// original spawn default, even though pi itself kept the new one.
			session.init = { ...session.init, provider: msg.provider, modelId: msg.modelId };
			break;
		}
		case "setImageModel": {
			// Persist the user's chosen image model to a file the
			// pi-venice-image extension reads on each `venice_generate_image`
			// tool call. Writing here keeps selection live across the
			// existing pi child (no respawn), which matters because image
			// generation is invoked from inside a long agent loop — a
			// respawn would lose the loop's progress.
			//
			// Fire-and-forget: onClientMessage is sync; the write is
			// atomic (write-then-rename) so a partially-written file
			// can't be read mid-update. `null` modelId removes the
			// override file entirely so the extension falls back to its
			// own built-in default.
			const file = config.imageModelFile;
			void persistImageModel(msg.modelId, file).catch((err) => {
				log.error("setImageModel write failed", {
					modelId: msg.modelId,
					file,
					error: err instanceof Error ? err.message : String(err),
				});
				deliverError(ws, "could not persist image model selection");
			});
			break;
		}
		case "setThinking": {
			pi.send({ type: "set_thinking_level", level: msg.level });
			// Same rationale as setModel: keep init in sync so reattach
			// reports the current thinking level, not the spawn default.
			session.init = { ...session.init, thinkingLevel: msg.level };
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
		case "newSession": {
			// Discard the current session and start a fresh one. newSession
			// is an explicit user action ("new chat"), so killing the old
			// child is expected — this is NOT the phone-lock case. `projectId`
			// selects which project folder the new `pi` runs in (defaults to
			// Global); pi auto-loads that folder's AGENTS.md as instructions.
			const project = msg.projectId ? getProject(msg.projectId) : undefined;
			const cwd = project?.cwd ?? config.piCwd;
			replaceSession(ws, session, {
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
			replaceSession(ws, session, {
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

/**
 * Push a freshly-read session list to every connected client. Used after
 * a pin/unpin so all open browsers/devices update live — pin state lives
 * on the server (data/pins.json), so this is how a pin done on the phone
 * reaches the desktop and vice versa. Also fires on the original client,
 * so the caller doesn't need a separate reply.
 */
function broadcastSessions(): void {
	if (!chatWss) return;
	const sessions = gatherSessions();
	const msg: ServerMessage = { type: "sessions", sessions };
	for (const ws of chatWss.clients) {
		if (ws.readyState === ws.OPEN) {
			deliver(ws as PiSocket, msg);
		}
	}
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
	if (!chatWss) return;
	const projects: ProjectSummary[] = listProjects() as ProjectSummary[];
	const msg: ServerMessage = { type: "projects", projects };
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
