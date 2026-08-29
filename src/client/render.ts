/**
 * Pure rendering: turns `state.messages` into DOM nodes, manages the
 * status bar, and exposes helpers for the live-streaming case. Does
 * not handle any input — that's main.ts.
 *
 * `renderShell` is the one exception: it wires up event handlers for
 * the whole UI. Callers must register their handlers via
 * `registerShellHandlers()` BEFORE calling `renderShell()` (e.g. on
 * module load, or at boot before any UI is shown). The other rendering
 * helpers are pure / side-effect-free aside from the DOM they touch.
 *
 * Cross-module callbacks (speakText) are imported lazily to keep the
 * dep graph acyclic — voice.ts imports from render.ts for `appendError`,
 * not the other way around. main.ts wires the voice-variant buttons by
 * reaching into state.lastAssistant.
 */

import type { PiCommand, ProjectSummary, SessionSummary } from "../shared/protocol.js";
import { type SessionSearchHit, searchSessions } from "./api.js";
import { $, el, escapeHtml, type LiveAssistantDom, mountModal } from "./dom.js";
import { setRichText, setUserRichText } from "./linkify.js";
import { services } from "./services.js";
import { type PersistedMessage, state, voiceRewriteLabel } from "./state.js";
import { formatAbsolute, formatRelative } from "./time.js";
import { sessionPath } from "./url.js";

export function autoSize(): void {
	const ta = $<HTMLTextAreaElement>("#input");
	ta.style.height = "auto";
	ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

export function setStreaming(s: boolean): void {
	state.isStreaming = s;
	// Keep the input enabled while streaming so the user can queue
	// steering messages (mirrors the CLI, where you can type while the
	// agent works). The send button stays visible and switches to
	// "steer" mode; the stop button appears alongside it.
	const sendBtn = $<HTMLButtonElement>("#send-btn");
	sendBtn.hidden = false;
	sendBtn.classList.toggle("steer-mode", s);
	sendBtn.textContent = s ? "⇢" : "↑";
	sendBtn.setAttribute("aria-label", s ? "Queue instruction" : "Send message");
	sendBtn.title = s
		? "Queue instruction — delivered after the current turn (⌘/Ctrl+Enter)"
		: "Send message (⌘/Ctrl+Enter)";
	const stopBtn = $<HTMLButtonElement>("#stop-btn");
	stopBtn.hidden = !s;
	// Context-aware label mirroring the CLI: while a retry backoff is
	// counting down, Stop cancels the retry ("interrupt to cancel"); a
	// compaction is likewise abortable through pi's normal abort path.
	stopBtn.title = state.retry
		? "Cancel retry backoff"
		: state.compaction
			? "Stop context cleanup"
			: "Stop the current run";
	if (!s) state.toolSpinner = null;
	startOrStopWorkingTick(s);
	refreshStatus();
}

/** Update the short, plain-language state line immediately above the composer. */
function refreshComposerState(): void {
	const line = document.getElementById("composer-state");
	if (!line) return;
	line.className = "composer-state";
	line.replaceChildren();
	if (state.isStreaming) {
		// The persistent streaming indicator below the composer already owns
		// the working state. Keep this line quiet, except for a useful
		// navigation control when the user has scrolled up for older output.
		if (isAtBottom()) {
			line.classList.add("hidden");
			return;
		}
		const latest = el(
			"button",
			{ class: "composer-latest-btn", type: "button", title: "Jump to the latest output" },
			"New output ↓",
		) as HTMLButtonElement;
		latest.addEventListener("click", () => {
			scrollToBottom();
			updateJumpToBottomFabState();
		});
		line.append(latest);
		line.classList.add("composer-state-working");
		return;
	}
	if (state.connectionStatus === "closed" || state.connectionStatus === "stalled") {
		line.append(
			el("span", { class: "composer-state-label" }, "Connection lost · your draft will be kept"),
		);
		const reconnect = el(
			"button",
			{ class: "composer-reconnect-btn", type: "button", title: "Reconnect to agentchatbox" },
			"Reconnect",
		) as HTMLButtonElement;
		reconnect.addEventListener("click", () => shellHandlers?.reconnect());
		line.append(reconnect);
		line.classList.add("composer-state-warning");
		return;
	}
	if (state.connectionStatus === "connecting") {
		line.textContent = "Connecting…";
		line.classList.add("composer-state-connecting");
		return;
	}
	line.classList.add("hidden");
}

/**
 * 1s tick while streaming so the status bar's elapsed timer and retry
 * countdown stay live — the CLI updates these on every render frame;
 * the browser only re-renders on events, so without a tick the elapsed
 * counter would freeze between tokens and the retry countdown would
 * never decrement. One interval covers both; stopped when idle.
 */
let workingTick: ReturnType<typeof setInterval> | null = null;
function startOrStopWorkingTick(streaming: boolean): void {
	if (streaming) {
		if (workingTick) return;
		workingTick = setInterval(() => {
			// Decrement the retry countdown (pi sends delayMs once at
			// auto_retry_start; we tick it down locally so the banner
			// counts 8…7…6… like the CLI).
			if (state.retry && state.retry.remainingMs > 0) {
				state.retry = {
					...state.retry,
					remainingMs: Math.max(0, state.retry.remainingMs - 1000),
				};
			}
			// Only the dynamic slot changes per second (elapsed timer + retry
			// countdown); the core and voice slots are untouched, so this is a
			// tiny repaint of a few characters rather than a full bar rebuild.
			paintStatusDynamic();
		}, 1000);
	} else if (workingTick) {
		clearInterval(workingTick);
		workingTick = null;
	}
}

const HISTORY_RENDER_LIMIT = 200;
let renderedHistoryStart = 0;

function loadOlderHistory(): void {
	const list = $("#messages");
	const loadRow = list.querySelector<HTMLElement>(".history-load-older");
	if (!loadRow || renderedHistoryStart === 0) return;
	const previousHeight = getScrollContainer().scrollHeight;
	const previousTop = getScrollContainer().scrollTop;
	const nextStart = Math.max(0, renderedHistoryStart - HISTORY_RENDER_LIMIT);
	const fragment = document.createDocumentFragment();
	for (let i = nextStart; i < renderedHistoryStart; i++) {
		fragment.append(renderMessageNode(state.messages[i]));
	}
	list.insertBefore(fragment, loadRow.nextSibling);
	renderedHistoryStart = nextStart;
	if (nextStart === 0) loadRow.remove();
	else {
		const remaining = nextStart;
		loadRow.querySelector("button")!.textContent = `Load ${remaining} older messages`;
	}
	// Keep the same message anchored under the user's eyes after prepending.
	const scroller = getScrollContainer();
	scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
}

export function renderHistory(): void {
	const list = $("#messages");
	list.innerHTML = "";
	renderedHistoryStart = Math.max(0, state.messages.length - HISTORY_RENDER_LIMIT);
	if (renderedHistoryStart > 0) {
		const loadRow = el("div", { class: "history-load-older" });
		const remaining = renderedHistoryStart;
		const button = el(
			"button",
			{ type: "button", title: "Load older messages" },
			`Load ${remaining} older messages`,
		) as HTMLButtonElement;
		button.addEventListener("click", loadOlderHistory);
		loadRow.append(button);
		list.append(loadRow);
	}
	for (let i = renderedHistoryStart; i < state.messages.length; i++) {
		list.append(renderMessageNode(state.messages[i]));
	}
	updateWelcomeVisibility();
	scrollToBottom();
	// Full re-render (new session / resume): the cached nav index no
	// longer maps to the right row, and the user-message count may have
	// changed — reset the walk and refresh the FAB state.
	currentUserMsgIndex = null;
	updateJumpFabState();
}

/**
 * Show the welcome / empty-state panel when there are no messages, hide it
 * as soon as the first row appears. Called from renderHistory, appendNode,
 * and the send path so the panel never lingers behind a real conversation.
 */
export function updateWelcomeVisibility(): void {
	const w = document.querySelector("#welcome");
	if (w) w.classList.toggle("hidden", state.messages.length > 0);
}

/**
 * Small muted timestamp chip showing BOTH the absolute Brisbane time
 * ("2 July 2026, 4:33pm") and the relative distance ("2m ago") inline,
 * always visible — no hover needed. Appended inside the user bubble
 * (bottom) or under the assistant reply.
 */
function makeTimestampEl(ts: number): HTMLElement {
	const rel = formatRelative(ts);
	const relLabel = rel === "just now" ? rel : `${rel} ago`;
	return el(
		"span",
		{ class: "msg-ts" },
		formatAbsolute(ts),
		el("span", { class: "msg-ts-rel" }, ` · ${relLabel}`),
	);
}

/**
 * Paint one message row.
 */
export function renderMessageNode(m: PersistedMessage): HTMLElement {
	if (m.kind === "user") {
		const row = el("div", { class: "row row-user" });
		const bubble = el("div", { class: "bubble markdown" });
		setUserRichText(bubble, m.text);
		if (m.ts !== undefined) bubble.append(makeTimestampEl(m.ts));
		row.append(bubble);
		const actions = el("div", { class: "message-actions user-message-actions" });
		actions.append(
			makeMessageActionButton("copy", "Copy your message", (button) => {
				if (!services.copyText) return;
				void services.copyText(m.text).then((ok) => {
					button.classList.toggle("is-success", ok);
					showToast(ok ? "Message copied." : "Clipboard access denied.", ok ? "info" : "error");
				});
			}),
		);
		if (m.seq !== undefined) {
			actions.append(
				makeMessageActionButton("fork", "Fork this conversation here", () => {
					services.forkFromMessage?.(m.seq as number);
				}),
			);
		}
		row.append(actions);
		return row;
	}
	if (m.kind === "steer") {
		// Steering message queued while the agent was running. Same
		// right-aligned bubble as a user message, but with a badge so
		// it's clear it's queued (not yet consumed by the agent) vs
		// delivered (folded into the next turn).
		const bubble = el("div", { class: "bubble markdown steer-bubble" });
		setUserRichText(bubble, m.text);
		const queuedPosition = m.delivered
			? 0
			: state.messages
					.filter((candidate) => candidate.kind === "steer" && !candidate.delivered)
					.indexOf(m) + 1;
		bubble.append(
			el(
				"span",
				{ class: `steer-badge${m.delivered ? " delivered" : ""}` },
				m.delivered ? "✓ delivered" : `⏳ queued #${Math.max(queuedPosition, 1)}`,
			),
		);
		return el("div", { class: "row row-user row-steer" }, bubble);
	}
	if (m.kind === "assistant") {
		const wrap = el("div", { class: "row row-assistant" });
		const avatar = el("div", { class: "avatar" });
		avatar.append(el("span", { class: "avatar-icon" }, "✦"));
		wrap.append(avatar);
		const body = el("div", { class: "body" });
		if (m.thinking) {
			const t = el("div", { class: "thinking" });
			// Default: expanded (▾). Click to collapse.
			t.append(el("span", { class: "thinking-toggle" }, "▾ thinking"));
			const pre = el("pre", { class: "thinking-body" }, m.thinking);
			t.append(pre);
			t.addEventListener("click", () => {
				pre.classList.toggle("hidden");
				t.querySelector(".thinking-toggle")!.textContent = pre.classList.contains("hidden")
					? "▸ thinking"
					: "▾ thinking";
			});
			body.append(t);
		}
		const text = el("div", { class: "text markdown" }, " ");
		setRichText(text, m.text || " ");
		body.append(text);
		if (m.ts !== undefined) body.append(makeTimestampEl(m.ts));
		body.append(
			makeVoiceActions(
				() => m.text,
				() => m.voiceLong ?? "",
				() => m.voiceMedium ?? "",
				() => m.voiceShort ?? "",
			),
		);
		// Read-along box for the medium/short spoken variants (long is
		// TTS-only). Populated from state at render time; stays hidden
		// until a variant exists.
		const voiceBox = makeVoiceTextBox();
		updateVoiceTextBox(voiceBox, m);
		body.append(voiceBox);
		body.append(makeAssistantActionBar(() => m));
		wrap.append(body);
		return wrap;
	}
	if (m.kind === "tool") {
		const wrap = el("div", { class: "row row-tool" });
		const card = el("div", { class: "tool-card" });
		const toolPath = toolPathFromArgs(m.args);
		mountToolHead(card, m.name, m.args, toolPath);
		if (m.result !== undefined) {
			appendToolResult(card, m.result, m.isError ?? false);
		} else if (m.interrupted) {
			// A replayed tool call whose session died before a result was
			// written. Nothing is executing it, so don't show the indefinite
			// "running…" spinner — surface it as interrupted instead.
			card.append(el("div", { class: "tool-interrupted" }, "⚠ interrupted (session ended)"));
		} else {
			card.append(el("div", { class: "tool-pending" }, "running…"));
		}
		wrap.append(card);
		return wrap;
	}
	if (m.kind === "note") {
		// Extension-injected display note (e.g. /imggen's model-free image
		// result). Pure markdown render — same pipeline as assistant text,
		// but its own lightweight row (no avatar, no voice buttons). No LLM
		// turn produced this; it's an extension surfacing content directly.
		const row = el("div", { class: "row row-note" });
		const body = el("div", { class: "body" });
		const text = el("div", { class: "text markdown" }, " ");
		setRichText(text, m.text || " ");
		body.append(text);
		if (m.ts !== undefined) body.append(makeTimestampEl(m.ts));
		row.append(body);
		return row;
	}
	// error (voice-reply is attached inline to the assistant row, never
	// rendered as its own node, so it never reaches here — narrow so the
	// remaining union is just the error case with `.text`.)
	if (m.kind !== "error") return el("div", { class: "row" });
	return el("div", { class: "row row-error" }, el("div", { class: "body" }, m.text));
}

/**
 * Sync the queued/delivered badges on rendered steering bubbles to the
 * current `state.messages`. Steering messages flip `delivered` from
 * false → true as the agent consumes them (driven by `queue_update`),
 * and we update the DOM in place rather than re-rendering the whole
 * transcript. Steer bubbles are matched to cache entries in DOM order,
 * which matches `state.messages` order.
 */
export function syncSteerBadges(): void {
	const steered = state.messages.filter((m) => m.kind === "steer");
	const nodes = document.querySelectorAll<HTMLElement>(".row-steer .steer-badge");
	let queuedPosition = 0;
	steered.forEach((m, i) => {
		if (m.kind !== "steer") return;
		const node = nodes[i];
		if (!node) return;
		if (m.delivered) {
			node.textContent = "✓ delivered";
		} else {
			queuedPosition += 1;
			node.textContent = `⏳ queued #${queuedPosition}`;
		}
		node.classList.toggle("delivered", m.delivered);
	});
}

/**
 * Resolve the spoken variant of the LAST assistant message in state.
 * Used by the live-streaming placeholder's Long/Short buttons, which
 * are created before the message object exists; they read the variant
 * lazily at click time so they pick up values the voice-reply handler
 * mutates onto the message after generation. /voice-last always voices
 * the last assistant message, so this matches that semantics.
 */
function lastAssistantVoice(variant: "long" | "medium" | "short"): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m.kind === "assistant") {
			return (
				(variant === "long" ? m.voiceLong : variant === "medium" ? m.voiceMedium : m.voiceShort) ??
				""
			);
		}
	}
	return "";
}

/**
 * Show the spinning indicator on a speak button (generate/synthesize
 * phase). Captures the idle label the first time so it can be restored.
 */
function setBtnLoading(btn: HTMLElement): void {
	if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent ?? "";
	btn.textContent = "";
	btn.append(Object.assign(document.createElement("span"), { className: "speak-spinner" }));
	btn.classList.add("is-loading");
}

/** Structural slice updateVoiceTextBox needs from an assistant message. */
interface VoiceTextSource {
	voiceMedium?: string;
	voiceShort?: string;
}

/**
 * Make an empty, hidden .voice-text read-along box. Populated by
 * updateVoiceTextBox() once a medium/short variant is generated. Long
 * is TTS-only and never appears here.
 */
function makeVoiceTextBox(): HTMLDivElement {
	return el("div", { class: "voice-text hidden" });
}

function makeImmediateVoiceButton(getText: () => string): HTMLButtonElement {
	const button = el("button", {
		class: "speak-btn voice-action immediate-voice",
		type: "button",
		title: "Speak this answer immediately",
	}) as HTMLButtonElement;
	button.append(el("span", { class: "voice-icon", text: "🔊" }));
	button.setAttribute("aria-label", "Speak this answer immediately");
	button.addEventListener("click", () => {
		const text = getText().trim();
		if (text) services.toggleSpeak?.(text, button);
	});
	return button;
}

