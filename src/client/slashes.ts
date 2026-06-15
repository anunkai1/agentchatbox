/**
 * Slash commands and the modal dialogs that back them.
 *
 *   /model, /think, /voice    →  open picker
 *   /clear, /new               →  start a new chat
 *   /sessions, /resume         →  open the sessions list
 *   /copy, /export, /name, ... →  small text operations
 *
 * Each slash handler is a switch case in `handleSlash`. Pickers live as
 * standalone functions so they can be invoked from the header buttons
 * as well as the slash menu.
 */

import type { ThinkingLevel } from "../shared/protocol.js";
import { $, el, uuid } from "./dom.js";
import { appendError, appendNode, refreshStatus } from "./render.js";
import {
	dbAllSessions,
	dbSaveSession,
	state,
	type ModelOption,
	type SessionRecord,
} from "./state.js";

/**
 * Small helper for the slash command's help/session/copy messages.
 * Hoisted here (not at the bottom of the file as it used to be) so
 * forward readers can find the helper when they hit the first
 * call site in `handleSlash`.
 */
function el_pre(text: string): HTMLPreElement {
	const node = document.createElement("pre");
	node.className = "help";
	node.textContent = text;
	return node;
}

export const SLASH_COMMANDS: Record<string, string> = {
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

export function showSlashMenu(): void {
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

export function isKnownSlash(s: string): boolean {
	const cmd = s.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
	return cmd in SLASH_COMMANDS;
}

/**
 * Dependency for slash commands that need to actually send a prompt
 * (websearch/fetch/codesearch). main.ts wires this at boot.
 */
export type SendAsUserFn = (text: string) => void;
let sendAsUserFn: SendAsUserFn = () => {};
export function setSendAsUser(fn: SendAsUserFn): void {
	sendAsUserFn = fn;
}

/**
 * Dependency for slash commands that need to ask the server to switch
 * model/thinking. main.ts wires this at boot.
 */
export interface ChatControls {
	setModel(modelId: string, provider: string): void;
	setThinking(level: ThinkingLevel): void;
	abort(): void;
}
let chatControls: ChatControls | null = null;
export function setChatControls(c: ChatControls): void {
	chatControls = c;
}

export function handleSlash(arg: string): void {
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
			if (rest && ["off", "minimal", "low", "medium", "high"].includes(rest) && chatControls) {
				chatControls.setThinking(rest as ThinkingLevel);
				state.currentThinking = rest as ThinkingLevel;
				$<HTMLTextAreaElement>("#input").value = "";
				refreshStatus();
			} else {
				openThinkPicker();
			}
			break;
		case "clear":
			if (confirm("Start a new chat? Current conversation will be saved.")) {
				void saveCurrentSession().then(async () => {
					state.sessionId = uuid();
					state.title = "New chat";
					state.messages = [];
					state.history = [];
					state.historyIdx = null;
					state.costTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					const { renderShell } = await import("./render.js");
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
				el_pre("Slash commands:\n" + Object.entries(SLASH_COMMANDS).map(([k, v]) => `  /${k.padEnd(8)} ${v}`).join("\n")),
			);
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "cost": {
			const c = state.costTotal;
			appendNode(el_pre(`Session totals:\n  in:  ${c.input.toLocaleString()} tok\n  out: ${c.output.toLocaleString()} tok\n  cache read: ${c.cacheRead.toLocaleString()} tok\n  cache write: ${c.cacheWrite.toLocaleString()} tok\n  cost: $${c.cost.toFixed(6)}`));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "abort":
			chatControls?.abort();
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
			appendNode(el_pre(info));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "copy": {
			for (let i = state.messages.length - 1; i >= 0; i--) {
				const m = state.messages[i];
				if (m.kind === "assistant" && m.text.trim()) {
					// Fire-and-forget; copyToClipboard now awaits the
					// clipboard.writeText promise so a permission denial
					// surfaces correctly. We don't block the slash
					// command on it.
					void copyToClipboard(m.text).then((ok) => {
						if (ok) appendNode(el_pre("Copied last assistant message to clipboard."));
						else appendError("clipboard access denied");
					});
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
				`  Enter           newline in input (mobile-friendly)\n` +
				`  ⌘/Ctrl+Enter    send message\n` +
				`  /               open slash menu (in empty input)\n` +
				`  ↑ / ↓           recall previous / next user message\n` +
				`  /abort          stop the current run\n` +
				`  /clear          start a new chat\n` +
				`  /sessions       browse previous chats\n` +
				`  /model          switch model\n` +
				`  /think <level>  set thinking level`;
			appendNode(el_pre(text));
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "changelog": {
			interface Commit { hash: string; date: string; subject: string; }
			interface Changelog { commits?: Commit[]; }
			void fetch("/api/changelog?limit=20")
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((data: Changelog) => {
					const lines = (data.commits ?? []).map((c) =>
						`  ${c.hash}  ${c.date.slice(0, 10)}  ${c.subject}`,
					);
					appendNode(el_pre(`Recent commits:\n${lines.join("\n") || "  (none)"}`));
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
				sendAsUserFn(`Use web_search to look up: ${query}\nGive me a 3-sentence summary plus the top 3 source URLs.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			import("./render.js").then(({ autoSize }) => autoSize());
			break;
		}
		case "fetch": {
			const url = rest;
			if (!url) {
				appendError("Usage: /fetch <url>");
			} else {
				sendAsUserFn(`Use fetch_content to grab ${url} and summarise the key points in 5 bullet points.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			import("./render.js").then(({ autoSize }) => autoSize());
			break;
		}
		case "codesearch": {
			const query = rest;
			if (!query) {
				appendError("Usage: /codesearch <query>");
			} else {
				sendAsUserFn(`Use code_search to find: ${query}\nGive me 2 short code snippets with source URLs.`);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			import("./render.js").then(({ autoSize }) => autoSize());
			break;
		}
		default:
			// Unknown. Leave the slash in the input and let it be sent as a regular prompt.
			refreshStatus();
	}
}

interface ModalRefs { overlay: HTMLDivElement; box: HTMLDivElement; }
function openModal(title: string, extraClass?: string): ModalRefs {
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	if (extraClass) box.classList.add(extraClass);
	box.append(el("h3", { text: title }));
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) overlay.remove();
	});
	overlay.append(box);
	document.body.append(overlay);
	return { overlay, box };
}

// ---------------------------------------------------------------------------
// Picker dialogs
// ---------------------------------------------------------------------------

export function openModelPicker(): void {
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

	const { overlay, box } = openModal("Choose model", "model-picker-box");

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
				chatControls?.setModel(m.id, m.provider);
				refreshStatus();
				overlay.remove();
			});
			box.append(row);
		}
	}

	box.append(el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }));
}

export function openThinkPicker(): void {
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
	const { overlay, box } = openModal("Thinking level");
	for (const lvl of levels) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, lvl));
		if (lvl === state.currentThinking) row.classList.add("active");
		row.addEventListener("click", () => {
			chatControls?.setThinking(lvl);
			state.currentThinking = lvl;
			refreshStatus();
			overlay.remove();
		});
		box.append(row);
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }));
}

