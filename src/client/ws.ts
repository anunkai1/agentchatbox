/**
 * WebSocket client for /api/chat.
 *
 * Single connection per page. Reconnects on close with a small backoff
 * so a server restart doesn't kill the session permanently.
 *
 * Events from the server are dispatched to a listener; prompts/aborts
 * go the other way.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
	ClientMessage,
	ServerMessage,
	ThinkingLevel,
} from "../shared/protocol.js";

export type AgentEventListener = (event: AgentEvent) => void;
export type ReadyListener = (info: {
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
}) => void;
export type ErrorListener = (message: string) => void;
export type StatusListener = (status: "connecting" | "open" | "closed") => void;

export interface ChatClient {
	/** Send a user prompt. Returns when the server has accepted (not when the run ends). */
	prompt(text: string): void;
	/** Abort the current run, if any. */
	abort(): void;
	/** Switch to a different model mid-session. */
	setModel(modelId: string, provider: string): void;
	/** Set the thinking level. */
	setThinking(level: ThinkingLevel): void;
	/** Subscribe to Agent events. Returns an unsubscribe fn. */
	onEvent(listener: AgentEventListener): () => void;
	/** Called once on first "ready" after connect. */
	onReady(listener: ReadyListener): () => void;
	/** Called on protocol-level errors. */
	onError(listener: ErrorListener): () => void;
	/** Called on connection status changes. */
	onStatus(listener: StatusListener): () => void;
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

	const eventListeners = new Set<AgentEventListener>();
	const readyListeners = new Set<ReadyListener>();
	const errorListeners = new Set<ErrorListener>();
	const statusListeners = new Set<StatusListener>();

	function setStatus(status: "connecting" | "open" | "closed") {
		for (const l of statusListeners) l(status);
	}

	function connect() {
		manualClose = false;
		setStatus("connecting");
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const url = `${proto}//${location.host}/api/chat`;
		ws = new WebSocket(url);

		ws.addEventListener("open", () => {
			attempt = 0;
			setStatus("open");
		});

		ws.addEventListener("message", (e) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(e.data) as ServerMessage;
			} catch {
				// Malformed. Notify error listeners.
				for (const l of errorListeners) l("malformed message from server");
				return;
			}
			switch (msg.type) {
				case "ready":
					for (const l of readyListeners)
						l({ modelId: msg.modelId, provider: msg.provider, thinkingLevel: msg.thinkingLevel });
					break;
				case "event":
					for (const l of eventListeners) l(msg.event);
					break;
				case "error":
					for (const l of errorListeners) l(msg.message);
					break;
			}
		});

		ws.addEventListener("close", () => {
			setStatus("closed");
			ws = null;
			if (!manualClose) {
				const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
				attempt++;
				setTimeout(connect, delay);
			}
		});

		ws.addEventListener("error", () => {
			// The "close" event will fire right after; do nothing here.
		});
	}

	function send(msg: ClientMessage) {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			for (const l of errorListeners) l("not connected to server");
			return;
		}
		ws.send(JSON.stringify(msg));
	}

	connect();

	return {
		prompt: (text) => send({ type: "prompt", text }),
		abort: () => send({ type: "abort" }),
		setModel: (modelId, provider) => send({ type: "setModel", modelId, provider }),
		setThinking: (level) => send({ type: "setThinking", level }),
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