function makeVoiceActions(
	getImmediateText: () => string,
	getLongText: () => string,
	getMediumText: () => string,
	getShortText: () => string,
): HTMLElement {
	const actions = el("div", {
		class: "voice-actions",
		role: "toolbar",
		"aria-label": "Voice actions",
	});
	actions.append(
		makeImmediateVoiceButton(getImmediateText),
		makeVoiceVariantButton("long", getLongText, "Speak the detailed spoken version"),
		makeVoiceVariantButton("medium", getMediumText, "Speak a summary of the answer"),
		makeVoiceVariantButton("short", getShortText, "Speak a brief summary of the answer"),
	);
	return actions;
}

function makeVoiceTextSection(label: string, text: string): HTMLElement {
	const s = el("div", { class: "voice-text-section" });
	s.append(el("div", { class: "voice-text-label" }, label));
	const body = el("div", { class: "markdown" });
	setRichText(body, text);
	s.append(body);
	return s;
}

/**
 * (Re)populate a read-along .voice-text box from an assistant message's
 * readable spoken variants. Renders medium then short (each with a small
 * label) so pressing MedTTS and ShortTTS in sequence accumulates both.
 * Clears + hides the box when neither variant exists yet. Idempotent —
 * safe to call on every voice-reply arrival.
 */
export function updateVoiceTextBox(box: HTMLElement, m: VoiceTextSource): void {
	const medium = m.voiceMedium?.trim() ?? "";
	const short = m.voiceShort?.trim() ?? "";
	box.replaceChildren();
	if (!medium && !short) {
		box.classList.add("hidden");
		return;
	}
	box.classList.remove("hidden");
	if (medium) box.append(makeVoiceTextSection("📝 MedTTS", medium));
	if (short) box.append(makeVoiceTextSection("💬 ShortTTS", short));
}

/**
 * Find the .voice-text read-along box belonging to the last rendered
 * assistant message in the transcript. Used by the voice-reply handler
 * to refresh that box live when a spoken variant arrives — WITHOUT
 * depending on lastAssistantDom, which is a streaming-scoped handle that
 * is null by the time a /voice-last turn delivers its custom message
 * (turn_start clears it before the custom message_start arrives).
 * Returns null if no assistant row exists yet.
 */
export function lastAssistantVoiceBox(): HTMLElement | null {
	const rows = document.querySelectorAll<HTMLElement>("#messages .row-assistant");
	const last = rows[rows.length - 1];
	return last?.querySelector<HTMLElement>(".voice-text") ?? null;
}

/**
 * A spoken-variant speak button (🗣️ LongTTS / 📝 MedTTS / 💬 ShortTTS),
 * shown on every assistant row. Two behaviors depending on whether the
 * variant has been generated yet:
 *
 *   - Already generated (getText() non-empty): a normal speak toggle —
 *     press once to play, press again to stop.
 *   - Not yet generated: the press requests generation of JUST this
 *     variant (/voice-last <variant>), shows a spinner, and records this
 *     variant + button in state so the voice-reply handler auto-plays
 *     THIS variant on THIS button when it arrives. One press, one play.
 *
 * long is TTS-only; medium and short are also rendered as readable text
 * below the reply (see updateVoiceTextBox) so the user can read along.
 */
export function makeVoiceVariantButton(
	variant: "long" | "medium" | "short",
	getText: () => string,
	title: string,
): HTMLElement {
	const icon = variant === "long" ? "🗣️" : variant === "medium" ? "📝" : "💬";
	const label = variant === "long" ? "Long" : variant === "medium" ? "Med" : "Short";
	const variantName =
		variant === "long" ? "Long TTS" : variant === "medium" ? "Medium TTS" : "Short TTS";
	const btn = el("button", { class: "speak-btn voice-variant-btn", title }) as HTMLButtonElement;
	btn.append(
		el("span", { class: "voice-icon", text: icon }),
		el("span", { class: "voice-label" }, label),
	);
	btn.dataset.voiceVariant = variant;
	btn.setAttribute("aria-label", title);
	btn.addEventListener("click", () => {
		const existing = getText().trim();
		if (existing) {
			// Variant already generated — play it directly.
			services.toggleSpeak?.(existing, btn);
			return;
		}
		// Not generated yet — request generation of THIS variant only and
		// queue it for autoplay. Show a spinner immediately so the press
		// has visible feedback during the (multi-second) LLM round-trip.
		// Also raise the blue TTS banner (like the multimodal-proxy toast):
		// it reads "generating…" here, then speakText() flips it to
		// "synthesizing via <engine>…" with a text preview once the spoken
		// text arrives.
		setBtnLoading(btn);
		state.pendingVoiceVariant = variant;
		state.pendingVoiceBtn = btn;
		showTtsBanner(`${variantName} · generating spoken text via ${voiceRewriteLabel()}…`);
		services.sendSlashCommand?.(`/voice-last ${variant}`);
	});
	return btn;
}

function previousUserPrompt(message: PersistedMessage): string | null {
	const index = state.messages.indexOf(message);
	if (index < 0) return null;
	for (let i = index - 1; i >= 0; i--) {
		const candidate = state.messages[i];
		if (candidate.kind === "user") return candidate.text;
	}
	return null;
}

type MessageIcon = "copy" | "retry" | "continue" | "fork" | "share" | "listen";

