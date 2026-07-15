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

import type { ContextUsage, PiCommand, ProjectSummary, ThinkingLevel } from "../shared/protocol.js";

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
	| {
			kind: "user";
			text: string /**
			 * 1-based ordinal of this message within the session's JSONL
			 * `type:"message"` entries — i.e. how many messages (including
			 * this one) a "fork from here" should copy. Stamped by
			 * projectTranscript (from the transcript array index) and by
			 * the live event dispatcher (from a monotonic counter seeded
			 * to the transcript length). Undefined only briefly, before
			 * the echo/stamp lands. Absent on kinds that can't be forked
			 * (tool/steer/error).
			 */;
			seq?: number;
			/**
			 * Epoch-ms when this message was created, sourced from the
			 * SDK `Message.timestamp` (authoritative — survives
			 * resume/fork). Live optimistic sends stamp `Date.now()`
			 * until the echo/replay lands the real value. Rendered as a
			 * relative label in Brisbane time; see src/client/time.ts.
			 * Absent on kinds that don't carry a moment in time
			 * (tool/steer/error).
			 */
			ts?: number;
	  }
	| {
			kind: "assistant";
			text: string;
			thinking: string;
			seq?: number;
			/** Epoch-ms when this assistant message was created (SDK
			 * `Message.timestamp`); always shown when present. See the
			 * `user` variant's `ts` for the full rationale. */
			ts?: number;
			/**
			 * Listenable spoken-rewrite variants produced by the
			 * pi-voice-reply extension, attached to this assistant message
			 * when a voice reply was requested (proactively via trigger
			 * phrase or retroactively via a Long/Med/Short button). long is
			 * TTS-only; medium and short are ALSO rendered as a readable
			 * box below the reply. Rendered as inline LongTTS/MedTTS/ShortTTS
			 * speak buttons on this message's button row. Each variant is
			 * generated on demand and merged in independently.
			 */
			voiceLong?: string;
			voiceMedium?: string;
			voiceShort?: string;
	  }
	| {
			kind: "tool";
			name: string;
			args: unknown;
			result?: string;
			isError?: boolean;
			/**
			 * Set when a replayed tool call never received a result — the
			 * session was interrupted mid-turn (e.g. the `pi` child died
			 * while a tool was running). Rendered as "interrupted" rather
			 * than the indefinite "running…" spinner, since nothing is
			 * actually executing the call anymore.
			 */
			interrupted?: boolean;
	  }
	| { kind: "error"; text: string }
	/**
	 * A steering message the user queued while the agent was running.
	 * Rendered like a user bubble but visually marked as queued until
	 * `delivered` flips true (when the agent consumes it for the next
	 * turn). Not persisted in session JSONL under this shape — pi
	 * re-inserts it as a normal user message once delivered, which is
	 * why resume transcripts never contain `kind: "steer"` rows.
	 */
	| { kind: "steer"; text: string; delivered: boolean }
	/**
	 * A spoken-summary voice reply from the pi-voice-reply extension.
	 * Emitted as a custom message (customType:"voice-reply") after a
	 * turn where the user asked for voice. Contains two listenable
	 * rewrites of the assistant's reply — a detailed long version and a
	 * concise short version — which the browser renders as two speak
	 * buttons. The actual TTS synthesis happens via the existing
	 * /api/tts endpoint (Kokoro); this message only carries the words.
	 */
	| { kind: "voice-reply"; long: string; short: string };

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
	/**
	 * Human-readable label for `currentModelId` (from /api/models' `name`),
	 * resolved once per model change instead of re-searching the model list
	 * on every status-bar tick (which fires each second while streaming).
	 * Falls back to the raw id when no friendly name is known.
	 */
	currentModelLabel: string;
	currentProvider: string | null;
	currentThinking: ThinkingLevel;
	/**
	 * Human-readable label for the current image-generation model, shown
	 * in the status overflow row. Updated by the pi-venice-image
	 * extension's notify events; defaults to "default". ACB no longer
	 * owns the image model list or persistence — that moved to the
	 * extension (selectable via `/imagemodel` → ctx.ui.select relay).
	 */
	currentImageModelLabel: string | null;
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
	/**
	 * Connection state reported by the WS client. "stalled" means the
	 * socket reports OPEN but no messages (including heartbeats) have
	 * arrived for a while — typically Android backgrounding the tab.
	 * The client will be actively reconnecting when this is set.
	 */
	connectionStatus: "connecting" | "open" | "closed" | "stalled";
	/** Currently selected TTS voice id (user's pick; null = server default). */
	ttsVoice: string | null;
	/** TTS engine id from /api/health ("kokoro" | "piper" | null until probed).
	 * Surfaces the actually-configured engine in the TTS banner instead of
	 * a hardcoded "Kokoro". */
	ttsEngine: string | null;
	/** Server-default TTS voice from /api/health (used as the banner label
	 * when the user hasn't picked a specific voice). */
	ttsDefaultVoice: string | null;
	/** Configured spoken-rewrite model override ("provider/modelId") from
	 * /api/health — the model the pi-voice-reply extension actually uses for
	 * the text-rewrite phase. null = rewrite falls back to the session model. */
	voiceRewriteModel: string | null;
	/** Whisper (STT) model id from /api/health (e.g. "base"). Display-only. */
	whisperModel: string | null;
	/** Resolved image-generation model + provenance from /api/health. null
	 * until the health probe lands. Display-only mirror of the extension's
	 * resolution chain. */
	imageModel: { model: string; source: "override" | "env" | "default" } | null;
	/** Resolved vision (image/video) model + mode from /api/health, mirroring
	 * pi-multimodal-proxy. null until the health probe lands. Display-only. */
	visionModel: {
		model: string;
		source: "env" | "config" | "default";
		mode: "fallback" | "always" | "off";
	} | null;
	/** Whether the Gemini key is configured for pi-web-access. Display-only. */
	geminiKey: boolean;
	/** TTS playback rate multiplier (1.0 = normal, 2.0 = double speed). */
	ttsSpeed: number;
	/** Number of TTS requests in flight (for the status bar indicator). */
	ttsInFlight: number;
	/** Set true while audio is playing (for the play/pause indicator). */
	audioPlaying: boolean;
	/** True while playback is paused mid-chunk (audio loaded, position held).
	 * Set only by the explicit pause button — NOT by the <audio> 'pause'
	 * event, which also fires between chunks and on stop. */
	audioPaused: boolean;
	/**
	 * When a 🗣️ Long / 💬 Short button is pressed BEFORE its spoken variant
	 * has been generated, these record which variant to auto-play and the
	 * button element that initiated it, so the voice-reply handler can
	 * finish the press (spin → play that variant on that button) instead
	 * of leaving the user to press again. Cleared once the voice-reply
	 * arrives (or on agent_end if generation produced nothing).
	 */
	pendingVoiceVariant: "long" | "medium" | "short" | null;
	pendingVoiceBtn: HTMLElement | null;
	/**
	 * Commands/skills/extensions loaded for the current session, reported
	 * by the server from pi's `get_commands` RPC (per-project accurate).
	 * Pushed after every `ready`, so it always matches the live child.
	 */
	capabilities: PiCommand[] | null;
	/** Context-window fill for the active model, from pi's
	 * `get_session_stats`. `tokens`/`percent` are null right after a
	 * compaction (pi can't size the context until the next reply). Drives
	 * the thin fill meter above the status bar. Null before the first
	 * reply or when the model has no known context window. */
	contextUsage: ContextUsage | null;
	/** Whether the server has semantic session search enabled. */
	searchEnabled: boolean;
	/** Whether the sidebar is currently showing search results (vs the date list). */
	searchActive: boolean;
	/**
	 * Plain string snapshot of `state.messages` last assistant text, kept
	 * in sync by main.ts's event dispatcher. The render layer reads this
	 * for the live-streaming speak button (so re-clicking after streaming
	 * ends replays the final text) without needing a back-reference into
	 * the messages array.
	 */
	lastAssistantText: string;
	/**
	 * JSONL ordinal of the currently-streaming (or just-finished) live
	 * assistant message, mirrored from the in-place `lastAssistant` block
	 * so the live fork button can read it without a back-reference into
	 * the messages array. Reset to null on turn boundaries.
	 */
	lastAssistantSeq: number | null;
	/**
	 * Number of steering messages queued but not yet consumed by the
	 * agent. Driven by `queue_update` events; shown in the status bar.
	 */
	pendingSteerCount: number;
	/**
	 * Active auto-retry state, or null when the agent isn't retrying.
	 * Driven by pi's `auto_retry_start`/`auto_retry_end` events — the
	 * same events the CLI uses to render its "Retrying (1/3) in 8s…"
	 * loader. Surfaced in the status bar so a retrying agent is
	 * visibly working (not frozen) and abortable, matching the CLI.
	 */
	retry: {
		attempt: number;
		maxAttempts: number;
		/** Remaining backoff ms at the moment of the last tick. */
		remainingMs: number;
		/** What went wrong (the model/transport error). */
		errorMessage: string;
	} | null;
	/** Epoch ms the current streaming run started (agent_start), or null
	 * when idle. Drives the elapsed-time working indicator next to
	 * "streaming" in the status bar — the CLI equivalent is the spinner
	 * + elapsed counter shown while a turn runs. Makes "working but
	 * slow" visually distinct from "frozen".
	 */
	streamingStartedAt: number | null;
	/** All known projects (folders with their own cwd + AGENTS.md). */
	projects: ProjectSummary[];
	/**
	 * The project new chats start in (sidebar-highlighted folder).
	 * Per your decision, a brand-new chat always starts in Global; this
	 * tracks which folder the user has expanded/selected for visibility
	 * and for the "+ New chat" target when they explicitly pick one.
	 */
	activeProjectId: string;
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
	currentModelLabel: "(no model)",
	currentProvider: null,
	currentImageModelLabel: null,
	currentThinking: "high",
	pendingModelSet: null,
	uploadedImages: new Map(),
	connectionStatus: "connecting",
	ttsVoice: null,
	ttsEngine: null,
	ttsDefaultVoice: null,
	voiceRewriteModel: null,
	whisperModel: null,
	imageModel: null,
	visionModel: null,
	geminiKey: false,
	ttsSpeed: 1.25,
	ttsInFlight: 0,
	audioPlaying: false,
	audioPaused: false,
	pendingVoiceVariant: null,
	pendingVoiceBtn: null,
	lastAssistantText: "",
	lastAssistantSeq: null,
	pendingSteerCount: 0,
	retry: null,
	streamingStartedAt: null,
	projects: [],
	activeProjectId: "global",
	capabilities: null,
	contextUsage: null,
	searchEnabled: false,
	searchActive: false,
};

