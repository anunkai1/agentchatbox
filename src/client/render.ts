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
import { $, el, escapeHtml, type LiveAssistantDom } from "./dom.js";
import { setRichText } from "./linkify.js";
import { services } from "./services.js";
import { type PersistedMessage, state, voiceRewriteLabel } from "./state.js";
import { sessionPath } from "./url.js";
import { formatAbsolute, formatRelative } from "./time.js";

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
	sendBtn.title = s
		? "Steer — queue this for after the current turn (⌘/Ctrl+Enter)"
		: "Send (⌘/Ctrl+Enter)";
	const stopBtn = $<HTMLButtonElement>("#stop-btn");
	stopBtn.hidden = !s;
	// Context-aware label mirroring the CLI: while a retry backoff is
	// counting down, Stop cancels the retry ("interrupt to cancel");
	// otherwise it aborts the whole run.
	stopBtn.title = state.retry ? "Cancel retry backoff" : "Stop the current run";
	if (!s) state.toolSpinner = null;
	startOrStopWorkingTick(s);
	refreshStatus();
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
			refreshStatus();
		}, 1000);
	} else if (workingTick) {
		clearInterval(workingTick);
		workingTick = null;
	}
}

export function renderHistory(): void {
	const list = $("#messages");
	list.innerHTML = "";
	for (const m of state.messages) {
		list.append(renderMessageNode(m));
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
		const bubble = el("div", { class: "bubble" }, m.text);
		if (m.ts !== undefined) bubble.append(makeTimestampEl(m.ts));
		row.append(bubble);
		if (m.seq !== undefined) row.append(makeForkButton(() => m.seq, { align: "right" }));
		return row;
	}
	if (m.kind === "steer") {
		// Steering message queued while the agent was running. Same
		// right-aligned bubble as a user message, but with a badge so
		// it's clear it's queued (not yet consumed by the agent) vs
		// delivered (folded into the next turn).
		const bubble = el("div", { class: "bubble steer-bubble" }, m.text);
		bubble.append(
			el(
				"span",
				{ class: `steer-badge${m.delivered ? " delivered" : ""}` },
				m.delivered ? "✓ delivered" : "⏳ queued",
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
			makeVoiceVariantButton("long", () => m.voiceLong ?? "", "Speak the detailed spoken version"),
		);
		body.append(
			makeVoiceVariantButton("medium", () => m.voiceMedium ?? "", "Speak a ~250-word summary"),
		);
		body.append(
			makeVoiceVariantButton("short", () => m.voiceShort ?? "", "Speak the concise summary"),
		);
		// Read-along box for the medium/short spoken variants (long is
		// TTS-only). Populated from state at render time; stays hidden
		// until a variant exists.
		const voiceBox = makeVoiceTextBox();
		updateVoiceTextBox(voiceBox, m);
		body.append(voiceBox);
		if (m.seq !== undefined) body.append(makeForkButton(() => m.seq));
		wrap.append(body);
		return wrap;
	}
	if (m.kind === "tool") {
		const wrap = el("div", { class: "row row-tool" });
		const card = el("div", { class: "tool-card" });
		const toolPath = toolPathFromArgs(m.args);
		mountToolHead(card, m.name, m.args, toolPath);
		if (m.result !== undefined) {
			card.append(el("pre", { class: `tool-result ${m.isError ? "tool-error" : ""}` }, m.result));
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
	steered.forEach((m, i) => {
		if (m.kind !== "steer") return;
		const node = nodes[i];
		if (!node) return;
		node.textContent = m.delivered ? "✓ delivered" : "⏳ queued";
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
				variant === "long"
					? m.voiceLong
					: variant === "medium"
						? m.voiceMedium
						: m.voiceShort) ?? "";
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
	const label =
		variant === "long" ? "🗣️ LongTTS" : variant === "medium" ? "📝 MedTTS" : "💬 ShortTTS";
	const btn = el("button", { class: "speak-btn voice-variant-btn", title }, label);
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
		showTtsBanner(`${label} · generating spoken text via ${voiceRewriteLabel()}…`);
		services.sendSlashCommand?.(`/voice-last ${variant}`);
	});
	return btn;
}

/**
 * The fork button copies the conversation up to and including this
 * message into a brand-new chat and switches to it. `getSeq` returns
 * the message's JSONL ordinal (how many messages a fork copies); it is
 * undefined only in the brief window before the ordinal is stamped, in
 * which case the button is a no-op. `{ align: "right" }` renders the
 * button for right-aligned user bubbles (mirrored layout).
 */
function makeForkButton(
	getSeq: () => number | undefined,
	opts?: { align?: "left" | "right" },
): HTMLElement {
	const btn = el(
		"button",
		{
			class: `fork-btn${opts?.align === "right" ? " fork-btn-right" : ""}`,
			title: "Fork into new chat",
		},
		"⑂",
	);
	btn.addEventListener("click", () => {
		const seq = getSeq();
		if (seq === undefined) return;
		services.forkFromMessage?.(seq);
	});
	return btn;
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
	if (downloadPath) head.append(makeFileDownloadLink(downloadPath));
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
function makeFileDownloadLink(path: string): HTMLAnchorElement {
	const url = `/api/file?path=${encodeURIComponent(path)}`;
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
		html:
			'<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M12 19V6"/><path d="M6 12l6-6 6 6"/></svg>',
	});
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
		makeVoiceVariantButton(
			"long",
			() => lastAssistantVoice("long"),
			"Speak the detailed spoken version",
		),
	);
	body.append(
		makeVoiceVariantButton(
			"medium",
			() => lastAssistantVoice("medium"),
			"Speak a ~250-word summary",
		),
	);
	body.append(
		makeVoiceVariantButton("short", () => lastAssistantVoice("short"), "Speak the concise summary"),
	);
	// Read-along box (hidden until a medium/short variant lands). Returned
	// so the voice-reply handler can populate it live without a re-render.
	const voiceBox = makeVoiceTextBox();
	body.append(voiceBox);
	body.append(makeForkButton(() => state.lastAssistantSeq ?? undefined));
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
	const card = row.querySelector(".tool-card");
	const pending = row.querySelector(".tool-pending");
	if (pending) pending.remove();
	if (card && result !== undefined) {
		card.append(el("pre", { class: `tool-result ${isError ? "tool-error" : ""}` }, result));
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
	const badge = document.getElementById("caps-badge");
	if (!badge) return;
	if (!caps || caps.length === 0) {
		badge.style.display = "none";
		return;
	}
	const skills = caps.filter((c) => c.source === "skill");
	const extPkgs = new Set(
		caps
			.filter((c) => c.source === "extension")
			.map((c) => c.sourceInfo?.source ?? c.name),
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
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});

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
			const row = el("div", { class: "caps-row caps-pkg-row" });
			row.append(el("span", { class: "caps-name" }, packageDisplayName(source)));
			row.append(el("span", { class: "caps-pkg" }, `${cmds.length}`));
			box.append(row);
			for (const c of cmds) {
				const cr = el("div", { class: "caps-row" });
				cr.append(el("span", { class: "caps-name" }, `/${c.name}`));
				if (c.description) cr.append(el("span", { class: "caps-desc" }, c.description));
				box.append(cr);
			}
		}
	}

	// Skills section — source === "skill". Names come from pi prefixed
	// `skill:`; strip it for display. Includes user-level skills (loose
	// SKILL.md files) the old package-only scanner never saw.
	const skillCmds = caps.filter((c) => c.source === "skill");
	if (skillCmds.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Skills"));
		for (const s of skillCmds) {
			const row = el("div", { class: "caps-row caps-pkg-row" });
			row.append(el("span", { class: "caps-name" }, s.name.replace(/^skill:/, "")));
			if (s.description) row.append(el("span", { class: "caps-desc" }, s.description));
			box.append(row);
		}
	}

	// Prompts section — prompt templates (project/user `.md` files).
	const promptCmds = caps.filter((c) => c.source === "prompt");
	if (promptCmds.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Prompts"));
		for (const p of promptCmds) {
			const row = el("div", { class: "caps-row caps-pkg-row" });
			row.append(el("span", { class: "caps-name" }, `/${p.name}`));
			if (p.description) row.append(el("span", { class: "caps-desc" }, p.description));
			box.append(row);
		}
	}

	box.append(
		el("button", { class: "btn caps-close-btn", text: "Close", onclick: () => overlay.remove() }),
	);
	overlay.append(box);
	document.body.append(overlay);
}