function messageIcon(name: MessageIcon): HTMLElement {
	const paths: Record<MessageIcon, string> = {
		copy: '<rect x="8" y="8" width="10" height="10" rx="1.5"/><path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/>',
		retry:
			'<path d="M20 11a8 8 0 0 0-14.7-4L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.7 4L21 15"/><path d="M21 20v-5h-5"/>',
		continue: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
		fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v4a4 4 0 0 0 4 4h6"/><path d="M18 7v3"/>',
		share:
			'<path d="M14 5h5v5"/><path d="m19 5-8 8"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
		listen:
			'<path d="M4 10v4"/><path d="M8 8v8"/><path d="M12 6v12"/><path d="M16 9v6"/><path d="M20 11v2"/>',
	};
	return el("span", {
		class: "message-action-icon",
		"aria-hidden": "true",
		html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`,
	});
}

function makeMessageActionButton(
	icon: MessageIcon,
	title: string,
	onClick: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
	const button = el("button", {
		class: "message-action",
		type: "button",
		"aria-label": title,
		title,
	});
	button.setAttribute("aria-label", title);
	button.append(messageIcon(icon));
	button.addEventListener("click", () => onClick(button));
	return button as HTMLButtonElement;
}

/**
 * Common actions for an assistant response. Actions resolve the message
 * lazily so the same bar can be attached to a streaming placeholder before
 * its final text and sequence number exist.
 */
function makeAssistantActionBar(getMessage: () => PersistedMessage | null): HTMLElement {
	const bar = el("div", {
		class: "message-actions assistant-actions",
		role: "toolbar",
		"aria-label": "Answer actions",
	});
	const sendActionPrompt = (text: string) => {
		if (state.isStreaming) {
			showToast("Wait for the current response to finish first.", "warning");
			return;
		}
		if (services.sendPrompt?.(text)) showToast("Message sent.");
	};
	bar.append(
		makeMessageActionButton("copy", "Copy this answer", (button) => {
			const message = getMessage();
			if (!message || message.kind !== "assistant" || !message.text.trim()) return;
			if (!services.copyText) return;
			void services.copyText(message.text).then((ok) => {
				button.classList.toggle("is-success", ok);
				showToast(ok ? "Answer copied." : "Clipboard access denied.", ok ? "info" : "error");
			});
		}),
		makeMessageActionButton("retry", "Retry the previous request", () => {
			const message = getMessage();
			if (message?.kind === "assistant") {
				const prompt = previousUserPrompt(message);
				if (prompt) sendActionPrompt(prompt);
			}
		}),
		makeMessageActionButton("continue", "Ask the agent to continue", () => {
			sendActionPrompt("Continue from your last answer.");
		}),
		makeMessageActionButton("fork", "Fork this conversation here", () => {
			const message = getMessage();
			if (message?.kind === "assistant" && message.seq !== undefined) {
				services.forkFromMessage?.(message.seq);
			}
		}),
		makeMessageActionButton("share", "Copy a shareable link to this chat", () => {
			services.copyShareLink?.();
		}),
	);
	return bar;
}

export function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return String(args ?? "");
	const a = args as Record<string, unknown>;
	if (typeof a.command === "string") return a.command;
	if (typeof a.path === "string" && typeof a.content === "string")
		return `${a.path} (${a.content.length} chars)`;
	if (typeof a.path === "string") return a.path;
	return JSON.stringify(a);
}

/**
 * Extract a filesystem path from a tool call's args, if it has one.
 * Covers the write / edit / read tools (which take `path`) and any
 * future tool that follows the same convention. Returns null for
 * tools whose args don't carry a path (bash, web_search, …).
 */
/**
 * The full, untruncated text for a tool call's args — shown when the
 * user expands the card. For bash this is the whole command (the
 * summary line truncates it); for structured tools we pretty-print
 * the args as JSON so the expanded view is readable. Returns null
 * when there's nothing useful to expand.
 */
function fullToolText(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	if (typeof a.command === "string") return a.command;
	try {
		return JSON.stringify(a, null, 2);
	} catch {
		return null;
	}
}

/**
 * Build a tool card's header: gear icon, the (truncated) one-line
 * summary, an optional file download link, and — when the full args
 * are long enough to be worth expanding — a clickable expand toggle.
 * The toggle reveals a `<pre class="tool-args">` with the complete
 * command/args, mirroring how the assistant "thinking" block collapses.
 *
 * `card` receives the head (and the hidden args body, if any) in
 * display order; callers then append the result/pending block after.
 */
function mountToolHead(
	card: HTMLElement,
	name: string,
	args: unknown,
	downloadPath: string | null,
): void {
	const summary = summarizeArgs(args);
	const full = fullToolText(args);
	// Only offer expansion when there's real content beyond the summary
	// line (long bash commands, structured args, etc.). Short calls
	// (e.g. `read` of a short path) get no toggle to avoid noise.
	const expandable = full !== null && full.length > 48;
	const head = el(
		"div",
		{ class: `tool-head${expandable ? " tool-head-expandable" : ""}` },
		el("span", { class: "tool-icon" }, "⚙"),
		el("span", { class: "tool-name" }, `${name} ${summary}`),
	);
	if (downloadPath) head.append(makeFileDownloadLink(downloadPath, state.sessionCwd));
	if (expandable && full !== null) {
		const toggle = el(
			"button",
			{ class: "tool-toggle", type: "button", title: "Show full command" },
			"▸",
		);
		head.append(toggle);
		const body = el("pre", { class: "tool-args hidden" }, full);
		// Clicking anywhere on the head (including the chevron button,
		// whose click bubbles up) flips the expanded body. The download
		// link stops its own propagation, so it stays a real link.
		head.addEventListener("click", () => {
			const open = body.classList.toggle("hidden");
			toggle.textContent = open ? "▸" : "▾";
			toggle.title = open ? "Show full command" : "Hide";
			head.classList.toggle("tool-head-open", !open);
		});
		card.append(head);
		card.append(body);
		return;
	}
	card.append(head);
}

/**
 * Completed tool calls stay as compact one-line rows. The command/arguments
 * and result remain available by clicking the row, but long tool output no
 * longer pushes the conversation away from the assistant's answer.
 */
function appendToolResult(card: HTMLElement, result: string, isError: boolean): void {
	const resultNode = el("pre", { class: `tool-result ${isError ? "tool-error" : ""}` }, result);
	resultNode.classList.add("tool-result-collapsed");
	card.append(resultNode);

	const head = card.querySelector<HTMLElement>(".tool-head");
	if (!head) return;
	head.classList.add("tool-head-expandable");
	let toggle = head.querySelector<HTMLButtonElement>(".tool-toggle");
	if (!toggle) {
		toggle = el(
			"button",
			{ class: "tool-toggle", type: "button", title: "Show tool details" },
			"▸",
		) as HTMLButtonElement;
		head.append(toggle);
	}
	const status = el(
		"span",
		{ class: `tool-status${isError ? " tool-status-error" : ""}` },
		isError ? "✕" : "✓",
	);
	const anchor = head.querySelector<HTMLElement>(".tool-download") ?? toggle;
	head.insertBefore(status, anchor);
	head.addEventListener("click", () => {
		const expanded = resultNode.classList.toggle("tool-result-collapsed") === false;
		toggle!.textContent = expanded ? "▾" : "▸";
		toggle!.title = expanded ? "Hide tool details" : "Show tool details";
		head.classList.toggle("tool-head-open", expanded);
	});
}

function toolPathFromArgs(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	return typeof a.path === "string" && a.path.length > 0 ? a.path : null;
}

/**
 * Build a download link anchor for a file the agent touched. Points
 * at the server's /api/file route, which streams any file inside the
 * agent project directory. Returns null if the path is empty.
 */
function makeFileDownloadLink(path: string, cwd: string | null): HTMLAnchorElement {
	const params = new URLSearchParams({ path });
	if (cwd && !path.startsWith("/")) params.set("cwd", cwd);
	const url = `/api/file?${params.toString()}`;
	return el(
		"a",
		{
			class: "tool-download",
			href: url,
			download: "", // hint the browser to save rather than navigate
			target: "_blank",
			rel: "noopener",
			title: `Download ${path}`,
			onclick: (e: Event) => {
				// Allow the default anchor navigation to happen (the `download`
				// attribute + Content-Disposition: attachment triggers a save).
				// Stop propagation so the click doesn't bubble into any
				// future card-level handler.
				e.stopPropagation();
			},
		},
		"⬇ download",
	) as HTMLAnchorElement;
}

/**
 * The scroll container is `.messages-wrap`, NOT `#messages`. The messages
 * div is the inner content that grows; .messages-wrap is the one with
 * overflow-y: auto. If you query #messages for scrollTop/scrollHeight,
 * both values are wrong (scrollTop is always 0, scrollHeight equals
 * clientHeight) and scrolling silently does nothing.
 */
function getScrollContainer(): HTMLElement {
	const el = document.querySelector(".messages-wrap");
	return (el ?? $("#messages")) as HTMLElement;
}

/**
 * True iff the user is currently sitting at the bottom of the messages
 * list (within a small tolerance). Used to decide whether new streamed
 * tokens should keep the viewport pinned to the latest line, or leave
 * the user alone when they've deliberately scrolled up to re-read
 * something.
 */
export function isAtBottom(): boolean {
	const scroller = getScrollContainer();
	const slack = 80; // px — generous so "near the bottom" counts as pinned
	return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= slack;
}

export function scrollToBottom(): void {
	const scroller = getScrollContainer();
	scroller.scrollTop = scroller.scrollHeight;
}

/**
 * Scroll only if the user is already at (or near) the bottom. If they've
 * scrolled up, do nothing — we don't want to yank them away from the
 * earlier text they were re-reading. Used during streaming so the cursor
 * line doesn't keep moving once the reader has looked away from it.
 */
export function scrollToBottomIfPinned(): void {
	if (isAtBottom()) scrollToBottom();
}

// ---------------------------------------------------------------------------
// "Jump to previous user message" navigation
// ---------------------------------------------------------------------------
//
// A floating button (bottom-right of the messages area) + Alt+↑ shortcut
// that walks UP through the user's own messages one at a time, so a long
// transcript's "where did I say X?" is a few clicks away instead of a
// scroll-hunt. Stateful: the first click lands on the newest user message
// strictly above the current view (or the newest overall when pinned at
// the bottom); each subsequent click moves one older. Manual scrolling
// resets the walk so the next click restarts from wherever the user
// landed. Steer bubbles (queued, not-yet-sent) are excluded — only real
// delivered user messages count as waypoints.

let currentUserMsgIndex: number | null = null;
// Guard so the scroll listener can tell a programmatic scroll (from
// scrollRowToTop) apart from the user dragging the scrollbar / wheel.
// Programmatic scrolls must NOT reset currentUserMsgIndex.
let programmaticScroll = false;
let programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;

/** All rendered user-message rows, excluding queued "steer" bubbles. */
function userMessageRows(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>("#messages .row-user:not(.row-steer)"));
}

/**
 * Scroll a row to the top of the messages area with a small gap, using
 * scrollTop math (not Element.scrollIntoView) so it matches the
 * instant-scroll behavior used everywhere else here — no smooth-scroll
 * that would queue glides and fight the user. Sets the programmatic-scroll
 * guard so the scroll listener doesn't treat this as a manual scroll.
 */
function scrollRowToTop(row: HTMLElement, gap = 12): void {
	const scroller = getScrollContainer();
	const dy = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - gap;
	programmaticScroll = true;
	if (programmaticScrollTimer) clearTimeout(programmaticScrollTimer);
	scroller.scrollTop += dy;
	// The (single, non-smooth) scroll event fires within a few ms; give
	// the guard a short tail so any async scroll dispatch is covered.
	programmaticScrollTimer = setTimeout(() => {
		programmaticScroll = false;
	}, 80);
}

/** Flash a brief highlight on a user bubble so the jump target is visible. */
function highlightUserRow(row: HTMLElement): void {
	const bubble = row.querySelector<HTMLElement>(".bubble");
	if (!bubble) return;
	bubble.classList.remove("jump-highlight");
	// Force a reflow so the animation restarts when the same bubble is
	// jumped to twice in a row (otherwise the class re-add is a no-op).
	void bubble.offsetWidth;
	bubble.classList.add("jump-highlight");
}

/**
 * Jump to the previous user message. Repeated calls walk up the
 * transcript one user message at a time. See the block comment above
 * for the full state model.
 */
export function jumpToPrevUserMessage(): void {
	const rows = userMessageRows();
	if (rows.length === 0) return;
	let idx: number;
	if (currentUserMsgIndex === null) {
		// Start: land on the newest user message strictly above the
		// current top of view; if none (we're at the very top, or pinned
		// at the bottom with nothing above the top edge), fall back to the
		// newest user message overall.
		const viewTop = getScrollContainer().getBoundingClientRect().top + 1;
		idx = -1;
		for (let i = rows.length - 1; i >= 0; i--) {
			if (rows[i].getBoundingClientRect().bottom <= viewTop) {
				idx = i;
				break;
			}
		}
		if (idx === -1) idx = rows.length - 1;
	} else {
		idx = Math.max(0, currentUserMsgIndex - 1);
	}
	currentUserMsgIndex = idx;
	scrollRowToTop(rows[idx]);
	highlightUserRow(rows[idx]);
	updateJumpFabState();
}

/**
 * Reflect the current nav state onto the FAB: hide it entirely when there
 * are no user messages (welcome screen / fresh chat), disable it at the
 * oldest message (nothing further up), and show a position hint in the
 * tooltip once navigating.
 */
export function updateJumpFabState(): void {
	const fab = document.getElementById("jump-prev-user");
	if (!fab) return;
	const rows = userMessageRows();
	if (rows.length === 0) {
		fab.classList.add("hidden");
		return;
	}
	fab.classList.remove("hidden");
	const atOldest = currentUserMsgIndex !== null && currentUserMsgIndex <= 0;
	fab.toggleAttribute("disabled", atOldest);
	fab.setAttribute(
		"title",
		currentUserMsgIndex !== null
			? `Your message ${currentUserMsgIndex + 1} of ${rows.length} — click for the one above (Alt+↑)`
			: "Jump to your previous message (Alt+↑)",
	);
}

/**
 * Clear the nav position. Called on manual scroll (the user moved
 * themselves, so the next click should restart from the new position)
 * and on send (a new message was added). No-op when not navigating, so
 * it's cheap to call from a scroll listener.
 */
export function resetJumpNav(): void {
	if (currentUserMsgIndex === null) return;
	currentUserMsgIndex = null;
	updateJumpFabState();
}

/**
 * Build the floating "jump to previous user message" button. Lives in
 * the bottom-right corner of the main column, above the composer. Its
 * visibility / disabled state is driven by updateJumpFabState().
 */
function makeJumpPrevUserFab(): HTMLElement {
	return el("button", {
		class: "jump-prev-user hidden",
		id: "jump-prev-user",
		type: "button",
		"aria-label": "Jump to your previous message",
		title: "Jump to your previous message (Alt+↑)",
		onclick: () => jumpToPrevUserMessage(),
		// Speech-bubble + chevron (not a bare arrow): this FAB sits right above
		// the composer's circular Send button, so a plain up-arrow collides
		// with it visually (see the mobile "two identical buttons" report).
		html:
			'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8 10 4-4 4 4"/></svg>',
	});
}

/**
 * Build the floating "jump to the latest message" button. Sits just
 * below the jump-to-previous-user button in the same stacked FAB group.
 * Only meaningful when the view is scrolled away from the bottom, so
 * its visibility is driven by updateJumpToBottomFabState() (hidden while
 * pinned at the bottom).
 */
function makeJumpToBottomFab(): HTMLElement {
	return el("button", {
		class: "jump-to-bottom hidden",
		id: "jump-to-bottom",
		type: "button",
		"aria-label": "Jump to the latest message",
		title: "Jump to the latest message",
		onclick: () => {
			scrollToBottom();
			updateJumpToBottomFabState();
		},
		html:
			'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8 11 4 4 4-4"/></svg>',
	});
}

/**
 * Show the jump-to-bottom button only when the view is NOT already at
 * the bottom — once pinned there it's redundant. Called from the scroll
 * listener (every scroll, programmatic or not) and after explicit
 * scrollToBottom() calls.
 */
export function updateJumpToBottomFabState(): void {
	const fab = document.getElementById("jump-to-bottom");
	if (!fab) return;
	fab.classList.toggle("hidden", isAtBottom());
}

export function appendNode(node: HTMLElement, opts: { pin?: boolean } = {}): void {
	// Capture pinning BEFORE appending. The new node may be tall (a ⚙
	// tool card, a thinking block, a result <pre>), and once it's in the
	// DOM it grows scrollHeight while scrollTop stays put — so an
	// after-append isAtBottom() check would falsely report "not at
	// bottom" (the 80px slack is consumed by the new block itself) and
	// silently skip the scroll. Worse, that poisons pinning for the
	// rest of the turn: every later streamed token's
	// scrollToBottomIfPinned() would then no-op because isAtBottom()
	// stays false. Capturing pre-append fixes both.
	const wasPinned = isAtBottom();
	$("#messages").append(node);
	updateWelcomeVisibility();
	// `pin` = only follow if the user was already near the bottom before
	// this block landed. Use this for blocks that appear mid-stream (a
	// new assistant turn, a tool/bash card) so we don't yank someone who
	// has scrolled up to re-read. Default (false) force-scrolls — correct
	// for the user's own messages and for explicit commands like /help.
	if (!opts.pin || wasPinned) scrollToBottom();
}

// Live rendering for the streaming case: we mutate the last assistant
// message's text node in place as `message_update` events arrive. We
// DON'T re-render the whole list on every event (would lose the cursor
// and cause flicker).

/**
 * Live rendering for the streaming case: returns the `.text` <pre> node
 * AND the thinking container so message_update can update both in place.
 */
export function appendAssistantPlaceholder(): LiveAssistantDom {
	const wrap = el("div", { class: "row row-assistant" });
	const avatar = el("div", { class: "avatar" });
	avatar.append(el("span", { class: "avatar-icon" }, "✦"));
	wrap.append(avatar);
	const body = el("div", { class: "body" });
	// Thinking block — created expanded by default; populated as
	// message_update events stream in thinking content. If the model never
	// emits thinking, the container stays empty and we remove it at
	// message_end so it doesn't leave a stray "▾ thinking" header.
	const thinkingWrap = el("div", { class: "thinking hidden-thinking" });
	// Default expanded (▾). Click to collapse.
	const thinkingToggle = el("span", { class: "thinking-toggle" }, "▾ thinking");
	const thinkingPre = el("pre", { class: "thinking-body" }, "");
	thinkingWrap.append(thinkingToggle);
	thinkingWrap.append(thinkingPre);
	thinkingWrap.addEventListener("click", () => {
		thinkingPre.classList.toggle("hidden");
		thinkingToggle.textContent = thinkingPre.classList.contains("hidden")
			? "▸ thinking"
			: "▾ thinking";
	});
	body.append(thinkingWrap);
	const pre = el("div", { class: "text markdown streaming" });
	body.append(pre);
	// Timestamp on the live placeholder too, so it's visible while the
	// reply streams in (renderMessageNode repaints it on full re-render).
	// The just-pushed assistant message is the last entry in state.
	{
		const am = state.messages[state.messages.length - 1];
		if (am && am.kind === "assistant" && am.ts !== undefined) body.append(makeTimestampEl(am.ts));
	}
	// Long/Med/Short spoken-variant buttons on EVERY assistant row, including
	// the live-streaming placeholder — the variants are generated on
	// demand on first press (see makeVoiceVariantButton), so they can be
	// shown unconditionally without waiting for a voice-reply to arrive.
	// The getter resolves to the last assistant message's variant, which
	// is what /voice-last voices anyway.
	body.append(
		makeVoiceActions(
			() => state.lastAssistantText,
			() => lastAssistantVoice("long"),
			() => lastAssistantVoice("medium"),
			() => lastAssistantVoice("short"),
		),
	);
	// Read-along box (hidden until a medium/short variant lands). Returned
	// so the voice-reply handler can populate it live without a re-render.
	const voiceBox = makeVoiceTextBox();
	body.append(voiceBox);
	body.append(
		makeAssistantActionBar(() => {
			for (let i = state.messages.length - 1; i >= 0; i--) {
				const message = state.messages[i];
				if (message.kind === "assistant") return message;
			}
			return null;
		}),
	);
	wrap.append(body);
	appendNode(wrap, { pin: true });
	return { textPre: pre, thinkingWrap, thinkingPre, voiceTextBox: voiceBox };
}
export function appendToolCall(name: string, args: unknown, toolCallId: string): void {
	const wrap = el("div", { class: "row row-tool" });
	const card = el("div", { class: "tool-card" });
	const toolPath = toolPathFromArgs(args);
	mountToolHead(card, name, args, toolPath);
	const pending = el("div", { class: "tool-pending" }, "running…");
	card.append(pending);
	wrap.append(card);
	// Mark the row with the SDK's toolCallId so the matching
	// `tool_execution_end` (or the subsequent `message_start` for the
	// toolResult) can find it directly. Falls back to the "last
	// pending" heuristic if id is missing for some reason. (The "last
	// pending" approach broke when the model fired two parallel tool
	// calls — the second's result would fill the first's pending row.)
	wrap.dataset.toolCallId = toolCallId;
	wrap.dataset.toolPending = "1";
	appendNode(wrap, { pin: true });
}

export function finalizeToolCall(
	toolCallId: string,
	name: string,
	result: string | undefined,
	isError: boolean,
): void {
	// Capture pinning BEFORE mutating — the result <pre> can be tall and
	// would otherwise falsely flip isAtBottom() to false, poisoning
	// pinning for the rest of the turn (see appendNode for the full
	// rationale).
	const wasPinned = isAtBottom();
	const list = $("#messages");
	const target = toolCallId
		? list.querySelector(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`)
		: null;
	// Resolve the row: prefer the id match (handles parallel tool calls);
	// fall back to the "last pending" heuristic for any tool that landed
	// without an id (shouldn't happen with the current SDK, but keeps us
	// safe against future protocol changes).
	let row: HTMLElement | null = target as HTMLElement | null;
	if (!row) {
		const rows = list.querySelectorAll(".row-tool");
		for (let i = rows.length - 1; i >= 0; i--) {
			const r = rows[i] as HTMLElement;
			if (r.dataset.toolPending === "1") {
				row = r;
				break;
			}
		}
	}
	if (!row) return;
	delete row.dataset.toolPending;
	const card = row.querySelector<HTMLElement>(".tool-card");
	const pending = row.querySelector(".tool-pending");
	if (pending) pending.remove();
	if (card && result !== undefined) {
		appendToolResult(card, result, isError);
	}
	void name; // unused for now — the tool-name row was already set on append
	// Polite scroll based on pre-mutation pinning state. Without this,
	// the tall result <pre> grows the page without the viewport
	// following, leaving the user above the bottom and silently killing
	// autoscroll for every subsequent streamed token.
	if (wasPinned) scrollToBottom();
}

export function appendError(text: string): void {
	appendNode(el("div", { class: "row row-error" }, el("div", { class: "body" }, text)));
}

/**
 * Inline scrollback marker for a completed compaction — the before→after
 * size, plus WHY it happened (the compaction reason). The status bar only
 * shows compaction *while it runs*; this leaves a durable trace in the chat
 * itself so "why did my history shrink / why is the meter low now?" is
 * answerable from the transcript. Ephemeral by design: rebuilt only from
 * live events, so it is not part of the on-disk transcript.
 */
export function appendCompactionChip(
	reason: string,
	tokensBefore: number | null,
	tokensAfter: number | null,
	willRetry: boolean,
): void {
	const k = (n: number): string => `${Math.round(n / 1000)}k`;
	const why =
		reason === "overflow"
			? "context overflow — condensed history" + (willRetry ? " and resuming the cut-off turn" : "")
			: reason === "manual"
				? "context compacted on request"
				: "context near the limit — condensed history";
	const sizes =
		tokensBefore != null && tokensAfter != null
			? ` · ${k(tokensBefore)} → ${k(tokensAfter)} tok`
			: tokensBefore != null
				? ` · ${k(tokensBefore)} tok before`
				: "";
	const row = el(
		"div",
		{ class: "row row-compaction" },
		el("div", { class: "compaction-chip" }, `🗜 ${why}${sizes}`),
	);
	appendNode(row);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

/**
 * Turn a pi `sourceInfo.source` identifier into a short display name for
 * the package that owns a command. pi reports sources like
 * `npm:pi-web-access` or `../../pi-venice-image`; we want `pi-web-access` /
 * `pi-venice-image`. Falls back to the raw source.
 */
function packageDisplayName(source: string | undefined): string {
	if (!source) return "(extension)";
	const clean = source.replace(/^npm:/, "");
	const seg = clean.split("/").pop();
	return seg || source;
}

/** Group extension commands by their owning package (sourceInfo.source). */
function groupExtensionPackages(commands: PiCommand[]): Map<string, PiCommand[]> {
	const groups = new Map<string, PiCommand[]>();
	for (const c of commands) {
		const key = c.sourceInfo?.source ?? c.name;
		const list = groups.get(key);
		if (list) list.push(c);
		else groups.set(key, [c]);
	}
	return groups;
}

/** Update the capabilities badge in the header. */
function refreshCapabilitiesBadge(): void {
	const caps = state.capabilities;
	const fastButton = document.getElementById("fast-mode");
	if (fastButton) {
		const fastAvailable = caps?.some(
			(command) => command.name === "fast" && command.source !== "skill",
		);
		fastButton.style.display = fastAvailable ? "" : "none";
		if (fastAvailable) {
			const status = state.extensionStatusLabels["codex-fast"];
			const label =
				status === "Enabled" ? "Fast" : status === "Standard" ? "Standard" : "Checking…";
			fastButton.textContent = `⚡ ${label}`;
			fastButton.title = `Codex response speed: ${label} (/fast)`;
			fastButton.setAttribute("aria-label", `Configure Codex response speed (currently ${label})`);
		}
	}

	const badge = document.getElementById("caps-badge");
	if (!badge) return;
	if (!caps || caps.length === 0) {
		badge.style.display = "none";
		return;
	}
	const skills = caps.filter((c) => c.source === "skill");
	const extPkgs = new Set(
		caps.filter((c) => c.source === "extension").map((c) => c.sourceInfo?.source ?? c.name),
	);
	const parts: string[] = [];
	if (skills.length) parts.push(`${skills.length} skill${skills.length !== 1 ? "s" : ""}`);
	if (extPkgs.size) parts.push(`${extPkgs.size} extension${extPkgs.size !== 1 ? "s" : ""}`);
	badge.textContent = parts.join(" · ");
	badge.style.display = "";
}

/** Show/hide the capabilities popover. */
export function toggleCapabilitiesPopover(): void {
	const existing = document.getElementById("caps-popover");
	if (existing) {
		existing.remove();
		return;
	}
	const caps = state.capabilities;
	if (!caps || caps.length === 0) return;

	const overlay = el("div", { class: "modal-overlay", id: "caps-popover" });
	const box = el("div", { class: "caps-popover-box" });

	box.append(el("h3", { text: "Loaded capabilities" }));

	// Extensions section — commands grouped by owning package. This is
	// what the pi TUI's [Extensions] list reflects: each installed
	// extension and the slash commands it registered. get_commands
	// reports all of them (including locally-registered path packages the
	// old `pi list` text parser silently dropped).
	const extCmds = caps.filter((c) => c.source === "extension");
	if (extCmds.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Extensions"));
		const groups = groupExtensionPackages(extCmds);
		for (const [source, cmds] of [...groups.entries()].sort((a, b) =>
			packageDisplayName(a[0]).localeCompare(packageDisplayName(b[0])),
		)) {
			const pkg = el("div", { class: "caps-package" });
			const row = el("div", { class: "caps-row caps-pkg-row" });
			row.append(el("span", { class: "caps-name" }, packageDisplayName(source)));
			row.append(
				el("span", { class: "caps-pkg" }, `${cmds.length} command${cmds.length === 1 ? "" : "s"}`),
			);
			pkg.append(row);

			const commandList = el("div", { class: "caps-command-list" });
			for (const c of cmds) {
				const cr = el("div", { class: "caps-row caps-command-row" });
				cr.append(el("span", { class: "caps-name" }, `/${c.name}`));
				if (c.description) cr.append(el("span", { class: "caps-desc" }, c.description));
				commandList.append(cr);
			}
			pkg.append(commandList);
			box.append(pkg);
		}
	}

	// Skills section — source === "skill". Names come from pi prefixed
	// `skill:`; strip it for display. Includes user-level skills (loose
	// SKILL.md files) the old package-only scanner never saw.
	const skillCmds = caps.filter((c) => c.source === "skill");
	if (skillCmds.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Skills"));
		const list = el("div", { class: "caps-list" });
		for (const s of skillCmds) {
			const row = el("div", { class: "caps-row caps-simple-row" });
			row.append(el("span", { class: "caps-name" }, s.name.replace(/^skill:/, "")));
			if (s.description) row.append(el("span", { class: "caps-desc" }, s.description));
			list.append(row);
		}
		box.append(list);
	}

	// Prompts section — prompt templates (project/user `.md` files).
	const promptCmds = caps.filter((c) => c.source === "prompt");
	if (promptCmds.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Prompts"));
		const list = el("div", { class: "caps-list" });
		for (const p of promptCmds) {
			const row = el("div", { class: "caps-row caps-simple-row" });
			row.append(el("span", { class: "caps-name" }, `/${p.name}`));
			if (p.description) row.append(el("span", { class: "caps-desc" }, p.description));
			list.append(row);
		}
		box.append(list);
	}

	box.append(
		el("button", { class: "btn caps-close-btn", text: "Close", onclick: () => overlay.remove() }),
	);
	mountModal(overlay, box, { label: "Loaded capabilities" });
}

export function refreshStatus(): void {
	// The human-readable model label is resolved once per model change
	// (see state.refreshCurrentModelLabel) instead of searching the model
	// list here on every status tick. Falls back to the raw id when no
	// friendly name is known.
	const modelLabel = state.currentModelLabel || state.currentModelId || "(no model)";

	// Escape the dynamic bits we interpolate into innerHTML below.
	const esc = escapeHtml;

	// The status bar is a fixed-height row of three one-line slots (see
	// styles.css .status-bar): core (stable), voice (transport controls),
	// dynamic (transient). Every slot is nowrap + ellipsis, so nothing can
	// ever wrap to a second line — the bar's height is constant and the
	// composer above it never moves, no matter what appears or disappears.
	const coreEl = $<HTMLSpanElement>("#status-core");
	if (coreEl) {
		// Core slot — stable info: model · think level · context fill.
		// Context-window fill is the SAME number the token pill represents
		// (state.contextUsage.tokens / contextWindow), NOT cumulative session
		// usage — cumulative input+output only ever grows and diverges from
		// the bar after a compaction, which made the number and the bar
		// disagree. They reset together when pi compacts. `tokens` is null
		// right after a compaction (pi can't size the context until the next
		// reply) → show `?`.
		const core = [
			esc(modelLabel),
			`think: ${esc(state.currentThinking)}`,
			esc(contextFillLabel()),
		].join(" · ");
		coreEl.innerHTML = core;
		// Full value on hover when truncated.
		coreEl.title = core;
	}

	paintStatusDynamic();

	// Voice slot — transport controls (pause/resume + stop, or the
	// synthesizing stop). Rendered as clickable buttons (not inert text) so
	// they're always reachable in a long session without scrolling back to
	// the message that started playback — the status bar never scrolls away.
	// The slot is flex-shrink: 0 and never truncates, so the stop button
	// can't be cut off. Clicks are handled by the delegated listener on
	// #status-bar (set up once in renderShell) so they survive this
	// innerHTML rebuild.
	const voiceEl = $<HTMLSpanElement>("#status-voice");
	if (voiceEl) {
		let html = "";
		if (state.audioPlaying || state.audioPaused || state.ttsInFlight > 0) {
			if (state.audioPlaying || state.audioPaused) {
				// Playback active or paused — show pause/resume + stop controls.
				// The toggle button swaps between ⏸ (playing) and ▶ (paused); the
				// stop button (red ⏹) is always present to fully halt + clear.
				const toggle = state.audioPaused
					? `<button class="status-voice-ctrl" data-voice-resume title="Resume playback" aria-label="Resume voice playback">▶</button>`
					: `<button class="status-voice-ctrl" data-voice-pause title="Pause playback" aria-label="Pause voice playback">⏸</button>`;
				const label = state.audioPaused ? "‖ paused" : "♪ playing";
				html = `${toggle}<button class="status-stop-voice" data-stop-voice title="Stop all voice" aria-label="Stop all voice playback">⏹</button> ${esc(label)}`;
			} else {
				// Synthesizing — nothing to pause yet (no audio loaded). Keep the
				// single stop button with a spinner so the user can cancel.
				html = `<button class="status-stop-voice" data-stop-voice title="Stop all voice" aria-label="Cancel voice synthesis"><span class="speak-spinner"></span> synthesizing…</button>`;
			}
		}
		voiceEl.innerHTML = html;
	}

	refreshCapabilitiesBadge();

	const mp = $<HTMLButtonElement>("#model-picker");
	// Show the human-readable name when we have it (e.g. "DeepSeek V4
	// Pro"), otherwise fall back to the raw id. Keep the raw id in the
	// title attribute for hover-tooltips.
	mp.textContent = `model: ${modelLabel}`;
	mp.title = `Model (/model) — current id: ${state.currentModelId ?? "…"}`;
	const tp = $<HTMLButtonElement>("#think-picker");
	tp.textContent = `think: ${state.currentThinking}`;
	const vp = $<HTMLButtonElement>("#voice-picker");
	vp.textContent = `voice: ${state.ttsVoice ?? "default"}`;
	const sp = $<HTMLButtonElement>("#speed-picker");
	sp.textContent = `speed: ${state.ttsSpeed}×`;
	refreshComposerState();
}

/**
 * Paint the dynamic slot — the transient, frequently-changing info:
 * streaming timer, retry loader, cost, queued steers, connection status.
 *
 * This is the only slot the 1s working tick touches while streaming, so a
 * new second of elapsed time (or a counting-down retry) repaints a few
 * characters instead of rebuilding the whole bar. All values are escaped
 * where they interpolate into innerHTML.
 */
/** Format a model output rate compactly enough for the single-line status bar. */
function formatTokenRate(tokensPerSecond: number): string {
	if (tokensPerSecond >= 100) return tokensPerSecond.toFixed(0);
	if (tokensPerSecond >= 10) return tokensPerSecond.toFixed(1);
	return tokensPerSecond.toFixed(2);
}

function tokenSpeedLabel(): string | null {
	const speed = state.streamingTokenSpeed;
	if (!speed) return null;
	if (speed.active) {
		if (speed.startedAt === null) return null;
		const elapsedSeconds = (Date.now() - speed.startedAt) / 1000;
		const tokens = speed.reportedOutputTokens ?? Math.ceil(speed.estimatedCharacters / 4);
		if (elapsedSeconds < 0.25 || tokens <= 0) return null;
		// Pi's usage snapshots are exact when a provider supplies them during
		// streaming. Most providers only return usage at completion, so mark
		// the character-derived live value clearly as an estimate.
		const prefix = speed.reportedOutputTokens === null ? "≈ " : "";
		return `${prefix}${formatTokenRate(tokens / elapsedSeconds)} tok/s`;
	}
	// Keep the completed-turn average visible once the agent is idle. Final
	// provider usage, when supplied, replaces the live character estimate.
	if (!state.isStreaming && speed.finalTokensPerSecond !== null) {
		const prefix = speed.reportedOutputTokens === null ? "≈ " : "";
		return `${prefix}${formatTokenRate(speed.finalTokensPerSecond)} tok/s`;
	}
	return null;
}

function paintStatusDynamic(): void {
	const dynEl = $<HTMLSpanElement>("#status-dynamic");
	if (!dynEl) return;
	const esc = escapeHtml;

	const dyn: string[] = [];
	const c = state.costTotal;
	// Cost only at turn boundaries — rendering it live mid-run made the bar
	// grow a new part on every message_update; it's a session total, not a
	// live meter, so painting it when the run ends is enough.
	if (c.cost > 0 && !state.isStreaming) dyn.push(`$${c.cost.toFixed(4)}`);
	if (state.isStreaming) {
		// Elapsed-time working indicator — the CLI shows a spinner +
		// elapsed counter while a turn runs; agentchatbox used to show
		// only a static "streaming" dot, which made a slow-but-working
		// turn look identical to a hang. Pi separately emits compaction
		// events, so name that slower local-Qwen checkpoint step explicitly
		// rather than incorrectly labelling it as a stalled response.
		const startedAt = state.compaction?.startedAt ?? state.streamingStartedAt;
		const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
		const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
		const ss = String(elapsed % 60).padStart(2, "0");
		if (state.compaction) {
			const label =
				state.compaction.reason === "manual"
					? "Saving chat summary"
					: state.compaction.reason === "overflow"
						? "Chat is too large for this model — condensing history"
						: "Preparing chat to fit this model's context";
			dyn.push(`<span class="streaming-dot"></span> ${label} ${mm}:${ss}`);
		} else {
			dyn.push(`<span class="streaming-dot"></span> streaming ${mm}:${ss}`);
		}
	}
	const tokenSpeed = tokenSpeedLabel();
	if (tokenSpeed) dyn.push(esc(tokenSpeed));
	if (state.retry) {
		// Mirror the CLI's retry loader verbatim:
		//   "Retrying (1/3) in 8s… (interrupt to cancel)"
		// plus the error message (the bit the CLI folds into the spinner
		// context but agentchatbox surfaces explicitly so you can see WHY
		// it's retrying — a transient 429 reads very differently from a
		// dead socket). Countdown is live-updated by startRetryCountdown.
		const r = state.retry;
		const secs = Math.max(0, Math.ceil(r.remainingMs / 1000));
		dyn.push(
			`<span class="retry-banner">↻ Retrying (${r.attempt}/${r.maxAttempts}) in ${secs}s — ${esc(r.errorMessage)}</span>`,
		);
	}
	if (state.pendingSteerCount > 0) dyn.push(`⟳ ${state.pendingSteerCount} queued`);
	if (state.connectionStatus !== "open") {
		const tag =
			state.connectionStatus === "stalled"
				? "⚠ stalled — reconnecting"
				: `[${state.connectionStatus}]`;
		dyn.push(esc(tag));
	}
	const html = dyn.join(" · ");
	// innerHTML (not textContent) so the streaming dot can be a styled,
	// flashing <span>. All interpolated bits are escaped above. The title
	// keeps the full value reachable on hover when the slot truncates.
	dynEl.innerHTML = html;
	dynEl.title = html;
}

/**
 * Transient whole-bar message used by the voice recorder ("recording…",
 * "transcribing…", "transcribed (N chars)…" states). Painted into the core
 * slot and cleared by the next refreshStatus — the same lifecycle as the
 * old `$("#status-bar").textContent = …` writes, but routed through a slot
 * so the fixed-height bar layout is never replaced by a raw text node.
 */
export function setStatusMessage(text: string): void {
	const coreEl = $<HTMLSpanElement>("#status-core");
	if (coreEl) coreEl.textContent = text;
	const voiceEl = $<HTMLSpanElement>("#status-voice");
	if (voiceEl) voiceEl.textContent = "";
	const dynEl = $<HTMLSpanElement>("#status-dynamic");
	if (dynEl) dynEl.textContent = "";
}

/** Compact text label for the status-line token pill. Reads
 *  `state.contextUsage` (seeded from pi's `get_session_stats` on every
 *  `ready`) so it survives a page refresh — unlike the old cumulative
 *  count, which was accumulated client-side from live events and reset
 *  to 0 on every load. Returns `?` when pi can't size the context yet
 *  (right after a compaction, before the next reply). */
function contextFillLabel(): string {
	const cu = state.contextUsage;
	if (!cu || cu.contextWindow <= 0) return "? tok";
	if (cu.tokens == null || cu.percent == null) return "? tok";
	const usedK = Math.round(cu.tokens / 1000);
	const winK = Math.round(cu.contextWindow / 1000);
	return `${usedK}k/${winK}k tok (${cu.percent.toFixed(0)}%)`;
}

// ---------------------------------------------------------------------------
// Shell (the whole UI scaffold)
// ---------------------------------------------------------------------------

/**
 * Handlers for the header / composer buttons. main.ts wires these in
 * once at boot — renderShell just calls them. This indirection keeps
 * render.ts from importing slashes.ts and voice.ts at module top-level.
 */
/** Add an image thumbnail above the composer while it is attached to the draft. */
export function addImageAttachmentPreview(
	url: string,
	filename: string,
	onRemove: () => void,
): void {
	const previews = document.getElementById("attachment-previews");
	if (
		!previews ||
		Array.from(previews.children).some((card) => card.getAttribute("data-url") === url)
	)
		return;
	const card = el("div", { class: "attachment-preview" });
	card.dataset.url = url;
	card.append(
		el("img", { src: url, alt: `Attached image: ${filename}` }),
		el(
			"button",
			{
				class: "attachment-preview-remove",
				type: "button",
				title: `Remove ${filename}`,
				"aria-label": `Remove ${filename}`,
				onclick: () => {
					onRemove();
					card.remove();
				},
			},
			"×",
		),
	);
	previews.append(card);
}

/**
 * Rebuild image previews after renderShell() replaces the composer DOM.
 * Uploaded image bytes live in state until the prompt is accepted, but the
 * old composer node (and its thumbnails) does not. Without this restoration,
 * a transcript refresh makes an attached image appear to vanish from the UI.
 */
export function restoreImageAttachmentPreviews(): void {
	for (const [url, attachment] of state.uploadedImages) {
		addImageAttachmentPreview(url, attachment.filename, () => {
			state.uploadedImages.delete(url);
			const ta = document.querySelector<HTMLTextAreaElement>("#input");
			if (ta) {
				ta.value = ta.value
					.replace(`![image: ${attachment.filename}](${url})`, "")
					.replace(`[image: ${attachment.filename}](${url})`, "")
					.trim();
				autoSize();
			}
		});
	}
}

export interface FileUploadPreview {
	setProgress: (loaded: number, total: number) => void;
	complete: (onRemove: () => void) => void;
	fail: (message: string) => void;
	cancelled: () => void;
	remove: () => void;
}

function formatAttachmentBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Show a persistent progress card for any file while it is transferred. Files
 * have no browser thumbnail, so leaving completed non-image cards in place
 * makes it clear that the attachment is ready to send.
 */
export function addFileUploadPreview(
	filename: string,
	size: number,
	onCancel: () => void,
): FileUploadPreview {
	const previews = document.getElementById("attachment-previews");
	if (!previews) {
		return {
			setProgress: () => {},
			complete: () => {},
			fail: () => {},
			cancelled: () => {},
			remove: () => {},
		};
	}
	const progress = el("progress", { max: Math.max(size, 1), value: 0 });
	const stateText = el("span", { class: "attachment-file-state", text: "Uploading · 0%" });
	const detailText = el("span", {
		class: "attachment-file-detail",
		text: `0 B of ${formatAttachmentBytes(size)}`,
	});
	const cancelButton = el(
		"button",
		{
			class: "attachment-upload-cancel",
			type: "button",
			title: `Cancel upload of ${filename}`,
			"aria-label": `Cancel upload of ${filename}`,
			onclick: () => {
				cancelButton.disabled = true;
				stateText.textContent = "Cancelling…";
				onCancel();
			},
		},
		"Cancel",
	);
	const card = el(
		"div",
		{ class: "attachment-preview attachment-file attachment-uploading" },
		el("span", { class: "attachment-file-icon", text: "↥", "aria-hidden": "true" }),
		el(
			"div",
			{ class: "attachment-file-copy" },
			el("span", { class: "attachment-file-name", text: filename, title: filename }),
			stateText,
			detailText,
			progress,
		),
		cancelButton,
	);
	previews.append(card);

	const addRemoveButton = (onRemove: () => void, label: string) => {
		card.append(
			el(
				"button",
				{
					class: "attachment-preview-remove",
					type: "button",
					title: label,
					"aria-label": label,
					onclick: () => {
						onRemove();
						card.remove();
					},
				},
				"×",
			),
		);
	};

	return {
		setProgress: (loaded, total) => {
			const safeTotal = Math.max(total, 1);
			const safeLoaded = Math.min(loaded, safeTotal);
			progress.max = safeTotal;
			progress.value = safeLoaded;
			const percent = Math.floor((safeLoaded / safeTotal) * 100);
			stateText.textContent = `Uploading · ${percent}%`;
			detailText.textContent = `${formatAttachmentBytes(safeLoaded)} of ${formatAttachmentBytes(safeTotal)}`;
		},
		complete: (onRemove) => {
			cancelButton.remove();
			progress.value = progress.max;
			card.classList.remove("attachment-uploading");
			card.classList.add("attachment-uploaded");
			stateText.textContent = "Uploaded · ready to send";
			detailText.textContent = formatAttachmentBytes(size);
			addRemoveButton(onRemove, `Remove ${filename}`);
		},
		fail: (message) => {
			cancelButton.remove();
			card.classList.remove("attachment-uploading");
			card.classList.add("attachment-upload-failed");
			stateText.textContent = "Upload failed";
			detailText.textContent = message;
			addRemoveButton(() => {}, `Dismiss ${filename}`);
		},
		cancelled: () => {
			cancelButton.remove();
			card.classList.remove("attachment-uploading");
			card.classList.add("attachment-upload-cancelled");
			stateText.textContent = "Upload cancelled";
			detailText.textContent = "This file was not attached";
			addRemoveButton(() => {}, `Dismiss ${filename}`);
		},
		remove: () => card.remove(),
	};
}

/** Remove composer-only attachment previews after the draft is submitted. */
export function clearAttachmentPreviews(): void {
	document.getElementById("attachment-previews")?.replaceChildren();
}

export interface ShellHandlers {
	handleSend: () => void;
	persistDraft: (text: string) => void;
	historyBack: () => void;
	historyForward: () => void;
	showSlashMenu: () => void;
	handleSlashMenuKeydown: (event: KeyboardEvent) => boolean;
	handleSlash: (cmd: string) => void;
	openModelPicker: () => void;
	openThinkPicker: () => void;
	openVoicePicker: () => void;
	openSpeedPicker: () => void;
	openOverflowMenu: () => void;
	handleVoiceRecord: () => Promise<void>;
	/** Stop all voice playback + cancel in-flight TTS (status-bar stop button). */
	stopAllVoice: () => void;
	/** Pause TTS playback, holding position (status-bar pause button). */
	pauseVoice: () => void;
	/** Resume paused TTS playback (status-bar resume button). */
	resumeVoice: () => void;
	handleFileAttach: (e: Event) => Promise<void>;
	handlePaste: (e: ClipboardEvent) => Promise<void>;
	handleDrop: (e: DragEvent) => Promise<void>;
	abort: () => void;
	reconnect: () => void;
	abortRetry: () => void;
	/** Pin/unpin any session by id (sidebar star). Server persists + rebroadcasts. */
	setSessionPinned: (sessionId: string, pinned: boolean) => void;
	/** Rename any session by id (sidebar pencil). Server appends to the JSONL. */
	renameSessionById: (sessionId: string, name: string) => void;
	/** Delete any session by id (sidebar trash). Server removes the JSONL. */
	deleteSession: (sessionId: string) => void;
	/** Start a fresh Global chat without a confirmation prompt. */
	newGlobalSession: () => void;
	// --- Projects --------------------------------------------------------
	/** Start a new chat in a specific project (folder "+" button). */
	newSessionInProject: (projectId: string) => void;
	createProject: (input: {
		name: string;
		icon?: string;
		instructions?: string;
		defaultModelId?: string | null;
		defaultProvider?: string | null;
		defaultThinkingLevel?: import("../shared/protocol.js").ThinkingLevel | null;
	}) => void;
	updateProject: (input: {
		id: string;
		name?: string;
		icon?: string;
		instructions?: string;
		defaultModelId?: string | null;
		defaultProvider?: string | null;
		defaultThinkingLevel?: import("../shared/protocol.js").ThinkingLevel | null;
	}) => void;
	deleteProject: (id: string) => void;
	reorderProjects: (order: string[]) => void;
}

let shellHandlers: ShellHandlers | null = null;
export function registerShellHandlers(h: ShellHandlers): void {
	shellHandlers = h;
}

// ── Toast (extension notifications) ─────────────────────────────
// A transient banner for extension_ui_request notify events (e.g. the
// pi-voice-reply extension's "voice model failed" warning). Auto-dismisses
// after 8s; click dismisses immediately. Created once in renderShell.
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Show a transient toast. The most recent call replaces any visible toast. */
export function showToast(message: string, type: "info" | "warning" | "error" = "info"): void {
	if (!toastEl) return;
	toastEl.textContent = message;
	toastEl.className = `toast toast-${type}`;
	toastEl.classList.remove("hidden");
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toastEl?.classList.add("hidden");
		toastTimer = null;
	}, 8000);
}

/**
 * Dismiss the toast / TTS banner immediately. Clears any children the
 * banner added and cancels the auto-dismiss timer.
 */
export function hideToast(): void {
	if (!toastEl) return;
	toastEl.classList.add("hidden");
	toastEl.replaceChildren();
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
}

/**
 * Persistent info banner for the TTS flow — mirrors the multimodal-proxy
 * toast (the blue bubble that appears while a vision call is in flight):
 * a bold header line (e.g. "🗣️ LongTTS · synthesizing via Kokoro…") plus
 * an optional one-line preview of the text being spoken. Unlike
 * showToast(), it does NOT auto-dismiss — it stays until hideToast()
 * (on playback start / stop / error) or until another showToast() /
 * showTtsBanner() replaces it. Built from DOM nodes (not innerHTML) so a
 * text preview containing markup is rendered safely.
 */
export function showTtsBanner(header: string, bodyPreview?: string): void {
	if (!toastEl) return;
	toastEl.replaceChildren();
	toastEl.append(el("div", { class: "toast-head" }, header));
	if (bodyPreview) toastEl.append(el("div", { class: "toast-body" }, bodyPreview));
	toastEl.className = "toast toast-info";
	toastEl.classList.remove("hidden");
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
}

export function renderShell(): void {
	if (!shellHandlers) {
		throw new Error(
			"renderShell called before registerShellHandlers — main.ts must wire the UI handlers first",
		);
	}
	// Reset transient audio state BEFORE wiping the DOM. The shared
	// <audio> element is about to be removed (its `pause` event won't
	// fire), so without this, `state.audioPlaying` stays `true` and the
	// status bar keeps showing "♪ playing" after the audio element is
	// gone (until the next renderShell or page load).
	state.audioPlaying = false;
	state.audioPaused = false;
	state.ttsInFlight = 0;
	document.body.innerHTML = "";
	const root = el("div", { id: "app" });
	document.body.append(root);

	// ── Sidebar ────────────────────────────────────────────────────
	const sidebar = el("aside", {
		class: "sidebar",
		id: "sidebar",
		"aria-label": "Conversations and projects",
	});
	const sidebarHeader = el("div", { class: "sidebar-header" });
	// Keep the two primary drawer actions on one compact line. New chat is an
	// <a href="/"> so middle/modifier clicks retain native new-tab behavior;
	// a plain click stays in the SPA and closes the drawer on touch layouts.
	const sidebarNewChat = el(
		"a",
		{
			class: "new-chat-btn",
			href: "/",
			rel: "noopener",
			"aria-label": "Start a new chat",
			title: "New chat — middle-click to open in a new tab",
			onclick: (e: MouseEvent) => {
				if (e.button !== 0) return;
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
				e.preventDefault();
				shellHandlers?.newGlobalSession();
				toggleSidebar(true);
			},
		},
		el("span", {
			class: "new-chat-icon",
			"aria-hidden": "true",
			html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
		}),
		el("span", {}, "New chat"),
	);
	sidebarHeader.append(
		el(
			"button",
			{
				class: "icon-btn",
				type: "button",
				title: "Close sidebar",
				"aria-label": "Close sidebar",
				onclick: () => toggleSidebar(true),
			},
			"✕",
		),
		el("span", { class: "spacer" }),
		sidebarNewChat,
	);
	sidebar.append(sidebarHeader);

	// Semantic search box. /api/health resolves asynchronously after the shell
	// is painted, so keep the row in the DOM and reveal it when that result
	// arrives. Rendering it only when state.searchEnabled was already true made
	// visibility depend on whether a later transcript happened to rebuild the
	// shell — a startup race that made the box appear only sometimes.
	const searchRow = el("div", {
		class: "sidebar-search-row",
		id: "sidebar-search-row",
		hidden: !state.searchEnabled,
	});
	searchRow.append(
		el("input", {
			class: "sidebar-search",
			id: "sidebar-search",
			type: "search",
			placeholder: "Search chats by meaning…",
			"aria-label": "Search conversations by meaning",
			autocomplete: "off",
			on: {
				input: (e: Event) => {
					const q = (e.target as HTMLInputElement).value;
					void onSidebarSearchInput(q);
				},
			},
		}),
		el(
			"button",
			{
				class: "search-info-btn",
				type: "button",
				title: "How does this search work?",
				"aria-label": "How does this search work?",
				onclick: toggleSearchHelp,
			},
			"ⓘ",
		),
	);
	sidebar.append(searchRow);

	// Session list area — split into two independently-scrolling panes
	// (Projects on top, Global/Other on the bottom) divided by a draggable
	// splitter. Populated by renderSidebarSessions(); search takes over the
	// bottom pane and hides the top via the .search-active class.
	const sessionsWrap = el("div", { class: "sidebar-sessions", id: "sidebar-sessions" });
	const projectsPane = el("div", {
		class: "sidebar-pane sidebar-projects-pane",
		id: "sidebar-projects-pane",
	});
	const splitter = el("div", {
		class: "sidebar-splitter",
		id: "sidebar-splitter",
		role: "separator",
		tabIndex: 0,
		"aria-label": "Resize project and conversation lists",
		"aria-orientation": "horizontal",
	});
	const sessionsPane = el("div", {
		class: "sidebar-pane sidebar-sessions-pane",
		id: "sidebar-sessions-pane",
	});
	sessionsPane.append(el("div", { class: "sidebar-empty" }, "Loading sessions…"));
	sessionsWrap.append(projectsPane, splitter, sessionsPane);
	sidebar.append(sessionsWrap);

	root.append(sidebar);
	// Wire the draggable splitter AFTER the sidebar is in the document so
	// getBoundingClientRect() returns real dimensions for the default split.
	// Idempotent across renderShell rebuilds (per-drag listeners are cleaned
	// up on mouseup, so nothing leaks).
	initSidebarSplitter();

	// ── Main column ────────────────────────────────────────────────
	const main = el("main", { class: "main" });
	root.append(main);

	// Header — left hamburger, title, model picker in the middle
	// (like "GLM-4.7 ▾"), and a single wrench "Settings" affordance on
	// the right. The full picker pills (voice/speed/tts) are moved into
	// the overflow menu on every screen size to keep the bar clean.
	const header = el("div", { class: "header" });
	header.append(
		el(
			"button",
			{
				class: "icon-btn",
				id: "menu-toggle",
				type: "button",
				title: "Open sidebar",
				"aria-label": "Open sidebar",
				"aria-controls": "sidebar",
				"aria-expanded": "true",
				onclick: () => toggleSidebar(false),
			},
			"☰",
		),
		el(
			"div",
			{ class: "header-brand" },
			// ACB brand mark on the left, then the chat title. The
			// colored robot-in-hexagon mark reads on both the dark UI
			// and light contexts, so one raster asset serves everywhere.
			el("img", {
				class: "header-mark",
				src: "/logo-mark.webp?v=ebfe29502536",
				alt: "ACB",
				width: 24,
				height: 24,
				draggable: false,
			}),
			el("span", { class: "title", id: "title" }, state.title),
		),
		// A real link makes middle-click / modifier-click open a fresh chat
		// in another tab. Plain clicks stay in the SPA and start immediately.
		el(
			"a",
			{
				class: "header-new-chat",
				id: "header-new-chat",
				href: "/",
				rel: "noopener",
				title: "New chat — middle-click to open in a new tab",
				ariaLabel: "New chat",
				onclick: (e: MouseEvent) => {
					if (e.button !== 0) return;
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
					e.preventDefault();
					shellHandlers?.newGlobalSession();
				},
			},
			el("span", {
				class: "header-new-chat-icon",
				"aria-hidden": "true",
				html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
			}),
			el("span", { class: "header-new-chat-label" }, "New chat"),
		),
		el("div", { class: "spacer" }),
		el(
			"button",
			{
				class: "picker-btn caps-badge",
				id: "caps-badge",
				type: "button",
				title: "Loaded tools, skills, extensions — click for details",
				"aria-label": "Show loaded capabilities",
				onclick: () => toggleCapabilitiesPopover(),
				style: "display:none",
			},
			"",
		),
		el(
			"button",
			{
				class: "picker-btn header-fast",
				id: "fast-mode",
				type: "button",
				title: "Codex response speed: checking… (/fast)",
				"aria-label": "Configure Codex response speed (currently checking)",
				onclick: () => shellHandlers?.handleSlash("fast menu"),
				style: "display:none",
			},
			"⚡ Checking…",
		),
		el(
			"button",
			{
				class: "picker-btn header-model",
				id: "model-picker",
				type: "button",
				title: "Model (/model)",
				"aria-label": "Choose chat model",
			},
			"model: …",
		),
		// The hidden pickers still exist in the DOM so refreshStatus() can
		// update them; they're just visually hidden via the .picker-hidden
		// class. The overflow menu gives the user access to all of them.
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "think-picker",
				type: "button",
				title: "Thinking (/think)",
				"aria-label": "Choose thinking level",
			},
			"think: …",
		),
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "voice-picker",
				type: "button",
				title: "TTS voice",
				"aria-label": "Choose text-to-speech voice",
			},
			"voice: …",
		),
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "speed-picker",
				type: "button",
				title: "TTS playback speed",
				"aria-label": "Choose text-to-speech speed",
			},
			"speed: …",
		),
		// Right-side single icon-button that opens the overflow menu
		// where every option lives. Wrench glyph signals "settings" and
		// replaces the old sparkle "API ↗" treatment.
		el(
			"button",
			{
				class: "header-overflow",
				id: "overflow-menu",
				type: "button",
				title: "Settings",
				"aria-label": "Open settings",
				onclick: () => shellHandlers?.openOverflowMenu(),
			},
			el("span", {
				html: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94L14.7 6.3z"/></svg>`,
			}),
			el("span", { text: "Settings" }),
		),
	);
	main.append(header);

	// Messages area — scrollable wrapper containing welcome + messages
	const messagesWrap = el("div", { class: "messages-wrap" });

	// Welcome / empty state — ACB brand mark, question heading, and a
	// row of mode chips that act like quick-start buttons. The mark is
	// centered above the heading so the empty state reads as a brand
	// surface rather than a wall of text.
	const welcome = el("div", { class: "welcome", id: "welcome" });
	welcome.append(el("div", { class: "welcome-brand" }, "Agent Chat Box"));
	welcome.append(
		el("img", {
			class: "welcome-mark",
			src: "/logo-mark.webp?v=ebfe29502536",
			alt: "agentchatbox",
			width: 72,
			height: 72,
			draggable: false,
		}),
	);
	welcome.append(el("h1", { class: "welcome-title" }, "What can I do for you?"));
	welcome.append(
		el("p", { class: "welcome-sub" }, "Ask anything — I'll think, use tools, and answer."),
	);
	const modes = el("div", { class: "welcome-modes" });
	renderWelcomeSuggestions(modes);
	welcome.append(modes);
	messagesWrap.append(welcome);

	// Messages list
	messagesWrap.append(el("div", { class: "messages", id: "messages" }));

	// Messages region wraps the scroll area + the floating nav buttons
	// (jump to previous user message, and jump to latest), so the group
	// anchors to the bottom-right of the messages viewport — independent
	// of how tall the composer / status bar happen to be. Clicking the
	// up button (or Alt+↑) walks up through the user's own messages one
	// at a time; the down button jumps straight to the bottom.
	const messagesRegion = el("section", {
		class: "messages-region",
		"aria-label": "Conversation transcript",
	});
	messagesRegion.append(messagesWrap);
	const jumpFabs = el("div", { class: "jump-fabs" });
	jumpFabs.append(makeJumpPrevUserFab());
	jumpFabs.append(makeJumpToBottomFab());
	messagesRegion.append(jumpFabs);
	main.append(messagesRegion);

	// A manual scroll (wheel / drag / touch) means the user repositioned
	// themselves, so the next jump should restart from the new spot.
	// Programmatic scrolls from scrollRowToTop set a guard to skip this.
	// The jump-to-bottom button tracks every scroll (programmatic or
	// not) so it appears once the view leaves the bottom and hides again
	// once it returns.
	messagesWrap.addEventListener("scroll", () => {
		if (!programmaticScroll) resetJumpNav();
		updateJumpToBottomFabState();
	});

	// Composer — pill with attach + voice buttons on the left, textarea
	// in the middle, and a dark up-arrow send button on the right.
	// The old globe/reasoning buttons were removed because they had no
	// direct effect (they opened other menus instead).
	const composerWrap = el("div", { class: "composer-wrap" });
	// A textarea cannot paint an inline image. Keep the model-visible Markdown
	// in it, and show each attached image as a removable thumbnail just above.
	composerWrap.append(el("div", { class: "attachment-previews", id: "attachment-previews" }));
	composerWrap.append(el("div", { class: "composer-state hidden", id: "composer-state" }));
	const composer = el("div", { class: "composer", id: "composer" });
	composer.append(
		el(
			"button",
			{
				class: "icon-btn",
				id: "attach-btn",
				type: "button",
				title: "Attach file",
				"aria-label": "Attach files",
				onclick: () => $<HTMLInputElement>("#file-input").click(),
			},
			"+",
		),
		el(
			"button",
			{
				class: "icon-btn",
				id: "voice-btn",
				type: "button",
				title: "Voice note (transcribes locally on server)",
				"aria-label": "Record a voice note",
				onclick: () => {
					void shellHandlers?.handleVoiceRecord();
				},
			},
			"🎙",
		),
		el("textarea", {
			id: "input",
			class: "input",
			rows: 1,
			placeholder: `Send a message  ·  ${
				navigator.platform.includes("Mac") ? "⌘+Enter" : "Ctrl+Enter"
			} to send`,
			"aria-label": "Message",
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: false,
			"aria-autocomplete": "list",
			"aria-expanded": "false",
		}),
		el(
			"div",
			{ class: "composer-actions" },
			el(
				"button",
				{
					class: "send-btn",
					id: "send-btn",
					type: "button",
					title: "Send (⌘/Ctrl+Enter)",
					"aria-label": "Send message",
					onclick: () => shellHandlers?.handleSend(),
				},
				"↑",
			),
			el(
				"button",
				{
					class: "stop-btn",
					id: "stop-btn",
					type: "button",
					title: "Stop the current run",
					"aria-label": "Stop the current run",
					hidden: true,
					onclick: () => shellHandlers?.abort(),
				},
				"■",
			),
		),
	);
	composerWrap.append(composer);
	main.append(composerWrap);
	main.append(
		el("input", {
			type: "file",
			id: "file-input",
			hidden: true,
			multiple: true,
		}),
	);

	// Status bar — a fixed-height row of three one-line slots so its height
	// can never change (see styles.css .status-bar). Core = stable info
	// (model · think · tokens), voice = transport controls (never truncated),
	// dynamic = transient info (streaming timer, retry, cost, queued…).
	const statusBar = el("div", { class: "status-bar", id: "status-bar" });
	statusBar.append(
		el("span", { class: "status-slot status-core", id: "status-core" }, "connecting…"),
		el("span", { class: "status-slot status-voice", id: "status-voice" }),
		el("span", { class: "status-slot status-dynamic", id: "status-dynamic" }),
	);
	// Delegated click handler for the stop-voice button that refreshStatus()
	// injects into the status bar as innerHTML. Delegation (one listener on
	// the container, surviving innerHTML rebuilds) beats re-binding on every
	// status tick. Matches any click bubbling from the [data-stop-voice] btn.
	statusBar.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		if (target.closest("[data-stop-voice]")) {
			shellHandlers?.stopAllVoice();
		} else if (target.closest("[data-voice-pause]")) {
			shellHandlers?.pauseVoice();
		} else if (target.closest("[data-voice-resume]")) {
			shellHandlers?.resumeVoice();
		}
	});
	main.append(statusBar);
	// Hidden audio element for TTS playback. One shared element so a new
	// speak request stops the current one.
	const audio = el("audio", { id: "tts-audio", hidden: true, preload: "auto" });
	audio.addEventListener("play", () => {
		state.audioPlaying = true;
		state.audioPaused = false; // playing ⇒ not paused
		refreshStatus();
	});
	audio.addEventListener("ended", () => {
		state.audioPlaying = false;
		refreshStatus();
	});
	audio.addEventListener("pause", () => {
		state.audioPlaying = false;
		refreshStatus();
	});
	audio.addEventListener("error", () => {
		state.audioPlaying = false;
		refreshStatus();
	});
	main.append(audio);

	// Toast — fixed overlay for transient extension notifications
	// (e.g. voice-model fallback warnings). Click dismisses.
	toastEl = el("div", {
		class: "toast hidden",
		role: "status",
		"aria-live": "polite",
		"aria-atomic": "true",
	});
	toastEl.addEventListener("click", () => {
		toastEl?.classList.add("hidden");
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = null;
		}
	});
	document.body.append(toastEl);

	// File-input handler
	$("#file-input").addEventListener("change", (e) => {
		void shellHandlers?.handleFileAttach(e);
	});

	// Input handlers
	const input = $<HTMLTextAreaElement>("#input");
	input.addEventListener("keydown", (e) => {
		if (shellHandlers?.handleSlashMenuKeydown(e)) return;
		// Enter always inserts a newline. Sending is via the send button
		// (or Ctrl/Cmd+Enter for power users) — plain Enter on the soft
		// Android keyboard doesn't have a Shift modifier, so the old
		// "Enter sends, Shift+Enter newline" rule was unfriendly to
		// mobile users who tapped return expecting a line break.
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			shellHandlers?.handleSend();
		} else if (
			e.key === "ArrowUp" &&
			!e.altKey &&
			(input.value === "" || input.selectionStart === 0)
		) {
			e.preventDefault();
			shellHandlers?.historyBack();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			shellHandlers?.historyForward();
		}
	});
	input.addEventListener("input", () => {
		autoSize();
		shellHandlers?.persistDraft(input.value);
		shellHandlers?.showSlashMenu();
	});
	// Paste files (e.g. screenshots copied to clipboard) and drag-and-drop
	// files route through the same attach pipeline as the file picker.
	input.addEventListener("paste", (e) => {
		void shellHandlers?.handlePaste(e);
	});
	input.addEventListener("dragover", (e) => {
		// A dragover must be canceled for the subsequent drop event to fire.
		if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
	});
	input.addEventListener("drop", (e) => {
		void shellHandlers?.handleDrop(e);
	});
	$("#model-picker").addEventListener("click", () => shellHandlers?.openModelPicker());
	$("#think-picker").addEventListener("click", () => shellHandlers?.openThinkPicker());
	$("#voice-picker").addEventListener("click", () => shellHandlers?.openVoicePicker());
	$("#speed-picker").addEventListener("click", () => shellHandlers?.openSpeedPicker());

	// Desktop: sidebar open by default. Mobile: collapsed.
	if (window.innerWidth <= 720) toggleSidebar(true);

	renderHistory();
	restoreImageAttachmentPreviews();
	refreshStatus();
}

