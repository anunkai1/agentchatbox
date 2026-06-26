/**
 * WebSocket client for /api/chat.
 *
 * Single connection per page. Reconnects on close with a small backoff
 * so a server restart doesn't kill the session permanently.
 *
 * Events from the server are dispatched to a listener; prompts/aborts
 * go the other way.
 *
 * The first message sent after connect is the `init` message, which
 * tells the server which provider/model/thinking-level/session-id to
 * spawn `pi --mode rpc` with. Until `init` is sent, the server is
 * waiting for it and won't process any other messages.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { PromptImage, SessionSummary, ThinkingLevel } from "../shared/protocol.js";

export type EventListener = (event: Record<string, unknown>) => void;
export type ReadyListener = (info: {
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
	sessionId?: string;
}) => void;
export type ErrorListener = (message: string) => void;
export type StatusListener = (status: "connecting" | "open" | "closed" | "stalled") => void;
export type SessionsListener = (sessions: SessionSummary[]) => void;
export type TranscriptListener = (sessionId: string, messages: Message[]) => void;

export interface ChatClient {
	/**
	 * Send the initial handshake to the server. Must be called once
	 * after the WS opens, before any other method. Spawns `pi --mode rpc`
	 * on the server with the given args.
	 */
	init(opts: {
		provider: string;
		modelId: string;
		thinkingLevel: ThinkingLevel;
		sessionId?: string;
	}): void;
	/** Send a user prompt. Optionally attach images (base64 + mimeType). */
	prompt(text: string, images?: PromptImage[]): void;
	/**
	 * Queue a steering message while the agent is running. Delivered
	 * after the current assistant turn finishes its tool calls.
	 */
	steer(text: string, images?: PromptImage[]): void;
	/** Abort the current run, if any. */
	abort(): void;
	/** Switch to a different model mid-session. */
	setModel(modelId: string, provider: string): void;
	/** Set the thinking level. */
	setThinking(level: ThinkingLevel): void;
	/** Rename the current session. */
	renameSession(name: string): void;
	/** Request the list of saved sessions. Replies via onSessionsUpdated. */
	listSessions(): void;
	/** Kill the current `pi` and start a fresh session. */
	newSession(): void;
	/** Kill the current `pi` and resume the session with the given id. */
	resumeSession(sessionId: string): void;
	/** Subscribe to `pi` events. Returns an unsubscribe fn. */
	onEvent(listener: EventListener): () => void;
	/** Called once after the server has spawned `pi` and the first session line arrives. */
	onReady(listener: ReadyListener): () => void;
	/** Called on protocol-level errors. */
	onError(listener: ErrorListener): () => void;
	/** Called on connection status changes ("stalled" = OPEN but no heartbeat within the watchdog window). */
	onStatus(listener: StatusListener): () => void;
	/** Called with the session list in response to listSessions(). */
	onSessionsUpdated(listener: SessionsListener): () => void;
	/** Called on resume with the prior transcript, before live events flow. */
	onTranscript(listener: TranscriptListener): () => void;
	/** Force a reconnect. */
	reconnect(): void;
	/** Permanently close. */
	close(): void;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];
/** Server sends an app-level ping every ~20s (see chat.ts HEARTBEAT_INTERVAL_MS). */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** No message (heartbeat or otherwise) for this long => socket is wedged. ~2x heartbeat. */
const STALE_AFTER_MS = 2 * HEARTBEAT_INTERVAL_MS;
/** How often the watchdog wakes up to check for staleness. */
const WATCHDOG_TICK_MS = 5_000;

