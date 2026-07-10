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

import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	getCapabilities,
	getHealth,
	getModels,
	sessionExists,
	type ModelInfo,
} from "./api.js";
import type { LiveAssistantDom } from "./dom.js";
import { $ } from "./dom.js";
import { setRichText } from "./linkify.js";
import { projectTranscript } from "./project.js";
import {
	appendAssistantPlaceholder,
	appendError,
	appendToolCall,
	autoSize,
	finalizeToolCall,
	isAtBottom,
	jumpToPrevUserMessage,
	refreshStatus,
	registerShellHandlers,
	renderMessageNode,
	renderShell,
	renderSidebarProjects,
	renderSidebarSessions,
	resetJumpNav,
	type ShellHandlers,
	scrollToBottom,
	scrollToBottomIfPinned,
	setStreaming,
	showToast,
	hideToast,
	syncSteerBadges,
	updateJumpFabState,
	lastAssistantVoiceBox,
	updateVoiceTextBox,
} from "./render.js";
import {
	handleSlash,
	isKnownSlash,
	openModelPicker,
	openOverflowMenu,
	openSpeedPicker,
	openThinkPicker,
	openVoicePicker,
	renderSessionsIntoPicker,
	setChatControls,
	setSendAsUser,
	resetChatState,
	showSlashMenu,
} from "./slashes.js";
import { type PersistedMessage, refreshCurrentModelLabel, state } from "./state.js";
import {
	handleDrop,
	handleFileAttach,
	handlePaste,
	handleVoiceRecord,
	stopAllVoice,
	pauseVoice,
	resumeVoice,
	speakText,
	toggleSpeak,
} from "./voice.js";
import { createChatClient } from "./ws.js";
import { handleExtensionUiRequest, type ExtensionUiResponder } from "./extension-ui.js";
import { readSessionIdFromUrl, writeSessionIdToUrl } from "./url.js";
import { applySessionPrefs } from "./prefs.js";
import { setServices } from "./services.js";

// ---------------------------------------------------------------------------
// History (↑/↓)
// ---------------------------------------------------------------------------

function historyBack(): void {
	if (state.history.length === 0) return;
	const idx =
		state.historyIdx === null ? state.history.length - 1 : Math.max(0, state.historyIdx - 1);
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
	// While the agent is streaming, a typed message is a steering
	// comment: queued and delivered after the current turn's tool
	// calls finish. This mirrors the CLI, where you can keep typing
	// while the agent works.
	if (state.isStreaming) {
		sendSteer(trimmed);
		return;
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
	// New message resets the jump walk: the next Alt+↑ / button press
	// should start fresh from this newest position, not resume a stale
	// index from before the send.
	resetJumpNav();
	appendNode(renderMessageNode({ kind: "user", text: trimmed }));

	// Auto-title from the first user message.
	if (state.title === "New chat" || !state.title) {
		state.title = trimmed.split(/[.\n!?]/)[0].slice(0, 50) || "New chat";
		$<HTMLSpanElement>("#title").textContent = state.title;
	}

	// Find any /uploads/<id>... URLs in the prompt and pull the base64
	// bytes for each one. The URLs are emitted by handleFileAttach as
	// markdown image links, so the regex finds them. consumeUploadedImages
	// dedupes by URL and removes them from the map after sending so we
	// don't keep multi-megabase strings around forever.
	const images = consumeUploadedImages(trimmed);

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
/** Closure over `chatClient.steer`, wired in boot(). */
let steerHook: SendPromptHook = () => {
	/* will be replaced by boot() */
};

/**
 * Closure over `chatClient.extensionUiResponse`, wired in boot(). Used
 * by the extension_ui_request event handler to send dialog responses
 * back to pi. Null until boot() completes.
 */
let extensionUiResponder: ExtensionUiResponder | null = null;

/**
 * Monotonic count of JSONL `type:"message"` entries seen so far in the
 * live event stream. Seeded to the transcript length on resume (so live
 * appends continue with correct ordinals) and reset to 0 on each ready
 * (new session). Drives the `seq` stamp each fork button reads.
 */
let liveMessageSeq = 0;

/**
 * Pull the base64 bytes for every /uploads/<id> URL referenced in `text`
 * out of the in-memory image map, and drop them (multi-MB strings
 * shouldn't linger after they've been shipped). Shared by sendAsUser
 * and sendSteer, which previously each inlined this ~15-line scan.
 */
function consumeUploadedImages(text: string): Array<{ data: string; mimeType: string }> {
	const images: Array<{ data: string; mimeType: string }> = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(/(\/uploads\/[A-Za-z0-9-]+\.[A-Za-z0-9]+)/g)) {
		const url = m[1];
		if (seen.has(url)) continue;
		seen.add(url);
		const img = state.uploadedImages.get(url);
		if (img) {
			images.push({ data: img.data, mimeType: img.mimeType });
			state.uploadedImages.delete(url);
		}
	}
	return images;
}

/**
 * Stamp the most recent user block that has no `seq` yet with the given
 * JSONL ordinal. The optimistic user block is pushed at send time before
 * the server echoes it; this lands the ordinal once pi's message_start
 * echo arrives. Finds the LAST unstamped user block so a rapid sequence
 * of sends (rare, but possible) still lines up with their echoes in order.
 */
function stampLastUserBlock(seq: number): void {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m.kind === "user") {
			if (m.seq === undefined) m.seq = seq;
			return;
		}
	}
}

