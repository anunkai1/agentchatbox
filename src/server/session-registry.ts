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
import type {
	ContextUsage,
	PiCommand,
	ServerMessage,
	ThinkingLevel,
	TranscriptPayload,
} from "../shared/protocol.js";
import { config, getServerApiKey } from "./config.js";
import { log } from "./logger.js";
import { type PiProcess, spawnPi } from "./pi-process.js";
import { readPiSessionMessages } from "./session-list.js";
import { safeUnref } from "./util.js";

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
	/**
	 * Working directory the `pi` child runs in. Defaults to config.piCwd
	 * (the Global project). Set to a project's folder so `pi` auto-loads
	 * that project's AGENTS.md and scopes sessions to that cwd.
	 */
	cwd?: string;
}

/**
 * A WebSocket that may be bound to a live session. The `_session`
 * back-reference lets message/close handlers reach the session without
 * a parallel closure variable that can drift during respawn/reattach.
 */
export interface PiSocket extends WebSocket {
	_session?: LiveSession | null;
	/** True while a candidate child is starting for newSession/resumeSession. */
	_switching?: boolean;
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
	/**
	 * Whether the agent is mid-run (between agent_start and agent_end).
	 * Broader than `busy` (which is per-turn): a multi-turn run has
	 * brief gaps between turns where busy=false but streaming=true.
	 * Tracked by observing the agent_start/agent_end events the pipe
	 * already forwards — no derivation — so it survives a tab refresh:
	 * the server reports it in `ready` and the client recovers its
	 * isStreaming (and the Stop button) correctly.
	 */
	streaming: boolean;
	idleTimer: ReturnType<typeof setTimeout> | null;
	currentTurn: unknown[];
	/**
	 * The model+thinking the user just clicked via setModel/setThinking,
	 * awaiting pi's confirmation. The chat.ts handler stashes the
	 * request here and we apply it to `init` only when the matching
	 * pi RPC response comes back with `success: true`. Pessimistic:
	 * if pi rejects the switch (e.g. a model id advertised in
	 * EXTRA_MODELS but not registered in pi's model-registry — see
	 * providers.ts for the drift history), we leave `init` pointing
	 * at the model pi is actually using, so a reattach reports
	 * reality and subsequent prompts go to the right place. The
	 * pre-fix code updated `init` BEFORE pi's response, so a failed
	 * `set_model` made the picker lie about the current model and
	 * prompts kept going to the old one — silent-fail mode.
	 */
	pendingModel: { provider: string; modelId: string } | null;
	pendingThinking: ThinkingLevel | null;
	/**
	 * True when the registry deliberately terminates this child (new/resume,
	 * idle reap, or server shutdown). Natural exits leave this false, allowing
	 * the exit handler to distinguish a broken transport from expected teardown.
	 */
	terminationExpected: boolean;
	/** Promises waiting for pi's first successful get_state readiness response. */
	readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
}

class SessionRegistry {
	/** Every live `pi` child, keyed by session id. */
	private readonly entries = new Map<string, LiveSession>();

	/**
	 * Sessions whose `pi` child has been spawned but hasn't yet reported a
	 * session id via `get_state` (so it isn't in `entries`). Tracked
	 * separately so `killAll()` on shutdown and the never-ready timeout in
	 * `requestSessionId` can reach them — without this, a fresh child that
	 * never became ready (and never exited on its own) was leaked forever:
	 * not in `entries` (no id yet), skipped by the idle reaper (which
	 * requires a session id), and missed by `killAll()` (which only walks
	 * `entries`). A resume child is in `entries` from spawn, so it isn't
	 * here.
	 */
	private readonly pending = new Set<LiveSession>();