// ---------------------------------------------------------------------------
// Sidebar helpers
// ---------------------------------------------------------------------------

/**
 * Welcome-screen mode chips. Labels and icons are browser presentation;
 * command behavior and prompt text are registered by the pi-owned
 * acb-workflows extension. Icons are inline SVGs so they stay crisp.
 */
const WELCOME_SUGGESTIONS: {
	title: string;
	sub: string;
	command: string;
	icon: string;
}[] = [
	{
		title: "Magic Design",
		sub: "Spin up an interactive UI from a description",
		command: "design",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.5L12 14.77 7.06 17.4 8 11.9 4 8l5.61-1.16L12 2z"/></svg>`,
	},
	{
		title: "Full-Stack",
		sub: "Build a complete app — front, back, and data",
		command: "fullstack",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>`,
	},
	{
		title: "Write",
		sub: "Draft, edit, and refine long-form text",
		command: "writing",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6L8 22H2v-6L14 4z"/><path d="M13 5l6 6"/></svg>`,
	},
];

function renderWelcomeSuggestions(modes: HTMLElement): void {
	const available = new Set(
		(state.capabilities ?? [])
			.filter((command) => command.source === "extension")
			.map((command) => command.name.toLowerCase()),
	);
	modes.replaceChildren();
	for (const suggestion of WELCOME_SUGGESTIONS) {
		const enabled = available.has(suggestion.command);
		const button = el(
			"button",
			{
				class: "welcome-mode",
				type: "button",
				title: enabled ? suggestion.sub : `${suggestion.sub} (loading…)`,
				disabled: !enabled,
				"aria-label": suggestion.sub,
				onclick: () => services.sendSlashCommand?.(`/${suggestion.command}`),
			},
			el("span", { class: "welcome-mode-icon", html: suggestion.icon }),
			el("span", { class: "welcome-mode-label" }, suggestion.title),
		);
		modes.append(button);
	}
}