export function createChatClient(): ChatClient {
	let ws: WebSocket | null = null;
	let attempt = 0;
	let manualClose = false;
	let inited = false;
	let currentStatus: "connecting" | "open" | "closed" | "stalled" = "connecting";
	/** Timestamp of the last message received from the server (any type). */
	let lastMessageAt = Date.now();
	/** Watchdog interval id, shared across reconnects. */
	let watchdog: ReturnType<typeof setInterval> | null = null;

	const eventListeners = new Set<EventListener>();
	const readyListeners = new Set<ReadyListener>();
	const errorListeners = new Set<ErrorListener>();
	const statusListeners = new Set<StatusListener>();
	const sessionsListeners = new Set<SessionsListener>();
	const transcriptListeners = new Set<TranscriptListener>();

	function setStatus(status: "connecting" | "open" | "closed" | "stalled") {
		currentStatus = status;
		for (const l of statusListeners) l(status);
	}

	function connect() {
		manualClose = false;
		inited = false; // need to re-send init after a reconnect
		setStatus("connecting");
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${proto}//${location.host}/api/chat`;
		ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			attempt = 0;
			setStatus("open");
		});

		ws.addEventListener("message", (e) => {
			// Any frame from the server proves the connection is alive —
			// this includes the heartbeat `{type:"ping"}`. Refreshing here
			// is what lets the watchdog detect a wedged socket.
			lastMessageAt = Date.now();
			if (currentStatus === "stalled") {
				// Server came back alive (e.g. transient stall). Clear the
				// warning indicator.
				setStatus("open");
			}
			let msg: Record<string, unknown> & { type?: string };
			try {
				msg = JSON.parse(e.data as string) as typeof msg;
			} catch {
				for (const l of errorListeners) l("malformed message from server");
				return;
			}
			switch (msg.type) {
				case "ping":
					// Heartbeat from the server. Already accounted for by
					// refreshing lastMessageAt above; nothing else to do.
					break;
				case "ready":
					for (const l of readyListeners) {
						l({
							modelId: String(msg.modelId ?? ""),
							provider: String(msg.provider ?? ""),
							thinkingLevel: msg.thinkingLevel as ThinkingLevel,
							sessionId: msg.sessionId as string | undefined,
						});
					}
					break;
				case "event":
					for (const l of eventListeners) l(msg.event as unknown as Record<string, unknown>);
					break;
				case "sessions":
					for (const l of sessionsListeners) l(msg.sessions as SessionSummary[]);
					break;
				case "transcript":
					for (const l of transcriptListeners) {
						l(String(msg.sessionId ?? ""), (msg.messages as Message[]) ?? []);
					}
					break;
				case "error":
					for (const l of errorListeners) l(String(msg.message ?? "unknown error"));
					break;
			}
		});

		ws.addEventListener("close", () => {
			setStatus("closed");
			ws = null;
			if (!manualClose) {
				const base = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
				// Apply ±20% jitter so multiple browser tabs reconnecting
				// to the same recovered server don't synchronize their
				// retries and thunder against it. (Jittered retry is a
				// standard mitigation for the "thundering herd" problem.)
				const jitter = 1 + (Math.random() * 0.4 - 0.2);
				const delay = Math.round(base * jitter);
				attempt++;
				setTimeout(connect, delay);
			}
		});

		ws.addEventListener("error", () => {
			// The "close" event will fire right after; do nothing here.
		});
	}

	function send(msg: Record<string, unknown>) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			for (const l of errorListeners) l("not connected to server");
			return;
		}
		ws.send(JSON.stringify(msg));
	}

	connect();

	/**
	 * Liveness watchdog. Runs on a fixed cadence and checks whether we've
	 * heard from the server recently. If the socket claims OPEN but we
	 * haven't received any frame (heartbeat or otherwise) within
	 * STALE_AFTER_MS, the connection is wedged — usually because Android
	 * suspended the tab and the OS killed the underlying TCP socket while
	 * the browser still believes it's OPEN. We surface a "stalled" status
	 * and force a reconnect so the user is told something is wrong and we
	 * recover, instead of hanging silently until the browser's own TCP
	 * timeout fires (which can take minutes).
	 */
	function checkStale() {
		if (currentStatus !== "open") return;
		if (Date.now() - lastMessageAt < STALE_AFTER_MS) return;
		// Wedged. Tell the UI, then force a reconnect.
		setStatus("stalled");
		try {
			if (ws) ws.close();
		} catch {
			/* ignore */
		}
		// The close handler will schedule a reconnect; reset attempt so
		// it happens fast rather than after a long backoff.
		attempt = 0;
	}
	watchdog = setInterval(checkStale, WATCHDOG_TICK_MS);
	// When the user returns to a backgrounded tab, JS resumes. Run the
	// check immediately instead of waiting up to WATCHDOG_TICK_MS for the
	// next tick — this is the primary case the watchdog exists for.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") checkStale();
	});

	return {
		init: (opts) => {
			inited = true;
			send({ type: "init", ...opts });
		},
		prompt: (text, images) => {
			if (!inited) {
				for (const l of errorListeners) l("prompt sent before init");
				return;
			}
			send({
				type: "prompt",
				text,
				...(images && images.length > 0 ? { images } : {}),
			});
		},
		steer: (text, images) => {
			if (!inited) {
				for (const l of errorListeners) l("steer sent before init");
				return;
			}
			send({
				type: "steer",
				text,
				...(images && images.length > 0 ? { images } : {}),
			});
		},
		abort: () => {
			if (!inited) return; // can't abort before init — server rejects non-init first messages
			send({ type: "abort" });
		},
		setModel: (modelId, provider) => send({ type: "setModel", modelId, provider }),
		setThinking: (level) => send({ type: "setThinking", level }),
		renameSession: (name) => send({ type: "renameSession", name }),
		listSessions: () => send({ type: "listSessions" }),
		newSession: () => send({ type: "newSession" }),
		resumeSession: (sessionId) => send({ type: "resumeSession", sessionId }),
		onEvent: (l) => {
			eventListeners.add(l);
			return () => eventListeners.delete(l);
		},
		onReady: (l) => {
			readyListeners.add(l);
			return () => readyListeners.delete(l);
		},
		onError: (l) => {
			errorListeners.add(l);
			return () => errorListeners.delete(l);
		},
		onStatus: (l) => {
			statusListeners.add(l);
			return () => statusListeners.delete(l);
		},
		onSessionsUpdated: (l) => {
			sessionsListeners.add(l);
			return () => sessionsListeners.delete(l);
		},
		onTranscript: (l) => {
			transcriptListeners.add(l);
			return () => transcriptListeners.delete(l);
		},
		reconnect: () => {
			if (ws) ws.close();
			attempt = 0;
			connect();
		},
		close: () => {
			manualClose = true;
			if (watchdog) clearInterval(watchdog);
			if (ws) ws.close();
		},
	};
}