	/**
	 * Snapshot of every live, ready session — id + cwd. Used by chat.ts
	 * to inject brand-new sessions into the sidebar list BEFORE pi has
	 * flushed their JSONL to disk (pi only writes the file once the
	 * first message lands, so without this a just-created empty chat is
	 * invisible in the sidebar until the next page refresh).
	 */
	liveSessions(): Array<{ sessionId: string; cwd?: string }> {
		const out: Array<{ sessionId: string; cwd?: string }> = [];
		for (const [id, s] of this.entries) {
			if (id && s.ready) out.push({ sessionId: id, cwd: s.init.cwd });
		}
		return out;
	}

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
			cwd: init.cwd ?? config.piCwd,
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
			streaming: false,
			idleTimer: null,
			currentTurn: [],
			pendingModel: null,
			pendingThinking: null,
			terminationExpected: false,
			readyWaiters: [],
		};
		// For a resume we know the id up front; register immediately so a
		// reconnect during the (<1s) spawn window can reattach. For a new
		// session the id isn't known until `get_state` returns; park it in
		// `pending` instead so killAll() and the never-ready timeout can
		// reach it. The two paths converge in the get_state handler below,
		// which flips ready and moves the session from `pending` into
		// `entries`.
		if (init.sessionId) this.entries.set(init.sessionId, session);
		else this.pending.add(session);

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
			if (session.sessionId && this.entries.get(session.sessionId) === session) {
				this.entries.delete(session.sessionId);
			}
			this.pending.delete(session);
			session.busy = false;
			session.streaming = false;
			if (!session.ready) {
				const message = `pi exited before ready (code=${info.code}, signal=${info.signal}): ${pi.getStderr().slice(-200)}`;
				for (const waiter of session.readyWaiters.splice(0)) waiter.reject(new Error(message));
				deliver(session.ws, { type: "error", message });
				return;
			}

			// A ready child disappearing naturally means the transport backing
			// this view is gone. Previously we silently removed the registry
			// entry and left the WebSocket open, so the browser stayed in its
			// last streaming/working state forever and future prompts went to a
			// dead pipe. Expected registry kills already unbind the view and set
			// terminationExpected; only an unexpected exit reaches this path.
			if (!session.terminationExpected) {
				const attached = session.ws;
				log.warn("pi exited unexpectedly after ready", {
					sessionId: session.sessionId,
					code: info.code,
					signal: info.signal,
				});
				deliver(attached, {
					type: "error",
					message: `pi exited unexpectedly (code=${info.code}, signal=${info.signal}); reconnecting`,
				});
				if (attached?._session === session) attached._session = null;
				session.ws = null;
				try {
					// Any close except the terminal 4001 takeover code triggers the
					// browser's normal reconnect path. Its init includes sessionId,
					// so the replacement child resumes the same transcript.
					attached?.close(1011, "pi subprocess exited unexpectedly");
				} catch {
					/* socket may have closed concurrently */
				}
			}
		});

		this.requestSessionId(session);
		return session;
	}

	/**
	 * Resolve once a candidate child has proved it is usable by returning a
	 * real session id from get_state. Session switching waits here before
	 * detaching the current child, making replacement transactional.
	 */
	waitUntilReady(session: LiveSession): Promise<void> {
		if (session.ready) return Promise.resolve();
		if (session.pi.killed) return Promise.reject(new Error("pi exited before becoming ready"));
		return new Promise<void>((resolve, reject) => {
			session.readyWaiters.push({ resolve, reject });
		});
	}

	/**
	 * Bind a WebSocket to a session (initial attach or reattach). Sends
	 * `ready` + transcript + current-turn replay immediately if the
	 * session is already ready (the reattach case). If not ready yet,
	 * the `get_state` response handler sends them once pi reports its
	 * session id. Cancels any pending idle reap — somebody is watching.
	 */
	attach(session: LiveSession, ws: PiSocket): void {
		// If a DIFFERENT view is already bound to this session (the user
		// opened the same session in a second tab, or a reconnect raced a
		// not-yet-closed old socket), eject it cleanly instead of silently
		// orphaning it — the prior tab would otherwise keep its `_session`
		// set but never receive another event, leaving it frozen with no
		// error. Tell it why, then close so its close handler runs (→
		// detach, which is a no-op here because `session.ws` no longer
		// points at it). Note `ejectView` unbinds `session.ws` itself.
		const prior = session.ws;
		if (prior && prior !== ws) this.ejectView(prior);

		ws._session = session;
		session.ws = ws;
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = null;
		}
		if (session.ready) this.sendReadyAndCatchup(session);
	}

	/**
	 * Eject a view that has been displaced by another attach. Sends an
	 * error frame so the client can show a readable reason, then closes
	 * with code 4001 ("session taken over"). The displaced client treats
	 * 4001 as TERMINAL — it does not auto-reconnect — so the two tabs
	 * don't ping-pong the session back and forth forever (A ejected →
	 * reconnects → re-init with sessionId → steals back → B ejected →
	 * ...). A normal drop (heartbeat timeout, reconnect race) closes with
	 * a different code and reconnects as usual. Clears the ws's `_session`
	 * so a late message on it isn't routed back into the session it lost.
	 */
	private ejectView(ws: PiSocket): void {
		ws._session = null;
		deliver(ws, {
			type: "error",
			message:
				"this session was opened in another tab. Reconnect there to continue, or reload here to start a fresh chat.",
		});
		try {
			ws.close(4001, "session taken over by another connection");
		} catch {
			/* ignore */
		}
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
		if (session.sessionId && this.entries.get(session.sessionId) === session) {
			this.entries.delete(session.sessionId);
		}
		this.pending.delete(session);
		session.terminationExpected = true;
		for (const waiter of session.readyWaiters.splice(0)) {
			waiter.reject(new Error("pi was terminated before becoming ready"));
		}
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
		// Snapshot pending: kill() mutates the set mid-iteration.
		for (const s of [...this.pending]) this.kill(s);
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
				this.pending.delete(session);
				this.entries.set(id, session); // idempotent for resume, first reg for new
				for (const waiter of session.readyWaiters.splice(0)) waiter.resolve();
				this.sendReadyAndCatchup(session);
			}
		}

		// Resolve in-flight set_model / set_thinking_level requests.
		// chat.ts stashes the requested model/thinking in
		// session.pendingModel/pendingThinking and we apply it to
		// session.init ONLY when pi confirms with success:true. The
		// response's `data` carries the model object pi actually set
		// (with `provider` + `id`), so we trust that over the pending
		// record (which may have been overwritten by a subsequent
		// user click). On failure, the pending record is cleared and
		// session.init keeps pointing at the model pi is actually
		// using — the picker stays truthful and prompts go to the
		// right place.
		//
		// We also push a small `modelState` frame to the client so the
		// picker header updates without waiting for the next page
		// refresh (the client's `ready` handler is the only other
		// place that adopts the server's model). Runs BEFORE the
		// "drop success acks" check below so success frames can still
		// be filtered out as noise.
		if (line.type === "response" && line.command === "set_model") {
			const succeeded = line.success !== false;
			if (succeeded && line.data) {
				const data = line.data as { provider?: string; id?: string };
				if (typeof data.provider === "string" && typeof data.id === "string") {
					session.init = { ...session.init, provider: data.provider, modelId: data.id };
				}
			}
			session.pendingModel = null;
			deliver(session.ws, {
				type: "modelState",
				provider: session.init.provider,
				modelId: session.init.modelId,
				thinkingLevel: session.init.thinkingLevel,
			});
		}
		if (line.type === "response" && line.command === "set_thinking_level") {
			// pi's success response for set_thinking_level has no `data`
			// (it just acks), so the level we want to apply is the
			// pending one the user just clicked. Fall through to the
			// init update on success, keep session.init untouched on
			// failure (just clear the pending).
			if (line.success !== false && session.pendingThinking) {
				session.init = { ...session.init, thinkingLevel: session.pendingThinking };
			}
			session.pendingThinking = null;
			deliver(session.ws, {
				type: "modelState",
				provider: session.init.provider,
				modelId: session.init.modelId,
				thinkingLevel: session.init.thinkingLevel,
			});
		}

		// pi's `get_commands` response — the authoritative list of slash
		// commands, prompt templates, and skills loaded for THIS session's
		// cwd. Forwarded to the client as {type:"capabilities"} so the
		// header badge reflects the live child (per-project accurate)
		// instead of a global guess. Intercepted here (before the success-ack
		// drop below) because a success response would otherwise be filtered
		// as noise and never reach the browser.
		if (line.type === "response" && line.command === "get_commands") {
			const cmds = (line.data as { commands?: unknown[] } | undefined)?.commands;
			deliver(session.ws, {
				type: "capabilities",
				commands: Array.isArray(cmds) ? (cmds as PiCommand[]) : [],
			});
			return;
		}

		// pi's `get_session_stats` response. We only forward the
		// `contextUsage` field (tokens / contextWindow / percent) — the
		// browser accumulates the cumulative token+cost totals itself from
		// per-turn message_end events, so resending them would just double-
		// count. contextUsage is undefined when pi can't compute it (no model,
		// or right after a compaction with no post-compaction reply yet); we
		// surface that as null so the client can render a neutral `?` state
		// instead of a stale bar. Intercepted here (before the success-ack
		// drop below) for the same reason as get_commands.
		if (line.type === "response" && line.command === "get_session_stats") {
			const data = line.data as
				| {
						contextUsage?: unknown;
						tokens?: {
							input: number;
							output: number;
							cacheRead: number;
							cacheWrite: number;
							total: number;
						};
						cost?: number;
				  }
				| undefined;
			deliver(session.ws, {
				type: "sessionStats",
				contextUsage: (data?.contextUsage ?? null) as ContextUsage | null,
				// Forward the cumulative token totals + cost too, so the client can
				// seed its display on a fresh page load instead of resetting to 0
				// (the client accumulates these live from message_end, but that
				// only captures events seen SINCE the page opened — a refresh wiped
				// everything before it). These are pi's ground-truth session totals.
				tokens: data?.tokens,
				cost: typeof data?.cost === "number" ? data.cost : undefined,
			});
			return;
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
		if (line.type === "agent_start") {
			// The agent run as a whole (possibly multiple turns). Mirror the
			// client's isStreaming so a tab refresh can recover it from the
			// server's `ready` (the browser's local copy is wiped on reload).
			session.streaming = true;
		} else if (line.type === "agent_end") {
			session.streaming = false;
		}
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
			isStreaming: session.streaming,
		});
		const messages = readPiSessionMessages(session.init.cwd ?? config.piCwd, session.sessionId);
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
		safeUnref(session.idleTimer);
	}

	/**
	 * Send `get_state` on a bounded retry schedule until the session is
	 * ready. pi doesn't ack get_state until its AgentSession is
	 * constructed, so a single send isn't enough. Bounded attempts
	 * prevent an unbounded loop on a wedged child; the exit handler
	 * sends the error frame in that case.
	 *
	 * Also short-circuits when the child has died (`session.pi.killed`,
	 * which the exit handler in pi-process.ts flips to true the moment
	 * the child goes away). Without this check, the retry timer kept
	 * firing send() against a closed pipe for the full ~10s budget
	 * even after the exit handler had already sent the error frame.
	 * Today that wasted work is silent (the noop stdin error listener
	 * + send()'s killed-guard mean nothing observable happens), but it
	 * also means a dead-session detection took the full retry budget;
	 * this check makes the failure mode prompt and explicit.
	 */
	private requestSessionId(session: LiveSession): void {
		const intervalMs = 200;
		const maxAttempts = 50; // ~10s ceiling — pi startup is normally <1s
		let attempts = 0;
		const send = (): void => {
			if (session.ready || session.pi.killed) return;
			if (attempts >= maxAttempts) {
				// pi never answered get_state within ~10s. It's wedged — kill
				// it so it doesn't leak: a fresh child with no id yet is
				// invisible to the idle reaper (needs a session id) and was
				// previously missed by killAll() (only walked `entries`). The
				// `pending` set now keeps it reachable. Deliver the error to
				// the attached view BEFORE kill() nulls session.ws; the exit
				// handler's own !ready error frame then no-ops (deliver(null))
				// so the client gets exactly one message.
				log.warn("pi never became ready; killing", { pid: session.pi.pid });
				deliver(session.ws, {
					type: "error",
					message: `pi did not become ready within ~${Math.round(
						(maxAttempts * intervalMs) / 1000,
					)}s; try reconnecting`,
				});
				this.kill(session);
				return;
			}
			attempts++;
			session.pi.send({ type: "get_state" });
			const t = setTimeout(send, intervalMs);
			safeUnref(t);
		};
		send();
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