export async function openSessionsDialog(): Promise<void> {
	const all = await dbAllSessions();
	const { overlay, box } = openModal("Sessions");
	if (all.length === 0) {
		box.append(el("p", { class: "muted", text: "No saved sessions yet." }));
	} else {
		for (const s of all) {
			const row = el("div", { class: "session-row" });
			row.append(el("div", { class: "session-title" }, s.title));
			row.append(el("div", { class: "session-meta" }, `${s.messages.length} msgs · ${s.modelId}`));
			row.addEventListener("click", async () => {
				overlay.remove();
				await loadSession(s.id);
			});
			box.append(row);
		}
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }));
}

async function loadSession(id: string): Promise<void> {
	const all = await dbAllSessions();
	const s = all.find((x) => x.id === id);
	if (!s) return;
	state.sessionId = s.id;
	state.title = s.title;
	state.messages = s.messages;
	state.currentModelId = s.modelId;
	state.currentProvider = s.provider;
	state.currentThinking = s.thinkingLevel;
	const { renderShell } = await import("./render.js");
	renderShell();
	// Re-sync the model with the server so subsequent prompts use it.
	// Mark the model as pending so the server's `ready` confirmation
	// (which is the only signal that the new agent is built) updates
	// the UI rather than being masked as a default-rebroadcast. See
	// onReady in boot() for the matching logic. (The currentModelId /
	// currentProvider assignments above are kept — renderShell reads
	// them to display the model in the header status bar. We just
	// avoid reassigning them here, which would be a no-op.)
	state.pendingModelSet = s.modelId;
	chatControls?.setModel(s.modelId, s.provider);
	chatControls?.setThinking(s.thinkingLevel);
	$<HTMLSpanElement>("#title").textContent = s.title;
	refreshStatus();
}