/** Repaint command-backed welcome shortcuts after pi reports capabilities. */
export function refreshWelcomeSuggestions(): void {
	const modes = document.querySelector<HTMLElement>(".welcome-modes");
	if (modes) renderWelcomeSuggestions(modes);
}

/**
 * Toggle the sidebar open/closed. On mobile, a dim overlay is shown when
 * the sidebar is open so taps outside dismiss it.
 */
function toggleSidebar(collapse: boolean): void {
	const sidebar = document.getElementById("sidebar");
	if (!sidebar) return;
	sidebar.classList.toggle("collapsed", collapse);
	sidebar.setAttribute("aria-hidden", String(collapse));
	const menuToggle = document.getElementById("menu-toggle");
	menuToggle?.setAttribute("aria-expanded", String(!collapse));

	// Mobile: manage the dim overlay
	let dim = document.querySelector<HTMLElement>(".sidebar-dim");
	if (!collapse) {
		if (!dim) {
			dim = el("div", {
				class: "sidebar-dim",
				role: "button",
				tabIndex: 0,
				"aria-label": "Close sidebar",
			});
			dim.addEventListener("click", () => toggleSidebar(true));
			dim.addEventListener("keydown", (event: KeyboardEvent) => {
				if (event.key === "Enter" || event.key === " ") toggleSidebar(true);
			});
			document.body.append(dim);
		}
	} else {
		dim?.remove();
	}
}