export function refreshStatus(): void {
	// The human-readable model label is resolved once per model change
	// (see state.refreshCurrentModelLabel) instead of searching the model
	// list here on every status tick (this fires each second while
	// streaming). Falls back to the raw id when no friendly name is known.
	const modelLabel = state.currentModelLabel || state.currentModelId || "(no model)";

	// Escape the dynamic bits we interpolate into innerHTML below.
	const esc = escapeHtml;

	const parts: string[] = [];
	parts.push(esc(modelLabel));
	parts.push(`think: ${esc(state.currentThinking)}`);
	const c = state.costTotal;
	parts.push(`${(c.input + c.output).toLocaleString()} tok`);
	if (c.cost > 0) parts.push(`$${c.cost.toFixed(4)}`);
	if (state.isStreaming) {
		// Elapsed-time working indicator — the CLI shows a spinner +
		// elapsed counter while a turn runs; agentchatbox used to show
		// only a static "streaming" dot, which made a slow-but-working
		// turn look identical to a hang. `streamingStartedAt` is set on
		// agent_start and cleared on agent_end. The elapsed tick is driven
		// by the retry-countdown interval below (1s cadence) so no extra
		// timer is needed when not retrying — fall back to a one-shot.
		const elapsed = state.streamingStartedAt
			? Math.max(0, Math.floor((Date.now() - state.streamingStartedAt) / 1000))
			: 0;
		const mm = Math.floor(elapsed / 60);
		const ss = elapsed % 60;
		parts.push(
			`<span class="streaming-dot"></span> streaming ${mm}:${ss.toString().padStart(2, "0")}`,
		);
	}
	if (state.retry) {
		// Mirror the CLI's retry loader verbatim:
		//   "Retrying (1/3) in 8s… (interrupt to cancel)"
		// plus the error message (the bit the CLI folds into the spinner
		// context but agentchatbox surfaces explicitly so you can see WHY
		// it's retrying — a transient 429 reads very differently from a
		// dead socket). Countdown is live-updated by startRetryCountdown.
		const r = state.retry;
		const secs = Math.max(0, Math.ceil(r.remainingMs / 1000));
		parts.push(
			`<span class="retry-banner">↻ Retrying (${r.attempt}/${r.maxAttempts}) in ${secs}s — ${esc(r.errorMessage)}</span>`,
		);
	}
	if (state.pendingSteerCount > 0) parts.push(`⟳ ${state.pendingSteerCount} queued`);
	// Voice activity — render as a single clickable stop button (not
	// inert text) so it's always reachable in a long session without
	// scrolling back to the message that started playback. The click is
	// handled by a delegated listener on #status-bar (set up once in
	// renderShell) so it survives this innerHTML rebuild, which fires on
	// every status tick during streaming.
	if (state.audioPlaying || state.audioPaused || state.ttsInFlight > 0) {
		if (state.audioPlaying || state.audioPaused) {
			// Playback active or paused — show pause/resume + stop controls.
			// The toggle button swaps between ⏸ (playing) and ▶ (paused); the
			// stop button (red ⏹) is always present to fully halt + clear.
			const toggle = state.audioPaused
				? `<button class="status-voice-ctrl" data-voice-resume title="Resume playback">▶</button>`
				: `<button class="status-voice-ctrl" data-voice-pause title="Pause playback">⏸</button>`;
			const label = state.audioPaused ? "‖ paused" : "♪ playing";
			parts.push(
				`${toggle}<button class="status-stop-voice" data-stop-voice title="Stop all voice">⏹</button> ${esc(label)}`,
			);
		} else {
			// Synthesizing — nothing to pause yet (no audio loaded). Keep the
			// single stop button with a spinner so the user can cancel.
			parts.push(
				`<button class="status-stop-voice" data-stop-voice title="Stop all voice"><span class="speak-spinner"></span> synthesizing…</button>`,
			);
		}
	}
	if (state.connectionStatus !== "open") {
		const tag =
			state.connectionStatus === "stalled"
				? "⚠ stalled — reconnecting"
				: `[${state.connectionStatus}]`;
		parts.push(esc(tag));
	}
	// innerHTML (not textContent) so the streaming dot can be a styled,
	// flashing <span>. All interpolated bits are escaped above.
	$("#status-bar").innerHTML = parts.join(" · ");
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
}

