/**
 * Detachable session registry — the "tmux for the agent" layer.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Previously one `pi --mode rpc` child was bound 1:1 to a WebSocket
 * connection, and `ws.on("close")` killed the child. On Android, the
 * OS suspends JS the moment you background/lock the tab; within ~20s
 * the heartbeat notices, the server terminates the socket, and the
 * close handler SIGTERMs the agent — interrupting whatever it was
 * doing. Reconnect only rebuilt the pipe to a freshly spawned (idle)
 * child; the in-flight work was gone.
 *
 * THE FIX
 *
 * Decouple the agent's lifetime from the connection's. The registry
 * owns every live `pi` child, keyed by session id. A WebSocket is just
 * a *view* that attaches and detaches:
 *
 *   - disconnect  → detach the view. The child keeps running. If it is
 *                   idle (not mid-turn) AND nothing reattaches within
 *                   IDLE_GRACE_MS, only THEN is it killed. A child
 *                   mid-turn is never killed — that would be the very
 *                   interruption we are fixing.
 *   - reconnect   → reattach to the still-live child (same session id),
 *                   replay the on-disk transcript, and — if the agent
 *                   is mid-turn — replay the buffered current-turn
 *                   events so the streaming UI reconstructs exactly.
 *
 * This is transport-layer plumbing (process lifetime + event routing),
 * NOT agent logic. The actual agent still lives entirely inside the
 * `pi` subprocess; nothing crosses the transport boundary that didn't
 * before. It fits the "transport layer only" rule: we are making the
 * pipe reattachable, no smarter.
 */

import type { WebSocket } from "ws";
import type { ServerMessage, ThinkingLevel, TranscriptPayload } from "../shared/protocol.js";
import { config, getServerApiKey } from "./config.js";
import { log } from "./logger.js";
import { type PiProcess, spawnPi } from "./pi-process.js";
import { readPiSessionMessages } from "./session-list.js";

/**
 * Grace period before an idle, detached session is reaped. An idle
 * session is one whose current turn has ended (`turn_end` seen) and
 * which has no WebSocket attached. A session that is mid-turn is
 * NEVER reaped, regardless of age — killing it would interrupt work,
 * which is the bug this module exists to prevent. Override via the
 * AGENTCHATBOX_IDLE_GRACE_MS env var.
 */
const IDLE_GRACE_MS = Number(process.env.AGENTCHATBOX_IDLE_GRACE_MS ?? 5 * 60_000);

/**
 * Maximum number of events buffered for the current (in-flight) turn.
 * Bounds memory if a turn runs very long; the buffer is a sliding
 * window so the most recent events (the ones needed to reconstruct
 * streaming state on reattach) are always kept.
 */
const CURRENT_TURN_BUFFER_MAX = 2000;

/**
 * Per-send WS output backpressure guard. `ws.bufferedAmount` is the
 * number of bytes Node has accepted but not yet flushed to the kernel.
 * Under heavy `message_update` streaming a slow/stuck tab can let this
 * grow without bound → server OOM. Past the high-water mark we treat
 * the client as wedged and close the socket (the browser reconnects and
 * gets fresh state via transcript replay). Standard ws-library pattern.
 */
const WS_BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024; // 16 MiB

export interface InitMessage {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	sessionId?: string;
}

/**
 * A WebSocket that may be bound to a live session. The `_session`
 * back-reference lets message/close handlers reach the session without
 * a parallel closure variable that can drift during respawn/reattach.
 */
export interface PiSocket extends WebSocket {
	_session?: LiveSession | null;
}

/**
 * A live `pi --mode rpc` child plus the state needed to reattach a
 * (possibly different) WebSocket to it after a disconnect.
 *
 *   - `ws` is the currently-attached view, or `null` when detached.
 *   - `ready` flips true once `get_state` returned a session id (i.e.
 *     pi's AgentSession is constructed and the client can be told
 *     `ready`). Before this, a close should kill (nothing to preserve).
 *   - `busy` is true between `turn_start` and `turn_end`. A busy
 *     session is immune to idle reaping.
 *   - `currentTurn` holds the raw events of the in-flight turn, replayed
 *     on reattach so a mid-stream reconnect reconstructs the partial
 *     assistant message (whose `message_start` the client otherwise
 *     missed while disconnected).
 *   - `idleTimer` is the pending reap timer for an idle+detached
 *     session, or null.
 */
export interface LiveSession {
	pi: PiProcess;
	init: InitMessage;
	sessionId: string;
	ws: PiSocket | null;
	ready: boolean;
	busy: boolean;
	idleTimer: ReturnType<typeof setTimeout> | null;
	currentTurn: unknown[];
}

class SessionRegistry {
	/** Every live `pi` child, keyed by session id. */
	private readonly entries = new Map<string, LiveSession>();

	/**
	 * Get an existing live session by id, or spawn a fresh one. This is
	 * the single entry point for both initial connect and reconnect — a
	 * reconnect whose `init.sessionId` is still live returns the running
	 * child (reattach), otherwise a new child is spawned.
	 */
	acquire(init: InitMessage): LiveSession {
		if (init.sessionId) {
			const existing = this.entries.get(init.sessionId);
			if (existing) {
				log.info("session reattach", { sessionId: init.sessionId });
				return existing;
			}
		}
		return this.spawn(init);
	}

