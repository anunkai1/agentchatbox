/**
 * agentchatbox client — pi-CLI renderer.
 *
 * The browser no longer runs the pi Agent. It opens a WebSocket to /api/chat
 * and renders the events the server sends. This file is the whole UI:
 *
 *   - DOM scaffolding (no framework)
 *   - Event handler that turns Agent events into DOM updates
 *   - Slash menu (/model, /think, /clear, /sessions, /help, /cost)
 *   - ↑/↓ history (in-memory ring buffer of the current session's user msgs)
 *   - Status bar (model · thinking · tokens)
 *   - File / voice attach (still browser-side — the recorder lives here)
 *   - IndexedDB session persistence (titles + transcripts)
 *
 * Visual conventions (ported from the pi CLI):
 *   - dark, monospace, no bubbles, role prefixes (You ›, Pi ›, Tool ›)
 *   - tool calls get a dedicated block with args, a spinner during run, and
 *     the result underneath
 *   - thinking blocks are dim/collapsed, click ▸ to expand
 *   - errors in red
 */

/**
 * UUID helper — `crypto.randomUUID()` is unavailable in non-secure contexts
 * on some Android WebViews (e.g. plain http://LAN IPs). Fall back to a
 * tiny RFC4122 v4 generator so the page still loads.
 */
function uuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const b = new Uint8Array(16);
	const get = (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function")
		? crypto.getRandomValues.bind(crypto)
		: (a) => a.map(() => Math.floor(Math.random() * 256));
	get(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
	return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}



import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type {
	ClientMessage,
	ServerMessage,
	ThinkingLevel,
} from "../shared/protocol.js";
import { createChatClient, type ChatClient } from "./ws.js";
import { uploadFile, transcribeAudio, getHealth, getModels, synthesizeSpeech, listVoices, type ModelInfo } from "./api.js";

// ---------------------------------------------------------------------------
// DOM helpers (no framework)
// ---------------------------------------------------------------------------

function $<T extends HTMLElement>(sel: string): T {
	const el = document.querySelector(sel) as T | null;
	if (!el) throw new Error(`element not found: ${sel}`);
	return el;
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Record<string, unknown> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v as string;
		else if (k === "html") (node as HTMLElement).innerHTML = v as string;
		else if (k === "text") (node as HTMLElement).textContent = v as string;
		else if (k === "on") {
			for (const [event, handler] of Object.entries(v as Record<string, EventListener>)) {
				node.addEventListener(event, handler);
			}
		} else (node as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) node.append(c);
	return node;
}

function text(s: string): Text {
	return document.createTextNode(s);
}

// ---------------------------------------------------------------------------
// IndexedDB (session titles + transcripts)
// ---------------------------------------------------------------------------

const DB_NAME = "agentchatbox";
const DB_VERSION = 2; // bumped: removed provider-keys, custom-providers

interface SessionRecord {
	id: string;
	title: string;
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
	messages: Array<Record<string, unknown>>;
	createdAt: string;
	lastModified: string;
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("sessions")) {
				const s = db.createObjectStore("sessions", { keyPath: "id" });
				s.createIndex("byLastModified", "lastModified");
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function dbAllSessions(): Promise<SessionRecord[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readonly");
		const req = tx.objectStore("sessions").getAll();
		req.onsuccess = () => {
			db.close();
			const all = req.result as SessionRecord[];
			resolve(all.sort((a, b) => b.lastModified.localeCompare(a.lastModified)));
		};
		req.onerror = () => {
			db.close();
			reject(req.error);
		};
	});
}

async function dbSaveSession(rec: SessionRecord): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readwrite");
		tx.objectStore("sessions").put(rec);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

async function dbDeleteSession(id: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readwrite");
		tx.objectStore("sessions").delete(id);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

// ---------------------------------------------------------------------------
// Session state (in-memory)
// ---------------------------------------------------------------------------

interface AppState {
	sessionId: string;
	title: string;
	messages: PersistedMessage[];
	historyIdx: number | null; // null = at the "now" position
	history: string[]; // user prompts typed in this session
	isStreaming: boolean;
	toolSpinner: HTMLElement | null;
	costTotal: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
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
	connectionStatus: "connecting" | "open" | "closed";
	/** When true, every final assistant message is spoken automatically. */
	autoSpeak: boolean;
	/** Currently selected TTS voice id. */
	ttsVoice: string | null;
	/** Number of TTS requests in flight (for the status bar indicator). */
	ttsInFlight: number;
	/** Set true while audio is playing (for the play/pause indicator). */
	audioPlaying: boolean;
}

type PersistedMessage =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: string; spoken?: boolean }
	| { kind: "tool"; name: string; args: unknown; result?: string; isError?: boolean }
	| { kind: "error"; text: string };