// ---------------------------------------------------------------------------
// Shell (the whole UI scaffold)
// ---------------------------------------------------------------------------

/**
 * Handlers for the header / composer buttons. main.ts wires these in
 * once at boot — renderShell just calls them. This indirection keeps
 * render.ts from importing slashes.ts and voice.ts at module top-level.
 */
export interface ShellHandlers {
	handleSend: () => void;
	historyBack: () => void;
	historyForward: () => void;
	showSlashMenu: () => void;
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
	abortRetry: () => void;
	/** Pin/unpin any session by id (sidebar star). Server persists + rebroadcasts. */
	setSessionPinned: (sessionId: string, pinned: boolean) => void;
	/** Rename any session by id (sidebar pencil). Server appends to the JSONL. */
	renameSessionById: (sessionId: string, name: string) => void;
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
	const sidebar = el("div", { class: "sidebar", id: "sidebar" });
	const sidebarHeader = el("div", { class: "sidebar-header" });
	sidebarHeader.append(
		el(
			"button",
			{
				class: "icon-btn",
				title: "Close sidebar",
				onclick: () => toggleSidebar(true),
			},
			"✕",
		),
		el("span", { class: "spacer" }),
	);
	sidebar.append(sidebarHeader);

	// New chat button. Rendered as an <a href="/"> so middle-click
	// (and ⌘/Ctrl/Shift+click) open a fresh chat in a new tab/window via
	// the browser's native link handling — same trick the session rows
	// use. Plain left-click is intercepted below so the SPA keeps the
	// live WS up and just runs the `clear` slash instead of a full nav.
	sidebar.append(
		el(
			"a",
			{
				class: "new-chat-btn",
				href: "/",
				rel: "noopener",
				title: "New chat — middle-click to open in a new tab",
				onclick: (e: MouseEvent) => {
					if (e.button !== 0) return;
					if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
					e.preventDefault();
					shellHandlers?.handleSlash("clear");
					toggleSidebar(true); // auto-close on mobile
				},
			},
			"✏️  New chat",
		),
	);