	private spawn(init: InitMessage): LiveSession {
		const apiKey = getServerApiKey(init.provider);
		if (!apiKey) {
			throw new Error(
				`no API key for provider "${init.provider}" — set one in .env or pick a different provider`,
			);
		}
		const pi = spawnPi({
			bin: config.piBin,
			provider: init.provider,
			modelId: init.modelId,
			apiKey,
			cwd: config.piCwd,
			sessionId: init.sessionId,
			thinkingLevel: init.thinkingLevel,
		});
		const session: LiveSession = {
			pi,
			init,
			sessionId: init.sessionId ?? "",
			ws: null,
			ready: false,
			busy: false,
			idleTimer: null,
			currentTurn: [],
		};
		// For a resume we know the id up front; register immediately so a
		// reconnect during the (<1s) spawn window can reattach. For a new
		// session the id isn't known until `get_state` returns; we register
		// there. The two paths converge in onGetStateResponse below.
		if (init.sessionId) this.entries.set(init.sessionId, session);

		// One set of listeners for the whole lifetime of the child. They
		// forward to `session.ws` — whatever it currently is — so attach /
		// detach is just swapping that reference.
		pi.on("event", (line) => this.onEvent(session, line));
		pi.on("error", (err) => {
			// The child will die on its own after this. Tell the attached
			// view (if any) but do NOT close its ws — it may be mid-respawn.
			deliver(session.ws, { type: "error", message: `pi subprocess error: ${err.message}` });
		});
		pi.on("exit", (info) => {
			if (session.idleTimer) {
				clearTimeout(session.idleTimer);
				session.idleTimer = null;
			}
			if (session.sessionId) this.entries.delete(session.sessionId);
			if (!session.ready) {
				deliver(session.ws, {
					type: "error",
					message: `pi exited before ready (code=${info.code}, signal=${info.signal}): ${pi.getStderr().slice(-200)}`,
				});
			}
			// If ready already sent, the child died after running a while.
			// Don't auto-close the ws — normal during respawn/reattach; the
			// client will receive a new ready once the new child is up.
		});

		this.requestSessionId(session);
		return session;
	}