interface ModelOption {
	id: string;
	provider: string;
	/** Human-readable label from the server (e.g. "DeepSeek V4 Pro"). */
	name?: string;
	/** Whether this model supports extended thinking. */
	reasoning?: boolean;
}

const state: AppState = {
	sessionId: uuid(),
	title: "New chat",
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
	connectionStatus: "connecting",
	autoSpeak: false,
	ttsVoice: null,
	ttsInFlight: 0,
	audioPlaying: false,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderShell(): void {
	document.body.innerHTML = "";
	const root = el("div", { id: "app" });
	document.body.append(root);

	// Header
	const header = el("div", { class: "header" });
	header.append(
		el(
			"button",
			{ class: "icon-btn", title: "New chat (/clear)", onclick: () => handleSlash("clear") },
			"new",
		),
		el(
			"button",
			{ class: "icon-btn", title: "Sessions (/sessions)", onclick: () => handleSlash("sessions") },
			"≡",
		),
		el("span", { class: "title", id: "title" }, state.title),
		el("div", { class: "spacer" }),
		el(
			"button",
			{ class: "picker-btn", id: "model-picker", title: "Model (/model)" },
			"model: …",
		),
		el(
			"button",
			{ class: "picker-btn", id: "think-picker", title: "Thinking (/think)" },
			"think: …",
		),
		el(
			"button",
			{ class: "picker-btn", id: "voice-picker", title: "TTS voice" },
			"voice: …",
		),
		el(
			"button",
			{ class: "picker-btn", id: "tts-toggle", title: "Auto-speak assistant messages" },
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
				onclick: openOverflowMenu,
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
		el("button", {
			class: "icon-btn",
			id: "attach-btn",
			title: "Attach file",
			onclick: () => $<HTMLInputElement>("#file-input").click(),
		}, "📎"),
		el("button", {
			class: "icon-btn",
			id: "voice-btn",
			title: "Voice note (transcribes locally on server)",
			onclick: handleVoiceRecord,
		}, "🎙"),
		el("textarea", {
			id: "input",
			class: "input",
			rows: 1,
			placeholder: "Type…",
			autocomplete: "off",
			autocapitalize: "off",
			spellcheck: false,
		}),
		el("button", { class: "send-btn", id: "send-btn", onclick: handleSend }, "send"),
		el("button", { class: "stop-btn", id: "stop-btn", hidden: true, onclick: () => chatClient.abort() }, "stop"),
	);
	root.append(composer);
	root.append(el("input", { type: "file", id: "file-input", hidden: true, multiple: true }));

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
	$("#file-input").addEventListener("change", handleFileAttach);

	// Input handlers
	const input = $<HTMLTextAreaElement>("#input");
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		} else if (e.key === "ArrowUp" && (input.value === "" || input.selectionStart === 0)) {
			e.preventDefault();
			historyBack();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			historyForward();
		} else if (e.key === "/") {
			// Slash menu opens on the next tick after the value updates.
			setTimeout(showSlashMenu, 0);
		}
	});
	input.addEventListener("input", autoSize);
	$("#model-picker").addEventListener("click", openModelPicker);
	$("#think-picker").addEventListener("click", openThinkPicker);
	$("#voice-picker").addEventListener("click", openVoicePicker);
	$("#tts-toggle").addEventListener("click", toggleAutoSpeak);

	renderHistory();
	refreshStatus();
}

function autoSize(): void {
	const ta = $<HTMLTextAreaElement>("#input");
	ta.style.height = "auto";
	ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}

function setStreaming(s: boolean): void {
	state.isStreaming = s;
	$("#send-btn").hidden = s;
	$("#stop-btn").hidden = !s;
	$<HTMLTextAreaElement>("#input").disabled = s;
	if (!s) state.toolSpinner = null;
	refreshStatus();
}

function renderHistory(): void {
	const list = $("#messages");
	list.innerHTML = "";
	for (const m of state.messages) {
		list.append(renderMessageNode(m));
	}
	scrollToBottom();
}