	// New project button — sits under New chat. Opens the project editor
	// modal to create a folder with its own AGENTS.md instructions.
	sidebar.append(
		el(
			"button",
			{
				class: "new-project-btn",
				title: "Create a project (its own folder + AGENTS.md instructions)",
				onclick: () => openProjectEditor(),
			},
			"+ New project",
		),
	);

	// Semantic search box — only rendered when the server advertises the
	// optional search feature (state.searchEnabled, set from /api/health).
	// Typing switches the sessions list to ranked-by-meaning results; clearing
	// it restores the normal date-grouped list. See src/server/search/.
	if (state.searchEnabled) {
		const searchRow = el("div", { class: "sidebar-search-row" });
		searchRow.append(
			el("input", {
				class: "sidebar-search",
				id: "sidebar-search",
				type: "search",
				placeholder: "Search chats by meaning…",
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
	}

	// Session list container — populated by renderSidebarSessions()
	const sessionsWrap = el("div", { class: "sidebar-sessions", id: "sidebar-sessions" });
	sessionsWrap.append(el("div", { class: "sidebar-empty" }, "Loading sessions…"));
	sidebar.append(sessionsWrap);

	root.append(sidebar);

	// ── Main column ────────────────────────────────────────────────
	const main = el("div", { class: "main" });
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
				title: "Open sidebar",
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
				src: "/logo-mark.png",
				alt: "ACB",
				width: 24,
				height: 24,
				draggable: false,
			}),
			el("span", { class: "title", id: "title" }, state.title),
		),
		el("div", { class: "spacer" }),
		el(
			"button",
			{
				class: "picker-btn caps-badge",
				id: "caps-badge",
				title: "Loaded tools, skills, extensions — click for details",
				onclick: () => toggleCapabilitiesPopover(),
				style: "display:none",
			},
			"",
		),
		el(
			"button",
			{ class: "picker-btn header-model", id: "model-picker", title: "Model (/model)" },
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
				title: "Thinking (/think)",
			},
			"think: …",
		),
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "voice-picker",
				title: "TTS voice",
			},
			"voice: …",
		),
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "speed-picker",
				title: "TTS playback speed",
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
				title: "Settings",
				onclick: () => shellHandlers?.openOverflowMenu(),
			},
			el("span", {
				html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 105.66 5.66l-1.42-1.42a2 2 0 11-2.82-2.82l-1.42-1.42zM3 21l3.5-1 9.9-9.9-2.5-2.5L4 17.5 3 21z"/></svg>`,
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
	welcome.append(
		el("img", {
			class: "welcome-mark",
			src: "/logo-mark.png",
			alt: "agentchatbox",
			width: 72,
			height: 72,
			draggable: false,
		}),
	);
	welcome.append(el("h1", { class: "welcome-title" }, "What can I build for you?"));
	welcome.append(
		el("p", { class: "welcome-sub" }, "Ask anything — I'll think, use tools, and answer."),
	);
	const modes = el("div", { class: "welcome-modes" });
	for (const s of WELCOME_SUGGESTIONS) {
		modes.append(
			el(
				"button",
				{
					class: "welcome-mode",
					title: s.sub,
					onclick: () => {
						const input = document.querySelector("#input") as HTMLTextAreaElement | null;
						if (input) {
							input.value = s.prompt;
							input.dispatchEvent(new Event("input"));
							shellHandlers?.handleSend();
						}
					},
				},
				el("span", { class: "welcome-mode-icon", html: s.icon }),
				el("span", { class: "welcome-mode-label" }, s.title),
			),
		);
	}
	welcome.append(modes);
	messagesWrap.append(welcome);

	// Messages list
	messagesWrap.append(el("div", { class: "messages", id: "messages" }));

	// Messages region wraps the scroll area + the floating "jump to
	// previous user message" button, so the button anchors to the
	// bottom-right of the messages viewport — independent of how tall
	// the composer / status bar happen to be. Clicking (or Alt+↑) walks
	// up through the user's own messages one at a time.
	const messagesRegion = el("div", { class: "messages-region" });
	messagesRegion.append(messagesWrap);
	messagesRegion.append(makeJumpPrevUserFab());
	main.append(messagesRegion);

	// A manual scroll (wheel / drag / touch) means the user repositioned
	// themselves, so the next jump should restart from the new spot.
	// Programmatic scrolls from scrollRowToTop set a guard to skip this.
	messagesWrap.addEventListener("scroll", () => {
		if (!programmaticScroll) resetJumpNav();
	});

	// Composer — pill with attach + voice buttons on the left, textarea
	// in the middle, and a dark up-arrow send button on the right.
	// The old globe/reasoning buttons were removed because they had no
	// direct effect (they opened other menus instead).
	const composerWrap = el("div", { class: "composer-wrap" });
	const composer = el("div", { class: "composer" });
	composer.append(
		el(
			"button",
			{
				class: "icon-btn",
				id: "attach-btn",
				title: "Attach file",
				onclick: () => $<HTMLInputElement>("#file-input").click(),
			},
			"+",
		),
		el(
			"button",
			{
				class: "icon-btn",
				id: "voice-btn",
				title: "Voice note (transcribes locally on server)",
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
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: false,
		}),
		el(
			"div",
			{ class: "composer-actions" },
			el(
				"button",
				{
					class: "send-btn",
					id: "send-btn",
					title: "Send (⌘/Ctrl+Enter)",
					onclick: () => shellHandlers?.handleSend(),
				},
				"↑",
			),
			el(
				"button",
				{
					class: "stop-btn",
					id: "stop-btn",
					title: "Stop the current run",
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

	// Status bar
	const statusBar = el("div", { class: "status-bar", id: "status-bar" }, "connecting…");
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
	toastEl = el("div", { class: "toast hidden" });
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
		} else if (e.key === "/") {
			// Slash menu opens on the next tick after the value updates.
			setTimeout(() => shellHandlers?.showSlashMenu(), 0);
		}
	});
	input.addEventListener("input", autoSize);
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
	if (window.innerWidth <= 720) {
		document.getElementById("sidebar")?.classList.add("collapsed");
	}

	renderHistory();
	refreshStatus();
}

// ---------------------------------------------------------------------------
// Sidebar helpers
// ---------------------------------------------------------------------------

/**
 * Welcome-screen mode chips (title, tooltip, inline SVG icon, prompt).
 * Icons are inline SVGs so they look crisp at any size and inherit the
 * current text color via `currentColor`.
 */
const WELCOME_SUGGESTIONS: {
	title: string;
	sub: string;
	prompt: string;
	icon: string;
}[] = [
	{
		title: "Magic Design",
		sub: "Spin up an interactive UI from a description",
		prompt:
			"Design and build a small interactive web page for me. Pick the layout, colors, and copy.",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.39 4.84L20 8l-4 3.9.94 5.5L12 14.77 7.06 17.4 8 11.9 4 8l5.61-1.16L12 2z"/></svg>`,
	},
	{
		title: "Full-Stack",
		sub: "Build a complete app — front, back, and data",
		prompt:
			"Help me build a small full-stack web app: pick a stack, sketch the data model, and scaffold the project.",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>`,
	},
	{
		title: "Write",
		sub: "Draft, edit, and refine long-form text",
		prompt:
			"Help me write a clear, well-structured piece on a topic of my choosing. Ask me what the topic is first.",
		icon: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4l6 6L8 22H2v-6L14 4z"/><path d="M13 5l6 6"/></svg>`,
	},
];

/**
 * Toggle the sidebar open/closed. On mobile, a dim overlay is shown when
 * the sidebar is open so taps outside dismiss it.
 */
function toggleSidebar(collapse: boolean): void {
	const sidebar = document.getElementById("sidebar");
	if (!sidebar) return;
	sidebar.classList.toggle("collapsed", collapse);

	// Mobile: manage the dim overlay
	let dim = document.querySelector(".sidebar-dim");
	if (!collapse) {
		if (!dim) {
			dim = el("div", { class: "sidebar-dim" });
			dim.addEventListener("click", () => toggleSidebar(true));
			document.body.append(dim);
		}
	} else {
		dim?.remove();
	}
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
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});
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
	box.append(
		el(
			"button",
			{ class: "icon-btn search-help-close", title: "Close", onclick: () => overlay.remove() },
			"✕",
		),
	);
	overlay.append(box);
	document.body.append(overlay);
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
			renderSidebarSessions(lastSessions);
			return;
		}
		const container = document.getElementById("sidebar-sessions");
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

