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

import { $, el, type LiveAssistantDom } from "./dom.js";
import { type PersistedMessage, state } from "./state.js";

export function autoSize(): void {
	const ta = $<HTMLTextAreaElement>("#input");
	ta.style.height = "auto";
	ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

export function setStreaming(s: boolean): void {
	state.isStreaming = s;
	$("#send-btn").hidden = s;
	$("#stop-btn").hidden = !s;
	$<HTMLTextAreaElement>("#input").disabled = s;
	if (!s) state.toolSpinner = null;
	refreshStatus();
}

export function renderHistory(): void {
	const list = $("#messages");
	list.innerHTML = "";
	for (const m of state.messages) {
		list.append(renderMessageNode(m));
	}
	scrollToBottom();
}

export function renderMessageNode(m: PersistedMessage): HTMLElement {
	if (m.kind === "user") {
		return el(
			"div",
			{ class: "row row-user" },
			el("span", { class: "role role-user" }, "You ›"),
			el("span", { class: "body" }, m.text),
		);
	}
	if (m.kind === "assistant") {
		const wrap = el("div", { class: "row row-assistant" });
		wrap.append(el("span", { class: "role role-assistant" }, "Pi ›"));
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
		const text = el("pre", { class: "text" }, m.text || " ");
		body.append(text);
		body.append(makeSpeakButton(() => m.text));
		wrap.append(body);
		return wrap;
	}
	if (m.kind === "tool") {
		const wrap = el("div", { class: "row row-tool" });
		wrap.append(el("span", { class: "role role-tool" }, "Tool ›"));
		const body = el("div", { class: "tool-body" });
		body.append(el("div", { class: "tool-name" }, `${m.name} ${summarizeArgs(m.args)}`));
		if (m.result !== undefined) {
			body.append(el("pre", { class: `tool-result ${m.isError ? "tool-error" : ""}` }, m.result));
		} else {
			body.append(el("div", { class: "tool-pending" }, "running…"));
		}
		wrap.append(body);
		return wrap;
	}
	// error
	return el(
		"div",
		{ class: "row row-error" },
		el("span", { class: "role" }, "!"),
		el("span", { class: "body" }, m.text),
	);
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
 * True iff the user is currently sitting at the bottom of the messages list
 * (within a small tolerance). Used to decide whether new streamed tokens
 * should keep the viewport pinned to the latest line, or leave the user
 * alone when they've deliberately scrolled up to re-read something.
 */
export function isAtBottom(): boolean {
	const list = $("#messages");
	const slack = 32; // px — small enough that "near the bottom" counts as pinned
	return list.scrollHeight - list.clientHeight - list.scrollTop <= slack;
}

export function scrollToBottom(): void {
	const list = $("#messages");
	list.scrollTop = list.scrollHeight;
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
	wrap.append(el("span", { class: "role role-assistant" }, "Pi ›"));
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
	wrap.append(el("span", { class: "role role-tool" }, "Tool ›"));
	const body = el("div", { class: "tool-body" });
	body.append(el("div", { class: "tool-name" }, `${name} ${summarizeArgs(args)}`));
	const pending = el("div", { class: "tool-pending" }, "running…");
	body.append(pending);
	wrap.append(body);
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
	const pending = row.querySelector(".tool-pending");
	if (pending) pending.remove();
	const body = row.querySelector(".tool-body");
	if (body && result !== undefined) {
		body.append(el("pre", { class: `tool-result ${isError ? "tool-error" : ""}` }, result));
	}
	void name; // unused for now — the tool-name row was already set on append
}

export function appendError(text: string): void {
	appendNode(
		el(
			"div",
			{ class: "row row-error" },
			el("span", { class: "role" }, "!"),
			el("span", { class: "body" }, text),
		),
	);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

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

	const parts: string[] = [];
	parts.push(modelLabel);
	parts.push(`think: ${state.currentThinking}`);
	const c = state.costTotal;
	parts.push(`${(c.input + c.output).toLocaleString()} tok`);
	if (c.cost > 0) parts.push(`$${c.cost.toFixed(4)}`);
	if (state.isStreaming) parts.push("● streaming");
	if (state.ttsInFlight > 0) parts.push("● tts");
	if (state.audioPlaying) parts.push("♪ playing");
	if (state.connectionStatus !== "open") parts.push(`[${state.connectionStatus}]`);
	$("#status-bar").textContent = parts.join(" · ");

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
	openOverflowMenu: () => void;
	toggleAutoSpeak: () => void;
	handleVoiceRecord: () => Promise<void>;
	handleFileAttach: (e: Event) => Promise<void>;
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

	// Header
	const header = el("div", { class: "header" });
	header.append(
		el(
			"button",
			{
				class: "icon-btn",
				title: "New chat (/clear)",
				onclick: () => shellHandlers?.handleSlash("clear"),
			},
			"new",
		),
		el(
			"button",
			{
				class: "icon-btn",
				title: "Sessions (/sessions)",
				onclick: () => shellHandlers?.handleSlash("sessions"),
			},
			"≡",
		),
		el("span", { class: "title", id: "title" }, state.title),
		el("div", { class: "spacer" }),
		el("button", { class: "picker-btn", id: "model-picker", title: "Model (/model)" }, "model: …"),
		el(
			"button",
			{ class: "picker-btn", id: "think-picker", title: "Thinking (/think)" },
			"think: …",
		),
		el("button", { class: "picker-btn", id: "voice-picker", title: "TTS voice" }, "voice: …"),
		el(
			"button",
			{
				class: "picker-btn",
				id: "tts-toggle",
				title: "Auto-speak assistant messages",
			},
			"🔇 off",
		),
		// Overflow menu — only visible on narrow screens, where the picker pills
		// are hidden via the @media block in styles.css.
		el(
			"button",
			{
				class: "icon-btn overflow-menu",
				id: "overflow-menu",
				title: "Settings",
				onclick: () => shellHandlers?.openOverflowMenu(),
			},
			"⋯",
		),
	);
	root.append(header);

	// Messages
	root.append(el("div", { class: "messages", id: "messages" }));

	// Composer
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
			"📎",
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
			placeholder: "Type… (Enter for newline, tap send to submit)",
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: false,
		}),
		el(
			"button",
			{
				class: "send-btn",
				id: "send-btn",
				title: "Send (⌘/Ctrl+Enter)",
				onclick: () => shellHandlers?.handleSend(),
			},
			"send",
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
			"stop",
		),
	);
	root.append(composer);
	root.append(
		el("input", {
			type: "file",
			id: "file-input",
			hidden: true,
			multiple: true,
		}),
	);

	// Status bar
	const statusBar = el("div", { class: "status-bar", id: "status-bar" }, "connecting…");
	root.append(statusBar);

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
	root.append(audio);

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
	$("#model-picker").addEventListener("click", () => shellHandlers?.openModelPicker());
	$("#think-picker").addEventListener("click", () => shellHandlers?.openThinkPicker());
	$("#voice-picker").addEventListener("click", () => shellHandlers?.openVoicePicker());
	$("#tts-toggle").addEventListener("click", () => shellHandlers?.toggleAutoSpeak());

	renderHistory();
	refreshStatus();
}
