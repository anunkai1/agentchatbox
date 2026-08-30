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
import type { ProjectSummary, PromptImage, SessionSummary } from "../shared/protocol.js";
import { THINKING_LEVELS } from "../shared/thinking.js";
import { getHealth, getModels, type ModelInfo, sessionExists } from "./api.js";
import {
	noteAssistantMessageEnd,
	noteContextMessage,
	reconcileContextUsage,
	resetContextEstimate,
	seedPostCompactionEstimate,
} from "./context-estimate.js";
import type { LiveAssistantDom } from "./dom.js";
import { $ } from "./dom.js";
import { type ExtensionUiResponder, handleExtensionUiRequest } from "./extension-ui.js";
import { setRichText } from "./linkify.js";
import { applySessionPrefs } from "./prefs.js";
import { projectTranscript } from "./project.js";
import {
	appendAssistantPlaceholder,
	appendCompactionChip,
	appendError,
	appendToolCall,
	autoSize,
	clearAttachmentPreviews,
	finalizeToolCall,
	hideToast,
	isAtBottom,
	jumpToPrevUserMessage,
	lastAssistantVoiceBox,
	refreshSidebarSearchVisibility,
	refreshStatus,
	refreshWelcomeSuggestions,
	registerShellHandlers,
	renderMessageNode,
	renderShell,
	renderSidebarProjects,
	renderSidebarSessions,
	resetJumpNav,
	type ShellHandlers,
	scrollToBottom,
	setStreaming,
	showToast,
	syncSteerBadges,
	updateJumpFabState,
	updateJumpToBottomFabState,
	updateVoiceTextBox,
} from "./render.js";
import { services, setServices } from "./services.js";
import {
	closeSlashMenu,
	handleSlash,
	handleSlashMenuKeydown,
	isKnownSlash,
	openModelPicker,
	openOverflowMenu,
	openSpeedPicker,
	openThinkPicker,
	openVoicePicker,
	renderSessionsIntoPicker,
	resetChatState,
	setChatControls,
	showSlashMenu,
} from "./slashes.js";
import {
	defaultModelForNewChats,
	type PersistedMessage,
	refreshCurrentModelLabel,
	state,
} from "./state.js";
import { readSessionIdFromUrl, shareableSessionUrl, writeSessionIdToUrl } from "./url.js";
import {
	handleDrop,
	handleFileAttach,
	handlePaste,
	handleVoiceRecord,
	isUploadInProgress,
	pauseVoice,
	resumeVoice,
	speakText,
	stopAllVoice,
	toggleSpeak,
} from "./voice.js";
import { createChatClient } from "./ws.js";

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
	persistDraft(input.value);
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
	persistDraft($<HTMLTextAreaElement>("#input").value);
	autoSize();
}

// ---------------------------------------------------------------------------
// Composer drafts and inline actions
// ---------------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the legacy textarea path for LAN/http contexts.
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}

const DRAFT_STORAGE_PREFIX = "acb-draft-v1:";

function draftStorageKey(sessionId = state.sessionId): string {
	return `${DRAFT_STORAGE_PREFIX}${sessionId ?? "new"}`;
}

function persistDraft(text: string): void {
	try {
		const key = draftStorageKey();
		if (text) localStorage.setItem(key, text);
		else localStorage.removeItem(key);
	} catch {
		// Draft persistence is best-effort; the live composer remains usable
		// when storage is disabled or full.
	}
}

function clearSavedDraft(): void {
	try {
		localStorage.removeItem(draftStorageKey());
	} catch {
		/* ignore storage failures */
	}
}