/** Render semantic-search hits as flat result cards (no date grouping). */
function renderSidebarSearchResults(hits: SessionSearchHit[]): void {
	const container = document.getElementById("sidebar-sessions");
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
	const container = document.getElementById("sidebar-sessions");
	if (!container) return;
	// Cache the full list so the search box can restore it when cleared.
	lastSessions = sessions;
	// If the user is mid-search, don't clobber the search results.
	if (state.searchActive) return;
	container.innerHTML = "";

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
	// non-global) so they can nest inside a top-level "Projects" container,
	// with Global and Other rendered as siblings below it.
	const globalProject = projects.find((p) => p.id === "global");
	const userProjects = projects.filter((p) => p.id !== "global");

	// 1) Top-level "Projects" container — expandable, holds every user
	//    project. Only rendered when at least one user project exists; with
	//    none, Global alone is the whole sidebar.
	if (userProjects.length > 0) {
		container.append(renderProjectsContainer(userProjects, buckets));
	}

	// 2) Global as its own top-level folder (the default home for new chats).
	if (globalProject) {
		const items = (buckets.get("global") ?? [])
			.slice()
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		container.append(renderProjectFolder(globalProject, items));
	}

	// 3) Trailing "Other" bucket for orphaned sessions (deleted projects).
	const other = (buckets.get("other") ?? [])
		.slice()
		.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	if (other.length > 0) {
		container.append(
			renderProjectFolder({ id: "other", name: "Other", icon: "📦", cwd: "" }, other),
		);
	}
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
	const chevron = el("span", { class: "project-chevron", text: collapsed ? "▸" : "▾" });
	const icon = el("span", { class: "project-icon", text: "📂" });
	const name = el("span", { class: "project-name", text: "Projects" });
	const count = el("span", {
		class: "project-count",
		text: String(userProjects.length),
	});
	const spacer = el("span", { class: "spacer" });
	header.append(chevron, icon, name, count, spacer);
	wrap.append(header);

	const body = el("div", { class: "projects-container-body" });
	for (const p of userProjects) {
		const items = (buckets.get(p.id) ?? [])
			.slice()
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		body.append(renderProjectFolder(p, items));
	}
	if (collapsed) body.style.display = "none";
	wrap.append(body);

	header.addEventListener("click", () => {
		const set = readCollapseState();
		if (set.has(PROJECTS_CONTAINER_ID)) set.delete(PROJECTS_CONTAINER_ID);
		else set.add(PROJECTS_CONTAINER_ID);
		writeCollapseState(set);
		chevron.textContent = set.has(PROJECTS_CONTAINER_ID) ? "▸" : "▾";
		body.style.display = set.has(PROJECTS_CONTAINER_ID) ? "none" : "";
		wrap.classList.toggle("collapsed", set.has(PROJECTS_CONTAINER_ID));
	});
	return wrap;
}