/**
 * Recover a steering message that pi can no longer drain on its own.
 *
 * pi only drains its steering queue mid-run (after tool calls, before
 * the next LLM call). If the agent goes idle with a steer still queued —
 * it finished its turn in the window after the steer landed, or the
 * steer arrived after idle (an inherent race, since `isStreaming` is
 * checked client-side) — the message would sit in pi's queue forever
 * and the "⏳ queued" badge would never clear.
 *
 * Re-send the stranded steer as a prompt: pi drains any leftover
 * steering queue at the top of every run, so the steer is honored, and
 * the prompt itself is what triggers the turn that delivers it. (The
 * steer text may also appear as the prompt; that's harmless — it just
 * reinforces the instruction. Images were already handed to pi with
 * the original steer and live in its queue, so they are not re-sent.)
 */
function recoverStrandedSteer(): void {
	if (state.isStreaming) return;
	const stranded = state.messages.find(
		(m): m is Extract<PersistedMessage, { kind: "steer" }> => m.kind === "steer" && !m.delivered,
	);
	if (!stranded) return;
	if (!stranded.text) return;
	sendPromptHook(stranded.text);
	setStreaming(true);
}

// Capture pinning BEFORE appending. The new node may be tall (a ⚙
// tool card, a thinking block, a result <pre>), and once it's in the
// DOM it grows scrollHeight while scrollTop stays put — so an
// after-append isAtBottom() check would falsely report "not at
// bottom" (the 80px slack is consumed by the new block itself) and
// silently skip the scroll. Worse, that poisons pinning for the
// rest of the turn: every later streamed token's
// scrollToBottomIfPinned() would then no-op because isAtBottom()
// stays false. Capturing pre-append fixes both.
function appendNode(node: HTMLElement, opts: { pin?: boolean } = {}): void {
	const wasPinned = isAtBottom();
	$("#messages").append(node);
	if (!opts.pin || wasPinned) scrollToBottom();
	// A new row may change the user-message count (e.g. the user just
	// sent one), so refresh the jump button's show/disabled state.
	updateJumpFabState();
}

/**
 * Queue a steering message while the agent is running. Rendered as a
 * user-style bubble with a "queued" badge; the badge flips to
 * "delivered" once `queue_update` reports the agent has consumed it.
 * Steering text is NOT pushed into `state.history` — it's an inline
 * course-correction, not a standalone prompt you'd recall with ↑/↓.
 */
function sendSteer(trimmed: string): void {
	if (!trimmed) return;
	const msg: PersistedMessage = { kind: "steer", text: trimmed, delivered: false };
	state.messages.push(msg);
	appendNode(renderMessageNode(msg), { pin: true });
	state.pendingSteerCount += 1;
	refreshStatus();
	// Upload-URL rewriting mirrors sendAsUser so attached files resolve.
	const images = consumeUploadedImages(trimmed);
	steerHook(trimmed, images.length > 0 ? images : undefined);
}

/**
 * Reconcile queued steering messages against a `queue_update` event.
 * The server reports the current steering queue contents; we mark the
 * oldest still-queued steer entries as delivered until the local
 * pending count matches the server's queue length.
 */
function reconcileSteerQueue(serverSteering: unknown[]): void {
	const queued = state.messages.filter((m) => m.kind === "steer" && !m.delivered);
	const remaining = Math.max(0, Math.min(serverSteering.length, queued.length));
	const toDeliver = queued.length - remaining;
	let delivered = 0;
	for (const m of state.messages) {
		if (delivered >= toDeliver) break;
		if (m.kind === "steer" && !m.delivered) {
			m.delivered = true;
			delivered += 1;
		}
	}
	state.pendingSteerCount = serverSteering.length;
	syncSteerBadges();
	refreshStatus();
}

// ---------------------------------------------------------------------------
// Event handling — bridge server events to DOM
// ---------------------------------------------------------------------------

