/**
 * In-memory app state and the typed cache of messages the renderer
 * paints. Owned by main.ts at boot, mutated by the server-event
 * dispatcher.
 *
 * Sessions are owned by the server (via `pi --mode rpc`'s on-disk
 * JSONL files). The browser no longer persists anything — every
 * session operation goes through the WS protocol to the server.
 * `state.messages` is a renderer cache: the server's transcript
 * replay on resume populates it once, and live `pi` events append
 * to it as the conversation continues.
 */

import type { ThinkingLevel } from "../shared/protocol.js";
import type { CapabilitiesInfo } from "./api.js";

// ---------------------------------------------------------------------------
// Renderer cache: messages the browser shows in the chat scrollback
// ---------------------------------------------------------------------------

/**
 * A flat, display-oriented view of a message — what the renderer
 * needs to paint a single block. The server's `transcript` message
 * delivers the SDK's `Message[]` shape; we project it into this
 * shape on the client so the renderer can stay simple.
 */
export type PersistedMessage =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: string; spoken?: boolean }
	| {
			kind: "tool";
			name: string;
			args: unknown;
			result?: string;
			isError?: boolean;
	  }
	| { kind: "error"; text: string };

// ---------------------------------------------------------------------------
// In-memory app state
// ---------------------------------------------------------------------------

export interface AppState {
	/** Title of the current chat. Set on first user message; updatable via /name. */
	title: string;
	/** Current pi session id, from the server's `ready`/`transcript` events. */
	sessionId: string | null;
	/** Renderer cache — the messages the browser has painted, in order. */
	messages: PersistedMessage[];
	historyIdx: number | null; // null = at the "now" position
	history: string[]; // user prompts typed in this session
	isStreaming: boolean;
	toolSpinner: HTMLElement | null;
	costTotal: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
	availableModels: ModelOption[];
	currentModelId: string | null;
	currentProvider: string | null;
	currentThinking: ThinkingLevel;
	/**
	 * The model id the user just clicked in the picker. The server will
	 * confirm it on the next `ready` event. Set to the model id at click
	 * time, cleared when the matching `ready` arrives. Used to distinguish
	 * "user picked this" from "server just connected and is reporting its
	 * default" — we only adopt the server-reported model if either we
	 * have no model displayed yet, or the server is confirming our pick.
	 */
	pendingModelSet: string | null;
	/**
	 * Map of uploaded image URL → base64 data + mime + filename. Populated
	 * when the user attaches an image via the file picker, consumed when
	 * they send a prompt that references the URL. Used to pass image
	 * bytes to the model so multimodal models (e.g. minimax M3) can see
	 * the picture, not just the markdown link.
	 */
	uploadedImages: Map<string, { data: string; mimeType: string; filename: string }>;
	connectionStatus: "connecting" | "open" | "closed";
	/** When true, every final assistant message is spoken automatically. */
	autoSpeak: boolean;
	/** Currently selected TTS voice id. */
	ttsVoice: string | null;
	/** TTS playback rate multiplier (1.0 = normal, 2.0 = double speed). */
	ttsSpeed: number;
	/** Number of TTS requests in flight (for the status bar indicator). */
	ttsInFlight: number;
	/** Set true while audio is playing (for the play/pause indicator). */
	audioPlaying: boolean;
	/**
	 * Capabilities reported by the server (tools, skills, packages).
	 * Populated by boot() on startup.
	 */
	capabilities: CapabilitiesInfo | null;
	/**
	 * Plain string snapshot of `state.messages` last assistant text, kept
	 * in sync by main.ts's event dispatcher. The render layer reads this
	 * for the live-streaming speak button (so re-clicking after streaming
	 * ends replays the final text) without needing a back-reference into
	 * the messages array.
	 */
	lastAssistantText: string;
}

export interface ModelOption {
	id: string;
	provider: string;
	/** Human-readable label from the server (e.g. "DeepSeek V4 Pro"). */
	name?: string;
	/** Whether this model supports extended thinking. */
	reasoning?: boolean;
}

export const state: AppState = {
	title: "New chat",
	sessionId: null,
	messages: [],
	historyIdx: null,
	history: [],
	isStreaming: false,
	toolSpinner: null,
	costTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	availableModels: [],
	currentModelId: null,
	currentProvider: null,
	currentThinking: "high",
	pendingModelSet: null,
	uploadedImages: new Map(),
	connectionStatus: "connecting",
	autoSpeak: false,
	ttsVoice: null,
	ttsSpeed: 1.4,
	ttsInFlight: 0,
	audioPlaying: false,
	lastAssistantText: "",
	capabilities: null,
};