/** Apply the asynchronous /api/health search capability to the live shell. */
export function refreshSidebarSearchVisibility(): void {
	const row = document.getElementById("sidebar-search-row");
	if (row) row.hidden = !state.searchEnabled;
}

/**
 * Pop up a short explanation of how semantic search works. Dismissable by
 * clicking outside or the ✕ — same overlay pattern as the capabilities
 * popover.
 */
function toggleSearchHelp(): void {
	const existing = document.getElementById("search-help");
	if (existing) {
		existing.remove();
		return;
	}
	const overlay = el("div", { class: "modal-overlay", id: "search-help" });
	const box = el("div", { class: "caps-popover-box search-help-box" });
	box.append(el("h3", { text: "Search chats by meaning" }));
	box.append(
		el(
			"p",
			{ class: "muted" },
			"This searches your past conversations by what they mean, not by exact words. Describe what you remember in your own words — even if no words overlap, it finds the match.",
		),
	);
	box.append(
		el(
			"p",
			{ class: "muted" },
			"For example: \u201cI moved MavalETH from server 3 to server 2\u201d finds a chat that actually said \u201crelocate the service from srv-03 to srv-02.\u201d",
		),
	);
	box.append(
		el(
			"p",
			{ class: "muted" },
			"How: every message is turned into a number-fingerprint that captures its meaning (using a small local model, no API key). Your query gets the same treatment, and the system matches by similarity. Results show the message that matched as a snippet.",
		),
	);
	mountModal(overlay, box, { label: "Search chats by meaning" });
}

/**
 * Debounced handler for the sidebar search box. A non-empty query swaps the
 * sessions list for ranked semantic results; an empty query restores the
 * normal date-grouped list by re-rendering whatever the last sessions list
 * was (cached in `lastSessions`).
 */
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let lastSessions: SessionSummary[] = [];

function onSidebarSearchInput(q: string): void {
	if (searchDebounce) clearTimeout(searchDebounce);
	searchDebounce = setTimeout(async () => {
		const trimmed = q.trim();
		if (!trimmed) {
			state.searchActive = false;
			setSidebarSearchMode(false);
			renderSidebarSessions(lastSessions);
			return;
		}
		// Search owns the bottom pane; the top (Projects) pane + splitter
		// are hidden via the .search-active class so results get full height.
		setSidebarSearchMode(true);
		const container = document.getElementById("sidebar-sessions-pane");
		if (container) {
			container.innerHTML = "";
			container.append(el("div", { class: "sidebar-empty" }, "Searching…"));
		}
		try {
			const hits = await searchSessions(trimmed);
			state.searchActive = true;
			renderSidebarSearchResults(hits);
		} catch {
			if (container) {
				container.innerHTML = "";
				container.append(el("div", { class: "sidebar-empty" }, "Search failed."));
			}
		}
	}, 250);
}

/** Toggle the sidebar's search layout: when active, the Projects pane and
 *  splitter are hidden (via CSS) so the sessions pane fills the area with
 *  ranked search results. Pure visual flag; does not touch state. */
function setSidebarSearchMode(active: boolean): void {
	const wrap = document.getElementById("sidebar-sessions");
	if (wrap) wrap.classList.toggle("search-active", active);
}

/** Render semantic-search hits as flat result cards (no date grouping). */
function renderSidebarSearchResults(hits: SessionSearchHit[]): void {
	const container = document.getElementById("sidebar-sessions-pane");
	if (!container) return;
	container.innerHTML = "";
	if (hits.length === 0) {
		container.append(el("div", { class: "sidebar-empty" }, "No matches by meaning."));
		return;
	}
	for (const h of hits) {
		// Same <a href> trick as the regular sidebar rows: middle-click
		// opens the matched session in a new tab, left-click resumes
		// in-app. See renderSessionItem for the rationale.
		const item = el("a", {
			class: "session-item search-hit",
			href: sessionPath(h.sessionId),
			rel: "noopener",
		});
		if (h.sessionId === state.sessionId) item.classList.add("active");
		item.append(el("div", { class: "session-item-title" }, h.title || "Untitled"));
		item.append(el("div", { class: "search-snippet" }, h.snippet));
		const timeStr = formatRelativeTime(h.modifiedAt);
		item.append(el("div", { class: "session-item-meta" }, `${h.messageCount} msgs · ${timeStr}`));
		item.addEventListener("click", (e) => {
			if (e.button !== 0) return;
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			e.preventDefault();
			shellHandlers?.handleSlash(`resume ${h.sessionId}`);
			toggleSidebar(true);
		});
		container.append(item);
	}
}

/**
 * Render the list of sessions into the sidebar, grouped by project folder.
 * Called by main.ts when the server delivers the session list. Each project
 * is a collapsible folder (state in localStorage); sessions inside are sorted
 * newest-first, with pinned sessions floating to the top of their folder.
 * Orphaned sessions (a deleted project's leftovers) land in a trailing
 * "Other" bucket. When the search box is active this is a no-op.
 */