/**
 * Render a collapsible project folder with its sessions nested inside.
 * The folder header shows icon + name + count, a "+" to start a new chat
 * in this project, and (for non-Global) an edit affordance. Clicking the
 * header toggles collapse.
 */
function renderProjectFolder(p: ProjectSummary, items: SessionSummary[]): HTMLElement {
	const collapsed = readCollapseState().has(p.id);
	const isOther = p.id === "other";
	const isGlobal = p.id === "global";
	const wrap = el("div", { class: `project-folder${collapsed ? " collapsed" : ""}` });
	wrap.dataset.projectId = p.id;

	const header = el("div", { class: "project-folder-header" });
	const chevron = el("span", { class: "project-chevron", text: collapsed ? "▸" : "▾" });
	const icon = el("span", { class: "project-icon", text: p.icon || "📁" });
	const name = el("span", { class: "project-name", text: p.name });
	const count = el("span", {
		class: "project-count",
		text: items.length > 0 ? String(items.length) : "",
	});
	const spacer = el("span", { class: "spacer" });
	const actions = el("div", { class: "project-actions" });
	// "+" starts a new chat in this project (Global's "+" is redundant with
	// the top New chat button but harmless; hide it on Global to avoid clutter).
	if (!isGlobal) {
		const plusBtn = el("button", {
			class: "project-action",
			title: `New chat in ${p.name}`,
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
			title: "Edit project",
			html: "✎",
		});
		editBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			openProjectEditor(p.id);
		});
		actions.append(editBtn);
	}
	header.append(chevron, icon, name, count, spacer, actions);
	wrap.append(header);

	const body = el("div", { class: "project-folder-body" });
	// Pinned float to the top within the folder.
	const pinned = items.filter((s) => s.pinned);
	const rest = items.filter((s) => !s.pinned);
	if (pinned.length > 0) {
		body.append(el("div", { class: "group-label" }, "Pinned"));
		for (const s of pinned) body.append(renderSessionItem(s));
	}
	for (const s of rest) body.append(renderSessionItem(s));
	if (items.length === 0 && isGlobal) {
		body.append(el("div", { class: "sidebar-empty" }, "No conversations yet"));
	}
	if (items.length === 0 && !isGlobal && !isOther) {
		body.append(el("div", { class: "sidebar-empty" }, "No chats yet — click + to start one"));
	}
	if (collapsed) body.style.display = "none";
	wrap.append(body);

	header.addEventListener("click", () => {
		const set = readCollapseState();
		if (set.has(p.id)) set.delete(p.id);
		else set.add(p.id);
		writeCollapseState(set);
		chevron.textContent = set.has(p.id) ? "▸" : "▾";
		body.style.display = set.has(p.id) ? "none" : "";
		wrap.classList.toggle("collapsed", set.has(p.id));
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

	// Render the row as an actual <a href> so middle-click (and
	// ⌘/Ctrl/Shift + left-click) open the session in a new tab/window
	// the way Firefox handles any regular link — no JS window.open dance,
	// no pop-up blocker caveats, keyboard-activatable for free. Left
	// click is intercepted below so the SPA keeps the live WS up
	// instead of doing a full page nav to `/s/<id>`.
	const item = el("a", {
		class: "session-item",
		href: sessionPath(s.id),
		rel: "noopener",
		title: `${displayTitle} — middle-click to open in a new tab`,
	});
	if (s.id === state.sessionId) item.classList.add("active");
	if (pinned) item.classList.add("pinned");

	const titleRow = el("div", { class: "session-item-title-row" });
	const titleEl = el("div", { class: "session-item-title" }, displayTitle);
	titleRow.append(titleEl);

	// Pinned sessions show an always-visible ⭐ indicator next to the
	// title. Clicking it unpins — no need to hover first.
	if (pinned) {
		const starBtn = el("button", {
			class: "session-pin-indicator",
			title: "Unpin",
			text: "⭐",
		});
		starBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			shellHandlers?.setSessionPinned(s.id, false);
		});
		// Browsers decide on mousedown (button===1) whether to follow
		// the parent link, before auxclick fires — so block it at
		// mousedown, otherwise middle-click on the star would
		// accidentally open the session in a new tab.
		starBtn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) e.stopPropagation();
		});
		titleRow.append(starBtn);
	}

	// Hover-revealed action buttons. Each stops propagation so they
	// don't trigger the row's resume-on-click. The pin toggle is only
	// shown when not pinned — pinned rows use the always-visible star.
	const actions = el("div", { class: "session-item-actions" });
	const renameBtn = el("button", {
		class: "session-action rename",
		title: "Rename",
		html: "✎",
	});
	actions.append(renameBtn);
	if (!pinned) {
		const pinBtn = el("button", {
			class: "session-action pin",
			title: "Pin to top",
			text: "☆",
		});
		pinBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			shellHandlers?.setSessionPinned(s.id, true);
		});
		pinBtn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) e.stopPropagation();
		});
		actions.insertBefore(pinBtn, renameBtn);
	}
	titleRow.append(actions);
	item.append(titleRow);

	const timeStr = formatRelativeTime(s.modifiedAt);
	item.append(el("div", { class: "session-item-meta" }, `${s.messageCount} msgs · ${timeStr}`));

	// Only intercept the primary left click (no modifiers). Middle-click
	// and ⌘/Ctrl/Shift+click intentionally fall through to the browser's
	// default `<a href>` handling so the user opens the session in a
	// new tab/window — identical to Firefox link behaviour.
	item.addEventListener("click", (e) => {
		if (e.button !== 0) return;
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		shellHandlers?.handleSlash(`resume ${s.id}`);
		toggleSidebar(true); // auto-close on mobile
	});

	renameBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		startRename(titleEl, titleRow, s);
	});
	// Same mousedown guard as the star/pin buttons — middle-clicking the
	// pencil shouldn't open the link.
	renameBtn.addEventListener("mousedown", (e) => {
		if (e.button !== 0) e.stopPropagation();
	});

	return item;
}