	/**
	 * Bind a WebSocket to a session (initial attach or reattach). Sends
	 * `ready` + transcript + current-turn replay immediately if the
	 * session is already ready (the reattach case). If not ready yet,
	 * the `get_state` response handler sends them once pi reports its
	 * session id. Cancels any pending idle reap — somebody is watching.
	 */
	attach(session: LiveSession, ws: PiSocket): void {
		ws._session = session;
		session.ws = ws;
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = null;
		}
		if (session.ready) this.sendReadyAndCatchup(session);
	}

	/**
	 * Unbind a WebSocket from a session. Called on ws close. Does NOT
	 * kill the child — that is the whole point. If the session is idle,
	 * schedule a reap after IDLE_GRACE_MS; if mid-turn, leave it running
	 * unconditionally (the turn_end handler will schedule the reap when
	 * the work finishes).
	 */
	detach(session: LiveSession, ws: PiSocket): void {
		if (session.ws === ws) session.ws = null;
		if (!session.busy) this.scheduleIdleReap(session);
	}

	/** Force-kill a session and remove it from the registry. */
	kill(session: LiveSession): void {
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = null;
		}
		if (session.sessionId) this.entries.delete(session.sessionId);
		session.ws = null;
		try {
			session.pi.kill();
		} catch {
			/* ignore */
		}
	}

	/** SIGTERM every live child — used on server shutdown. */
	killAll(): void {
		for (const s of this.entries.values()) this.kill(s);
	}

	// -----------------------------------------------------------------------
	// Event handling (one listener set per child, lifetime-bound)
	// -----------------------------------------------------------------------

	private onEvent(session: LiveSession, line: Record<string, unknown>): void {
		// Harvest the session id from get_state's response. pi doesn't emit
		// a "session" line on startup; the id is buried in get_state's
		// response. On the first one, mark ready and (if a view is
		// attached) send ready + catch-up.
		if (line.type === "response" && line.command === "get_state" && !session.ready) {
			const data = line.data as { sessionId?: string } | undefined;
			const id = String(data?.sessionId ?? "");
			if (id) {
				session.sessionId = id;
				session.ready = true;
				this.entries.set(id, session); // idempotent for resume, first reg for new
				this.sendReadyAndCatchup(session);
			}
		}

		// Drop success acks (noise — pi's events are the real confirmation).
		// Fall through for success:false so failures reach the client: that
		// is what makes this a transparent pipe rather than a silent dropper.
		if (line.type === "response" && line.success !== false) return;

		// Busy tracking + current-turn buffering. turn_start/turn_end are
		// the clean boundaries of an agent turn; between them the session
		// is immune to idle reaping. The current-turn buffer is replayed on
		// reattach to reconstruct an in-flight assistant message whose
		// `message_start` the client missed while disconnected.
		if (line.type === "turn_start") {
			session.busy = true;
			session.currentTurn = [line];
			// Work started — cancel any pending reap. A busy session is
			// never reaped, even if detached.
			if (session.idleTimer) {
				clearTimeout(session.idleTimer);
				session.idleTimer = null;
			}
		} else if (session.busy && line.type !== "turn_end") {
			session.currentTurn.push(line);
			if (session.currentTurn.length > CURRENT_TURN_BUFFER_MAX) {
				session.currentTurn.shift();
			}
		} else if (line.type === "turn_end") {
			// Keep the completed turn buffered until the next turn_start
			// overwrites it — covers a reattach in the tiny window between
			// turn_end and the JSONL flush. Then, if nobody is watching,
			// schedule the idle reap.
			session.currentTurn.push(line);
			session.busy = false;
			if (!session.ws) this.scheduleIdleReap(session);
		}

		deliver(session.ws, { type: "event", event: line });
	}

	/**
	 * Send `ready`, then replay catch-up state to the attached view:
	 *   1. the on-disk transcript — all completed messages so far (also
	 *      covers the resume-from-disk case and a full page reload).
	 *   2. if mid-turn, the buffered current-turn events — reconstructs
	 *      the in-flight assistant message exactly (message_start,
	 *      message_update deltas, tool calls). Transcript and buffer do
	 *      not overlap: the in-flight message is not on disk yet.
	 *
	 * The client's onTranscript is already a no-op when the replayed
	 * transcript matches what's on screen, so a silent same-session
	 * reconnect neither flickers nor double-renders.
	 */
	private sendReadyAndCatchup(session: LiveSession): void {
		const ws = session.ws;
		if (!ws) return;
		deliver(ws, {
			type: "ready",
			modelId: session.init.modelId,
			provider: session.init.provider,
			thinkingLevel: session.init.thinkingLevel,
			sessionId: session.sessionId,
		});
		const messages = readPiSessionMessages(config.piCwd, session.sessionId);
		if (messages.length > 0) {
			const payload: TranscriptPayload = { sessionId: session.sessionId, messages };
			deliver(ws, { type: "transcript", ...payload });
		}
		// Only replay the turn buffer when genuinely mid-turn — once the
		// turn ended, the completed message is on disk and the transcript
		// above already delivered it. Replaying a finished turn would
		// double-render it.
		if (session.busy) {
			for (const ev of session.currentTurn) {
				deliver(ws, { type: "event", event: ev as Record<string, unknown> });
			}
		}
	}

	/**
	 * Schedule a reap of an idle, detached session. A session is only
	 * reaped if, when the timer fires, it is STILL detached and STILL
	 * idle — reattaching or a new turn_start cancels the timer. This is
	 * just cleanup (free the memory of a finished, forgotten session);
	 * it never interrupts active work.
	 */
	private scheduleIdleReap(session: LiveSession): void {
		if (session.idleTimer) return; // already scheduled
		if (!session.sessionId) return; // not ready yet — nothing to reap
		session.idleTimer = setTimeout(() => {
			session.idleTimer = null;
			if (!session.ws && !session.busy) {
				log.info("idle session grace expired; reaping", { sessionId: session.sessionId });
				this.kill(session);
			}
		}, IDLE_GRACE_MS);
		// Don't keep the event loop alive just for reaping.
		if (typeof session.idleTimer.unref === "function") session.idleTimer.unref();
	}

	/**
	 * Send `get_state` on a bounded retry schedule until the session is
	 * ready. pi doesn't ack get_state until its AgentSession is
	 * constructed, so a single send isn't enough. Bounded attempts
	 * prevent an unbounded loop on a wedged child; the exit handler
	 * sends the error frame in that case.
	 */
	private requestSessionId(session: LiveSession): void {
		const intervalMs = 200;
		const maxAttempts = 50; // ~10s ceiling — pi startup is normally <1s
		let attempts = 0;
		const retry = () => {
			if (session.ready || attempts >= maxAttempts) return;
			attempts++;
			session.pi.send({ type: "get_state" });
			setTimeout(retry, intervalMs);
		};
		session.pi.send({ type: "get_state" });
		attempts++;
		setTimeout(retry, intervalMs);
	}
}

/** Process-wide singleton — one registry for the whole server. */
export const registry = new SessionRegistry();

/**
 * Send a message to whatever WebSocket is currently bound to a session
 * (or a raw ws). Guards on readyState and applies the backpressure
 * high-water check: if the socket has buffered more than
 * WS_BACKPRESSURE_HIGH_WATER bytes (a stuck/slow tab under heavy
 * streaming), we close the connection rather than let the buffer grow
 * unbounded into OOM. The browser reconnects and replays state.
 */
export function deliver(ws: PiSocket | null, msg: ServerMessage): void {
	if (!ws || ws.readyState !== ws.OPEN) return;
	if (ws.bufferedAmount > WS_BACKPRESSURE_HIGH_WATER) {
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

/** Convenience: deliver an error frame to the bound ws. */
export function deliverError(ws: PiSocket | null, message: string): void {
	deliver(ws, { type: "error", message });
}
