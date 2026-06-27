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
 * not the other way around. main.ts wires the speak button by reaching
 * into state.lastAssistant.
 */

import type { SessionSummary } from "../shared/protocol.js";
import { $, el, type LiveAssistantDom } from "./dom.js";
import { setRichText } from "./linkify.js";
import { type PersistedMessage, state } from "./state.js";

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
	$("#stop-btn").hidden = !s;
	if (!s) state.toolSpinner = null;
	refreshStatus();
}

export function renderHistory(): void {
	const list = $("#messages");
	list.innerHTML = "";
	for (const m of state.messages) {
		list.append(renderMessageNode(m));
	}
	updateWelcomeVisibility();
	scrollToBottom();
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

export function renderMessageNode(m: PersistedMessage): HTMLElement {
	if (m.kind === "user") {
		return el("div", { class: "row row-user" }, el("div", { class: "bubble" }, m.text));
	}
	if (m.kind === "steer") {
		// Steering message queued while the agent was running. Same
		// right-aligned bubble as a user message, but with a badge so
		// it's clear it's queued (not yet consumed by the agent) vs
		// delivered (folded into the next turn).
		const bubble = el("div", { class: "bubble steer-bubble" }, m.text);
		bubble.append(
			el("span", { class: `steer-badge${m.delivered ? " delivered" : ""}` }, m.delivered ? "✓ delivered" : "⏳ queued"),
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
		const text = el("pre", { class: "text" }, " ");
		setRichText(text, m.text || " ");
		body.append(text);
		body.append(makeSpeakButton(() => m.text));
		wrap.append(body);
		return wrap;
	}
	if (m.kind === "tool") {
		const wrap = el("div", { class: "row row-tool" });
		const card = el("div", { class: "tool-card" });
		const head = el(
			"div",
			{ class: "tool-head" },
			el("span", { class: "tool-icon" }, "⚙"),
			el("span", { class: "tool-name" }, `${m.name} ${summarizeArgs(m.args)}`),
		);
		const toolPath = toolPathFromArgs(m.args);
		if (toolPath) head.append(makeFileDownloadLink(toolPath));
		card.append(head);
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
	// error
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
 * The speak button always defers to the in-place `state.lastAssistant`
 * for the live-streaming case, so re-clicking after streaming ends
 * replays the final text. For rendered (non-live) messages it speaks
 * the text passed to the closure.
 */
function makeSpeakButton(getText: () => string): HTMLElement {
	return el(
		"button",
		{
			class: "speak-btn",
			title: "Speak this message (local TTS)",
			onclick: () => {
				void import("./voice.js").then(({ speakText }) => {
					void speakText(getText());
				});
			},
		},
		"🔊",
	);
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

export function appendNode(node: HTMLElement): void {
	$("#messages").append(node);
	updateWelcomeVisibility();
	scrollToBottom();
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
	const pre = el("pre", { class: "text streaming" });
	body.append(pre);
	body.append(makeSpeakButton(() => state.lastAssistantText));
	wrap.append(body);
	appendNode(wrap);
	return { textPre: pre, thinkingWrap, thinkingPre };
}
export function appendToolCall(name: string, args: unknown, toolCallId: string): void {
	const wrap = el("div", { class: "row row-tool" });
	const card = el("div", { class: "tool-card" });
	const head = el(
		"div",
		{ class: "tool-head" },
		el("span", { class: "tool-icon" }, "⚙"),
		el("span", { class: "tool-name" }, `${name} ${summarizeArgs(args)}`),
	);
	const toolPath = toolPathFromArgs(args);
	if (toolPath) head.append(makeFileDownloadLink(toolPath));
	card.append(head);
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
	appendNode(wrap);
}

export function finalizeToolCall(
	toolCallId: string,
	name: string,
	result: string | undefined,
	isError: boolean,
): void {
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
}

export function appendError(text: string): void {
	appendNode(el("div", { class: "row row-error" }, el("div", { class: "body" }, text)));
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

/** Update the capabilities badge in the header. */
function refreshCapabilitiesBadge(): void {
	const caps = state.capabilities;
	const badge = document.getElementById("caps-badge");
	if (!badge) return;
	if (
		!caps ||
		(caps.tools.length === 0 && caps.skills.length === 0 && caps.packages.length === 0)
	) {
		badge.style.display = "none";
		return;
	}
	const parts: string[] = [];
	if (caps.tools.length)
		parts.push(`${caps.tools.length} tool${caps.tools.length !== 1 ? "s" : ""}`);
	if (caps.skills.length)
		parts.push(`${caps.skills.length} skill${caps.skills.length !== 1 ? "s" : ""}`);
	badge.textContent =
		parts.join(" · ") || `${caps.packages.length} pkg${caps.packages.length !== 1 ? "s" : ""}`;
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
	if (!caps) return;

	const overlay = el("div", { class: "modal-overlay", id: "caps-popover" });
	const box = el("div", { class: "caps-popover-box" });
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});

	box.append(el("h3", { text: "Loaded capabilities" }));

	// Tools section
	if (caps.tools.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Tools"));
		for (const t of caps.tools) {
			const row = el("div", { class: "caps-row" });
			row.append(el("span", { class: "caps-name" }, t.name));
			row.append(el("span", { class: "caps-pkg" }, t.package));
			box.append(row);
		}
	}

	// Skills section
	if (caps.skills.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Skills"));
		for (const s of caps.skills) {
			const row = el("div", { class: "caps-row" });
			row.append(el("span", { class: "caps-name" }, s.name));
			row.append(el("span", { class: "caps-pkg" }, s.package));
			box.append(row);
		}
	}

	// Packages section
	if (caps.packages.length > 0) {
		box.append(el("div", { class: "caps-section-header" }, "Extensions"));
		for (const p of caps.packages) {
			const row = el("div", { class: "caps-row caps-pkg-row" });
			const ver = p.version ? ` v${p.version}` : "";
			row.append(el("span", { class: "caps-name" }, `${p.name}${ver}`));
			if (p.description) {
				row.append(el("span", { class: "caps-desc" }, p.description));
			}
			box.append(row);
		}
	}

	if (caps.tools.length === 0 && caps.skills.length === 0 && caps.packages.length === 0) {
		box.append(el("p", { class: "caps-empty" }, "No extensions loaded."));
	}

	box.append(
		el("button", { class: "btn caps-close-btn", text: "Close", onclick: () => overlay.remove() }),
	);
	overlay.append(box);
	document.body.append(overlay);
}

export function refreshStatus(): void {
	// Helper: prefer the human-readable name from /api/models over the
	// raw model id (which is the same as the name for MiniMax-M3 but
	// is "deepseek-v4-pro" rather than "DeepSeek V4 Pro" for deepseek).
	const modelLabel = (() => {
		const id = state.currentModelId;
		if (!id) return "(no model)";
		const opt = state.availableModels.find((m) => m.id === id);
		return opt?.name ?? id;
	})();

	// Escape the dynamic bits we interpolate into innerHTML below.
	const esc = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");

	const parts: string[] = [];
	parts.push(esc(modelLabel));
	parts.push(`think: ${esc(state.currentThinking)}`);
	const c = state.costTotal;
	parts.push(`${(c.input + c.output).toLocaleString()} tok`);
	if (c.cost > 0) parts.push(`$${c.cost.toFixed(4)}`);
	if (state.isStreaming)
		parts.push('<span class="streaming-dot"></span> streaming');
	if (state.pendingSteerCount > 0)
		parts.push(`⟳ ${state.pendingSteerCount} queued`);
	if (state.ttsInFlight > 0) parts.push("● tts");
	if (state.audioPlaying) parts.push("♪ playing");
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
	toggleAutoSpeak: () => void;
	handleVoiceRecord: () => Promise<void>;
	handleFileAttach: (e: Event) => Promise<void>;
	handlePaste: (e: ClipboardEvent) => Promise<void>;
	handleDrop: (e: DragEvent) => Promise<void>;
	abort: () => void;
}

let shellHandlers: ShellHandlers | null = null;
export function registerShellHandlers(h: ShellHandlers): void {
	shellHandlers = h;
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

	// New chat button
	sidebar.append(
		el(
			"button",
			{
				class: "new-chat-btn",
				onclick: () => {
					shellHandlers?.handleSlash("clear");
					toggleSidebar(true); // auto-close on mobile
				},
			},
			"✏️  New chat",
		),
	);

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
			// ACB brand mark on the left, then the chat title.
			// `logo-mark-light.png` is the navy-in-ink recolored to
			// cream so it reads on the dark UI; the SVG version is
			// used at smaller sizes for crispness, with the PNG
			// as a fallback for browsers that drop the SVG <img>
			// (Safari on some iOS builds).
			el("img", {
				class: "header-mark",
				src: "/logo-mark-light.svg",
				alt: "ACB",
				width: 24,
				height: 24,
				draggable: false,
				onerror: (e: Event) => {
					// Fall back to the PNG if the SVG can't load.
					const img = e.currentTarget as HTMLImageElement;
					if (img.src.endsWith(".svg")) img.src = "/logo-mark-light.png";
				},
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
		el(
			"button",
			{
				class: "picker-btn picker-hidden",
				id: "tts-toggle",
				title: "Auto-speak assistant messages",
			},
			"🔇 off",
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
			el(
				"span",
				{
					html: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 105.66 5.66l-1.42-1.42a2 2 0 11-2.82-2.82l-1.42-1.42zM3 21l3.5-1 9.9-9.9-2.5-2.5L4 17.5 3 21z"/></svg>`,
				},
			),
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
			src: "/logo-mark-light.svg",
			alt: "agentchatbox",
			width: 72,
			height: 72,
			draggable: false,
			onerror: (e: Event) => {
				const img = e.currentTarget as HTMLImageElement;
				if (img.src.endsWith(".svg")) img.src = "/logo-mark-light.png";
			},
		}),
	);
	welcome.append(el("h1", { class: "welcome-title" }, "What can I build for you?"));
	welcome.append(el("p", { class: "welcome-sub" }, "Ask anything — I'll think, use tools, and answer."));
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
	main.append(messagesWrap);

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
	main.append(statusBar);

	// Hidden audio element for TTS playback. One shared element so a new
	// speak request stops the current one.
	const audio = el("audio", { id: "tts-audio", hidden: true, preload: "auto" });
	audio.addEventListener("play", () => {
		state.audioPlaying = true;
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
		} else if (e.key === "ArrowUp" && (input.value === "" || input.selectionStart === 0)) {
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
	$("#tts-toggle").addEventListener("click", () => shellHandlers?.toggleAutoSpeak());

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
		prompt: "Design and build a small interactive web page for me. Pick the layout, colors, and copy.",
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
 * Render the list of sessions into the sidebar. Called by main.ts when
 * the server delivers the session list (via onSessionsUpdated). Sessions
 * are grouped by date: Today / Yesterday / This week / Older.
 */
export function renderSidebarSessions(sessions: SessionSummary[]): void {
	const container = document.getElementById("sidebar-sessions");
	if (!container) return;
	container.innerHTML = "";
	if (sessions.length === 0) {
		container.append(el("div", { class: "sidebar-empty" }, "No conversations yet"));
		return;
	}

	// Sort newest first
	const sorted = [...sessions].sort(
		(a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime(),
	);

	// Group by date bucket
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
	const startOfWeek = new Date(startOfToday.getTime() - 6 * 86400000);

	const buckets: { label: string; items: SessionSummary[] }[] = [
		{ label: "Today", items: [] },
		{ label: "Yesterday", items: [] },
		{ label: "This week", items: [] },
		{ label: "Older", items: [] },
	];
	for (const s of sorted) {
		const d = new Date(s.modifiedAt);
		if (d >= startOfToday) buckets[0].items.push(s);
		else if (d >= startOfYesterday) buckets[1].items.push(s);
		else if (d >= startOfWeek) buckets[2].items.push(s);
		else buckets[3].items.push(s);
	}

	for (const bucket of buckets) {
		if (bucket.items.length === 0) continue;
		container.append(el("div", { class: "group-label" }, bucket.label));
		for (const s of bucket.items) {
			const item = el("div", { class: "session-item" });
			if (s.id === state.sessionId) item.classList.add("active");
			item.append(el("div", { class: "session-item-title" }, s.title || "Untitled"));
			const timeStr = formatRelativeTime(s.modifiedAt);
			item.append(el("div", { class: "session-item-meta" }, `${s.messageCount} msgs · ${timeStr}`));
			item.addEventListener("click", () => {
				shellHandlers?.handleSlash(`resume ${s.id}`);
				toggleSidebar(true); // auto-close on mobile
			});
			container.append(item);
		}
	}
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
