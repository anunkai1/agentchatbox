/**
 * agentchatbox client — pi-CLI renderer.
 *
 * The browser no longer runs the pi Agent. It opens a WebSocket to /api/chat
 * and renders the events the server sends. This file is now the orchestrator:
 *
 *   - Module wiring (registers the cross-module shell handlers in render.ts)
 *   - Boot: probe the server, open the WebSocket, hook the dispatch loop
 *   - `onEvent`: turns Agent events into DOM updates
 *   - History (↑/↓), handleSend, sendAsUser
 *
 * The actual rendering lives in render.ts, slash commands in slashes.ts,
 * voice/file-attach in voice.ts, and the DOM helpers in dom.ts.
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { $, el, type LiveAssistantDom } from "./dom.js";
import { createChatClient } from "./ws.js";
import { getHealth, getModels, type ModelInfo } from "./api.js";
import { renderSessionsIntoPicker } from "./slashes.js";
import {
	appendAssistantPlaceholder,
	appendError,
	appendToolCall,
	autoSize,
	finalizeToolCall,
	renderShell,
	renderMessageNode,
	refreshStatus,
	registerShellHandlers,
	scrollToBottomIfPinned,
	setStreaming,
	type ShellHandlers,
} from "./render.js";
import {
	handleFileAttach,
	handleVoiceRecord,
	toggleAutoSpeak,
} from "./voice.js";
import {
	handleSlash,
	isKnownSlash,
	openModelPicker,
	openOverflowMenu,
	openThinkPicker,
	openVoicePicker,
	setChatControls,
	setSendAsUser,
	showSlashMenu,
} from "./slashes.js";
import { state, type PersistedMessage } from "./state.js";

// ---------------------------------------------------------------------------
// History (↑/↓)
// ---------------------------------------------------------------------------

function historyBack(): void {
	if (state.history.length === 0) return;
	const idx = state.historyIdx === null ? state.history.length - 1 : Math.max(0, state.historyIdx - 1);
	state.historyIdx = idx;
	const input = $<HTMLTextAreaElement>("#input");
	input.value = state.history[idx];
	autoSize();
}

function historyForward(): void {
	if (state.historyIdx === null) return;
	const idx = state.historyIdx + 1;
	if (idx >= state.history.length) {
		state.historyIdx = null;
		$<HTMLTextAreaElement>("#input").value = "";
	} else {
		state.historyIdx = idx;
		$<HTMLTextAreaElement>("#input").value = state.history[idx];
	}
	autoSize();
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function handleSend(): void {
	const input = $<HTMLTextAreaElement>("#input");
	const text = input.value;
	const trimmed = text.trim();
	if (!trimmed) return;
	input.value = "";
	autoSize();
	if (trimmed.startsWith("/")) {
		handleSlash(trimmed.replace(/^\//, ""));
		// If the slash was unknown, send it as a regular prompt.
		// (handleSlash leaves the input empty on known commands.)
		if ($<HTMLTextAreaElement>("#input").value === "" && isKnownSlash(trimmed)) {
			// known slash — handled, do NOT also send as prompt
			return;
		} else {
			// unknown slash — fall through and send as prompt
		}
	}
	sendAsUser(trimmed);
}

/**
 * Send a message as the user. Called both from handleSend (typed input) and
 * from slash commands like /websearch, /fetch, /codesearch that need to inject
 * a pre-formatted prompt into the conversation.
 */
function sendAsUser(trimmed: string): void {
	if (!trimmed) return;
	// Push to history.
	if (state.history[state.history.length - 1] !== trimmed) state.history.push(trimmed);
	state.historyIdx = null;

	// Add user message to in-memory transcript.
	state.messages.push({ kind: "user", text: trimmed });
	appendNode(renderMessageNode({ kind: "user", text: trimmed }));

	// Auto-title from the first user message.
	if (state.title === "New chat" || !state.title) {
		state.title = trimmed.split(/[.\n!?]/)[0].slice(0, 50) || "New chat";
		$<HTMLSpanElement>("#title").textContent = state.title;
	}

	// Find any /uploads/<id>... URLs in the prompt and pull the base64
	// bytes for each one. The URLs are emitted by handleFileAttach as
	// markdown image links, so the regex finds them. We dedupe by URL
	// and remove them from the map after sending so we don't keep
	// multi-megabase strings around forever.
	const urlRegex = /(\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+)/g;
	const seen = new Set<string>();
	const images: Array<{ data: string; mimeType: string }> = [];
	const uploadedUrls: string[] = [];
	for (const m of trimmed.matchAll(urlRegex)) {
		const url = m[1];
		if (seen.has(url)) continue;
		seen.add(url);
		const img = state.uploadedImages.get(url);
		if (img) {
			images.push({ data: img.data, mimeType: img.mimeType });
			// Drop the base64 blob from the in-memory map once we've
			// shipped it. Multi-MB images would otherwise accumulate
			// for the lifetime of the page.
			uploadedUrls.push(url);
		}
	}
	for (const url of uploadedUrls) state.uploadedImages.delete(url);

	// Hand off the actual send to a hook wired up in boot(), so this
	// function doesn't have to capture `chatClient` (which is local to
	// boot()). The hook is `(text, images?) => void`.
	sendPromptHook(trimmed, images.length > 0 ? images : undefined);
	setStreaming(true);
}