function renderMessageNode(m: PersistedMessage): HTMLElement {
	if (m.kind === "user") {
		return el("div", { class: "row row-user" }, el("span", { class: "role role-user" }, "You ›"), el("span", { class: "body" }, m.text));
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
				t.querySelector(".thinking-toggle")!.textContent = pre.classList.contains("hidden") ? "▸ thinking" : "▾ thinking";
			});
			body.append(t);
		}
		const text = el("pre", { class: "text" }, m.text || " ");
		body.append(text);
		// Speak button: synthesize + play this message.
		const speakBtn = el(
			"button",
			{
				class: "speak-btn",
				title: "Speak this message (local TTS)",
				onclick: () => void speakText(m.text),
			},
			"🔊",
		);
		body.append(speakBtn);
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
	return el("div", { class: "row row-error" }, el("span", { class: "role" }, "!"), el("span", { class: "body" }, m.text));
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return String(args ?? "");
	const a = args as Record<string, unknown>;
	if (typeof a.command === "string") return a.command;
	if (typeof a.path === "string" && typeof a.content === "string") return `${a.path} (${a.content.length} chars)`;
	if (typeof a.path === "string") return a.path;
	return JSON.stringify(a);
}

/**
 * True iff the user is currently sitting at the bottom of the messages list
 * (within a small tolerance). Used to decide whether new streamed tokens
 * should keep the viewport pinned to the latest line, or leave the user
 * alone when they've deliberately scrolled up to re-read something.
 */
function isAtBottom(): boolean {
	const list = $("#messages");
	const slack = 32; // px — small enough that "near the bottom" counts as pinned
	return list.scrollHeight - list.clientHeight - list.scrollTop <= slack;
}

function scrollToBottom(): void {
	const list = $("#messages");
	list.scrollTop = list.scrollHeight;
}

/**
 * Scroll only if the user is already at (or near) the bottom. If they've
 * scrolled up, do nothing — we don't want to yank them away from the
 * earlier text they were re-reading. Used during streaming so the cursor
 * line doesn't keep moving once the reader has looked away from it.
 */
function scrollToBottomIfPinned(): void {
	if (isAtBottom()) scrollToBottom();
}

function appendNode(node: HTMLElement): void {
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
function appendAssistantPlaceholder(): LiveAssistantDom {
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
		thinkingToggle.textContent = thinkingPre.classList.contains("hidden") ? "▸ thinking" : "▾ thinking";
	});
	body.append(thinkingWrap);
	const pre = el("pre", { class: "text streaming" });
	body.append(pre);
	// Speak button: synthesized text comes from the in-flight lastAssistant
	// record; we re-look it up at click time so the user can replay the
	// final text even after the streaming cursor has been removed.
	const speakBtn = el(
		"button",
		{
			class: "speak-btn",
			title: "Speak this message (local TTS)",
			onclick: () => {
				if (lastAssistant && lastAssistant.kind === "assistant") {
					void speakText(lastAssistant.text);
				}
			},
		},
		"🔊",
	);
	body.append(speakBtn);
	wrap.append(body);
	appendNode(wrap);
	return { textPre: pre, thinkingWrap, thinkingPre };
}

function appendToolCall(name: string, args: unknown): void {
	const wrap = el("div", { class: "row row-tool" });
	wrap.append(el("span", { class: "role role-tool" }, "Tool ›"));
	const body = el("div", { class: "tool-body" });
	body.append(el("div", { class: "tool-name" }, `${name} ${summarizeArgs(args)}`));
	const pending = el("div", { class: "tool-pending" }, "running…");
	body.append(pending);
	wrap.append(body);
	wrap.dataset.toolPending = "1";
	appendNode(wrap);
}

function finalizeToolCall(name: string, result: string | undefined, isError: boolean): void {
	const list = $("#messages");
	const rows = list.querySelectorAll(".row-tool");
	// Find the last pending tool row.
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i] as HTMLElement;
		if (r.dataset.toolPending === "1") {
			delete r.dataset.toolPending;
			const pending = r.querySelector(".tool-pending");
			if (pending) pending.remove();
			const body = r.querySelector(".tool-body");
			if (body && result !== undefined) {
				body.append(el("pre", { class: `tool-result ${isError ? "tool-error" : ""}` }, result));
			}
			break;
		}
	}
	void name; // unused for now
}