function restoreSavedDraft(): void {
	const input = $<HTMLTextAreaElement>("#input");
	if (input.value) return;
	try {
		let text = localStorage.getItem(draftStorageKey());
		// Text typed before the first session id arrived is saved under "new".
		// Migrate it to the real session when the server handshake completes.
		if (!text && state.sessionId) {
			text = localStorage.getItem(draftStorageKey(null));
			if (text) {
				localStorage.setItem(draftStorageKey(), text);
				localStorage.removeItem(draftStorageKey(null));
			}
		}
		if (text) {
			input.value = text;
			autoSize();
		}
	} catch {
		/* ignore storage failures */
	}
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

function clearComposerDraft(): void {
	$<HTMLTextAreaElement>("#input").value = "";
	clearAttachmentPreviews();
	clearSavedDraft();
	autoSize();
}

function handleSend(): void {
	closeSlashMenu();
	if (isUploadInProgress()) {
		showToast("Upload in progress — wait for it to finish before sending.");
		return;
	}
	const input = $<HTMLTextAreaElement>("#input");
	const trimmed = input.value.trim();
	// An image is now represented by its attachment preview, not Markdown in
	// the textarea, so an image-only prompt is valid too.
	if (!trimmed && state.uploadedImages.size === 0) return;

	// Known slash commands consume the composer immediately. Normal prompts
	// stay in the input until the WebSocket accepts them, so a disconnected
	// or not-yet-ready session never loses the user's draft.
	if (trimmed.startsWith("/") && isKnownSlash(trimmed)) {
		clearComposerDraft();
		handleSlash(trimmed.replace(/^\//, ""));
		state.uploadedImages.clear();
		return;
	}

	// While the agent is streaming, a typed message is a steering comment:
	// queued and delivered after the current turn's tool calls finish.
	const accepted = state.isStreaming ? sendSteer(trimmed) : sendAsUser(trimmed);
	if (accepted) clearComposerDraft();
}

/**
 * Send a typed message as the user. Agent workflow commands are owned by pi
 * extensions and arrive through the normal RPC event stream instead.
 */
function sendAsUser(trimmed: string): boolean {
	const images = collectUploadedImages();
	if (!trimmed && images.length === 0) return false;
	const messageText = withImageAttachmentMarkdown(trimmed);
	if (!sendPromptHook(messageText, images.length > 0 ? images : undefined)) {
		showToast("Not connected — your draft was kept.", "warning");
		return false;
	}
	// Only clear the attachment references after the WebSocket accepted the
	// prompt. If the connection is unavailable, the draft and attachments
	// remain resubmittable.
	state.uploadedImages.clear();

	// Push typed text to history only after acceptance; attachment Markdown
	// is transport/display metadata and should not reappear in the composer.
	if (trimmed && state.history[state.history.length - 1] !== trimmed) state.history.push(trimmed);
	state.historyIdx = null;

	// Add user message to in-memory transcript. ts is stamped locally
	// at send time (ms-accurate enough for a relative "2m" label); the
	// authoritative SDK timestamp lands on resume via projectTranscript.
	const userMsg = { kind: "user" as const, text: messageText, ts: Date.now() };
	state.messages.push(userMsg);
	// New message resets the jump walk: the next Alt+↑ / button press
	// should start fresh from this newest position, not resume a stale
	// index from before the send.
	resetJumpNav();
	appendNode(renderMessageNode(userMsg));

	// Auto-title from the first user message.
	if (state.title === "New chat" || !state.title) {
		state.title = trimmed.split(/[.\n!?]/)[0].slice(0, 50) || "Photo";
		$<HTMLSpanElement>("#title").textContent = state.title;
	}
	return true;
}

/**
 * Wires `sendAsUser` to the boot-local chat client. It remains a module-level
 * hook because composer handlers are registered before the WebSocket client
 * finishes booting.
 */
type SendPromptHook = (text: string, images?: PromptImage[]) => boolean;
let sendPromptHook: SendPromptHook = () => false;
/** Closure over `chatClient.steer`, wired in boot(). */
let steerHook: SendPromptHook = () => false;
/** Closure over `chatClient.getSessionStats`, wired in boot(). onEvent is
 *  module-scoped but `chatClient` is a boot()-local const, so the event
 *  handlers reach it through this hook (same pattern as steerHook). */
let getSessionStatsHook: () => void = () => {
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
 * Collect a small upload reference for every image attached to the composer.
 * The server resolves each reference from its private upload store, avoiding
 * duplicate base64 in the browser socket and keeping upload URLs out of the
 * visible draft.
 */
function collectUploadedImages(): PromptImage[] {
	return Array.from(state.uploadedImages.keys(), (url) => ({ url }));
}

/** Preserve the familiar image in the sent user bubble and a durable filename
 * label in pi's transcript without exposing the URL in the textarea itself. */
function withImageAttachmentMarkdown(text: string): string {
	const attachments = Array.from(
		state.uploadedImages,
		([url, image]) => `![image: ${image.filename}](${url})`,
	);
	return [...attachments, text].filter(Boolean).join("\n");
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
	// Reflect whether we're still pinned at the bottom after the new
	// row landed, so the jump-to-bottom button hides / shows correctly.
	updateJumpToBottomFabState();
}

/**
 * Queue a steering message while the agent is running. Rendered as a
 * user-style bubble with a "queued" badge; the badge flips to
 * "delivered" once `queue_update` reports the agent has consumed it.
 * Steering text is NOT pushed into `state.history` — it's an inline
 * course-correction, not a standalone prompt you'd recall with ↑/↓.
 */
function sendSteer(trimmed: string): boolean {
	const images = collectUploadedImages();
	if (!trimmed && images.length === 0) return false;
	const messageText = withImageAttachmentMarkdown(trimmed);
	if (!steerHook(messageText, images.length > 0 ? images : undefined)) {
		showToast("Not connected — your draft was kept.", "warning");
		return false;
	}
	state.uploadedImages.clear();
	const msg: PersistedMessage = { kind: "steer", text: messageText, delivered: false };
	state.messages.push(msg);
	appendNode(renderMessageNode(msg), { pin: true });
	state.pendingSteerCount += 1;
	refreshStatus();
	return true;
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

/**
 * Streaming-token render coalescer.
 *
 * `message_update` fires for every token the model streams (often tens
 * per second). The markdown render it triggers — marked.parse +
 * DOMPurify.sanitize + a full innerHTML rebuild of the WHOLE growing
 * message — is O(n²) over message length: a long reply re-parses the
 * entire text on every token, burning main-thread time and janking the
 * UI.
 *
 * Coalesce the expensive DOM repaint to one pass per animation frame.
 * The text still accumulates on the model object (`lastAssistant.text`)
 * on every token, so the data is always current; only the paint is
 * batched. A final flush at message_end (see flushStreamDom) guarantees
 * the last tokens render before the row finalizes — message_end does
 * not otherwise re-render the text.
 */
let pendingStreamDom: { dom: LiveAssistantDom; text: string; thinking: string } | null = null;
let streamRafId: number | null = null;
let streamThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let lastStreamPaintAt = 0;
const STREAM_PAINT_INTERVAL_MS = 75; // ~13 updates/sec; final output still flushes immediately

function paintStreamDom(p: { dom: LiveAssistantDom; text: string; thinking: string }): void {
	lastStreamPaintAt = performance.now();
	// Capture pinning BEFORE the DOM mutation. The new tokens grow the
	// message — and thinking blocks grow fast: reasoning streams in
	// rapidly, and the very first thinking paint removes `hidden-thinking`
	// (`display: none`), adding the whole thinking container in one
	// frame. An after-mutation isAtBottom() check would then falsely
	// report "not at bottom" and silently kill autoscroll for the rest
	// of the turn (every later scrollToBottomIfPinned() would no-op).
	// Same capture-before/scroll-after pattern as appendNode and
	// finalizeToolCall in render.ts.
	const wasPinned = isAtBottom();
	setRichText(p.dom.textPre, p.text || " ");
	if (p.thinking) {
		p.dom.thinkingPre.textContent = p.thinking;
		p.dom.thinkingWrap.classList.remove("hidden-thinking");
	}
	if (wasPinned) scrollToBottom();
}

/** Schedule a streaming-token repaint, coalescing bursts and limiting the
 * expensive full Markdown parse/sanitize pass to roughly 13 times/sec. */
function scheduleStreamDom(dom: LiveAssistantDom, text: string, thinking: string): void {
	pendingStreamDom = { dom, text, thinking };
	if (streamRafId !== null || streamThrottleTimer !== null) return;
	const wait = Math.max(0, STREAM_PAINT_INTERVAL_MS - (performance.now() - lastStreamPaintAt));
	if (wait > 0) {
		streamThrottleTimer = setTimeout(() => {
			streamThrottleTimer = null;
			if (streamRafId !== null) return;
			streamRafId = requestAnimationFrame(() => {
				streamRafId = null;
				const p = pendingStreamDom;
				pendingStreamDom = null;
				if (p) paintStreamDom(p);
			});
		}, wait);
		return;
	}
	streamRafId = requestAnimationFrame(() => {
		streamRafId = null;
		const p = pendingStreamDom;
		pendingStreamDom = null;
		if (p) paintStreamDom(p);
	});
}

/** Flush any pending repaint synchronously. Called at message_end so the
 *  final tokens (which may have arrived after the last frame fired) are
 *  painted before the row is finalized or removed. */
function flushStreamDom(): void {
	if (streamThrottleTimer !== null) {
		clearTimeout(streamThrottleTimer);
		streamThrottleTimer = null;
	}
	if (streamRafId !== null) {
		cancelAnimationFrame(streamRafId);
		streamRafId = null;
	}
	const p = pendingStreamDom;
	pendingStreamDom = null;
	if (p) paintStreamDom(p);
}

/** Start measuring output throughput at the first visible model delta. */
function startTokenSpeed(): void {
	state.streamingTokenSpeed = {
		startedAt: null,
		estimatedCharacters: 0,
		reportedOutputTokens: null,
		finalTokensPerSecond: null,
		active: true,
	};
}

/** Record a text/thinking delta. Providers that expose incremental usage give
 * us an exact token numerator; otherwise the status bar deliberately labels
 * its character-based live value as an estimate. */
function recordTokenSpeed(delta: unknown, message: AssistantMessage): void {
	if (typeof delta !== "string" || delta.length === 0) return;
	const speed = state.streamingTokenSpeed;
	if (!speed) return;
	if (speed.startedAt === null) speed.startedAt = Date.now();
	speed.estimatedCharacters += delta.length;
	const output = message.usage?.output;
	if (typeof output === "number" && Number.isFinite(output) && output > 0) {
		speed.reportedOutputTokens = output;
	}
}

/** Lock in the completed-message average using final provider usage where it
 * exists. Timing begins at the first streamed delta, so it measures decoding
 * speed rather than time-to-first-token. */
function finishTokenSpeed(message: AssistantMessage): void {
	const speed = state.streamingTokenSpeed;
	if (!speed) return;
	speed.active = false;
	const output = message.usage?.output;
	if (typeof output === "number" && Number.isFinite(output) && output > 0) {
		speed.reportedOutputTokens = output;
	}
	if (speed.startedAt === null) return;
	const tokens = speed.reportedOutputTokens ?? Math.ceil(speed.estimatedCharacters / 4);
	const elapsedSeconds = (Date.now() - speed.startedAt) / 1000;
	if (tokens > 0 && elapsedSeconds > 0) speed.finalTokensPerSecond = tokens / elapsedSeconds;
}

function onEvent(event: Record<string, unknown>): void {
	// The server forwards raw `pi --mode rpc` events, which is a
	// superset of the bare `AgentEvent` union. Cast to a permissive
	// type for property access; the switch ignores unknown types.
	// biome-ignore lint/suspicious/noExplicitAny: pi RPC events are an undocumented superset of AgentEvent; permissive cast is intentional for property access, the switch ignores unknown types.
	const e = event as Record<string, any>;
	switch (e.type) {
		case "agent_start":
			// An overflow compaction can immediately retry the interrupted run.
			// The new agent run is the authoritative end of the cleanup state.
			state.compaction = null;
			state.streamingTokenSpeed = null;
			setStreaming(true);
			state.streamingStartedAt = Date.now();
			refreshStatus();
			break;

		case "agent_end":
			// Flush any final pending repaint before tearing down streaming UI.
			flushStreamDom();
			// Pi may move straight from this low-level run into compaction. Keep
			// the Stop control and elapsed working state alive if that event has
			// already arrived, rather than briefly presenting the chat as idle.
			if (!state.compaction) {
				setStreaming(false);
				state.streamingStartedAt = null;
			}
			state.retry = null;
			// Safety net: if a Long/Short button was pressed to generate a
			// voice reply but pi finished without emitting one (error or
			// unsupported turn), reset the pending button so its spinner
			// doesn't spin forever. toggleSpeak clears pendingVoiceBtn when
			// it fires, so a non-null value here means generation failed.
			if (state.pendingVoiceBtn) {
				const b = state.pendingVoiceBtn;
				const fallbackVoiceIcon =
					state.pendingVoiceVariant === "medium"
						? "📝"
						: state.pendingVoiceVariant === "short"
							? "💬"
							: "🗣️";
				b.classList.remove("is-loading");
				b.textContent = b.dataset.idleLabel ?? fallbackVoiceIcon;
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
			// The run just finished — refresh the context-window fill meter
			// so the user can see how close they are to needing a /compact.
			// Fired once per complete run (not per intermediate message_end),
			// which is the cadence that actually matters and avoids a request
			// storm in a tool-heavy multi-turn run.
			getSessionStatsHook();
			break;

		case "turn_start":
			// Flush any repaint still pending from the prior turn before we
			// drop the live-assistant references — otherwise the pending
			// rAF would later paint into a detached/old node.
			flushStreamDom();
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
				// New assistant message — create a fresh block and start its
				// output-speed meter when its first text/thinking delta arrives.
				startTokenSpeed();
				lastAssistant = {
					kind: "assistant",
					text: "",
					thinking: "",
					seq: liveMessageSeq,
					ts: e.message.timestamp,
				};
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
				// Its content grows the context, so count it (pi's estimator does too).
				noteContextMessage(e.message);
				refreshStatus();
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
				} else if (e.message.customType === "note") {
					// Extension-emitted display note (e.g. /imggen's model-free
					// image result). Pure render — markdown content shown as its
					// own row. No LLM turn is involved (the command emitted this
					// with display:true and no triggerTurn).
					const content =
						typeof (e.message as { content?: unknown }).content === "string"
							? ((e.message as { content?: string }).content ?? "")
							: "";
					const note = {
						kind: "note" as const,
						text: content,
						ts: (e.message as { timestamp?: number }).timestamp,
					};
					state.messages.push(note);
					appendNode(renderMessageNode(note));
				}
			} else if (e.message.role === "user") {
				// User message echoed by the server (we already showed it
				// optimistically at send time). Stamp the matching block now
				// that we know its JSONL ordinal.
				stampLastUserBlock(liveMessageSeq);
				noteContextMessage(e.message);
				refreshStatus();
			} else if (e.message.role === "toolResult") {
				// Tool result from a tool the model called. Render as a tool
				// block in our transcript.
				const tr = e.message as ToolResultMessage;
				// Tick the context-fill estimate: tool results are what grow
				// the context between assistant turns in an agentic run.
				noteContextMessage(tr);
				refreshStatus();
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
			const update = e.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
			if (update?.type === "text_delta" || update?.type === "thinking_delta") {
				recordTokenSpeed(update.delta, m);
			}
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
				// Coalesce the expensive markdown repaint to one per frame
				// (see scheduleStreamDom). The model object above is always
				// current regardless of when the paint lands.
				scheduleStreamDom(lastAssistantDom, text, thinking);
			}
			// Update cost incrementally.
			if (m.usage) {
				state.costTotal.input += m.usage.input;
				state.costTotal.output += m.usage.output;
				state.costTotal.cacheRead += m.usage.cacheRead;
				state.costTotal.cacheWrite += m.usage.cacheWrite;
				state.costTotal.cost += m.usage.cost?.total ?? 0;
			}
			// Don't repaint the status bar for every token. The model, thinking
			// level and context fill are unchanged during a message, while
			// replacing the status DOM on each update needlessly forces Android
			// to reflow the focused composer/status area. The streaming timer is
			// updated by the dedicated one-second tick, and the final usage/cost
			// is refreshed at message_end.
			// Don't yank the user back to the bottom on every token — if they've
			// scrolled up to re-read, leave them there. The actual scroll is
			// performed in paintStreamDom (inside the rAF repaint) using the
			// captured pinning state, because the DOM mutation happens there —
			// scrolling here would be one frame behind the content and let a
			// fast-growing thinking block slip past the isAtBottom() slack,
			// silently disabling autoscroll for the rest of the turn.
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
			// Flush any streaming repaint still pending from the last tokens
			// (message_update coalesces to rAF) so the final text is painted
			// before this case finalizes or removes the row.
			flushStreamDom();
			const m = e.message as AssistantMessage;
			if (m.role === "assistant") finishTokenSpeed(m);
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
			// Tick the context-fill estimate from this message's usage (the
			// refreshStatus() at the end of this case repaints it). pi's
			// ground truth from getSessionStats overwrites it at agent_end.
			if (m.role === "assistant") noteAssistantMessageEnd(m);
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

		case "compaction_start": {
			// Raw pi transport event: compaction is agent-owned, while the
			// browser only makes the otherwise-silent cleanup visibly active.
			const reason =
				e.reason === "manual" || e.reason === "overflow" || e.reason === "threshold"
					? e.reason
					: "threshold";
			state.compaction = { reason, startedAt: Date.now() };
			state.streamingStartedAt = state.compaction.startedAt;
			setStreaming(true);
			break;
		}

		case "compaction_end": {
			const failed = typeof e.errorMessage === "string" ? e.errorMessage : null;
			const result = (e.result ?? null) as {
				tokensBefore?: number;
				estimatedTokensAfter?: number;
			} | null;
			state.compaction = null;
			// The local per-message estimate's base is now pre-compaction —
			// drop it so pi's seed below holds until the next valid assistant
			// usage re-bases it (mirrors pi's own post-compaction distrust).
			resetContextEstimate();
			if (!e.willRetry) {
				setStreaming(false);
				state.streamingStartedAt = null;
			} else {
				refreshStatus();
			}
			if (failed) {
				showToast(failed, "warning");
			} else if (result) {
				// Durable scrollback trace of the compaction (status bar only
				// shows it while running): reason + before→after size.
				appendCompactionChip(
					String(e.reason ?? "threshold"),
					typeof result.tokensBefore === "number" ? result.tokensBefore : null,
					typeof result.estimatedTokensAfter === "number" ? result.estimatedTokensAfter : null,
					e.willRetry === true,
				);
				// Seed the meter from pi's own estimate so the pill doesn't sit
				// at "? tok" until the next reply settles exact usage.
				const est = result.estimatedTokensAfter;
				if (typeof est === "number") {
					const seeded = seedPostCompactionEstimate(est, state.contextUsage?.contextWindow);
					if (seeded) {
						state.contextUsage = seeded;
						refreshStatus();
					}
				}
			}
			// A completed compaction invalidates pi's last usage snapshot. Ask
			// for the fresh post-cleanup meter as soon as it is available.
			getSessionStatsHook();
			break;
		}

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
			if (e.method === "setStatus" && typeof e.statusKey === "string") {
				if (typeof e.statusText === "string") {
					state.extensionStatusLabels[e.statusKey] = e.statusText;
				} else {
					delete state.extensionStatusLabels[e.statusKey];
				}
				refreshStatus();
			} else if (e.method === "notify" && typeof e.message === "string") {
				const notifyType =
					e.notifyType === "error" ? "error" : e.notifyType === "warning" ? "warning" : "info";
				showToast(e.message, notifyType);
				// Capture the image-model label from the pi-venice-image extension's
				// notify so the Settings row reflects the current model. The
				// extension owns the state; this is a display-only mirror.
				// (\S+) = stop at first whitespace, so we capture just the model id
				// even when the notify appends extra context (e.g. pi-local-image's
				// "... — port 8012, GPU switched").
				const imgMatch = e.message.match(/image model set to (\S+)/i);
				if (imgMatch) {
					state.currentImageModelLabel = imgMatch[1];
					refreshStatus();
				} else if (/reset to default/i.test(e.message)) {
					state.currentImageModelLabel = null;
					refreshStatus();
				}
			} else if (extensionUiResponder) {
				handleExtensionUiRequest(
					{
						id: String(e.id),
						method: String(e.method),
						title: e.title as string | undefined,
						options: e.options as string[] | undefined,
						message: e.message as string | undefined,
						placeholder: e.placeholder as string | undefined,
					},
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
			if (
				typeof e.thinkingLevel === "string" &&
				(THINKING_LEVELS as readonly string[]).includes(e.thinkingLevel)
			) {
				state.currentThinking = e.thinkingLevel as typeof state.currentThinking;
			}
			// Clear the pending marker — the server has answered.
			state.pendingModelSet = null;
			refreshStatus();
			// Different models have different context windows — re-fetch the
			// context usage so the percent (and the meter) reflects the NEW
			// model's limit rather than the old one's. Without this, switching
			// e.g. from a 1M-token model to a 256k one would leave the meter
			// showing a stale, far-too-low fill.
			getSessionStatsHook();
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * A display-only snapshot makes a hard refresh paint the sidebar immediately.
 * The server remains authoritative and refreshes this in the background; no
 * transcript or editable state is kept in the browser.
 */
const SIDEBAR_CACHE_KEY = "acb-sidebar-summaries-v1";
type SidebarCache = { sessions: SessionSummary[]; projects: ProjectSummary[] };
let sidebarSessionsForCache: SessionSummary[] = [];
/** True once either localStorage or the server has supplied a real sidebar
 * snapshot. This distinguishes an authoritative empty list from the initial
 * "nothing has loaded yet" state when a transcript rebuilds the shell. */
let hasSidebarSessionSnapshot = false;

/** Keep the header title aligned with the server-owned session summary.
 * Resumed/direct-link sessions do not pass through the optimistic first-send
 * title path, so without this they remain labelled "New chat" forever. */
function syncCurrentSessionTitle(sessions: SessionSummary[]): void {
	if (!state.sessionId) return;
	const current = sessions.find((session) => session.id === state.sessionId);
	if (!current) return;
	state.title = current.title.trim() || "New chat";
	state.sessionCwd = current.cwd;
	const title = document.querySelector<HTMLSpanElement>("#title");
	if (title) title.textContent = state.title;
}

function readSidebarCache(): SidebarCache | null {
	try {
		const value = JSON.parse(
			localStorage.getItem(SIDEBAR_CACHE_KEY) ?? "null",
		) as Partial<SidebarCache> | null;
		if (!value || !Array.isArray(value.sessions) || !Array.isArray(value.projects)) return null;
		if (
			!value.sessions.every(
				(s) =>
					typeof s?.id === "string" &&
					typeof s.cwd === "string" &&
					typeof s.createdAt === "string" &&
					typeof s.modifiedAt === "string" &&
					typeof s.title === "string" &&
					typeof s.messageCount === "number",
			) ||
			!value.projects.every(
				(p) =>
					typeof p?.id === "string" &&
					typeof p.name === "string" &&
					typeof p.icon === "string" &&
					typeof p.cwd === "string",
			)
		) {
			return null;
		}
		return { sessions: value.sessions, projects: value.projects };
	} catch {
		return null;
	}
}

function saveSidebarCache(): void {
	if (state.projects.length === 0) return;
	try {
		localStorage.setItem(
			SIDEBAR_CACHE_KEY,
			JSON.stringify({ sessions: sidebarSessionsForCache, projects: state.projects }),
		);
	} catch {
		// Storage can be disabled/full; the live server response still renders.
	}
}

async function boot(): Promise<void> {
	const cachedSidebar = readSidebarCache();
	// These display-only requests must never delay the chat handshake. On a
	// cold server /api/models may be waiting for its one-shot pi probe, while
	// the actual session child can already be starting in parallel.
	const metadataPromise = Promise.all([getHealth(), getModels()]);

	// A cached Global project tells us the model a brand-new tab will use.
	// Paint it immediately rather than showing "(no model)" until pi's
	// get_state reply arrives. The server remains authoritative and corrects
	// this provisional value in the first ready frame.
	if (cachedSidebar) state.projects = cachedSidebar.projects;
	const cachedDefault = defaultModelForNewChats();
	if (cachedDefault) {
		state.currentModelId = cachedDefault.id;
		state.currentProvider = cachedDefault.provider;
		if (cachedDefault.thinking) state.currentThinking = cachedDefault.thinking;
	} else {
		// This is the same new-chat fallback sent in the init handshake below.
		state.currentModelId = "glm-5.2";
		state.currentProvider = "zai";
	}
	refreshCurrentModelLabel();

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
		persistDraft,
		historyBack,
		historyForward,
		showSlashMenu,
		handleSlashMenuKeydown,
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
		reconnect: () => chatClient.reconnect(),
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
		deleteSession: (sessionId) => {
			// Tell the server to unlink the JSONL. If the deleted session is
			// the one we're currently viewing, swap to a brand-new chat so
			// the message area doesn't linger on a now-deleted conversation
			// and so the live pi child doesn't re-create the file by writing
			// its next event. The server's broadcastSessions refresh will
			// drop the row from every sidebar.
			const wasActive = sessionId === state.sessionId;
			chatClient.deleteSession(sessionId);
			if (wasActive) {
				resetChatState();
				chatClient.newSession();
			}
		},
		newGlobalSession: () => {
			resetChatState();
			chatClient.newSession();
		},
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

	renderShell();
	// Paint the previous display-only sidebar snapshot before pi finishes
	// starting. The authoritative WS response below replaces it shortly after.
	if (cachedSidebar) {
		sidebarSessionsForCache = cachedSidebar.sessions;
		hasSidebarSessionSnapshot = true;
		syncCurrentSessionTitle(cachedSidebar.sessions);
		renderSidebarSessions(cachedSidebar.sessions);
	}

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
		compact: (customInstructions) => chatClient.compact(customInstructions),
		newSession: (projectId) => chatClient.newSession(projectId),
		resumeSession: (id) => chatClient.resumeSession(id),
		listSessions: () => chatClient.listSessions(),
		renameSession: (name) => chatClient.renameSession(name),
		updateProject: (input) => chatClient.updateProject(input),
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
			// A cached/server sidebar snapshot can name a resumed session before
			// its transcript arrives. Fresh sessions simply have no match yet.
			syncCurrentSessionTitle(sidebarSessionsForCache);
			// Mirror the session into the URL so the chat is a bookmarkable,
			// shareable link. Covers new sessions, resumes, and reconnects
			// — every `ready` reflects the currently bound session.
			writeSessionIdToUrl(info.sessionId);
		}
		restoreSavedDraft();
		// Adopt pi's authoritative model unless the user picked another model
		// while this child was still starting. In that race, the first ready
		// frame describes the original spawn model; keep the optimistic pick
		// and its pending marker until the later modelState frame confirms or
		// rejects the set_model request. This is the targeted rollback of the
		// old `awaitingInitialReady` behaviour, which snapped quick picks back
		// to the default model.
		const hasPendingPick = state.pendingModelSet !== null;
		const readyConfirmsPending = state.pendingModelSet === info.modelId;
		if (!hasPendingPick || readyConfirmsPending) {
			state.currentModelId = info.modelId;
			state.currentProvider = info.provider;
			refreshCurrentModelLabel();
			if (readyConfirmsPending) state.pendingModelSet = null;
		}
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
		// Session/project metadata was requested as soon as this WebSocket
		// opened. Do not request the full list again here: with 1,000+ sessions
		// that duplicated roughly 260 KiB of uncompressed WS traffic plus a
		// complete cache write/sidebar repaint on every load. A brand-new empty
		// pi session is intentionally absent until its first persisted message;
		// the normal session-info broadcast then adds it authoritatively.
		// Refresh the loaded-commands badge for this session's project. A
		// different project loads a different extension set, so every ready
		// (new session, resume, fork, reconnect) re-asks pi — the server
		// just forwards to pi, this is where the browser decides it wants
		// the data for display.
		chatClient.getCapabilities();
		// Fetch the context-window fill so the meter reflects where this
		// session stands on resume/reconnect (a long resumed chat may already
		// be near its limit). Different models have different windows, so
		// we re-fetch on every model change too (see modelState below).
		// Drop the local per-message estimate first: it belongs to whatever
		// context this page was showing before, and the stats that arrive
		// hold the meter until the next valid assistant usage re-bases it.
		resetContextEstimate();
		chatClient.getSessionStats();
	});
	chatClient.onEvent(onEvent);
	chatClient.onError((msg) => appendError(msg));
	// /sessions picker: when the server replies with the list, fill the
	// open modal. The listener is a no-op if no picker is open.
	// Also refresh the sidebar session list.
	chatClient.onSessionsUpdated((sessions) => {
		sidebarSessionsForCache = sessions;
		hasSidebarSessionSnapshot = true;
		syncCurrentSessionTitle(sessions);
		saveSidebarCache();
		renderSessionsIntoPicker(sessions);
		// Derive which project the currently-viewed session belongs to, so
		// the sidebar can highlight its folder.
		const current = sessions.find((s) => s.id === state.sessionId);
		if (current?.projectId) state.activeProjectId = current.projectId;
		renderSidebarSessions(sessions);
	});
	chatClient.onProjectsUpdated((projects) => {
		state.projects = projects;
		saveSidebarCache();
		renderSidebarProjects(projects);
	});
	// Loaded commands/skills/extensions for the live session, from pi's
	// get_commands RPC (pushed by the server after every ready). This is
	// per-project accurate — switching projects re-fires ready, which
	// re-fetches capabilities — so the header badge always matches what
	// pi actually has loaded for the current chat.
	chatClient.onCapabilities((commands) => {
		state.capabilities = commands;
		refreshWelcomeSuggestions();
		refreshStatus();
		// Status values stay extension-owned. Ask the Fast extension to publish
		// its current display label through the generic setStatus relay.
		if (commands.some((command) => command.name === "fast" && command.source !== "skill")) {
			services.sendSlashCommand?.("/fast report");
		}
		if (commands.some((command) => command.name === "localai" && command.source !== "skill")) {
			services.sendSlashCommand?.("/localai report");
		}
	});
	// Context-window fill from pi's get_session_stats RPC. Updates the
	// thin meter above the status bar. Fired after each run (agent_end),
	// on resume (ready), and after a model switch (modelState — the
	// context window size can change with the model, so the percent would
	// otherwise be stale).
	chatClient.onSessionStats((stats) => {
		// Pi deliberately reports an unknown count immediately after compaction.
		// Preserve the compaction result estimate through that one expected gap;
		// the first numeric snapshot replaces it.
		state.contextUsage = reconcileContextUsage(stats.contextUsage);
		// Proactive nudge (B): the meter alone is easy to miss in a long
		// session, and the failure mode — output truncation, agent idling
		// at 98%+ context — is exactly the kind of thing to warn about
		// BEFORE it happens. Warn once per fill-up; the flag resets when
		// the meter drops back under 70% (compaction's job), so each new
		// fill of the window earns at most one nudge.
		const pct = state.contextUsage?.percent;
		if (typeof pct === "number") {
			if (pct >= 85 && !state.contextWarned) {
				state.contextWarned = true;
				showToast(
					`Context is ${pct}% full (${state.contextUsage?.tokens?.toLocaleString() ?? "?"} tok). /compact will summarize older turns before you run out.`,
					"warning",
				);
			} else if (pct < 70) {
				state.contextWarned = false;
			}
		}
		// Seed cumulative token + cost totals from pi's ground truth so a
		// fresh page load shows the session's REAL running totals instead
		// of resetting to 0. The client still accumulates live from
		// message_end during the session, but those deltas only capture
		// events seen since this page opened; seeding from the server makes
		// the numbers survive a refresh. We always adopt the server's value
		// (not max) because getSessionStats fires at turn boundaries and
		// reflects the complete session — there's no live-delta drift to
		// clobber.
		if (stats.tokens) {
			state.costTotal.input = stats.tokens.input;
			state.costTotal.output = stats.tokens.output;
			state.costTotal.cacheRead = stats.tokens.cacheRead;
			state.costTotal.cacheWrite = stats.tokens.cacheWrite;
		}
		if (typeof stats.cost === "number") state.costTotal.cost = stats.cost;
		refreshStatus();
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
		syncCurrentSessionTitle(sidebarSessionsForCache);
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
		// The transcript renderer currently rebuilds the shell. Restore the
		// authoritative sidebar snapshot immediately afterward; otherwise a
		// fast listSessions response rendered before this transcript is wiped
		// back to "Loading sessions…" with no later event to repaint it.
		// A search query cannot survive a shell rebuild, so clear its matching
		// state too or renderSidebarSessions would intentionally no-op.
		state.searchActive = false;
		renderShell();
		if (hasSidebarSessionSnapshot) renderSidebarSessions(sidebarSessionsForCache);
		// onReady restores the session draft before the transcript event, and
		// renderShell replaces that textarea. Restore it once more into the new
		// shell so resuming a chat does not silently discard its saved draft.
		restoreSavedDraft();
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
	const defaultModel = defaultModelForNewChats() ??
		state.availableModels.find((m) => m.id === "glm-5.2") ??
		state.availableModels[0] ?? { id: "glm-5.2", provider: "zai" };
	// Send the init handshake every time the WS (re)opens. On mobile
	// browsers (especially Android Firefox), backgrounding the tab kills
	// the WebSocket — the OS suspends JS, the TCP connection times out,
	// and when the user returns the WS auto-reconnects. Without this
	// handler firing on every "open", the reconnected WS never sends
	// `init`, the server sits waiting for it, and the user's next message
	// hits "prompt sent before init".
	const onWsOpen = (s: "connecting" | "open" | "closed" | "stalled") => {
		if (s !== "open") return;
		const modelId = state.currentModelId ?? defaultModel.id;
		const provider = state.currentProvider ?? defaultModel.provider;
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
		// These are server-side filesystem reads, independent of pi's ready
		// response. Starting them now overlaps the cold session scan with pi
		// startup instead of making the sidebar wait for it serially.
		chatClient.listSessions();
		chatClient.listProjects();
	};
	chatClient.onStatus(onWsOpen);

	// Wire the prompt-send hook used by composer submissions. The hook is a
	// no-op until this runs; user gestures can only reach it after renderShell
	// has installed the handlers.
	sendPromptHook = (text, images) => chatClient.prompt(text, images);
	steerHook = (text, images) => chatClient.steer(text, images);
	getSessionStatsHook = () => chatClient.getSessionStats();
	extensionUiResponder = (id, response) => chatClient.extensionUiResponse(id, response);
	// Wire the render→main/render→voice callbacks through the services
	// registry (a leaf module) so render.ts doesn't have to dynamic-import
	// this file or voice.ts — breaking the render↔{main,voice} cycle.
	setServices({
		forkFromMessage: (count) => {
			if (state.sessionId) chatClient.forkSession(state.sessionId, count);
		},
		sendSlashCommand: (text) => {
			sendPromptHook(text);
		},
		sendPrompt: (text) => sendAsUser(text),
		copyText,
		copyShareLink: () => {
			const link = shareableSessionUrl(state.sessionId);
			if (!link) {
				showToast("No session link yet — send a message first.", "warning");
				return;
			}
			void copyText(link).then((ok) => {
				showToast(ok ? "Chat link copied." : "Clipboard access denied.", ok ? "info" : "error");
			});
		},
		toggleSpeak,
	});
	// When a fork completes server-side, switch this view to the new
	// session. resumeSession kills the current `pi` child and spawns a
	// fresh one bound to the forked JSONL, which replays as the prior
	// transcript — so the chat seamlessly continues from the fork point.
	chatClient.onForked((newSessionId) => {
		chatClient.resumeSession(newSessionId);
	});

	// Fill the non-essential metadata once it arrives. This runs after the
	// WebSocket has been opened, so a slow model-cache probe cannot hold up a
	// new tab or leave it looking disconnected.
	void metadataPromise
		.then(([h, models]) => {
			state.searchEnabled = h.search ?? false;
			refreshSidebarSearchVisibility();
			state.ttsEngine = h.ttsEngine ?? null;
			state.ttsDefaultVoice = h.ttsVoice ?? null;
			state.voiceRewriteModel = h.voiceRewriteModel ?? null;
			state.whisperModel = h.whisperModel ?? null;
			state.imageModel = h.imageModel ?? null;
			// Seed the Settings-row label from the server-known model (override/env),
			// so it shows the actual model on load instead of "default". The notify
			// path below keeps it fresh after in-session picks.
			if (state.imageModel && state.imageModel.source !== "default") {
				state.currentImageModelLabel = state.imageModel.model;
			}
			state.visionModel = h.visionModel ?? null;
			state.geminiKey = h.geminiKey ?? false;
			state.availableModels = models.map((m: ModelInfo) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				reasoning: m.reasoning,
				thinkingLevels: m.thinkingLevels,
			}));
			// Fall back to the legacy single-provider shape if /api/models
			// returns nothing (older server) — we still get *something* in
			// the picker so the user isn't stuck.
			if (state.availableModels.length === 0) {
				state.availableModels = h.providers.map((p) => ({
					id: "MiniMax-M3",
					provider: p,
				}));
			}
			refreshCurrentModelLabel();
			refreshStatus();
		})
		.catch((e) => {
			appendError(`server health check failed: ${e instanceof Error ? e.message : String(e)}`);
		});
}

boot();