/**
 * Replace the title node with an inline text input, commit on Enter /
 * blur, cancel on Escape. Commit sends the new name to the server
 * (which appends a session_info line to the session JSONL), and the
 * server's rebroadcast refreshes the sidebar. Empty input clears the
 * name (falls back to the auto-derived first-message title).
 */
function startRename(titleEl: HTMLElement, titleRow: HTMLElement, s: SessionSummary): void {
	const current = s.title || "";
	const input = document.createElement("input");
	input.type = "text";
	input.className = "session-rename-input";
	input.value = current;
	input.placeholder = "Untitled";
	input.maxLength = 120;

	titleEl.replaceWith(input);
	// Hide the action row while editing so the input gets full width.
	const actions = titleRow.querySelector(".session-item-actions");
	if (actions) (actions as HTMLElement).style.display = "none";

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

	const overlay = el("div", { class: "modal-overlay", id: "project-editor" });
	const box = el("div", { class: "project-editor-box" });
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});

	box.append(el("h3", { text: editing ? `Edit “${editing.name}”` : "New project" }));

	// Icon + name row.
	const iconInput = document.createElement("input");
	iconInput.type = "text";
	iconInput.className = "project-icon-input";
	iconInput.value = editing?.icon ?? "📁";
	iconInput.maxLength = 4;
	iconInput.placeholder = "📁";
	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "project-name-input";
	nameInput.value = editing?.name ?? "";
	nameInput.placeholder = "Project name";
	nameInput.maxLength = 60;
	const nameRow = el("div", { class: "project-editor-namerow" });
	nameRow.append(iconInput, nameInput);
	box.append(nameRow);

	// Instructions textarea — the project's AGENTS.md.
	box.append(
		el(
			"label",
			{ class: "project-editor-label" },
			"Instructions (saved as AGENTS.md — pi loads it automatically)",
		),
	);
	const instr = document.createElement("textarea");
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
	const saveBtn = el("button", { class: "project-save-btn", text: editing ? "Save" : "Create" });
	const cancelBtn = el("button", { class: "project-cancel-btn", text: "Cancel" });
	cancelBtn.addEventListener("click", () => overlay.remove());
	actions.append(cancelBtn);
	if (editing && !isBuiltin) {
		const delBtn = el("button", { class: "project-delete-btn", text: "Delete…" });
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

	overlay.append(box);
	document.body.append(overlay);
	nameInput.focus();
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
