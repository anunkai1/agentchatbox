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
import { createChatClient, type ChatClient } from "./ws.js";
import { getHealth, getModels, type ModelInfo } from "./api.js";
import { saveCurrentSession } from "./slashes.js";
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
	for (const m of trimmed.matchAll(urlRegex)) {
		const url = m[1];
		if (seen.has(url)) continue;
		seen.add(url);
		const img = state.uploadedImages.get(url);
		if (img) {
			images.push({ data: img.data, mimeType: img.mimeType });
		}
	}

	chatClient.prompt(trimmed, images.length > 0 ? images : undefined);
	setStreaming(true);
}

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

function onEvent(event: AgentEvent): void {
	switch (event.type) {
		case "agent_start":
			setStreaming(true);
			break;

		case "agent_end":
			setStreaming(false);
			void saveCurrentSession();
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
				finalizeToolCall(tr.toolName, text, tr.isError);
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
			state.messages.push({ kind: "tool", name: event.toolName, args: event.args });
			appendToolCall(event.toolName, event.args);
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

let chatClient: ChatClient;

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

	chatClient = createChatClient();
	setChatControls({
		setModel: (modelId, provider) => chatClient.setModel(modelId, provider),
		setThinking: (level) => chatClient.setThinking(level),
		abort: () => chatClient.abort(),
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
}

boot();