let lastAssistant: PersistedMessage | null = null;
let lastAssistantDom: LiveAssistantDom | null = null;

/**
 * Remove the whole live assistant row whose handles we captured in
 * `appendAssistantPlaceholder`. `LiveAssistantDom` deliberately exposes
 * only the in-place-updatable nodes (text/thinking), not the container —
 * so to discard a row we climb from `textPre` to its `.row` ancestor.
 * Used when a streamed assistant message ends empty (spurious turn from
 * the pi-voice-reply extension, or a model error) so the user doesn't see
 * a frozen empty bubble with a spinner.
 */
function removeLiveAssistantRow(dom: LiveAssistantDom): void {
	dom.textPre.closest(".row")?.remove();
}

function onEvent(event: Record<string, unknown>): void {
	// The server forwards raw `pi --mode rpc` events, which is a
	// superset of the bare `AgentEvent` union. Cast to a permissive
	// type for property access; the switch ignores unknown types.
	// biome-ignore lint/suspicious/noExplicitAny: pi RPC events are an undocumented superset of AgentEvent; permissive cast is intentional for property access, the switch ignores unknown types.
	const e = event as Record<string, any>;
	switch (e.type) {
		case "agent_start":
			setStreaming(true);
			state.streamingStartedAt = Date.now();
			break;

		case "agent_end":
			setStreaming(false);
			state.streamingStartedAt = null;
			state.retry = null;
			// Safety net: if a Long/Short button was pressed to generate a
			// voice reply but pi finished without emitting one (error or
			// unsupported turn), reset the pending button so its spinner
			// doesn't spin forever. toggleSpeak clears pendingVoiceBtn when
			// it fires, so a non-null value here means generation failed.
			if (state.pendingVoiceBtn) {
				const b = state.pendingVoiceBtn;
				b.classList.remove("is-loading");
				b.textContent = b.dataset.idleLabel ?? "🗣️ LongTTS";
				state.pendingVoiceVariant = null;
				state.pendingVoiceBtn = null;
				// Generation produced no voice reply — clear the blue TTS banner
				// (it was raised as "generating…" on the button press).
				hideToast();
			}
			// No local save — the server's `pi` child auto-persists
			// every event to its JSONL session file as it happens.
			// A steer stranded in pi's queue when the agent went idle
			// (it finished before draining the steer) can't be delivered
			// until the next run — recover now.
			recoverStrandedSteer();
			break;

		case "turn_start":
			// Reset per-turn state. The assistant block for the next message
			// gets created on the first message_start.
			lastAssistant = null;
			lastAssistantDom = null;
			state.lastAssistantSeq = null;
			// Don't reset spoken here — spoken is per-message, not per-turn.
			break;

		case "turn_end":
			// Tools results come in here. We don't render toolResult messages
			// inline (they were already rendered as the tool call block);
			// the tool_execution_end below is what shows the result.
			break;

		case "message_start":
			// Every message_start corresponds to one JSONL `type:"message"`
			// line (user/assistant/toolResult). Bump the live ordinal so the
			// fork button on each block reports how many messages a fork
			// from here would copy.
			if (
				e.message.role === "user" ||
				e.message.role === "assistant" ||
				e.message.role === "toolResult"
			) {
				liveMessageSeq++;
			}
			if (e.message.role === "assistant") {
				// New assistant message — create a fresh block.
				lastAssistant = { kind: "assistant", text: "", thinking: "", seq: liveMessageSeq };
				state.messages.push(lastAssistant);
				// Mirror the ordinal into state so the live fork button (rendered
				// via appendAssistantPlaceholder) can read it without a
				// back-reference into the messages array.
				state.lastAssistantSeq = liveMessageSeq;
				lastAssistantDom = appendAssistantPlaceholder();
			} else if (e.message.role === "custom") {
				// Custom message from an extension. The pi-voice-reply
				// extension emits customType:"voice-reply" carrying ONE
				// spoken variant (long|medium|short) — generated on demand
				// by the matching LongTTS/MedTTS/ShortTTS button. The buttons
				// are always present on every assistant row, so here we only
				// need to: (1) MERGE the arriving variant onto the last
				// assistant message (without clearing the others), (2) refresh
				// its read-along box, and (3) auto-play the requested variant.
				if (e.message.customType === "voice-reply") {
					const details =
						(e.message as { details?: { long?: string; medium?: string; short?: string } })
							.details ?? {};
					// Merge only the variant(s) this message carries, so
					// per-button /voice-last calls accumulate onto one
					// assistant message without wiping a previously-generated
					// variant. The already-rendered buttons read these lazily.
					let updated = false;
					for (let j = state.messages.length - 1; j >= 0; j--) {
						const prev = state.messages[j];
						if (prev.kind === "assistant") {
							if (details.long !== undefined) prev.voiceLong = details.long;
							if (details.medium !== undefined) prev.voiceMedium = details.medium;
							if (details.short !== undefined) prev.voiceShort = details.short;
							// Refresh the target message's read-along box live.
							// lastAssistantDom is a streaming-scoped handle that is
							// null by the time this /voice-last turn delivers its
							// custom message (turn_start clears it first), so fall
							// back to querying the last assistant row's .voice-text —
							// which is exactly the message we just merged onto.
							const voiceBox = lastAssistantDom?.voiceTextBox ?? lastAssistantVoiceBox();
							if (voiceBox) updateVoiceTextBox(voiceBox, prev);
							updated = true;
							break;
						}
					}
					// Auto-play. If a button initiated this (the variant wasn't
					// generated yet at press time), honor the variant it picked
					// and drive THAT button's label (spin → ⏹) via toggleSpeak
					// so it's stoppable. Otherwise (keyword trigger like "reply
					// in voice") default to long with no owning button. Falls
					// back to whichever variant actually arrived if the requested
					// one is empty.
					const want = state.pendingVoiceVariant ?? "long";
					const btn = state.pendingVoiceBtn;
					state.pendingVoiceVariant = null;
					state.pendingVoiceBtn = null;
					const wantText =
						want === "short" ? details.short : want === "medium" ? details.medium : details.long;
					const text =
						(wantText ?? "").trim() ||
						(details.long ?? "").trim() ||
						(details.medium ?? "").trim() ||
						(details.short ?? "").trim();
					if (text && updated) {
						if (btn) toggleSpeak(text, btn);
						else speakText(text);
					}
				}
			} else if (e.message.role === "user") {
				// User message echoed by the server (we already showed it
				// optimistically at send time). Stamp the matching block now
				// that we know its JSONL ordinal.
				stampLastUserBlock(liveMessageSeq);
			} else if (e.message.role === "toolResult") {
				// Tool result from a tool the model called. Render as a tool
				// block in our transcript.
				const tr = e.message as ToolResultMessage;
				const text = tr.content
					.filter((c) => c.type === "text")
					.map((c) => (c as TextContent).text)
					.join("");
				state.messages.push({
					kind: "tool",
					name: tr.toolName,
					args: "(see above)",
					result: text,
					isError: tr.isError,
				});
				finalizeToolCall(tr.toolCallId, tr.toolName, text, tr.isError);
			}
			break;

		case "message_update": {
			const m = e.message as AssistantMessage;
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
				setRichText(lastAssistantDom.textPre, text || " ");
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

		case "queue_update": {
			// pi reports the current steering/follow-up queue. We use the
			// steering array to flip our queued steer bubbles to
			// "delivered" as the agent consumes them.
			const steering = Array.isArray(e.steering) ? (e.steering as unknown[]) : [];
			reconcileSteerQueue(steering);
			// If a steer lands while the agent is already idle (the race:
			// isStreaming was true when we sent, but the agent finished
			// before the steer reached pi), pi will never drain it on its
			// own — recover.
			if (!state.isStreaming && steering.length > 0) recoverStrandedSteer();
			break;
		}

		case "message_end": {
			const m = e.message as AssistantMessage;
			// Suppress the blank spurious assistant message that the
			// pi-voice-reply extension's sendMessage triggers (see the
			// extension's spurious-turn handling). The extension blanks
			// the content; we drop the empty block so the user never
			// sees a stray empty bubble after the voice-reply buttons.
			//
			// ALSO suppress empty assistant messages whose stopReason is
			// "error" — these happen when the provider returns an error
			// (overloaded, context too long, rate limit) and the agent
			// loop retries. Without this, each failed attempt renders as
			// a frozen "streaming" row with a spinner and no text, which
			// looks like the agent is stuck. Surface a visible error
			// instead so it's clear what happened.
			// Authoritative final text from the message_end payload. An
			// extension suppressing a spurious turn (pi-voice-reply) can blank
			// the final content to "" AFTER tokens have streamed to the client,
			// so a row may be "empty" even when lastAssistant.text (accumulated
			// from message_update) is non-empty. Treat either as removable so
			// no frozen bubble lingers.
			//
			// IMPORTANT: the emptiness check must consider THINKING too. A
			// turn that streams reasoning and then makes a tool call (no
			// visible text) is not empty — it has a reasoning transcript the
			// user wants to see. Without this, the thinking block gets
			// yanked together with the row at message_end, and the user
			// watches it appear, get pushed up by the tool card, and
			// vanish.
			//
			// Logic note: the previous incarnation used `||` here, which
			// was wrong — any single empty field would trigger removal, so
			// the very case this guard exists to protect (thinking + tool
			// call, text empty) still tripped it. The correct shape is
			// AND-of-ANDs: the row is empty only when *both* the streaming-
			// accumulated state AND the authoritative message_end payload
			// have no text AND no thinking. That keeps the pi-voice-reply
			// blanked turn and the error-retry paths working (no text, no
			// thinking) while preserving `thinking + toolCall` rows.
			let finalText = "";
			let finalThinking = "";
			if (m.role === "assistant") {
				for (const block of m.content) {
					if (block.type === "text") finalText += (block as TextContent).text;
					else if (block.type === "thinking") finalThinking += (block as ThinkingContent).thinking;
				}
			}
			const isEmptyError =
				m.role === "assistant" && (m as { stopReason?: string }).stopReason === "error";
			if (
				m.role === "assistant" &&
				lastAssistant &&
				lastAssistant.kind === "assistant" &&
				!lastAssistant.text.trim() &&
				!lastAssistant.thinking.trim() &&
				!finalText.trim() &&
				!finalThinking.trim() &&
				lastAssistantDom
			) {
				if (isEmptyError) {
					// Replace the frozen empty row with a visible error notice.
					removeLiveAssistantRow(lastAssistantDom);
					state.messages.pop();
					const errMsg = {
						kind: "error" as const,
						text: "Model returned an error (possibly context too long or provider overloaded). Retrying…",
					};
					state.messages.push(errMsg);
					appendNode(renderMessageNode(errMsg));
				} else {
					removeLiveAssistantRow(lastAssistantDom);
					state.messages.pop();
				}
				lastAssistant = null;
				lastAssistantDom = null;
				refreshStatus();
				break;
			}
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
			refreshStatus();
			break;
		}

		case "tool_execution_start":
			// The model just decided to call a tool. Show a pending block.
			// Carry the SDK's toolCallId through to the DOM so the
			// matching tool_execution_end / message_start can find the
			// right row even when multiple tools are in flight in
			// parallel.
			state.messages.push({ kind: "tool", name: e.toolName, args: e.args });
			appendToolCall(e.toolName, e.args, e.toolCallId);
			break;

		case "tool_execution_update":
			// We don't render partial tool results; just keep the pending state.
			break;

		case "tool_execution_end":
			// The actual result text comes in via the subsequent message_start
			// for the toolResult. Nothing to do here; finalizeToolCall is
			// called from there.
			break;

		case "auto_retry_start": {
			// pi hit a recoverable error (transient model/transport fault)
			// and is backing off before the next attempt — the SAME event
			// the CLI renders as "Retrying (1/3) in 8s… (interrupt to
			// cancel)". Surface it so a retrying agent is visibly working,
			// not frozen, and so the reason (errorMessage) is shown —
			// previously these events arrived and were silently dropped,
			// which is why a mid-retry agent looked indistinguishable from
			// a hang.
			state.retry = {
				attempt: Number(e.attempt) || 0,
				maxAttempts: Number(e.maxAttempts) || 0,
				remainingMs: Number(e.delayMs) || 0,
				errorMessage: String(e.errorMessage ?? "Unknown error"),
			};
			refreshStatus();
			break;
		}

		case "auto_retry_end":
			// Retry resolved (either the next attempt succeeded, failed out,
			// or the user cancelled via abortRetry). Clear the banner.
			state.retry = null;
			refreshStatus();
			break;

		case "extension_ui_request": {
			// Extension UI relay: pi extensions ask the user questions via
			// ctx.ui.select()/confirm()/input(). The event is forwarded by
			// the server verbatim; we render the dialog in the browser and
			// send the answer back via extensionUiResponse.
			//
			// `notify` is fire-and-forget (no response expected) — handled
			// inline here. Dialog methods (select/confirm/input) are handled
			// by the extension-ui module, which calls the responder.
			if (e.method === "notify" && typeof e.message === "string") {
				const notifyType =
					e.notifyType === "error" ? "error" : e.notifyType === "warning" ? "warning" : "info";
				showToast(e.message, notifyType);
				// Capture the image-model label from the pi-venice-image extension's
				// notify so the Settings row reflects the current model. The
				// extension owns the state; this is a display-only mirror.
				const imgMatch = e.message.match(/image model set to (.+)/i);
				if (imgMatch) {
					state.currentImageModelLabel = imgMatch[1];
					refreshStatus();
				} else if (/reset to default/i.test(e.message)) {
					state.currentImageModelLabel = null;
					refreshStatus();
				}
			} else if (extensionUiResponder) {
				handleExtensionUiRequest(
					{ id: String(e.id), method: String(e.method), title: e.title as string | undefined, options: e.options as string[] | undefined, message: e.message as string | undefined, placeholder: e.placeholder as string | undefined },
					extensionUiResponder,
				);
			}
			break;
		}

		case "modelState": {
			// Server confirms a setModel/setThinking round-trip. Adopt
			// the server's view of the current model+thinking (which is
			// whatever pi is actually using — NOT the user's last click
			// if that click was rejected by pi). This is the only path
			// the client has to learn the truth without a page refresh;
			// `ready` only fires on attach/reattach.
			if (typeof e.provider === "string") state.currentProvider = e.provider;
			if (typeof e.modelId === "string") state.currentModelId = e.modelId;
			refreshCurrentModelLabel();
			// Narrow at runtime — ThinkingLevel is a string union, and the
			// wire format is just a string. Avoid an unsafe cast.
			if (typeof e.thinkingLevel === "string") {
				const valid = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
				if ((valid as readonly string[]).includes(e.thinkingLevel)) {
					state.currentThinking = e.thinkingLevel as typeof state.currentThinking;
				}
			}
			// Clear the pending marker — the server has answered.
			state.pendingModelSet = null;
			refreshStatus();
			break;
		}
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
		const [h, models] = await Promise.all([
			getHealth(),
			getModels(),
		]);
		state.searchEnabled = h.search ?? false;
		state.ttsEngine = h.ttsEngine ?? null;
		state.ttsDefaultVoice = h.ttsVoice ?? null;
		state.voiceRewriteModel = h.voiceRewriteModel ?? null;
		state.availableModels = models.map((m: ModelInfo) => ({
			id: m.id,
			provider: m.provider,
			name: m.name,
			reasoning: m.reasoning,
		}));
		// Fetch capabilities (tools, skills, packages) for the header badge.
		getCapabilities()
			.then((caps) => {
				state.capabilities = caps;
				refreshStatus();
			})
			.catch(() => {
				// capabilities fetch is best-effort — don't block the app
			});

		// Fall back to the legacy single-provider shape if /api/models
		// returns nothing (older server) — we still get *something* in
		// the picker so the user isn't stuck.
		if (state.availableModels.length === 0) {
			state.availableModels = h.providers.map((p) => ({
				id: "MiniMax-M3",
				provider: p,
			}));
		}
		// The model list just (re)loaded — re-resolve the friendly label
		// for the current model now that names are available.
		refreshCurrentModelLabel();
	} catch (e) {
		appendError(`server health check failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Shareable-session links: if the URL names a session (`/s/<id>`),
	// resolve it BEFORE opening the WS so the first `init` resumes it.
	// Validate existence first — a stale link (session deleted, or shared
	// from another machine/project) starts a fresh chat instead of handing
	// `pi` a missing session id. This is pure client-side routing: the
	// server already resumes by id; we're only choosing what to ask for.
	const urlSessionId = readSessionIdFromUrl();
	if (urlSessionId) {
		const exists = await sessionExists(urlSessionId);
		if (exists) {
			state.sessionId = urlSessionId;
			applySessionPrefs();
		} else {
			writeSessionIdToUrl(null); // stale link — drop it, start fresh
		}
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
		openSpeedPicker,
		openOverflowMenu,
		handleVoiceRecord,
		stopAllVoice,
		pauseVoice,
		resumeVoice,
		handleFileAttach,
		handlePaste,
		handleDrop,
		abort: () => {
			// Mirror the CLI: while a retry backoff is counting down,
			// Stop cancels the retry (the CLI binds the same key to
			// "interrupt to cancel" during a retry). Otherwise Stop
			// aborts the whole run.
			if (state.retry) chatClient.abortRetry();
			else chatClient.abort();
		},
		abortRetry: () => chatClient.abortRetry(),
		setSessionPinned: (sessionId, pinned) => chatClient.setSessionPinned(sessionId, pinned),
		renameSessionById: (sessionId, name) => chatClient.renameSessionById(sessionId, name),
		newSessionInProject: (projectId) => {
			if (confirm("Start a new chat in this project?")) {
				resetChatState();
				chatClient.newSession(projectId);
			}
		},
		createProject: (input) => chatClient.createProject(input),
		updateProject: (input) => chatClient.updateProject(input),
		deleteProject: (id) => chatClient.deleteProject(id),
		reorderProjects: (order) => chatClient.reorderProjects(order),
	};
	registerShellHandlers(shellHandlers);
	setSendAsUser(sendAsUser);

	renderShell();

	// Global shortcut: Alt+↑ jumps to the previous user message (same as
	// the floating button). Attached once at boot; the handler queries the
	// DOM at call time, so it survives renderShell rebuilds. The input's
	// own ↑ (history recall) is gated on !e.altKey, so the two never clash.
	document.addEventListener("keydown", (e) => {
		if (e.altKey && (e.key === "ArrowUp" || e.key === "Up")) {
			e.preventDefault();
			jumpToPrevUserMessage();
		}
	});

	setChatControls({
		setModel: (modelId, provider) => chatClient.setModel(modelId, provider),
		setThinking: (level) => chatClient.setThinking(level),
		abort: () => chatClient.abort(),
		newSession: (projectId) => chatClient.newSession(projectId),
		resumeSession: (id) => chatClient.resumeSession(id),
		listSessions: () => chatClient.listSessions(),
		renameSession: (name) => chatClient.renameSession(name),
	});
	chatClient.onStatus((s) => {
		state.connectionStatus = s;
		refreshStatus();
	});
	chatClient.onReady((info) => {
		// A fresh `pi` child is up (new session, resume, or reconnect).
		// Reset the live message ordinal — it gets re-seeded to the
		// transcript length below if this is a resume with history.
		liveMessageSeq = 0;
		// Track the session id for export/display.
		if (info.sessionId) {
			state.sessionId = info.sessionId;
			applySessionPrefs();
			// Mirror the session into the URL so the chat is a bookmarkable,
			// shareable link. Covers new sessions, resumes, and reconnects
			// — every `ready` reflects the currently bound session.
			writeSessionIdToUrl(info.sessionId);
		}
		// Adopt the server-reported model. The server reports the
		// session's CURRENT model (chat.ts setModel/setThinking handlers
		// update session.init on every change, so a reattach reports the
		// truth, not the spawn-time default). We adopt it when:
		//   1. we don't currently have one displayed (hard refresh —
		//      state.currentModelId is null after a fresh page load), OR
		//   2. the server is confirming the model the user just picked
		//      (i.e. a setModel round-trip — server rebuilt the agent
		//      and is reporting back the model we asked for).
		// On a soft WS reconnect (no page reload) currentModelId is already
		// set, so neither condition fires and we keep what's displayed —
		// which matches the server anyway, so no fight.
		// We detect (2) by tracking `pendingModelSet` — set when the user
		// clicks a model in the picker, cleared on the matching `ready`.
		const isConfirmingPending = state.pendingModelSet === info.modelId;
		if (!state.currentModelId || isConfirmingPending) {
			state.currentModelId = info.modelId;
			state.currentProvider = info.provider;
			refreshCurrentModelLabel();
		}
		state.pendingModelSet = null;
		state.currentThinking = info.thinkingLevel;
		// Recover isStreaming from the server's ground truth. A hard refresh
		// wipes the browser's local isStreaming (and the Stop button with
		// it); the server tracks this from the agent_start/agent_end events
		// it already forwards as a transport pipe, so its value survives
		// the refresh. Without this, the Stop button vanishes mid-run after
		// a refresh — leaving the user with no way to abort. Trust the
		// server unconditionally (it sees pi; the browser only sees events
		// since it connected).
		if (typeof info.isStreaming === "boolean") setStreaming(info.isStreaming);
		refreshStatus();
		// Request the session list for the sidebar on the first ready event.
		// Subsequent ready events (reconnects, new sessions) also refresh.
		chatClient.listSessions();
		chatClient.listProjects();
	});
	chatClient.onEvent(onEvent);
	chatClient.onError((msg) => appendError(msg));
	// /sessions picker: when the server replies with the list, fill the
	// open modal. The listener is a no-op if no picker is open.
	// Also refresh the sidebar session list.
	chatClient.onSessionsUpdated((sessions) => {
		renderSessionsIntoPicker(sessions);
		// Derive which project the currently-viewed session belongs to, so
		// the sidebar can highlight its folder.
		const current = sessions.find((s) => s.id === state.sessionId);
		if (current?.projectId) state.activeProjectId = current.projectId;
		renderSidebarSessions(sessions);
	});
	chatClient.onProjectsUpdated((projects) => {
		state.projects = projects;
		renderSidebarProjects(projects);
	});
	// On resume: replace the renderer cache with the server's replay
	// transcript, then re-render the chat scrollback so the past
	// conversation is visible. On a silent reconnect (same session we
	// already have displayed), skip the re-render if the transcript
	// matches what's on screen — avoids a flicker + scroll jump every
	// time the mobile WS drops and reconnects.
	chatClient.onTranscript((sessionId, messages) => {
		const projected = projectTranscript(messages);
		const sameSession = state.sessionId === sessionId;
		const sameLength = state.messages.length === projected.length;
		const lastMatches =
			sameLength &&
			(state.messages.length === 0 ||
				JSON.stringify(state.messages[state.messages.length - 1]) ===
					JSON.stringify(projected[projected.length - 1]));
		state.sessionId = sessionId;
		applySessionPrefs();
		state.messages = projected;
		// Seed the live message ordinal from the replayed transcript so
		// subsequently streamed messages continue with correct JSONL
		// ordinals (used by the per-message fork button).
		liveMessageSeq = projected.reduce((n, m) => {
			const seq = "seq" in m ? (m.seq as number | undefined) : undefined;
			return seq !== undefined ? Math.max(n, seq) : n;
		}, 0);
		// Only nuke + rebuild the DOM if something actually changed.
		// On a background reconnect for the same session this is a no-op,
		// preserving scroll position and avoiding a flicker.
		if (sameSession && sameLength && lastMatches) return;
		renderShell();
		// renderShell rebuilds the entire DOM, including a fresh
		// #stop-btn created hidden. If we're mid-run (server reported
		// isStreaming=true in the ready that preceded this transcript,
		// or we never left a run), re-apply that state so the Stop
		// button is visible after resume. Without this the button we
		// unhid in onReady is destroyed and replaced by a hidden one —
		// the "Stop button missing after refresh/resume" bug.
		setStreaming(state.isStreaming);
	});
	// After resumeSession/newSession completes, the server reports
	// the new session's metadata. We adopt it (model/thinking) but
	// don't touch the message cache — that's already populated by
	// the transcript message for resume, or is empty for new.
	// Send the init handshake as soon as the WS opens. The server is
	// waiting for this before it spawns the `pi` child. If we have
	// no model picked yet, default to GLM-5.2 (if available in
	// the model list) or the first available model otherwise.
	const defaultModel =
		state.availableModels.find((m) => m.id === "glm-5.2") ?? state.availableModels[0];
	// Send the init handshake every time the WS (re)opens. On mobile
	// browsers (especially Android Firefox), backgrounding the tab kills
	// the WebSocket — the OS suspends JS, the TCP connection times out,
	// and when the user returns the WS auto-reconnects. Without this
	// handler firing on every "open", the reconnected WS never sends
	// `init`, the server sits waiting for it, and the user's next message
	// hits "prompt sent before init".
	const onWsOpen = (s: "connecting" | "open" | "closed" | "stalled") => {
		if (s !== "open") return;
		const modelId = state.currentModelId ?? defaultModel?.id ?? "glm-5.2";
		const provider = state.currentProvider ?? defaultModel?.provider ?? "zai";
		const thinkingLevel = state.currentThinking;
		// On reconnect (after a dropped/stalled connection), pass the
		// current session id so the server spawns `pi --session <id>`
		// and resumes the prior conversation — instead of starting a
		// fresh session with no context. On the very first connect,
		// state.sessionId is null, so this is omitted and a new session
		// is created as expected.
		chatClient.init({
			provider,
			modelId,
			thinkingLevel,
			...(state.sessionId ? { sessionId: state.sessionId } : {}),
		});
	};
	chatClient.onStatus(onWsOpen);

	// Wire the prompt-send hook used by `sendAsUser` (defined above
	// at module scope, so the `setSendAsUser` dep injection in
	// slashes.ts works before/after boot completes). The hook is a
	// no-op until this runs, which is fine — the only way to call
	// `sendAsUser` is via a user gesture (button/keypress) which
	// can only fire after `renderShell` has wired the handlers.
	sendPromptHook = (text, images) => {
		chatClient.prompt(text, images);
	};
	steerHook = (text, images) => {
		chatClient.steer(text, images);
	};
	extensionUiResponder = (id, response) => chatClient.extensionUiResponse(id, response);
	// Wire the render→main/render→voice callbacks through the services
	// registry (a leaf module) so render.ts doesn't have to dynamic-import
	// this file or voice.ts — breaking the render↔{main,voice} cycle.
	setServices({
		forkFromMessage: (count) => {
			if (state.sessionId) chatClient.forkSession(state.sessionId, count);
		},
		sendSlashCommand: (text) => sendPromptHook(text),
		toggleSpeak,
	});
	// When a fork completes server-side, switch this view to the new
	// session. resumeSession kills the current `pi` child and spawns a
	// fresh one bound to the forked JSONL, which replays as the prior
	// transcript — so the chat seamlessly continues from the fork point.
	chatClient.onForked((newSessionId) => {
		chatClient.resumeSession(newSessionId);
	});
}

boot();
