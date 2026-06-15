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

import type { ThinkingLevel, SessionSummary, PromptImage } from "../shared/protocol.js";

export type EventListener = (event: Record<string, unknown>) => void;
export type ReadyListener = (info: {
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
	sessionId?: string;
}) => void;
export type ErrorListener = (message: string) => void;
export type StatusListener = (status: "connecting" | "open" | "closed") => void;
export type SessionsListener = (sessions: SessionSummary[]) => void;
export type TranscriptListener = (sessionId: string, messages: unknown[]) => void;
export type SessionResumedListener = (info: { sessionId: string; modelId: string; provider: string; thinkingLevel: ThinkingLevel }) => void;

export interface ChatClient {
	/**
	 * Send the initial handshake to the server. Must be called once
	 * after the WS opens, before any other method. Spawns `pi --mode rpc`
	 * on the server with the given args.
	 */
	init(opts: { provider: string; modelId: string; thinkingLevel: ThinkingLevel; sessionId?: string }): void;
	/** Send a user prompt. Optionally attach images (base64 + mimeType). */
	prompt(text: string, images?: PromptImage[]): void;
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
	/** Called on connection status changes. */
	onStatus(listener: StatusListener): () => void;
	/** Called with the session list in response to listSessions(). */
	onSessionsUpdated(listener: SessionsListener): () => void;
	/** Called on resume with the prior transcript, before live events flow. */
	onTranscript(listener: TranscriptListener): () => void;
	/** Called after newSession / resumeSession completes. */
	onSessionResumed(listener: SessionResumedListener): () => void;
	/** Force a reconnect. */
	reconnect(): void;
	/** Permanently close. */
	close(): void;
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10000];

export function createChatClient(): ChatClient {
	let ws: WebSocket | null = null;
	let attempt = 0;
	let manualClose = false;
	let inited = false;

	const eventListeners = new Set<EventListener>();
	const readyListeners = new Set<ReadyListener>();
	const errorListeners = new Set<ErrorListener>();
	const statusListeners = new Set<StatusListener>();
	const sessionsListeners = new Set<SessionsListener>();
	const transcriptListeners = new Set<TranscriptListener>();
	const sessionResumedListeners = new Set<SessionResumedListener>();

	function setStatus(status: "connecting" | "open" | "closed") {
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
			let msg: Record<string, unknown> & { type?: string };
			try {
				msg = JSON.parse(e.data as string) as typeof msg;
			} catch {
				for (const l of errorListeners) l("malformed message from server");
				return;
			}
			switch (msg.type) {
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
						l(String(msg.sessionId ?? ""), (msg.messages as unknown[]) ?? []);
					}
					break;
				case "sessionResumed":
					for (const l of sessionResumedListeners) {
						l({
							sessionId: String(msg.sessionId ?? ""),
							modelId: String(msg.modelId ?? ""),
							provider: String(msg.provider ?? ""),
							thinkingLevel: msg.thinkingLevel as ThinkingLevel,
						});
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
			send({ type: "prompt", text, ...(images && images.length > 0 ? { images } : {}) });
		},
		abort: () => send({ type: "abort" }),
		setModel: (modelId, provider) => send({ type: "setModel", modelId, provider }),
		setThinking: (level) => send({ type: "setThinking", level }),
		renameSession: (name) => send({ type: "renameSession", name }),
		listSessions: () => send({ type: "listSessions" }),
		newSession: () => send({ type: "newSession" }),
		resumeSession: (sessionId) => send({ type: "resumeSession", sessionId }),
		onEvent: (l) => { eventListeners.add(l); return () => eventListeners.delete(l); },
		onReady: (l) => { readyListeners.add(l); return () => readyListeners.delete(l); },
		onError: (l) => { errorListeners.add(l); return () => errorListeners.delete(l); },
		onStatus: (l) => { statusListeners.add(l); return () => statusListeners.delete(l); },
		onSessionsUpdated: (l) => { sessionsListeners.add(l); return () => sessionsListeners.delete(l); },
		onTranscript: (l) => { transcriptListeners.add(l); return () => transcriptListeners.delete(l); },
		onSessionResumed: (l) => { sessionResumedListeners.add(l); return () => sessionResumedListeners.delete(l); },
		reconnect: () => {
			if (ws) ws.close();
			attempt = 0;
			connect();
		},
		close: () => {
			manualClose = true;
			if (ws) ws.close();
		},
	};
}