/**
 * Resolve `state.currentModelLabel` from the model list for the current
 * model id. Cheap to call whenever the model changes or the available
 * list (re)loads. Lets the status bar read a precomputed label instead
 * of searching the list on every 1s tick.
 */
export function refreshCurrentModelLabel(): void {
	const id = state.currentModelId;
	if (!id) {
		state.currentModelLabel = "(no model)";
		return;
	}
	const opt = state.availableModels.find((m) => m.id === id);
	state.currentModelLabel = opt?.name ?? id;
}

/**
 * Friendly label for the model that actually generates spoken text in a
 * voice reply: the configured `VOICE_REWRITE_MODEL` override if set,
 * else the session model. The override arrives as a raw "provider/modelId"
 * string from /api/health; we resolve it to the model list's display name
 * when possible, falling back to the raw string. Used by the TTS banner so
 * it names the rewrite model (e.g. "Gemini 3 Flash") rather than the
 * session model (e.g. "GLM-5.2") that isn't doing the work.
 */
export function voiceRewriteLabel(): string {
	const override = state.voiceRewriteModel;
	if (!override) return state.currentModelLabel;
	const slash = override.indexOf("/");
	const provider = slash > 0 ? override.slice(0, slash) : "";
	const modelId = slash > 0 && slash < override.length - 1 ? override.slice(slash + 1) : override;
	const opt = state.availableModels.find((m) => m.provider === provider && m.id === modelId);
	return opt?.name ?? override;
}