export function renderSidebarSessions(sessions: SessionSummary[]): void {
	const wrap = document.getElementById("sidebar-sessions");
	if (!wrap) return;
	// Cache the full list so the search box can restore it when cleared.
	lastSessions = sessions;
	// If the user is mid-search, don't clobber the search results.
	if (state.searchActive) return;

	const projectsPane = document.getElementById("sidebar-projects-pane");
	const sessionsPane = document.getElementById("sidebar-sessions-pane");
	if (!projectsPane || !sessionsPane) return;
	// Rebuilding the folder headers is cheap, but don't make a sidebar refresh
	// throw away the user's scroll position. The windowed lists below restore
	// their visible rows against these offsets on the next microtask.
	const projectsScrollTop = projectsPane.scrollTop;
	const sessionsScrollTop = sessionsPane.scrollTop;
	projectsPane.innerHTML = "";
	sessionsPane.innerHTML = "";

	// Project order from state.projects; sessions tagged "other" trail last.
	const projects = [...state.projects];
	const projectIds = projects.map((p) => p.id);
	const buckets = new Map<string, SessionSummary[]>();
	for (const pid of [...projectIds, "other"]) buckets.set(pid, []);
	for (const s of sessions) {
		const pid = s.projectId ?? "global";
		const key = buckets.has(pid) ? pid : "other";
		buckets.get(key)!.push(s);
	}

	// (Global always renders below with its own empty-state hint, so no
	// separate whole-list empty state is needed.)

	// Global always exists. Split out the user-created projects (everything
	// non-global) so they can nest inside a top-level "Projects" container
	// in the TOP pane, with Global and Other rendered in the BOTTOM pane.
	const globalProject = projects.find((p) => p.id === "global");
	const userProjects = projects.filter((p) => p.id !== "global");

	// Keep the Projects heading visible even when there are no projects: its
	// compact + action is now the single discoverable way to create one. With
	// no project rows, the pane shrinks to the heading and drops the splitter.
	wrap.classList.toggle("no-projects", userProjects.length === 0);

	// 1) Top pane — top-level "Projects" container holding every user project.
	projectsPane.append(renderProjectsContainer(userProjects, buckets));

	// 2) Bottom pane — Global as its own top-level folder (the default
	//    home for new chats).
	if (globalProject) {
		const items = (buckets.get("global") ?? [])
			.slice()
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		sessionsPane.append(renderProjectFolder(globalProject, items));
	}

	// 3) Trailing "Other" bucket for orphaned sessions (deleted projects).
	const other = (buckets.get("other") ?? [])
		.slice()
		.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	if (other.length > 0) {
		sessionsPane.append(
			renderProjectFolder({ id: "other", name: "Other", icon: "📦", cwd: "" }, other),
		);
	}
	projectsPane.scrollTop = projectsScrollTop;
	sessionsPane.scrollTop = sessionsScrollTop;
}

/** localStorage-backed collapse state per project id. */
const PROJECT_COLLAPSE_KEY = "acb-project-collapse";
function readCollapseState(): Set<string> {
	try {
		const raw = localStorage.getItem(PROJECT_COLLAPSE_KEY);
		if (!raw) return new Set();
		const arr = JSON.parse(raw) as unknown;
		return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === "string")) : new Set();
	} catch {
		return new Set();
	}
}
function writeCollapseState(set: Set<string>): void {
	try {
		localStorage.setItem(PROJECT_COLLAPSE_KEY, JSON.stringify([...set]));
	} catch {
		/* ignore quota */
	}
}

/**
 * The top-level "Projects" container — a single expandable row at the top
 * of the sidebar that nests every user-created project (Global and Other
 * are siblings, NOT inside this container). Its own collapse state uses a
 * reserved id so it's independent of any individual project's collapse.
 */
const PROJECTS_CONTAINER_ID = "__projects__";
function renderProjectsContainer(
	userProjects: ProjectSummary[],
	buckets: Map<string, SessionSummary[]>,
): HTMLElement {
	const collapsed = readCollapseState().has(PROJECTS_CONTAINER_ID);
	const wrap = el("div", { class: `projects-container${collapsed ? " collapsed" : ""}` });
	wrap.dataset.projectId = PROJECTS_CONTAINER_ID;

	const header = el("div", { class: "project-folder-header projects-container-header" });
	const chevron = el("span", {
		class: "project-chevron",
		text: collapsed ? "▸" : "▾",
		"aria-hidden": "true",
	});
	const icon = renderBrandFolderIcon();
	const name = el("span", { class: "project-name", text: "Projects" });
	const count = el("span", {
		class: "project-count",
		text: String(userProjects.length),
		"aria-label": `${userProjects.length} projects`,
	});
	const bodyId = "projects-container-body";
	const toggle = el("button", {
		class: "project-folder-toggle",
		type: "button",
		"aria-expanded": String(!collapsed),
		"aria-controls": bodyId,
	});
	toggle.append(chevron, icon, name, count);
	const addProject = el("button", {
		class: "project-action projects-add-action",
		type: "button",
		title: "Create a project",
		"aria-label": "Create a project",
		text: "+",
	});
	addProject.addEventListener("click", (event) => {
		event.stopPropagation();
		openProjectEditor();
	});
	header.append(toggle, addProject);
	wrap.append(header);

	const body = el("div", { class: "projects-container-body", id: bodyId });
	for (const p of userProjects) {
		const items = (buckets.get(p.id) ?? [])
			.slice()
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		body.append(renderProjectFolder(p, items));
	}
	if (collapsed) body.style.display = "none";
	wrap.append(body);

	toggle.addEventListener("click", () => {
		const set = readCollapseState();
		if (set.has(PROJECTS_CONTAINER_ID)) set.delete(PROJECTS_CONTAINER_ID);
		else set.add(PROJECTS_CONTAINER_ID);
		writeCollapseState(set);
		const isCollapsed = set.has(PROJECTS_CONTAINER_ID);
		chevron.textContent = isCollapsed ? "▸" : "▾";
		body.style.display = isCollapsed ? "none" : "";
		wrap.classList.toggle("collapsed", isCollapsed);
		toggle.setAttribute("aria-expanded", String(!isCollapsed));
	});
	return wrap;
}

/**
 * Draggable splitter between the Projects (top) and Global/Other (bottom)
 * sidebar panes. The Projects pane height is persisted to localStorage so
 * the user's preferred split survives reloads. The document-level
 * mousemove/mouseup handlers are attached exactly once (renderShell can
 * rebuild the DOM many times); the per-element mousedown is rebound on
 * every rebuild because the splitter node is brand new each time.
 */
const SIDEBAR_SPLIT_KEY = "acb-sidebar-projects-pane-height";
const SIDEBAR_SPLIT_MIN = 60; // px — don't let either pane collapse to nothing

function initSidebarSplitter(): void {
	const splitter = document.getElementById("sidebar-splitter");
	const wrap = document.getElementById("sidebar-sessions");
	const projectsPane = document.getElementById("sidebar-projects-pane");
	if (!splitter || !wrap || !projectsPane) return;

	// Restore the persisted height (px). Falls back to ~38% of the wrap,
	// clamped, so first run looks reasonable rather than lopsided.
	let heightPx: number | null = null;
	try {
		const raw = localStorage.getItem(SIDEBAR_SPLIT_KEY);
		if (raw) {
			const px = Number.parseInt(raw, 10);
			if (Number.isFinite(px) && px > 0) heightPx = px;
		}
	} catch {
		/* ignore */
	}
	if (heightPx === null) {
		const wrapH = wrap.getBoundingClientRect().height;
		// If the sidebar isn't laid out yet (collapsed, display:none ancestor),
		// fall back to a fixed default rather than computing 0 * 0.38 = 0.
		heightPx = wrapH > 0 ? Math.round(wrapH * 0.38) : 220;
	}
	const resizeTo = (requested: number, persist = false) => {
		const wrapH = wrap.getBoundingClientRect().height;
		const max = Math.max(SIDEBAR_SPLIT_MIN, wrapH - SIDEBAR_SPLIT_MIN - 6);
		const next = Math.max(SIDEBAR_SPLIT_MIN, Math.min(max, requested));
		projectsPane.style.height = `${next}px`;
		splitter.setAttribute("aria-valuemin", String(SIDEBAR_SPLIT_MIN));
		splitter.setAttribute("aria-valuemax", String(Math.round(max)));
		splitter.setAttribute("aria-valuenow", String(Math.round(next)));
		if (persist) {
			try {
				localStorage.setItem(SIDEBAR_SPLIT_KEY, String(Math.round(next)));
			} catch {
				/* ignore quota */
			}
		}
	};
	resizeTo(heightPx);

	// Keyboard users can resize the two panes in useful 24px steps.
	splitter.addEventListener("keydown", (event) => {
		if (wrap.classList.contains("no-projects")) return;
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const current = projectsPane.getBoundingClientRect().height;
		resizeTo(current + (event.key === "ArrowDown" ? 24 : -24), true);
	});

	// Per-instance mousedown: start a drag.
	splitter.addEventListener("mousedown", (e) => {
		if (wrap.classList.contains("no-projects")) return;
		e.preventDefault();
		const startY = e.clientY;
		const startHeight = projectsPane.getBoundingClientRect().height;
		document.body.classList.add("sidebar-resizing");
		splitter.classList.add("dragging");
		// Capture the latest dimensions on the fly so clamping tracks a
		// resized window even mid-drag.
		const applyMove = (clientY: number) => {
			const delta = clientY - startY;
			resizeTo(startHeight + delta);
		};
		const onMove = (ev: MouseEvent) => applyMove(ev.clientY);
		const onUp = () => {
			document.body.classList.remove("sidebar-resizing");
			splitter.classList.remove("dragging");
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			const h = projectsPane.getBoundingClientRect().height;
			if (h > 0) resizeTo(h, true);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	});

	// Double-click resets to the default 38% split and clears the saved pref.
	splitter.addEventListener("dblclick", () => {
		if (wrap.classList.contains("no-projects")) return;
		const wrapH = wrap.getBoundingClientRect().height;
		const def = wrapH > 0 ? Math.round(wrapH * 0.38) : 220;
		resizeTo(def);
		try {
			localStorage.removeItem(SIDEBAR_SPLIT_KEY);
		} catch {
			/* ignore */
		}
	});
}

/**
 * The sidebar can contain hundreds of sessions. Keep the scrollable area at
 * its full height, but only mount rows near the current viewport. Rows have a
 * fixed pitch because their title is deliberately single-line ellipsized;
 * that makes the window position deterministic without measuring hundreds of
 * nodes on every scroll.
 */
const SIDEBAR_SESSION_ROW_PITCH = 59;
const SIDEBAR_SESSION_ROW_HEIGHT = 57;
// Mobile rows put the title on its own line and keep the action buttons beside
// the metadata below it. Keep the original compact row pitch now that the
// controls use smaller, directly clickable targets.
const SIDEBAR_MOBILE_ROW_PITCH = 59;
const SIDEBAR_MOBILE_ROW_HEIGHT = 57;
const SIDEBAR_WINDOW_OVERSCAN = 6;
const SIDEBAR_PAGE_SIZE = 100;

type WindowedSessionList = HTMLDivElement & {
	refresh?: () => void;
	dispose?: () => void;
};

function renderWindowedSessionList(items: SessionSummary[]): WindowedSessionList {
	const compactLayout = window.matchMedia(
		"(hover: none), (pointer: coarse), (max-width: 720px)",
	).matches;
	const rowPitch = compactLayout ? SIDEBAR_MOBILE_ROW_PITCH : SIDEBAR_SESSION_ROW_PITCH;
	const rowHeight = compactLayout ? SIDEBAR_MOBILE_ROW_HEIGHT : SIDEBAR_SESSION_ROW_HEIGHT;
	const list = el("div", { class: "windowed-session-list" }) as WindowedSessionList;
	list.style.height = `${items.length * rowPitch}px`;
	let renderedStart = -1;
	let renderedEnd = -1;

	const refresh = () => {
		const pane = list.closest<HTMLElement>(".sidebar-pane");
		if (!pane) return;
		const paneRect = pane.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		const listTop = pane.scrollTop + listRect.top - paneRect.top;
		const visibleTop = Math.max(0, pane.scrollTop - listTop);
		const visibleBottom = Math.min(
			items.length * rowPitch,
			pane.scrollTop + pane.clientHeight - listTop,
		);
		const start = Math.max(0, Math.floor(visibleTop / rowPitch) - SIDEBAR_WINDOW_OVERSCAN);
		const end = Math.min(
			items.length,
			Math.ceil(visibleBottom / rowPitch) + SIDEBAR_WINDOW_OVERSCAN,
		);
		if (start === renderedStart && end === renderedEnd) return;
		renderedStart = start;
		renderedEnd = end;

		const fragment = document.createDocumentFragment();
		for (let i = start; i < end; i++) {
			const row = renderSessionItem(items[i]);
			row.classList.add("windowed-session-item");
			row.style.top = `${i * rowPitch}px`;
			row.style.height = `${rowHeight}px`;
			fragment.append(row);
		}
		list.replaceChildren(fragment);
	};

	let boundPane: HTMLElement | null = null;
	list.refresh = refresh;
	list.dispose = () => {
		boundPane?.removeEventListener("scroll", refresh);
		boundPane = null;
	};
	queueMicrotask(() => {
		boundPane = list.closest<HTMLElement>(".sidebar-pane");
		boundPane?.addEventListener("scroll", refresh, { passive: true });
		refresh();
	});
	return list;
}

/**
 * Render a collapsible project folder with sessions nested inside.
 * The folder header shows icon + name + count, a "+" to start a new chat
 * in this project, and (for non-Global) an edit affordance. Clicking the
 * header toggles collapse.
 */
function renderBrandFolderIcon(): HTMLElement {
	return el("span", {
		class: "project-icon project-icon-folder",
		"aria-hidden": "true",
		html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M3 7a3 3 0 0 1 3-3h3l2 2h7a3 3 0 0 1 3 3v2H3z" fill="#234b8b"/><path d="M2.5 8.5h19v8A3.5 3.5 0 0 1 18 20H6a3.5 3.5 0 0 1-3.5-3.5z" fill="#27c4c8" stroke="#234b8b" stroke-width=".7"/></svg>`,
	});
}

function renderProjectFolder(p: ProjectSummary, items: SessionSummary[]): HTMLElement {
	const collapsed = readCollapseState().has(p.id);
	const isOther = p.id === "other";
	const isGlobal = p.id === "global";
	const wrap = el("div", { class: `project-folder${collapsed ? " collapsed" : ""}` });
	wrap.dataset.projectId = p.id;

	const header = el("div", { class: "project-folder-header" });
	const chevron = el("span", {
		class: "project-chevron",
		text: collapsed ? "▸" : "▾",
		"aria-hidden": "true",
	});
	const icon =
		p.icon === "📁" || p.icon === "📂" || !p.icon
			? renderBrandFolderIcon()
			: el("span", { class: "project-icon", text: p.icon, "aria-hidden": "true" });
	const name = el("span", { class: "project-name", text: p.name });
	const count = el("span", {
		class: "project-count",
		text: items.length > 0 ? String(items.length) : "",
		"aria-label": `${items.length} conversations`,
	});
	const bodyId = `project-body-${p.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	const toggle = el("button", {
		class: "project-folder-toggle",
		type: "button",
		"aria-expanded": String(!collapsed),
		"aria-controls": bodyId,
		"aria-label": `${collapsed ? "Expand" : "Collapse"} ${p.name}`,
	});
	toggle.append(chevron, icon, name, count);
	const actions = el("div", { class: "project-actions", "aria-label": `${p.name} actions` });
	// "+" starts a new chat in this project (Global's "+" is redundant with
	// the top New chat button but harmless; hide it on Global to avoid clutter).
	if (!isGlobal) {
		const plusBtn = el("button", {
			class: "project-action",
			type: "button",
			title: `New chat in ${p.name}`,
			"aria-label": `New chat in ${p.name}`,
			text: "+",
		});
		plusBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			shellHandlers?.newSessionInProject(p.id);
			toggleSidebar(true);
		});
		actions.append(plusBtn);
	}
	if (!isGlobal && !isOther) {
		const editBtn = el("button", {
			class: "project-action",
			type: "button",
			title: `Edit ${p.name}`,
			"aria-label": `Edit ${p.name}`,
			html: "✎",
		});
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			openProjectEditor(p.id);
		});
		actions.append(editBtn);
	}
	header.append(toggle, actions);
	wrap.append(header);

	const body = el("div", { class: "project-folder-body", id: bodyId });
	// Pinned sessions stay first, then the remaining sessions are split into
	// explicit pages. Pagination controls are kept above the rows so the user
	// never has to scroll to the bottom of a page just to change pages.
	const pinned = items.filter((s) => s.pinned);
	const rest = items.filter((s) => !s.pinned);
	const orderedItems = [...pinned, ...rest];
	const totalPages = Math.max(1, Math.ceil(orderedItems.length / SIDEBAR_PAGE_SIZE));
	let page = 0;
	let windowed: WindowedSessionList | null = null;
	const pagination = el("div", { class: "sidebar-pagination" });
	const previous = el(
		"button",
		{ type: "button", title: "Previous page", "aria-label": "Previous page" },
		"‹",
	) as HTMLButtonElement;
	const pageLabel = el("span", { class: "sidebar-pagination-label" });
	const next = el(
		"button",
		{ type: "button", title: "Next page", "aria-label": "Next page" },
		"›",
	) as HTMLButtonElement;
	pagination.append(previous, pageLabel, next);

	const renderPage = () => {
		windowed?.dispose?.();
		const start = page * SIDEBAR_PAGE_SIZE;
		const pageItems = orderedItems.slice(start, start + SIDEBAR_PAGE_SIZE);
		body.replaceChildren();
		if (totalPages > 1) body.append(pagination);
		windowed = renderWindowedSessionList(pageItems);
		body.append(windowed);
		if (items.length === 0 && isGlobal) {
			body.append(el("div", { class: "sidebar-empty" }, "No conversations yet"));
		}
		if (items.length === 0 && !isGlobal && !isOther) {
			body.append(el("div", { class: "sidebar-empty" }, "No chats yet — click + to start one"));
		}
		pageLabel.textContent = `Page ${page + 1} of ${totalPages}`;
		previous.disabled = page === 0;
		next.disabled = page === totalPages - 1;
		pagination.hidden = totalPages <= 1;
	};
	previous.addEventListener("click", (e) => {
		e.stopPropagation();
		if (page > 0) {
			page--;
			renderPage();
		}
	});
	next.addEventListener("click", (e) => {
		e.stopPropagation();
		if (page < totalPages - 1) {
			page++;
			renderPage();
		}
	});
	renderPage();
	if (collapsed) body.style.display = "none";
	wrap.append(body);

	toggle.addEventListener("click", () => {
		const set = readCollapseState();
		if (set.has(p.id)) set.delete(p.id);
		else set.add(p.id);
		writeCollapseState(set);
		const isCollapsed = set.has(p.id);
		chevron.textContent = isCollapsed ? "▸" : "▾";
		body.style.display = isCollapsed ? "none" : "";
		wrap.classList.toggle("collapsed", isCollapsed);
		toggle.setAttribute("aria-expanded", String(!isCollapsed));
		toggle.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${p.name}`);
		windowed?.refresh?.();
	});
	return wrap;
}