/**
 * Wires the prompt-send half of `sendAsUser` to a closure over the
 * `chatClient` instance. Called once at the end of `boot()`; null
 * outside the boot path (e.g. early slash-command triggers from the
 * `setSendAsUser` import — those are no-ops until boot completes).
 */
type SendPromptHook = (text: string, images?: Array<{ data: string; mimeType: string }>) => void;
let sendPromptHook: SendPromptHook = () => {
	/* will be replaced by boot() */
};

// Local appendNode — main.ts only uses it once (in sendAsUser), so we
// keep the dep on render.ts for the bulk of the API and call it inline.
function appendNode(node: HTMLElement): void {
	$("#messages").append(node);
	// Always scroll to bottom for user messages.
	$("#messages").scrollTop = $("#messages").scrollHeight;
}

// ---------------------------------------------------------------------------
// Event handling — bridge server events to DOM
// ---------------------------------------------------------------------------

let lastAssistant: PersistedMessage | null = null;
let lastAssistantDom: LiveAssistantDom | null = null;
let lastThinking: PersistedMessage | null = null;

function onEvent(event: AgentEvent | Record<string, unknown>): void {
	// The server is now forwarding raw `pi --mode rpc` events, which
	// is a superset of the bare `AgentEvent` union. Treat the input
	// as `Record<string, unknown>` and read the `type` field as a
	// string; the switch ignores unknown types.
	const e = event as AgentEvent;
	switch (e.type) {
		case "agent_start":
			setStreaming(true);
			break;

		case "agent_end":
			setStreaming(false);
			// No local save — the server's `pi` child auto-persists
			// every event to its JSONL session file as it happens.
			break;

		case "turn_start":
			// Reset per-turn state. The assistant block for the next message
			// gets created on the first message_start.
			lastAssistant = null;
			lastAssistantDom = null;
			lastThinking = null;
			// Don't reset spoken here — spoken is per-message, not per-turn.
			break;

		case "turn_end":
			// Tools results come in here. We don't render toolResult messages
			// inline (they were already rendered as the tool call block);
			// the tool_execution_end below is what shows the result.
			break;

		case "message_start":
			if (event.message.role === "assistant") {
				// New assistant message — create a fresh block.
				lastAssistant = { kind: "assistant", text: "", thinking: "" };
				state.messages.push(lastAssistant);
				lastAssistantDom = appendAssistantPlaceholder();
			} else if (event.message.role === "user") {
				// User message echoed by the server (we already showed it).
			} else if (event.message.role === "toolResult") {
				// Tool result from a tool the model called. Render as a tool
				// block in our transcript.
				const tr = event.message as ToolResultMessage;
				const text = tr.content
					.filter((c) => c.type === "text")
					.map((c) => (c as TextContent).text)
					.join("");
				state.messages.push({ kind: "tool", name: tr.toolName, args: "(see above)", result: text, isError: tr.isError });
				finalizeToolCall(tr.toolCallId, tr.toolName, text, tr.isError);
			}
			break;

		case "message_update": {
			const m = event.message as AssistantMessage;
			// Reconstruct the assistant text from content blocks.
			let text = "";
			let thinking = "";
			for (const block of m.content) {
				if (block.type === "text") text += (block as TextContent).text;
				else if (block.type === "thinking") thinking += (block as ThinkingContent).thinking;
			}
			if (lastAssistant && lastAssistant.kind === "assistant") {
				lastAssistant.text = text;
				lastAssistant.thinking = thinking;
			}
			// Mirror the latest text into a top-level state field so the
			// live-streaming speak button (which closes over `state` via
			// render.ts) always replays the final text.
			state.lastAssistantText = text;
			if (lastAssistantDom) {
				lastAssistantDom.textPre.textContent = text || " ";
				// Stream thinking content into the (collapsed) thinking block.
				// If this is the first non-empty chunk, remove the
				// hidden-thinking marker so the toggle is visible.
				if (thinking) {
					lastAssistantDom.thinkingPre.textContent = thinking;
					lastAssistantDom.thinkingWrap.classList.remove("hidden-thinking");
				}
			}
			// Update cost incrementally.
			if (m.usage) {
				state.costTotal.input += m.usage.input;
				state.costTotal.output += m.usage.output;
				state.costTotal.cacheRead += m.usage.cacheRead;
				state.costTotal.cacheWrite += m.usage.cacheWrite;
				state.costTotal.cost += m.usage.cost?.total ?? 0;
			}
			// Don't yank the user back to the bottom on every token — if they've
			// scrolled up to re-read, leave them there. scrollToBottomIfPinned
			// only scrolls when they were already near the bottom.
			scrollToBottomIfPinned();
			refreshStatus();
			break;
		}

		case "message_end": {
			const m = event.message as AssistantMessage;
			if (m.usage) {
				state.costTotal.input += m.usage.input;
				state.costTotal.output += m.usage.output;
				state.costTotal.cacheRead += m.usage.cacheRead;
				state.costTotal.cacheWrite += m.usage.cacheWrite;
				state.costTotal.cost += m.usage.cost?.total ?? 0;
			}
			if (lastAssistantDom) {
				lastAssistantDom.textPre.classList.remove("streaming");
				// If the model never emitted any thinking content, remove
				// the stray toggle so the message doesn't show a useless
				// "▸ thinking" header.
				if (!lastAssistantDom.thinkingPre.textContent?.trim()) {
					lastAssistantDom.thinkingWrap.remove();
				}
			}
			// Auto-speak: if the toggle is on, fire TTS for the final
			// assistant text. We only speak if there's a "lastAssistant"
			// with non-empty text, and only on the first message_end for
			// that turn (we use the in-place edit of the .text node as a
			// proxy: if text is non-empty and we haven't spoken it yet,
			// speak).
			if (m.role === "assistant" && state.autoSpeak && lastAssistant && lastAssistant.kind === "assistant") {
				const t = lastAssistant.text;
				if (t && t.trim() && !lastAssistant.spoken) {
					lastAssistant.spoken = true;
					void import("./voice.js").then(({ speakText }) => { void speakText(t); });
				}
			}
			refreshStatus();
			break;
		}

		case "tool_execution_start":
			// The model just decided to call a tool. Show a pending block.
			// Carry the SDK's toolCallId through to the DOM so the
			// matching tool_execution_end / message_start can find the
			// right row even when multiple tools are in flight in
			// parallel.
			state.messages.push({ kind: "tool", name: event.toolName, args: event.args });
			appendToolCall(event.toolName, event.args, event.toolCallId);
			break;

		case "tool_execution_update":
			// We don't render partial tool results; just keep the pending state.
			break;

		case "tool_execution_end":
			// The actual result text comes in via the subsequent message_start
			// for the toolResult. Nothing to do here; finalizeToolCall is
			// called from there.
			break;
	}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
	// Probe the server's health and model list. If the relevant API keys
	// aren't set, the lists come back empty and the picker will show a
	// helpful error.
	try {
		const [h, models] = await Promise.all([getHealth(), getModels()]);
		state.availableModels = models.map((m: ModelInfo) => ({
			id: m.id,
			provider: m.provider,
			name: m.name,
			reasoning: m.reasoning,
		}));
		// Fall back to the legacy single-provider shape if /api/models
		// returns nothing (older server) — we still get *something* in
		// the picker so the user isn't stuck.
		if (state.availableModels.length === 0) {
			state.availableModels = h.providers.map((p) => ({ id: "MiniMax-M3", provider: p }));
		}
	} catch (e) {
		appendError("server health check failed: " + (e instanceof Error ? e.message : String(e)));
	}

	// Build the WS client FIRST so the shell-handler closures below
	// capture a real `ChatClient` instead of a module-level `let` that
	// happens to be `undefined` at registration time. (Old code
	// declared `let chatClient` at module scope and registered the
	// shell handlers before `createChatClient()` ran — the closures
	// would have crashed if any handler fired during boot.)
	const chatClient = createChatClient();

	// Register cross-module handlers BEFORE renderShell so the UI
	// buttons can find them. Once renderShell runs, the handlers
	// can't be re-registered without throwing.
	const shellHandlers: ShellHandlers = {
		handleSend,
		historyBack,
		historyForward,
		showSlashMenu,
		handleSlash,
		openModelPicker,
		openThinkPicker,
		openVoicePicker,
		openOverflowMenu,
		toggleAutoSpeak,
		handleVoiceRecord,
		handleFileAttach,
		abort: () => chatClient.abort(),
	};
	registerShellHandlers(shellHandlers);
	setSendAsUser(sendAsUser);

	renderShell();

	setChatControls({
		setModel: (modelId, provider) => chatClient.setModel(modelId, provider),
		setThinking: (level) => chatClient.setThinking(level),
		abort: () => chatClient.abort(),
		newSession: () => chatClient.newSession(),
		resumeSession: (id) => chatClient.resumeSession(id),
		listSessions: () => chatClient.listSessions(),
		renameSession: (name) => chatClient.renameSession(name),
	});
	chatClient.onStatus((s) => {
		state.connectionStatus = s;
		refreshStatus();
	});
	chatClient.onReady((info) => {
		// Don't blindly overwrite the displayed model with the server's
		// default on every fresh connection — the server sends `ready`
		// with the *initial* model (MiniMax-M3) on each new connection,
		// which would clobber the user's pick on every reconnect.
		//
		// Instead: only adopt the server-reported model if
		//   1. we don't currently have one displayed, OR
		//   2. the server is confirming the model the user just picked
		//      (i.e. a setModel round-trip — server rebuilt the agent
		//      and is reporting back the model we asked for).
		//
		// We detect (2) by tracking `pendingModelSet` — set when the user
		// clicks a model in the picker, cleared on the matching `ready`.
		const isConfirmingPending = state.pendingModelSet === info.modelId;
		if (!state.currentModelId || isConfirmingPending) {
			state.currentModelId = info.modelId;
			state.currentProvider = info.provider;
		}
		state.pendingModelSet = null;
		state.currentThinking = info.thinkingLevel;
		refreshStatus();
	});
	chatClient.onEvent(onEvent);
	chatClient.onError((msg) => appendError(msg));
	// /sessions picker: when the server replies with the list, fill the
	// open modal. The listener is a no-op if no picker is open.
	chatClient.onSessionsUpdated((sessions) => {
		renderSessionsIntoPicker(sessions);
	});
	// On resume: replace the renderer cache with the server's replay
	// transcript, then re-render the chat scrollback so the past
	// conversation is visible.
	chatClient.onTranscript((_sessionId, messages) => {
		state.messages = messages.map(projectToPersisted);
		// Re-render: simplest approach is to nuke the messages div
		// and re-append every cached message. The render layer's
		// renderMessageNode is the source of truth for what a
		// single PersistedMessage looks like.
		void import("./render.js").then(({ renderShell }) => {
			renderShell();
		});
	});
	// After resumeSession/newSession completes, the server reports
	// the new session's metadata. We adopt it (model/thinking) but
	// don't touch the message cache — that's already populated by
	// the transcript message for resume, or is empty for new.
	chatClient.onSessionResumed((info) => {
		state.currentModelId = info.modelId;
		state.currentProvider = info.provider;
		state.currentThinking = info.thinkingLevel;
		refreshStatus();
	});

	// Send the init handshake as soon as the WS opens. The server is
	// waiting for this before it spawns the `pi` child. If we have
	// no model picked yet, default to the first available model.
	const onOpen = () => {
		const modelId = state.currentModelId ?? state.availableModels[0]?.id ?? "MiniMax-M3";
		const provider = state.currentProvider ?? state.availableModels[0]?.provider ?? "minimax";
		const thinkingLevel = state.currentThinking;
		chatClient.init({ provider, modelId, thinkingLevel });
		chatClient.offStatus(onOpen);
	};
	chatClient.onStatus(onOpen);

	// Wire the prompt-send hook used by `sendAsUser` (defined above
	// at module scope, so the `setSendAsUser` dep injection in
	// slashes.ts works before/after boot completes). The hook is a
	// no-op until this runs, which is fine — the only way to call
	// `sendAsUser` is via a user gesture (button/keypress) which
	// can only fire after `renderShell` has wired the handlers.
	sendPromptHook = (text, images) => {
		chatClient.prompt(text, images);
	};
}

/**
 * Project an SDK-shaped Message (from the server's transcript
 * replay) to the renderer's flat PersistedMessage cache type. The
 * types are mostly equivalent for user/assistant messages; tool
 * messages and toolResult messages get merged into a single
 * "tool" cache row that the renderer already knows how to paint.
 */
function projectToPersisted(m: unknown): PersistedMessage {
	if (!m || typeof m !== "object") {
		return { kind: "error", text: String(m) };
	}
	const msg = m as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
	switch (msg.role) {
		case "user": {
			const text = extractText(msg.content);
			return { kind: "user", text };
		}
		case "assistant": {
			const text = extractText(msg.content);
			const thinking = extractThinking(msg.content);
			return { kind: "assistant", text, thinking };
		}
		case "toolResult": {
			const text = extractText(msg.content);
			return { kind: "tool", name: msg.toolName ?? "tool", args: "(replayed)", result: text, isError: msg.isError };
		}
		default:
			return { kind: "error", text: JSON.stringify(m).slice(0, 500) };
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b && b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("");
	}
	return "";
}

function extractThinking(content: unknown): string {
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b && b.type === "thinking")
			.map((b: { thinking?: string }) => b.thinking ?? "")
			.join("");
	}
	return "";
}

boot();