export async function saveCurrentSession(): Promise<void> {
	if (state.messages.length === 0) return;
	const rec: SessionRecord = {
		id: state.sessionId,
		title: state.title,
		modelId: state.currentModelId ?? "unknown",
		provider: state.currentProvider ?? "unknown",
		thinkingLevel: state.currentThinking,
		messages: state.messages,
		createdAt: new Date().toISOString(),
		lastModified: new Date().toISOString(),
	};
	await dbSaveSession(rec);
}

export async function openVoicePicker(): Promise<void> {
	const { listVoices } = await import("./api.js");
	const { appendError } = await import("./render.js");

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

	const { overlay, box } = openModal("TTS voice");
	for (const v of voices) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, v));
		if (v === defaultVoice) row.append(el("div", { class: "model-provider" }, "(server default)"));
		if (v === state.ttsVoice) row.classList.add("active");
		row.addEventListener("click", () => {
			state.ttsVoice = v;
			overlay.remove();
			refreshStatus();
		});
		box.append(row);
	}
	box.append(el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }));
}

// ---------------------------------------------------------------------------
// Mobile overflow menu (compact mode)
// ---------------------------------------------------------------------------

/**
 * Compact mobile menu — only shown on narrow screens (see styles.css).
 * Re-exposes model, thinking, voice, and TTS toggle in a single overlay.
 */
export function openOverflowMenu(): void {
	const { overlay, box } = openModal("Settings", "overflow-box");

	const modelLine = el("div", { class: "overflow-row" });
	modelLine.append(el("div", { class: "overflow-label" }, "model"));
	modelLine.append(el("div", { class: "overflow-value" }, state.currentModelId ?? "—"));
	modelLine.addEventListener("click", () => {
		overlay.remove();
		openModelPicker();
	});
	box.append(modelLine);

	const thinkLine = el("div", { class: "overflow-row" });
	thinkLine.append(el("div", { class: "overflow-label" }, "think"));
	thinkLine.append(el("div", { class: "overflow-value" }, state.currentThinking));
	thinkLine.addEventListener("click", () => {
		overlay.remove();
		openThinkPicker();
	});
	box.append(thinkLine);

	const voiceLine = el("div", { class: "overflow-row" });
	voiceLine.append(el("div", { class: "overflow-label" }, "voice"));
	voiceLine.append(el("div", { class: "overflow-value" }, state.ttsVoice ?? "default"));
	voiceLine.addEventListener("click", () => {
		overlay.remove();
		void openVoicePicker();
	});
	box.append(voiceLine);

	const ttsLine = el("div", { class: "overflow-row" });
	ttsLine.append(el("div", { class: "overflow-label" }, "auto-speak"));
	ttsLine.append(el("div", { class: "overflow-value" }, state.autoSpeak ? "on" : "off"));
	ttsLine.addEventListener("click", async () => {
		const { toggleAutoSpeak } = await import("./voice.js");
		toggleAutoSpeak();
		ttsLine.querySelector(".overflow-value")!.textContent = state.autoSpeak ? "on" : "off";
	});
	box.append(ttsLine);

	box.append(el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }));
}

// ---------------------------------------------------------------------------
// Clipboard + export
// ---------------------------------------------------------------------------

/**
 * Copy text to the system clipboard. Returns false on permission denied
 * or in non-secure contexts where navigator.clipboard is unavailable.
 *
 * The `navigator.clipboard.writeText` call is awaited so a permission
 * denial surfaces here (return `false`) instead of escaping the try as
 * a fire-and-forget rejection. Before this fix, the function returned
 * `true` *before* the write resolved, so callers that logged "copied!"
 * were lying when the clipboard write had actually failed.
 */
async function copyToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			// navigator.clipboard requires https or localhost. Fall back to
			// the legacy textarea trick on http:// LAN addresses.
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to textarea fallback
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
export function exportSessionAsHtml(): void {
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