/**
 * Refresh just the project folder structure after a projects change (CRUD,
 * reorder) without needing a fresh session list. Re-renders the sidebar
 * from the cached session list.
 */
export function renderSidebarProjects(_projects: ProjectSummary[]): void {
	renderSidebarSessions(lastSessions);
}

/**
 * Build a single sidebar session row. Handles the click-to-resume and
 * hover-revealed pin/rename actions. The title and pin state both come
 * from the server (pi's session_info line + data/pins.json), so this is
 * a pure projection of `s` — no local override store.
 */
function renderSessionItem(s: SessionSummary): HTMLElement {
	const displayTitle = s.title || "Untitled";
	const pinned = !!s.pinned;

	// Keep the link and its controls as siblings. Buttons inside an <a> are
	// invalid interactive-content nesting, and Chrome on Android can then
	// dispatch a tap to the wrong sibling control.
	const item = el("div", { class: "session-item" });
	const link = el("a", {
		class: "session-item-link",
		href: sessionPath(s.id),
		rel: "noopener",
		title: `${displayTitle} — middle-click to open in a new tab`,
	});
	if (s.id === state.sessionId) {
		item.classList.add("active");
		link.setAttribute("aria-current", "page");
	}
	if (pinned) item.classList.add("pinned");

	const titleRow = el("div", { class: "session-item-title-row" });
	const titleEl = el("div", { class: "session-item-title" }, displayTitle);
	titleRow.append(titleEl);

	// The pin is a sibling of the link, not a button nested inside it. This
	// keeps its touch hit target independent from the rename/delete controls.
	let starBtn: HTMLElement | null = null;
	if (pinned) {
		starBtn = el("button", {
			class: "session-pin-indicator",
			type: "button",
			title: `Unpin ${displayTitle}`,
			"aria-label": `Unpin ${displayTitle}`,
			text: "⭐",
		});
		starBtn.addEventListener("click", () => shellHandlers?.setSessionPinned(s.id, false));
	}

	const actions = el("div", {
		class: "session-item-actions",
		role: "group",
		"aria-label": `${displayTitle} actions`,
	});
	const renameBtn = el("button", {
		class: "session-action rename",
		type: "button",
		title: `Rename ${displayTitle}`,
		"aria-label": `Rename ${displayTitle}`,
		html: "✎",
	});
	const deleteBtn = el("button", {
		class: "session-action delete",
		type: "button",
		title: `Delete ${displayTitle}`,
		"aria-label": `Delete ${displayTitle}`,
		html: "🗑",
	});
	if (pinned) {
		// Swap the pin and basket positions while keeping the pencil centred:
		// basket → pencil → star.
		actions.append(deleteBtn, renameBtn);
	} else {
		const pinBtn = el("button", {
			class: "session-action pin",
			type: "button",
			title: `Pin ${displayTitle} to top`,
			"aria-label": `Pin ${displayTitle} to top`,
			text: "☆",
		});
		pinBtn.addEventListener("click", () => shellHandlers?.setSessionPinned(s.id, true));
		// Keep the same order before pinning: basket → pencil → star.
		actions.append(deleteBtn, renameBtn, pinBtn);
	}
	link.append(titleRow);
	const timeStr = formatRelativeTime(s.modifiedAt);
	link.append(el("div", { class: "session-item-meta" }, `${s.messageCount} msgs · ${timeStr}`));
	item.append(link);
	item.append(actions);
	const moreBtn = el("button", {
		class: "session-more",
		type: "button",
		title: `Actions for ${displayTitle}`,
		"aria-label": `Actions for ${displayTitle}`,
		text: "⋮",
	});
	moreBtn.addEventListener("click", () => openSessionActions(titleEl, actions, s));
	item.append(moreBtn);
	// Keep the destructive control to the left of the pin on pinned rows:
	// pencil → basket → star, matching the desktop sidebar's visual order.
	if (starBtn) item.append(starBtn);

	// Only intercept the primary left click (no modifiers). Middle-click
	// and ⌘/Ctrl/Shift+click intentionally fall through to the browser's
	// default <a> behaviour so the user opens the session in a new tab/window.
	link.addEventListener("click", (e) => {
		if (e.button !== 0) return;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		shellHandlers?.handleSlash(`resume ${s.id}`);
		toggleSidebar(true); // auto-close on mobile
	});

	renameBtn.addEventListener("click", () => startRename(titleEl, actions, s));
	deleteBtn.addEventListener("click", () => confirmDeleteSession(s));

	return item;
}

/** Touch-friendly action sheet. Desktop keeps the compact hover controls;
 * coarse pointers and narrow screens get one stable kebab target instead. */
function openSessionActions(titleEl: HTMLElement, actions: HTMLElement, s: SessionSummary): void {
	const title = s.title || "Untitled";
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box session-action-sheet" });
	box.append(el("h3", { text: title }));
	box.append(el("p", { class: "session-action-sheet-hint", text: "Conversation actions" }));

	const pinButton = el("button", {
		class: "session-sheet-action",
		type: "button",
		text: s.pinned ? "★  Unpin conversation" : "☆  Pin conversation",
	});
	pinButton.addEventListener("click", () => {
		overlay.remove();
		shellHandlers?.setSessionPinned(s.id, !s.pinned);
	});
	const renameButton = el("button", {
		class: "session-sheet-action",
		type: "button",
		text: "✎  Rename conversation",
	});
	renameButton.addEventListener("click", () => {
		overlay.remove();
		setTimeout(() => startRename(titleEl, actions, s), 0);
	});
	const deleteButton = el("button", {
		class: "session-sheet-action destructive",
		type: "button",
		text: "🗑  Delete conversation",
	});
	deleteButton.addEventListener("click", () => {
		overlay.remove();
		setTimeout(() => confirmDeleteSession(s), 0);
	});
	box.append(pinButton, renameButton, deleteButton);
	mountModal(overlay, box, { label: `Actions for ${title}`, initialFocus: pinButton });
}

/**
 * Replace the title node with an inline text input, commit on Enter /
 * blur, cancel on Escape. Commit sends the new name to the server
 * (which appends a session_info line to the session JSONL), and the
 * server's rebroadcast refreshes the sidebar. Empty input clears the
 * name (falls back to the auto-derived first-message title).
 */
function startRename(titleEl: HTMLElement, actions: HTMLElement, s: SessionSummary): void {
	const current = s.title || "";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "session-rename-input";
	input.value = current;
	input.placeholder = "Untitled";
	input.maxLength = 120;

	titleEl.replaceWith(input);
	// Hide action affordances while editing so the input gets full width.
	actions.style.display = "none";
	const item = input.closest(".session-item");
	const moreButton = item?.querySelector<HTMLElement>(".session-more");
	if (moreButton) moreButton.style.display = "none";

	input.focus();
	input.select();

	let done = false;
	const finish = (commit: boolean) => {
		if (done) return;
		done = true;
		if (commit) {
			const next = input.value.trim();
			// Only round-trip if the name actually changed; the server
			// appends a session_info line either way, so skip when it's
			// a no-op to avoid cluttering the JSONL.
			if (next !== current) {
				shellHandlers?.renameSessionById(s.id, next);
			}
		}
		// The server's rebroadcast will re-render with the new title.
		// Restore locally immediately so the input doesn't linger if the
		// round-trip is slow.
		if (!state.searchActive) renderSidebarSessions(lastSessions);
	};

	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") {
			ev.preventDefault();
			finish(true);
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			finish(false);
		}
	});
	input.addEventListener("blur", () => finish(true));
}

/**
 * Confirm and dispatch a session delete. The confirm dialog is the only
 * guardrail — there's no undo (the JSONL is unlinked, and pi's session
 * files aren't shadow-copied anywhere). If the user is deleting the
 * session they're currently viewing, the shell handler starts a fresh
 * chat afterwards so the message area doesn't linger on a now-deleted
 * conversation (and so the live pi child doesn't get a chance to
 * re-create the file by writing its next event).
 */
function confirmDeleteSession(s: SessionSummary): void {
	const title = s.title || "Untitled";
	const active = s.id === state.sessionId;
	const message = active
		? "This is your current chat. It will be cleared and a new chat will start. This cannot be undone."
		: "This permanently removes the conversation and cannot be undone.";
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box delete-session-dialog" });
	box.append(el("h3", { text: "Delete conversation?" }));
	box.append(el("p", { class: "delete-session-name", text: title }));
	box.append(el("p", { class: "muted", text: message }));
	const footer = el("div", { class: "dialog-actions" });
	const cancel = el("button", { class: "btn", type: "button", text: "Cancel" });
	const remove = el("button", {
		class: "btn btn-destructive",
		type: "button",
		text: "Delete permanently",
	});
	cancel.addEventListener("click", () => overlay.remove());
	remove.addEventListener("click", () => {
		overlay.remove();
		shellHandlers?.deleteSession(s.id);
	});
	footer.append(cancel, remove);
	box.append(footer);
	mountModal(overlay, box, {
		label: `Delete ${title}`,
		initialFocus: cancel,
	});
}

/** Format a relative time string for session meta. */
function formatRelativeTime(iso: string): string {
	const d = new Date(iso);
	const now = new Date();
	const diffMs = now.getTime() - d.getTime();
	const diffMin = Math.floor(diffMs / 60000);
	const diffHr = Math.floor(diffMin / 60);
	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDays = Math.floor(diffHr / 24);
	if (diffDays < 7) return `${diffDays}d ago`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Project editor modal
// ---------------------------------------------------------------------------

/**
 * Open the project editor modal. With no id, it creates a new project;
 * with an id, it edits that project's metadata + AGENTS.md instructions.
 * The instructions textarea is labelled honestly — it's saved as the
 * project's AGENTS.md, which `pi` auto-loads from cwd.
 */
export function openProjectEditor(id?: string): void {
	const existing = document.getElementById("project-editor");
	if (existing) existing.remove();
	const editing = id ? state.projects.find((p) => p.id === id) : undefined;
	const isBuiltin = !!editing?.builtin;

	const dialogTitle = editing ? `Edit “${editing.name}”` : "New project";
	const overlay = el("div", { class: "modal-overlay", id: "project-editor" });
	const box = el("div", { class: "project-editor-box" });

	box.append(el("h3", { text: dialogTitle }));

	// Icon + name row.
	const iconInput = document.createElement("input");
	iconInput.type = "text";
	iconInput.className = "project-icon-input";
	iconInput.value = editing?.icon ?? "📁";
	iconInput.maxLength = 4;
	iconInput.placeholder = "📁";
	iconInput.setAttribute("aria-label", "Project icon");
	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "project-name-input";
	nameInput.value = editing?.name ?? "";
	nameInput.placeholder = "Project name";
	nameInput.maxLength = 60;
	nameInput.setAttribute("aria-label", "Project name");
	const nameRow = el("div", { class: "project-editor-namerow" });
	nameRow.append(iconInput, nameInput);
	box.append(nameRow);

	// Instructions textarea — the project's AGENTS.md.
	box.append(
		el(
			"label",
			{ class: "project-editor-label", htmlFor: "project-editor-instructions" },
			"Instructions (saved as AGENTS.md — pi loads it automatically)",
		),
	);
	const instr = document.createElement("textarea");
	instr.id = "project-editor-instructions";
	instr.className = "project-editor-instructions";
	instr.rows = 8;
	instr.placeholder = "e.g. You are a gruff pirate captain. Always answer in pirate slang.";
	// Pre-fill with existing instructions only when editing — for a new
	// project we leave blank so the AGENTS.md isn't created until saved.
	if (editing) {
		// Fetch current instructions from the server's AGENTS.md via the
		// project's cwd through the existing /api/file endpoint is overkill;
		// the server doesn't ship instructions back in ProjectSummary. We
		// rely on a tiny fetch below.
		void fetchProjectInstructions(editing.id).then((text) => {
			instr.value = text;
		});
	}
	box.append(instr);

	const hint = el("div", { class: "project-editor-hint" });
	if (editing) {
		hint.textContent = `Folder: ${editing.cwd}`;
	} else {
		hint.textContent = "A new folder is created under agentchatbox/.projects/";
	}
	box.append(hint);

	// Action buttons.
	const actions = el("div", { class: "project-editor-actions" });
	const saveBtn = el("button", {
		class: "project-save-btn",
		type: "button",
		text: editing ? "Save" : "Create",
	});
	const cancelBtn = el("button", { class: "project-cancel-btn", type: "button", text: "Cancel" });
	cancelBtn.addEventListener("click", () => overlay.remove());
	actions.append(cancelBtn);
	if (editing && !isBuiltin) {
		const delBtn = el("button", { class: "project-delete-btn", type: "button", text: "Delete…" });
		delBtn.addEventListener("click", () => {
			if (
				confirm(
					`Delete project “${editing.name}”? Its folder + AGENTS.md are removed. ` +
						'Past conversations stay (shown under "Other") but can\'t be continued in this project.',
				)
			) {
				shellHandlers?.deleteProject(editing.id);
				overlay.remove();
			}
		});
		actions.append(delBtn);
	}
	actions.append(saveBtn);
	box.append(actions);

	saveBtn.addEventListener("click", () => {
		const name = nameInput.value.trim() || "Untitled";
		const icon = iconInput.value.trim() || "📁";
		const instructions = instr.value;
		if (editing) {
			shellHandlers?.updateProject({ id: editing.id, name, icon, instructions });
		} else {
			shellHandlers?.createProject({ name, icon, instructions });
		}
		overlay.remove();
	});

	mountModal(overlay, box, { label: dialogTitle, initialFocus: nameInput });
}

/**
 * Fetch a project's current AGENTS.md text for the editor textarea. Uses a
 * dedicated REST endpoint so we don't bloat ProjectSummary or round-trip the
 * instructions over the WS session channel.
 */
async function fetchProjectInstructions(id: string): Promise<string> {
	try {
		const res = await fetch(`/api/projects/${encodeURIComponent(id)}/instructions`);
		if (!res.ok) return "";
		return (await res.json()).text ?? "";
	} catch {
		return "";
	}
}