function appendError(text: string): void {
	appendNode(el("div", { class: "row row-error" }, el("span", { class: "role" }, "!"), el("span", { class: "body" }, text)));
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function refreshStatus(): void {
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
// Slash menu
// ---------------------------------------------------------------------------

const SLASH_COMMANDS: Record<string, string> = {
	// Core
	model: "open the model picker",
	think: "set thinking level: /think off|minimal|low|medium|high",
	clear: "start a new chat (alias: /new)",
	new: "start a new chat (alias: /clear)",
	sessions: "open the sessions list (alias: /resume)",
	resume: "open the sessions list (alias: /sessions)",
	help: "show this help",
	cost: "show session token/cost totals",
	abort: "abort the current run",
	// Session meta
	name: "rename the current session: /name <name>",
	session: "show session info (id, model, thinking, tokens, cost)",
	// Output
	copy: "copy the last assistant message to the clipboard",
	export: "download the current session as an HTML file",
	// Reference
	hotkeys: "show keyboard shortcuts",
	changelog: "show recent commits to this repo",
	// Misc
	reload: "reload the page (re-pick up any server-side changes)",
	quit: "close the tab",
	// Web access (pi-web-access tools)
	websearch: "search the web and summarise: /websearch <query>",
	fetch: "fetch and read a URL: /fetch <url>",
	codesearch: "search for code examples: /codesearch <query>",
};

function showSlashMenu(): void {
	const value = $<HTMLTextAreaElement>("#input").value;
	if (!value.startsWith("/")) return;
	// (For brevity: we just show a static hint below the input. The full
	// fuzzy-matching autocomplete from pi-tui is a follow-up.)
	// Trigger slash-menu rendering inline: parse the command, show a hint.
	const cmd = value.slice(1).split(/\s+/)[0] ?? "";
	const hint = SLASH_COMMANDS[cmd];
	if (hint) {
		$("#status-bar").textContent = `/${cmd} — ${hint}`;
	} else if (cmd) {
		$("#status-bar").textContent = `/${cmd} (unknown — will be sent as a prompt)`;
	} else {
		$("#status-bar").textContent = Object.entries(SLASH_COMMANDS).map(([k, v]) => `/${k} — ${v}`).join("    ");
	}
}

function handleSlash(arg: string): void {
	// `arg` is the slash body with the leading "/" already stripped (for
	// input-based invocations) OR a bare command name (for header-button
	// invocations like handleSlash("clear")).
	const parts = (arg || "").split(/\s+/);
	const cmd = (parts[0] || "").toLowerCase();
	const rest = parts.slice(1).join(" ");

	switch (cmd) {
		case "model":
			openModelPicker();
			break;
		case "think":
			if (rest && ["off", "minimal", "low", "medium", "high"].includes(rest)) {
				chatClient.setThinking(rest as ThinkingLevel);
				state.currentThinking = rest as ThinkingLevel;
				$<HTMLTextAreaElement>("#input").value = "";
				refreshStatus();
			} else {
				openThinkPicker();
			}
			break;
		case "clear":
			if (confirm("Start a new chat? Current conversation will be saved.")) {
				void saveCurrentSession().then(() => {
					state.sessionId = uuid();
					state.title = "New chat";
					state.messages = [];
					state.history = [];
					state.historyIdx = null;
					state.costTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					renderShell();
				});
			}
			break;
		case "sessions":
			$<HTMLTextAreaElement>("#input").value = "";
			void openSessionsDialog();
			break;
		case "help":
			appendNode(
				el("pre", { class: "help" }, "Slash commands:\n" + Object.entries(SLASH_COMMANDS).map(([k, v]) => `  /${k.padEnd(8)} ${v}`).join("\n")),
			);
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "cost":
			{
				const c = state.costTotal;
				appendNode(el("pre", { class: "help" }, `Session totals:\n  in:  ${c.input.toLocaleString()} tok\n  out: ${c.output.toLocaleString()} tok\n  cache read: ${c.cacheRead.toLocaleString()} tok\n  cache write: ${c.cacheWrite.toLocaleString()} tok\n  cost: $${c.cost.toFixed(6)}`));
				$<HTMLTextAreaElement>("#input").value = "";
			}
			break;
		case "abort":
			chatClient.abort();
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		// --- New commands: aliases first, then actions. ---
		case "new":
			// Alias for /clear.
			handleSlash("clear");
			return;
		case "resume":
			// Alias for /sessions.
			handleSlash("sessions");
			return;
		case "name": {
			const newName = rest.trim();
			if (!newName) {
				appendError("usage: /name <name>");
			} else {
				state.title = newName.slice(0, 60);
				$<HTMLSpanElement>("#title").textContent = state.title;
				void saveCurrentSession();
			}
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "session": {
			const c = state.costTotal;
			const info =
				`Session info:\n` +
				`  id:        ${state.sessionId}\n` +
				`  title:     ${state.title}\n` +
				`  model:     ${state.currentModelId ?? "(unknown)"}\n` +
				`  thinking:  ${state.currentThinking}\n` +
				`  messages:  ${state.messages.length}\n` +
				`  in:        ${c.input.toLocaleString()} tok\n` +
				`  out:       ${c.output.toLocaleString()} tok\n` +
				`  cache r/w: ${c.cacheRead.toLocaleString()} / ${c.cacheWrite.toLocaleString()} tok\n` +
				`  cost:      $${c.cost.toFixed(6)}`;
			appendNode(el("pre", { class: "help" }, info));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "copy": {
			for (let i = state.messages.length - 1; i >= 0; i--) {
				const m = state.messages[i];
				if (m.kind === "assistant" && m.text.trim()) {
					const ok = copyToClipboard(m.text);
					if (ok) appendNode(el("pre", { class: "help" }, "Copied last assistant message to clipboard."));
					else appendError("clipboard access denied");
					break;
				}
			}
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "export":
			exportSessionAsHtml();
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "hotkeys": {
			const text =
				`Keyboard shortcuts:\n` +
				`  Enter           send message\n` +
				`  Shift+Enter     newline in input\n` +
				`  /               open slash menu (in empty input)\n` +
				`  ↑ / ↓           recall previous / next user message\n` +
				`  /abort          stop the current run\n` +
				`  /clear          start a new chat\n` +
				`  /sessions       browse previous chats\n` +
				`  /model          switch model\n` +
				`  /think <level>  set thinking level`;
			appendNode(el("pre", { class: "help" }, text));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "changelog": {
			void fetch("/api/changelog?limit=20")
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((data) => {
					const lines = (data.commits ?? []).map((c) =>
						`  ${c.hash}  ${c.date.slice(0, 10)}  ${c.subject}`,
					);
					appendNode(el("pre", { class: "help" }, `Recent commits:\n${lines.join("\n") || "  (none)"}`));
				})
				.catch((e) => appendError("changelog failed: " + (e instanceof Error ? e.message : String(e))));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "reload":
			location.reload();
			return;
		case "quit":
			try { window.close(); } catch { /* ignore */ }
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "websearch": {
			const query = rest;
			if (!query) {
				appendError("Usage: /websearch <query>");
			} else {
				sendAsUser(`Use web_search to look up: ${query}\nGive me a 3-sentence summary plus the top 3 source URLs.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			autoSize();
			break;
		}
		case "fetch": {
			const url = rest;
			if (!url) {
				appendError("Usage: /fetch <url>");
			} else {
				sendAsUser(`Use fetch_content to grab ${url} and summarise the key points in 5 bullet points.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			autoSize();
			break;
		}
		case "codesearch": {
			const query = rest;
			if (!query) {
				appendError("Usage: /codesearch <query>");
			} else {
				sendAsUser(`Use code_search to find: ${query}\nGive me 2 short code snippets with source URLs.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			autoSize();
			break;
		}
		default:
			// Unknown. Leave the slash in the input and let it be sent as a regular prompt.
			refreshStatus();
	}
}

function openModelPicker(): void {
	if (state.availableModels.length === 0) {
		appendError("No models available (server has no provider keys configured).");
		return;
	}
	// Group models by provider for readability. Within each group, sort
	// by name. We use a stable insertion-ordered map (the model list
	// returned by /api/models is already grouped by provider, but we
	// re-group defensively in case the server changes that).
	const groups = new Map<string, ModelOption[]>();
	for (const m of state.availableModels) {
		const list = groups.get(m.provider) ?? [];
		list.push(m);
		groups.set(m.provider, list);
	}
	for (const [, list] of groups) {
		list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
	}

	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box model-picker-box" });
	box.append(el("h3", { text: "Choose model" }));

	for (const [provider, models] of groups) {
		box.append(el("div", { class: "model-group-header" }, provider));
		for (const m of models) {
			const row = el("div", { class: "model-row" });
			const main = el("div", { class: "model-name" }, m.name ?? m.id);
			if (m.reasoning) {
				main.append(el("span", { class: "model-badge", title: "Supports extended thinking" }, "thinking"));
			}
			row.append(main);
			row.append(el("div", { class: "model-provider" }, m.id === m.name ? "" : m.id));
			if (m.id === state.currentModelId) row.classList.add("active");
			row.addEventListener("click", () => {
				// Update displayed model optimistically so the picker
				// feels instant, but mark the model as "pending" so the
				// server's next `ready` event confirms it (rather than
				// being mistaken for a default-rebroadcast on a new
				// connection). See onReady in boot() for the matching
				// logic.
				state.currentModelId = m.id;
				state.currentProvider = m.provider;
				state.pendingModelSet = m.id;
				chatClient.setModel(m.id, m.provider);
				refreshStatus();
				document.body.removeChild(overlay);
			});
			box.append(row);
		}
	}

	box.append(el("button", { class: "btn", text: "Close", onclick: () => document.body.removeChild(overlay) }));
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

function openThinkPicker(): void {
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "Thinking level" }));
	for (const lvl of levels) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, lvl));
		if (lvl === state.currentThinking) row.classList.add("active");
		row.addEventListener("click", () => {
			chatClient.setThinking(lvl);
			state.currentThinking = lvl;
			refreshStatus();
			document.body.removeChild(overlay);
		});
		box.append(row);
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => document.body.removeChild(overlay) }));
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

async function openSessionsDialog(): Promise<void> {
	const all = await dbAllSessions();
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "Sessions" }));
	if (all.length === 0) {
		box.append(el("p", { class: "muted", text: "No saved sessions yet." }));
	} else {
		for (const s of all) {
			const row = el("div", { class: "session-row" });
			row.append(el("div", { class: "session-title" }, s.title));
			row.append(el("div", { class: "session-meta" }, `${s.messages.length} msgs · ${s.modelId}`));
			row.addEventListener("click", async () => {
				document.body.removeChild(overlay);
				await loadSession(s.id);
			});
			box.append(row);
		}
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => document.body.removeChild(overlay) }));
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

async function loadSession(id: string): Promise<void> {
	const all = await dbAllSessions();
	const s = all.find((x) => x.id === id);
	if (!s) return;
	state.sessionId = s.id;
	state.title = s.title;
	state.messages = s.messages as unknown as PersistedMessage[];
	state.currentModelId = s.modelId;
	state.currentProvider = s.provider;
	state.currentThinking = s.thinkingLevel;
	renderShell();
	// Re-sync model + thinking with the server so subsequent prompts use them.
	// Mark the model as pending so the server's `ready` confirmation
	// (which is the only signal that the new agent is built) updates the
	// UI rather than being masked as a default-rebroadcast. See onReady
	// in boot() for the matching logic.
	state.currentModelId = s.modelId;
	state.currentProvider = s.provider;
	state.pendingModelSet = s.modelId;
	chatClient.setModel(s.modelId, s.provider);
	chatClient.setThinking(s.thinkingLevel);
	$<HTMLSpanElement>("#title").textContent = s.title;
	refreshStatus();
}

async function saveCurrentSession(): Promise<void> {
	if (state.messages.length === 0) return;
	const rec: SessionRecord = {
		id: state.sessionId,
		title: state.title,
		modelId: state.currentModelId ?? "unknown",
		provider: state.currentProvider ?? "unknown",
		thinkingLevel: state.currentThinking,
		messages: state.messages as unknown as Array<Record<string, unknown>>,
		createdAt: new Date().toISOString(),
		lastModified: new Date().toISOString(),
	};
	await dbSaveSession(rec);
}

// ---------------------------------------------------------------------------
// TTS (local piper)
// ---------------------------------------------------------------------------

/**
 * Synthesize the given text via /api/tts and play it on the shared <audio>.
 * One call at a time — starting a new one stops the current playback.
 */
async function speakText(text: string): Promise<void> {
	const trimmed = text.trim();
	if (!trimmed) return;
	const audio = $<HTMLAudioElement>("#tts-audio");
	state.ttsInFlight++;
	refreshStatus();
	try {
		// Stop any current playback.
		audio.pause();
		audio.currentTime = 0;
		const blob = await synthesizeSpeech(trimmed, state.ttsVoice ?? undefined);
		const url = URL.createObjectURL(blob);
		audio.src = url;
		await audio.play();
		// Revoke object URL after playback ends (or on next speak).
		audio.onended = () => {
			URL.revokeObjectURL(url);
			audio.onended = null;
		};
	} catch (err) {
		appendError("tts failed: " + (err instanceof Error ? err.message : String(err)));
	} finally {
		state.ttsInFlight--;
		refreshStatus();
	}
}

function toggleAutoSpeak(): void {
	state.autoSpeak = !state.autoSpeak;
	const btn = $<HTMLButtonElement>("#tts-toggle");
	btn.classList.toggle("active", state.autoSpeak);
	btn.textContent = state.autoSpeak ? "🔊 on" : "🔇 off";
	refreshStatus();
}

async function openVoicePicker(): Promise<void> {
	let voices: string[];
	let defaultVoice: string;
	try {
		const v = await listVoices();
		voices = v.available;
		defaultVoice = v.default;
	} catch (e) {
		appendError("could not list voices: " + (e instanceof Error ? e.message : String(e)));
		return;
	}
	if (voices.length === 0) {
		appendError("no piper voices found. Download one to ~/.local/share/piper/voices/.");
		return;
	}

	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "TTS voice" }));
	for (const v of voices) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, v));
		if (v === defaultVoice) row.append(el("div", { class: "model-provider" }, "(server default)"));
		if (v === state.ttsVoice) row.classList.add("active");
		row.addEventListener("click", () => {
			state.ttsVoice = v;
			document.body.removeChild(overlay);
			refreshStatus();
		});
		box.append(row);
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => document.body.removeChild(overlay) }));
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

/**
 * Compact mobile menu — only shown on narrow screens (see styles.css).
 * Re-exposes model, thinking, voice, and TTS toggle in a single overlay.
 */
function openOverflowMenu(): void {
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box overflow-box" });
	box.append(el("h3", { text: "Settings" }));

	const modelLine = el("div", { class: "overflow-row" });
	modelLine.append(el("div", { class: "overflow-label" }, "model"));
	modelLine.append(el("div", { class: "overflow-value" }, state.currentModelId ?? "—"));
	modelLine.addEventListener("click", () => {
		document.body.removeChild(overlay);
		openModelPicker();
	});
	box.append(modelLine);

	const thinkLine = el("div", { class: "overflow-row" });
	thinkLine.append(el("div", { class: "overflow-label" }, "think"));
	thinkLine.append(el("div", { class: "overflow-value" }, state.currentThinking));
	thinkLine.addEventListener("click", () => {
		document.body.removeChild(overlay);
		openThinkPicker();
	});
	box.append(thinkLine);

	const voiceLine = el("div", { class: "overflow-row" });
	voiceLine.append(el("div", { class: "overflow-label" }, "voice"));
	voiceLine.append(el("div", { class: "overflow-value" }, state.ttsVoice ?? "default"));
	voiceLine.addEventListener("click", () => {
		document.body.removeChild(overlay);
		void openVoicePicker();
	});
	box.append(voiceLine);

	const ttsLine = el("div", { class: "overflow-row" });
	ttsLine.append(el("div", { class: "overflow-label" }, "auto-speak"));
	ttsLine.append(el("div", { class: "overflow-value" }, state.autoSpeak ? "on" : "off"));
	ttsLine.addEventListener("click", () => {
		toggleAutoSpeak();
		ttsLine.querySelector(".overflow-value")!.textContent = state.autoSpeak ? "on" : "off";
	});
	box.append(ttsLine);

	box.append(el("button", { class: "btn", text: "Close", onclick: () => document.body.removeChild(overlay) }));
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

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

	chatClient.prompt(trimmed);
	setStreaming(true);
}

function isKnownSlash(s: string): boolean {
	const cmd = s.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
	return cmd in SLASH_COMMANDS;
}


/**
 * Copy text to the system clipboard. Returns false on permission denied
 * or in non-secure contexts where navigator.clipboard is unavailable.
 */
function copyToClipboard(text: string): boolean {
	try {
		if (navigator.clipboard?.writeText) {
			// navigator.clipboard requires https or localhost. Fall back to
			// the legacy textarea trick on http:// LAN addresses.
			navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through
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

/**
 * Download the current session as a self-contained HTML file. Used by
 * /export. Produces a styled dark-mode page that mirrors the chat view.
 */
function exportSessionAsHtml(): void {
	const esc = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	const css = `
		* { box-sizing: border-box; }
		body { background: #0b0b0b; color: #d4d4d4; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 24px; line-height: 1.5; }
		h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
		.msg { padding: 6px 0; display: flex; gap: 10px; }
		.role { flex-shrink: 0; font-weight: 600; }
		.user .role { color: #7aa2f7; }
		.assistant .role { color: #9ece6a; }
		.tool .role { color: #bb9af7; }
		.error .role { color: #f7768e; }
		.body { flex: 1; min-width: 0; white-space: pre-wrap; word-wrap: break-word; }
		.tool-body { flex: 1; }
		.tool-name { color: #9aa0a6; font-size: 12px; margin-bottom: 4px; }
		.tool-result { background: #161616; padding: 6px 10px; border-radius: 4px; font-size: 12px; max-height: 400px; overflow: auto; }
		.tool-error { border-left: 2px solid #f7768e; }
		.thinking { color: #5a5a5a; font-size: 12px; }
		.thinking-body { margin: 4px 0 4px 12px; max-height: 200px; overflow: auto; border-left: 2px solid #2a2a2a; padding-left: 8px; }
		.meta { color: #5a5a5a; font-size: 12px; margin-bottom: 16px; }
		footer { color: #5a5a5a; font-size: 12px; margin-top: 24px; border-top: 1px solid #1f1f1f; padding-top: 12px; }
	`;
	const c = state.costTotal;
	const lines: string[] = [];
	lines.push(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(state.title)} — agentchatbox export</title><style>${css}</style></head><body>`);
	lines.push(`<h1>${esc(state.title)}</h1>`);
	lines.push(`<div class="meta">id: ${esc(state.sessionId.slice(0, 8))} · model: ${esc(state.currentModelId ?? "(unknown)")} · thinking: ${esc(state.currentThinking)} · ${state.messages.length} messages · ${c.input.toLocaleString()}/${c.output.toLocaleString()} tok · $${c.cost.toFixed(6)}</div>`);
	for (const m of state.messages) {
		if (m.kind === "user") {
			lines.push(`<div class="msg user"><span class="role">You ›</span><span class="body">${esc(m.text)}</span></div>`);
		} else if (m.kind === "assistant") {
			lines.push(`<div class="msg assistant"><span class="role">Pi ›</span><span class="body">`);
			if (m.thinking) lines.push(`<details class="thinking"><summary>▸ thinking</summary><pre class="thinking-body">${esc(m.thinking)}</pre></details>`);
			lines.push(esc(m.text));
			lines.push(`</span></div>`);
		} else if (m.kind === "tool") {
			const args = (() => {
				try { return JSON.stringify(m.args); } catch { return String(m.args); }
			})();
			lines.push(`<div class="msg tool"><span class="role">Tool ›</span><div class="tool-body"><div class="tool-name">${esc(m.name)} ${esc(args)}</div>`);
			if (m.result !== undefined) {
				lines.push(`<pre class="tool-result${m.isError ? " tool-error" : ""}">${esc(m.result)}</pre>`);
			}
			lines.push(`</div></div>`);
		} else if (m.kind === "error") {
			lines.push(`<div class="msg error"><span class="role">!</span><span class="body">${esc(m.text)}</span></div>`);
		}
	}
	lines.push(`<footer>Exported from agentchatbox · ${new Date().toISOString()}</footer>`);
	lines.push(`</body></html>`);
	const blob = new Blob([lines.join("\n")], { type: "text/html;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${state.title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase().slice(0, 40) || "session"}-${state.sessionId.slice(0, 8)}.html`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// File / voice
// ---------------------------------------------------------------------------

async function handleFileAttach(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	const files = input.files;
	if (!files || files.length === 0) return;
	const ta = $<HTMLTextAreaElement>("#input");
	for (const file of Array.from(files)) {
		try {
			const res = await uploadFile(file);
			const insertion = res.mimeType.startsWith("image/")
				? `\n[image: ${res.filename}](${res.url})`
				: `\n[file: ${res.filename}](${res.url})`;
			ta.value = (ta.value + " " + insertion).trim();
			autoSize();
		} catch (err) {
			appendError(err instanceof Error ? err.message : String(err));
		}
	}
	input.value = "";
}

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStart = 0;

async function handleVoiceRecord(): Promise<void> {
	if (mediaRecorder && mediaRecorder.state === "recording") {
		mediaRecorder.stop();
		return;
	}
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		recordedChunks = [];
		mediaRecorder = new MediaRecorder(stream);
		mediaRecorder.ondataavailable = (e) => {
			if (e.data.size > 0) recordedChunks.push(e.data);
		};
		mediaRecorder.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop());
			const blob = new Blob(recordedChunks, { type: "audio/webm" });
			const secs = (Date.now() - recordingStart) / 1000;
			$("#status-bar").textContent = `transcribing ${secs.toFixed(1)}s of audio…`;
			try {
				const text = await transcribeAudio(blob);
				$<HTMLTextAreaElement>("#input").value = text;
				autoSize();
				$("#status-bar").textContent = `transcribed (${text.length} chars). Press Enter to send.`;
			} catch (err) {
				appendError("transcription failed: " + (err instanceof Error ? err.message : String(err)));
			}
		};
		recordingStart = Date.now();
		mediaRecorder.start();
		$<HTMLButtonElement>("#voice-btn").textContent = "⏹";
		$("#status-bar").textContent = "recording… click ⏹ to stop";
	} catch (err) {
		appendError("microphone access denied: " + (err instanceof Error ? err.message : String(err)));
	}
}

// ---------------------------------------------------------------------------
// Event handling — bridge server events to DOM
// ---------------------------------------------------------------------------

let lastAssistant: PersistedMessage | null = null;
interface LiveAssistantDom {
	textPre: HTMLPreElement;
	thinkingWrap: HTMLDivElement;
	thinkingPre: HTMLPreElement;
}
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
					void speakText(t);
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

	renderShell();

	chatClient = createChatClient();
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
