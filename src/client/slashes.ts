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

import type { SessionSummary, ThinkingLevel } from "../shared/protocol.js";
import { THINKING_LEVELS } from "../shared/thinking.js";
import { listVoices } from "./api.js";
import { $, el, escapeHtml, mountModal } from "./dom.js";
import { saveSessionPrefs } from "./prefs.js";
import {
	appendError,
	appendNode,
	autoSize,
	openProjectEditor,
	refreshStatus,
	renderShell,
	toggleCapabilitiesPopover,
} from "./render.js";
import { services } from "./services.js";
import {
	defaultModelForNewChats,
	GLOBAL_PROJECT_ID,
	type ModelOption,
	refreshCurrentModelLabel,
	state,
} from "./state.js";
import { shareableSessionUrl } from "./url.js";

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
	models: "show all models & services in use (display-only overview)",
	imagemodel: "open the image-generation model picker (alias: /image)",
	image: "open the image-generation model picker (alias: /imagemodel)",
	imggen: 'generate an image directly (no LLM): /imggen [-a ASPECT] [-m MODEL] "prompt"',
	think: "set a model-supported thinking level: /think off|minimal|low|medium|high|xhigh|max",
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
	link: "copy a shareable link to this chat (alias: /share)",
	share: "copy a shareable link to this chat (alias: /link)",
	export: "download the current session as an HTML file",
	// Reference
	hotkeys: "show keyboard shortcuts",
	changelog: "show recent commits to this repo",
	// Misc
	reload: "reload the page (re-pick up any server-side changes)",
	quit: "close the tab",
	// Transport-only alias. pi's acb-workflows input handler owns behavior.
	websearch: "search the web and summarise: /websearch <query>",
	project: "start a new chat in a project: /project <name|id>",
};

interface CommandPaletteEntry {
	name: string;
	description: string;
	category: string;
	order: number;
}

const COMMAND_CATEGORIES = ["Core", "Sessions", "Tools", "Output", "Reference", "Extensions"];
let commandPalette: HTMLElement | null = null;
let commandPaletteInput: HTMLTextAreaElement | null = null;
let commandPaletteOutsideClick: ((event: PointerEvent) => void) | null = null;
let commandPaletteEntries: CommandPaletteEntry[] = [];
let commandPaletteFiltered: CommandPaletteEntry[] = [];
let commandPaletteSelected = 0;

function commandCategory(name: string): string {
	if (["model", "models", "imagemodel", "image", "imggen", "think", "abort"].includes(name))
		return "Core";
	if (["clear", "new", "sessions", "resume", "name", "session", "project"].includes(name))
		return "Sessions";
	if (name === "websearch") return "Tools";
	if (["copy", "link", "share", "export"].includes(name)) return "Output";
	return "Reference";
}

function getCommandPaletteEntries(): CommandPaletteEntry[] {
	const entries: CommandPaletteEntry[] = Object.entries(SLASH_COMMANDS).map(
		([name, description], order) => ({
			name,
			description,
			category: commandCategory(name),
			order,
		}),
	);
	const names = new Set(entries.map((entry) => entry.name));
	for (const command of state.capabilities ?? []) {
		if (command.source === "skill" || names.has(command.name)) continue;
		// ACB presents the familiar /websearch alias; /research is the
		// collision-free pi command it transports to, not a second UI entry.
		if (command.name === "research" && names.has("websearch")) continue;
		entries.push({
			name: command.name,
			description: command.description || "Extension command",
			category: ["research", "fetch", "codesearch"].includes(command.name)
				? "Tools"
				: "Extensions",
			order: entries.length,
		});
		names.add(command.name);
	}
	return entries.sort((a, b) => {
		const categoryDelta =
			COMMAND_CATEGORIES.indexOf(a.category) - COMMAND_CATEGORIES.indexOf(b.category);
		return categoryDelta || a.order - b.order;
	});
}

function closeCommandPalette(): void {
	if (commandPaletteInput) {
		commandPaletteInput.setAttribute("aria-expanded", "false");
		commandPaletteInput.removeAttribute("aria-controls");
	}
	if (commandPaletteOutsideClick) {
		document.removeEventListener("pointerdown", commandPaletteOutsideClick);
	}
	commandPalette?.remove();
	commandPalette = null;
	commandPaletteInput = null;
	commandPaletteOutsideClick = null;
	commandPaletteFiltered = [];
	commandPaletteSelected = 0;
}

export function closeSlashMenu(): void {
	closeCommandPalette();
}

function refreshCommandPaletteSelection(): void {
	if (!commandPalette) return;
	const rows = commandPalette.querySelectorAll<HTMLElement>("[data-command-index]");
	rows.forEach((row) => {
		const active = Number(row.dataset.commandIndex) === commandPaletteSelected;
		row.classList.toggle("active", active);
		row.setAttribute("aria-selected", String(active));
	});
	rows[commandPaletteSelected]?.scrollIntoView({ block: "nearest" });
}

function chooseCommand(entry: CommandPaletteEntry): void {
	const input = commandPaletteInput;
	if (!input) return;
	const needsArgument = /<[^>]+>/.test(entry.description);
	input.value = `/${entry.name}${needsArgument ? " " : ""}`;
	input.focus();
	input.setSelectionRange(input.value.length, input.value.length);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	closeCommandPalette();
}

function renderCommandPalette(): void {
	const input = commandPaletteInput;
	if (!input) return;
	const raw = input.value.slice(1);
	const query = raw.toLowerCase();
	commandPaletteEntries = getCommandPaletteEntries();
	commandPaletteFiltered = commandPaletteEntries.filter(
		(entry) =>
			!query ||
			entry.name.toLowerCase().includes(query) ||
			entry.description.toLowerCase().includes(query),
	);
	commandPaletteSelected = Math.min(
		commandPaletteSelected,
		Math.max(0, commandPaletteFiltered.length - 1),
	);

	if (!commandPalette) {
		const composer = document.getElementById("composer");
		if (!composer) return;
		commandPalette = el("div", {
			class: "command-palette",
			id: "command-palette",
			role: "listbox",
			"aria-label": "Slash commands",
		});
		composer.append(commandPalette);
		input.setAttribute("aria-expanded", "true");
		input.setAttribute("aria-controls", "command-palette");
		commandPaletteOutsideClick = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && !commandPalette?.contains(target) && target !== commandPaletteInput) {
				closeCommandPalette();
			}
		};
		document.addEventListener("pointerdown", commandPaletteOutsideClick);
	}

	const palette = commandPalette;
	if (!palette) return;
	palette.replaceChildren();
	if (commandPaletteFiltered.length === 0) {
		palette.append(el("div", { class: "command-palette-empty" }, "No matching commands"));
		return;
	}

	let lastCategory = "";
	commandPaletteFiltered.forEach((entry, index) => {
		if (entry.category !== lastCategory) {
			lastCategory = entry.category;
			palette.append(el("div", { class: "command-palette-category" }, entry.category));
		}
		const row = el("button", {
			class: `command-palette-item${index === commandPaletteSelected ? " active" : ""}`,
			type: "button",
			role: "option",
			"aria-selected": String(index === commandPaletteSelected),
		});
		row.dataset.commandIndex = String(index);
		row.append(
			el("span", { class: "command-palette-name" }, `/${entry.name}`),
			el("span", { class: "command-palette-description" }, entry.description),
		);
		row.addEventListener("mouseenter", () => {
			commandPaletteSelected = index;
			refreshCommandPaletteSelection();
		});
		row.addEventListener("click", () => chooseCommand(entry));
		palette.append(row);
	});
}

export function handleSlashMenuKeydown(event: KeyboardEvent): boolean {
	if (!commandPalette || commandPaletteInput !== event.currentTarget) return false;
	if (event.key === "Escape") {
		event.preventDefault();
		closeCommandPalette();
		return true;
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		if (commandPaletteFiltered.length === 0) return true;
		const direction = event.key === "ArrowDown" ? 1 : -1;
		commandPaletteSelected =
			(commandPaletteSelected + direction + commandPaletteFiltered.length) %
			commandPaletteFiltered.length;
		refreshCommandPaletteSelection();
		return true;
	}
	if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
		if (commandPaletteFiltered.length === 0) return false;
		event.preventDefault();
		chooseCommand(commandPaletteFiltered[commandPaletteSelected]);
		return true;
	}
	return false;
}

export function showSlashMenu(): void {
	const input = $<HTMLTextAreaElement>("#input");
	const value = input.value;
	// Arguments belong in the composer, not in the command picker. Keep the
	// palette open while choosing a command name, then let it disappear once
	// the user types a space and starts entering arguments.
	if (!value.startsWith("/") || /\s/.test(value.slice(1))) {
		closeCommandPalette();
		return;
	}
	if (commandPaletteInput !== input) {
		closeCommandPalette();
		commandPaletteInput = input;
		commandPaletteSelected = 0;
	}
	renderCommandPalette();
}

export function isKnownSlash(s: string): boolean {
	const cmd = s.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
	return (
		cmd in SLASH_COMMANDS ||
		(state.capabilities ?? []).some((entry) => entry.name.toLowerCase() === cmd && entry.source !== "skill")
	);
}

/**
 * Dependency for slash commands that need to ask the server to switch
 * model/thinking. main.ts wires this at boot.
 */
export interface ChatControls {
	setModel(modelId: string, provider: string): void;
	setThinking(level: ThinkingLevel): void;
	abort(): void;
	/** Start a new session in a project (defaults to Global when omitted). */
	newSession(projectId?: string): void;
	resumeSession(sessionId: string): void;
	listSessions(): void;
	renameSession(name: string): void;
	/**
	 * Update a project's metadata/defaults. Used by the model picker's
	 * star button to set (or clear) the Global project's default model
	 * for new chats. Mirrors chatClient.updateProject — pure transport.
	 */
	updateProject(input: {
		id: string;
		defaultModelId?: string | null;
		defaultProvider?: string | null;
		defaultThinkingLevel?: ThinkingLevel | null;
	}): void;
}
let chatControls: ChatControls | null = null;
export function setChatControls(c: ChatControls): void {
	chatControls = c;
}

/**
 * Reset the renderer cache + cost counters for a brand-new chat. Shared by
 * /clear (Global) and /project <name> so both leave a clean slate before
 * the server's new `pi` child reports back. The server auto-saved the
 * prior session, so there's no local save step.
 */
function resetChatState(): void {
	state.title = "New chat";
	state.messages = [];
	state.history = [];
	state.historyIdx = null;
	state.costTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	renderShell();
}

/** Public so main.ts's `newSessionInProject` can reset before spawning. */
export { resetChatState };

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
		case "models":
			openModelsPanel();
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "imagemodel":
		case "image":
			// Forwarded to pi — the pi-venice-image extension registers the
			// /imagemodel command and owns the model catalog + persistence.
			// ACB renders the picker via the extension_ui relay.
			//
			// Sent via the lean sendSlashCommand path, NOT sendAsUser, because
			// this is an extension-owned picker rather than a user prompt.
			services.sendSlashCommand?.(`/${cmd}`);
			break;
		case "websearch":
			// Preserve the friendly legacy alias, but route it to the collision-free
			// /research command. The acb-workflows pi extension owns validation,
			// prompt construction, and delivery.
			services.sendSlashCommand?.(`/research${rest ? ` ${rest}` : ""}`);
			break;
		case "imggen":
			// Model-free image generation (pi-local-image extension). Same
			// lean sendSlashCommand path as /imagemodel — /imggen is an
			// extension command that calls the image backend directly and
			// surfaces the result via a custom "note" message. `rest` carries
			// the prompt + flags.
			services.sendSlashCommand?.(`/imggen ${rest}`);
			break;
		case "think": {
			const requested = (THINKING_LEVELS as readonly string[]).includes(rest)
				? (rest as ThinkingLevel)
				: null;
			if (requested && currentModelThinkingLevels().includes(requested) && chatControls) {
				chatControls.setThinking(requested);
				state.currentThinking = requested;
				$<HTMLTextAreaElement>("#input").value = "";
				refreshStatus();
			} else {
				openThinkPicker();
			}
			break;
		}
		case "clear":
			if (confirm("Start a new chat? Current conversation will be saved.")) {
				// Server-side: `pi` already auto-saves on every event, so
				// there's no local "save the prior session" step. We just
				// ask the server to start a new one (in Global by default).
				resetChatState();
				chatControls?.newSession();
			}
			break;
		case "sessions":
			$<HTMLTextAreaElement>("#input").value = "";
			void openSessionsDialog();
			break;
		case "help":
			appendNode(
				el_pre(
					"Slash commands:\n" +
						Object.entries(SLASH_COMMANDS)
							.map(([k, v]) => `  /${k.padEnd(8)} ${v}`)
							.join("\n"),
				),
			);
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		case "cost": {
			const c = state.costTotal;
			appendNode(
				el_pre(
					`Session totals:\n  in:  ${c.input.toLocaleString()} tok\n  out: ${c.output.toLocaleString()} tok\n  cache read: ${c.cacheRead.toLocaleString()} tok\n  cache write: ${c.cacheWrite.toLocaleString()} tok\n  cost: $${c.cost.toFixed(6)}`,
				),
			);
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
		case "project": {
			// Start a new chat in a named project. Matches by id first, then
			// by case-insensitive name. No arg opens the project editor.
			const q = rest.trim().toLowerCase();
			if (!q) {
				openProjectEditor();
				$<HTMLTextAreaElement>("#input").value = "";
				return;
			}
			const match =
				state.projects.find((p) => p.id === rest.trim()) ??
				state.projects.find((p) => p.name.toLowerCase() === q);
			if (!match) {
				appendError(
					`No project named "${rest.trim()}". Projects: ${
						state.projects.map((p) => p.name).join(", ") || "(none yet)"
					}`,
				);
			} else if (confirm(`Start a new chat in "${match.name}"?`)) {
				resetChatState();
				chatControls?.newSession(match.id);
			}
			$<HTMLTextAreaElement>("#input").value = "";
			return;
		}
		case "resume":
			// If a session id is provided (e.g. from the sidebar), resume
			// that session directly. Otherwise open the sessions picker.
			if (rest.trim()) {
				chatControls?.resumeSession(rest.trim());
			} else {
				handleSlash("sessions");
			}
			return;
		case "name": {
			const newName = rest.trim();
			if (!newName) {
				appendError("usage: /name <name>");
			} else {
				state.title = newName.slice(0, 60);
				$<HTMLSpanElement>("#title").textContent = state.title;
				chatControls?.renameSession(newName.slice(0, 60));
			}
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "session": {
			const c = state.costTotal;
			const link = shareableSessionUrl(state.sessionId);
			const info =
				`Session info:\n` +
				`  title:     ${state.title}\n` +
				`  id:        ${state.sessionId ?? "(none)"}\n` +
				`  model:     ${state.currentModelId ?? "(unknown)"}\n` +
				`  provider:  ${state.currentProvider ?? "(unknown)"}\n` +
				`  thinking:  ${state.currentThinking}\n` +
				`  messages:  ${state.messages.length}\n` +
				`  in:        ${c.input.toLocaleString()} tok\n` +
				`  out:       ${c.output.toLocaleString()} tok\n` +
				`  cache r/w: ${c.cacheRead.toLocaleString()} / ${c.cacheWrite.toLocaleString()} tok\n` +
				`  cost:      $${c.cost.toFixed(6)}` +
				(link ? `\n  link:      ${link}` : "");
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
		case "link":
		case "share": {
			const url = shareableSessionUrl(state.sessionId);
			if (!url) {
				appendError("no session yet — send a message first");
			} else {
				void copyToClipboard(url).then((ok) => {
					if (ok) appendNode(el_pre(`Copied chat link to clipboard:\n  ${url}`));
					else appendError("clipboard access denied");
				});
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
			interface Commit {
				hash: string;
				date: string;
				subject: string;
			}
			interface Changelog {
				commits?: Commit[];
			}
			void fetch("/api/changelog?limit=20")
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((data: Changelog) => {
					const lines = (data.commits ?? []).map(
						(c) => `  ${c.hash}  ${c.date.slice(0, 10)}  ${c.subject}`,
					);
					appendNode(el_pre(`Recent commits:\n${lines.join("\n") || "  (none)"}`));
				})
				.catch((e) =>
					appendError(`changelog failed: ${e instanceof Error ? e.message : String(e)}`),
				);
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		}
		case "reload":
			location.reload();
			return;
		case "quit":
			try {
				window.close();
			} catch {
				/* ignore */
			}
			$<HTMLTextAreaElement>("#input").value = "";
			break;
		default: {
			// Dynamically loaded extension/prompt commands are owned by pi.
			// ACB only forwards the command; it does not interpret it.
			const dynamic = (state.capabilities ?? []).some(
				(entry) => entry.name.toLowerCase() === cmd && entry.source !== "skill",
			);
			if (dynamic) {
				services.sendSlashCommand?.(`/${arg}`);
				$<HTMLTextAreaElement>("#input").value = "";
			} else {
				// Unknown commands remain ordinary prompts.
				refreshStatus();
			}
			break;
		}
	}
}

interface ModalRefs {
	overlay: HTMLDivElement;
	box: HTMLDivElement;
}
function openModal(title: string, extraClass?: string): ModalRefs {
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	if (extraClass) box.classList.add(extraClass);
	box.append(el("h3", { text: title }));
	mountModal(overlay, box, { label: title });
	return { overlay, box };
}

/** Give custom picker rows native-like keyboard activation. */
function makeKeyboardClickable(element: HTMLElement, activate: () => void): void {
	element.tabIndex = 0;
	if (!element.hasAttribute("role")) element.setAttribute("role", "button");
	element.addEventListener("click", activate);
	element.addEventListener("keydown", (event) => {
		if (event.target !== element || (event.key !== "Enter" && event.key !== " ")) return;
		event.preventDefault();
		activate();
	});
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

	// Optional filter box: typing here narrows models across ALL
	// providers. When non-empty, every group whose rows survive the
	// filter is force-expanded; otherwise each group respects its
	// collapsed/expanded state (defaulting to collapsed, except the
	// group containing the current model).
	const filterInput = el("input", {
		type: "search",
		class: "model-filter-input",
		placeholder: "Filter models…",
		"aria-label": "Filter models",
		autocomplete: "off",
	}) as HTMLInputElement;
	box.append(filterInput);

	// Build one <div class="model-group"> per provider: a clickable
	// header (toggles the rows below it) followed by a rows container.
	// We keep references so the filter handler can show/hide rows and
	// expand/collapse groups.
	type GroupRefs = {
		header: HTMLElement;
		rows: HTMLElement;
		all: ModelOption[];
		raw: HTMLElement[];
	};
	const groupRefs: GroupRefs[] = [];

	const setExpanded = (g: GroupRefs, expanded: boolean) => {
		g.header.classList.toggle("collapsed", !expanded);
		g.header.setAttribute("aria-expanded", String(expanded));
		g.rows.classList.toggle("hidden", !expanded);
	};

	for (const [provider, models] of groups) {
		const activeInGroup = models.some((m) => m.id === state.currentModelId);

		const headerLabel = el(
			"span",
			{ class: "model-group-title" },
			`${provider} · ${models.length}`,
		);
		const activeTag = activeInGroup
			? el(
					"span",
					{ class: "model-group-active" },
					models.find((m) => m.id === state.currentModelId)?.name ?? state.currentModelId ?? "",
				)
			: null;

		const header = el("div", {
			class: "model-group-header",
			role: "button",
			"aria-label": `${provider} models`,
		});
		header.append(el("span", { class: "model-group-twisty" }, "▾"));
		header.append(headerLabel);
		if (activeTag) header.append(activeTag);

		const rows = el("div", { class: "model-group-rows" });
		const raw: HTMLElement[] = [];
		// The user's configured default for new chats (from the Global
		// project). A row whose model matches this gets a filled ★ star
		// button + a "default" badge; every other row gets an ☆ that,
		// when clicked, makes THAT model the default (persisted server-side
		// via updateProject, so every new tab picks it up).
		const currentDefault = defaultModelForNewChats();
		for (const m of models) {
			const row = el("div", { class: "model-row" });
			row.dataset.modelId = m.id;
			row.dataset.modelProvider = m.provider;
			const info = el("div", { class: "model-row-info" });
			const main = el("div", { class: "model-name" }, m.name ?? m.id);
			if (m.reasoning) {
				main.append(
					el("span", { class: "model-badge", title: "Supports extended thinking" }, "thinking"),
				);
			}
			const isDefault =
				!!currentDefault && currentDefault.id === m.id && currentDefault.provider === m.provider;
			if (isDefault) {
				main.append(
					el(
						"span",
						{ class: "model-badge model-badge-default", title: "Default for new chats" },
						"default",
					),
				);
			}
			info.append(main);
			info.append(el("div", { class: "model-provider" }, m.id === m.name ? "" : m.id));
			row.append(info);

			// Star button: set / clear the Global default for new chats.
			// stopPropagation so the row click (which switches the live
			// session) doesn't also fire.
			const star = el(
				"button",
				{
					class: `model-default-btn${isDefault ? " is-default" : ""}`,
					type: "button",
					title: isDefault
						? "Default for new chats — click to clear"
						: "Set as default for new chats",
					"aria-label": isDefault
						? `Clear ${m.name ?? m.id} as the default model`
						: `Set ${m.name ?? m.id} as the default model`,
				},
				isDefault ? "★" : "☆",
			);
			star.addEventListener("click", (ev) => {
				ev.stopPropagation();
				toggleDefaultModel(box, m);
			});
			row.append(star);

			if (m.id === state.currentModelId) row.classList.add("active");
			makeKeyboardClickable(row, () => {
				// Update displayed model optimistically so the picker
				// feels instant, but mark the model as "pending" so the
				// server's next `ready` event confirms it (rather than
				// being mistaken for a default-rebroadcast on a new
				// connection). See onReady in boot() for the matching
				// logic.
				state.currentModelId = m.id;
				state.currentProvider = m.provider;
				state.currentModelLabel = m.name ?? m.id;
				state.pendingModelSet = m.id;
				chatControls?.setModel(m.id, m.provider);
				refreshStatus();
				overlay.remove();
			});
			rows.append(row);
			raw.push(row);
		}

		const group = el("div", { class: "model-group" });
		group.append(header, rows);
		box.append(group);

		const refs: GroupRefs = { header, rows, all: models, raw };
		groupRefs.push(refs);

		// Default state: collapsed, EXCEPT the group holding the
		// currently selected model so you can see what's active.
		setExpanded(refs, activeInGroup);

		makeKeyboardClickable(header, () => {
			// When a filter is active, the filter handler drives
			// expansion, so header clicks are a no-op to avoid
			// fighting it.
			if (filterInput.value.trim()) return;
			const expanded = !header.classList.contains("collapsed");
			setExpanded(refs, !expanded);
		});
	}

	// Filter handler: hide rows that don't match, hide groups with no
	// survivors, and force-expand groups that do survive. Clearing the
	// filter restores each group to its default collapsed/expanded
	// state (active group expanded).
	const applyFilter = () => {
		const q = filterInput.value.trim().toLowerCase();
		for (const g of groupRefs) {
			let visible = 0;
			for (let i = 0; i < g.all.length; i++) {
				const m = g.all[i];
				const row = g.raw[i];
				const name = (m.name ?? m.id).toLowerCase();
				const id = m.id.toLowerCase();
				const match = !q || name.includes(q) || id.includes(q);
				row.classList.toggle("hidden", !match);
				if (match) visible++;
			}
			const groupEl = g.header.parentElement as HTMLElement | null;
			if (groupEl) groupEl.classList.toggle("hidden", q !== "" && visible === 0);
			if (q) {
				// While filtering, expand any group with survivors so
				// matches are visible without an extra click.
				setExpanded(g, visible > 0);
			} else {
				setExpanded(
					g,
					g.all.some((m) => m.id === state.currentModelId),
				);
			}
		}
	};
	filterInput.addEventListener("input", applyFilter);
	// Autofocus so you can just start typing.
	setTimeout(() => filterInput.focus(), 0);

	// Footer hint: explains the star affordance + names the current
	// default so the user can see at a glance what new tabs will load.
	box.append(renderDefaultFooter());

	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

/**
 * Toggle the Global project's default model for new chats. Setting a
 * new default persists `defaultModelId`/`defaultProvider` (plus the
 * current thinking level) server-side via updateProject, so every
 * brand-new tab picks it up at spawn time (see resolveInitDefaults in
 * chat.ts). Clicking the star on the already-default model CLEARS the
 * default (new tabs then fall back to the first available model).
 *
 * We optimistically mutate `state.projects` so the picker updates
 * instantly, then refresh every row's star + badge to match. The
 * server's authoritative projects rebroadcast lands later and matches.
 */
function toggleDefaultModel(box: HTMLElement, m: ModelOption): void {
	const cur = defaultModelForNewChats();
	const clearing = !!cur && cur.id === m.id && cur.provider === m.provider;
	const global = state.projects.find((p) => p.id === GLOBAL_PROJECT_ID);
	if (global) {
		global.defaultModelId = clearing ? null : m.id;
		global.defaultProvider = clearing ? null : m.provider;
		global.defaultThinkingLevel = clearing ? null : state.currentThinking;
	}
	chatControls?.updateProject({
		id: GLOBAL_PROJECT_ID,
		defaultModelId: clearing ? null : m.id,
		defaultProvider: clearing ? null : m.provider,
		defaultThinkingLevel: clearing ? null : state.currentThinking,
	});
	refreshDefaultStars(box);
	// The footer names the current default — rebuild it too.
	const footer = box.querySelector(".model-default-footer");
	if (footer) footer.replaceWith(renderDefaultFooter());
}

/**
 * Walk every `.model-row` in the picker and resync its star button +
 * "default" badge to the current Global default. Called after a toggle.
 * Rows carry their model id/provider on dataset so this stays O(rows)
 * with no closure bookkeeping.
 */
function refreshDefaultStars(box: HTMLElement): void {
	const d = defaultModelForNewChats();
	const rows = box.querySelectorAll<HTMLElement>(".model-row");
	for (const row of rows) {
		const mid = row.dataset.modelId ?? "";
		const mprov = row.dataset.modelProvider ?? "";
		const isDefault = !!d && d.id === mid && d.provider === mprov;
		const btn = row.querySelector<HTMLButtonElement>(".model-default-btn");
		if (btn) {
			btn.textContent = isDefault ? "★" : "☆";
			btn.classList.toggle("is-default", isDefault);
			btn.title = isDefault
				? "Default for new chats — click to clear"
				: "Set as default for new chats";
			btn.setAttribute(
				"aria-label",
				isDefault ? `Clear ${mid} as the default model` : `Set ${mid} as the default model`,
			);
		}
		const name = row.querySelector<HTMLElement>(".model-name");
		const badge = name?.querySelector<HTMLElement>(".model-badge-default");
		if (isDefault && !badge && name) {
			name.append(
				el(
					"span",
					{ class: "model-badge model-badge-default", title: "Default for new chats" },
					"default",
				),
			);
		} else if (!isDefault && badge) {
			badge.remove();
		}
	}
}

/**
 * Footer line naming the current default model for new chats (or
 * "none" if unset). Pure render — rebuilt by toggleDefaultModel so the
 * name tracks the latest pick without a full picker rebuild.
 */
function renderDefaultFooter(): HTMLElement {
	const d = defaultModelForNewChats();
	const label = d
		? (state.availableModels.find((m) => m.id === d.id && m.provider === d.provider)?.name ?? d.id)
		: "none";
	const footer = el("div", { class: "model-default-footer" });
	footer.append(
		el("span", { class: "model-default-footer-star" }, "★"),
		el(
			"span",
			{ class: "model-default-footer-text" },
			`Default for new tabs: ${label}. Click a ☆ to change it.`,
		),
	);
	return footer;
}

function currentModelThinkingLevels(): ThinkingLevel[] {
	const model = state.availableModels.find(
		(m) => m.id === state.currentModelId && m.provider === state.currentProvider,
	);
	if (model?.thinkingLevels?.length) return model.thinkingLevels;
	if (model?.reasoning === false) return ["off"];

	// Compatibility fallback for an older /api/models response that predates
	// per-model level metadata. Preserve ACB's former five-level picker rather
	// than guessing that extended xhigh/max support exists.
	return ["off", "minimal", "low", "medium", "high"];
}

export function openThinkPicker(): void {
	const levels = currentModelThinkingLevels();
	const { overlay, box } = openModal("Thinking level");
	for (const lvl of levels) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, lvl));
		if (lvl === state.currentThinking) row.classList.add("active");
		makeKeyboardClickable(row, () => {
			chatControls?.setThinking(lvl);
			state.currentThinking = lvl;
			refreshStatus();
			overlay.remove();
		});
		box.append(row);
	}
	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

export function openSpeedPicker(): void {
	const speeds = [1, 1.25, 1.4, 1.5, 2];
	const { overlay, box } = openModal("TTS playback speed");
	for (const rate of speeds) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, `${rate}×`));
		if (rate === 1) row.append(el("div", { class: "model-provider" }, "(normal)"));
		if (rate === state.ttsSpeed) row.classList.add("active");
		makeKeyboardClickable(row, () => {
			state.ttsSpeed = rate;
			saveSessionPrefs();
			overlay.remove();
			refreshStatus();
		});
		box.append(row);
	}
	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

export async function openSessionsDialog(): Promise<void> {
	// The actual list is delivered asynchronously via the WS
	// `onSessionsUpdated` callback (set up in main.ts). The picker
	// modal opens immediately; the rows are filled in when the server
	// replies. If the server doesn't reply within 3s, we show an
	// error so the user isn't staring at a forever-empty modal.
	chatControls?.listSessions();
	const { overlay, box } = openModal("Sessions");
	const content = el("div", { class: "sessions-dialog-content" });
	content.append(el("p", { class: "muted", text: "Loading sessions…" }));
	box.append(content);
	// Save only the content region so an async refresh cannot erase the
	// dialog heading, accessible label, or standard close button.
	pendingSessionsBox = content;
	pendingSessionsOverlay = overlay;
	setTimeout(() => {
		if (pendingSessionsBox === content) {
			content.innerHTML = "";
			content.append(
				el("p", {
					class: "muted",
					text: "No saved sessions (or server didn't reply).",
				}),
			);
		}
	}, 3000);
}

// Module-scope: the box the listener should fill. Set when
// openSessionsDialog opens the modal, cleared when filled.
let pendingSessionsBox: HTMLDivElement | null = null;
let pendingSessionsOverlay: HTMLDivElement | null = null;

/**
 * Called by main.ts's `onSessionsUpdated` listener to render the
 * server's reply into the currently-open picker modal. Idempotent
 * and self-clearing: subsequent calls with no modal open are a
 * no-op (the list was probably triggered by code other than the
 * picker, e.g. /name showing the active session).
 */
export function renderSessionsIntoPicker(sessions: SessionSummary[]): void {
	if (!pendingSessionsBox || !pendingSessionsOverlay) return;
	const box = pendingSessionsBox;
	const overlay = pendingSessionsOverlay;
	pendingSessionsBox = null;
	pendingSessionsOverlay = null;
	box.innerHTML = "";
	if (sessions.length === 0) {
		box.append(el("p", { class: "muted", text: "No saved sessions yet." }));
	} else {
		for (const s of sessions) {
			const row = el("div", { class: "session-row" });
			row.append(el("div", { class: "session-title" }, s.title));
			const meta = `${s.messageCount} msgs · ${new Date(s.createdAt).toLocaleString()}`;
			row.append(el("div", { class: "session-meta" }, meta));
			makeKeyboardClickable(row, () => {
				overlay.remove();
				chatControls?.resumeSession(s.id);
			});
			box.append(row);
		}
	}
	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

export async function openVoicePicker(): Promise<void> {
	let voices: string[];
	let defaultVoice: string;
	try {
		const v = await listVoices();
		voices = v.available;
		defaultVoice = v.default;
	} catch (e) {
		appendError(`could not list voices: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	if (voices.length === 0) {
		appendError("no TTS voices found.");
		return;
	}

	const { overlay, box } = openModal("TTS voice");
	for (const v of voices) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, v));
		if (v === defaultVoice) row.append(el("div", { class: "model-provider" }, "(server default)"));
		if (v === state.ttsVoice) row.classList.add("active");
		makeKeyboardClickable(row, () => {
			state.ttsVoice = v;
			saveSessionPrefs();
			overlay.remove();
			refreshStatus();
		});
		box.append(row);
	}
	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

// ---------------------------------------------------------------------------
// Models & services overview panel (display-only)
// ---------------------------------------------------------------------------

/** A small coloured status pill: live (mutable now), env, default, etc. */
function pill(
	text: string,
	kind: "live" | "set" | "default" | "implicit" | "missing",
): HTMLSpanElement {
	return el("span", { class: `svc-pill svc-${kind}`, text });
}

/** Monospace code chip, e.g. an env-var name or slash command. */
function kbd(text: string): HTMLSpanElement {
	return el("span", { class: "kbd", text });
}

/** A hint line under a model value: "switch → /model" etc. */
function hint(...parts: (string | Node)[]): HTMLDivElement {
	return el("div", { class: "svc-hint" }, ...parts);
}

/**
 * One row in the overview panel. `label`/`desc` is the left column;
 * `valueNode` (pill + model id) and `hintNode` form the right column.
 * When `onClick` is given the row is clickable (an actionable switcher);
 * otherwise it is display-only.
 */
function svcRow(
	name: string,
	desc: string,
	valueNode: Node,
	hintNode: Node,
	onClick?: () => void,
): HTMLDivElement {
	const label = el("div", { class: "svc-label" });
	label.append(el("div", { class: "svc-name", text: name }));
	label.append(el("div", { class: "svc-desc", text: desc }));
	const value = el("div", { class: "svc-value" });
	value.append(valueNode, hintNode);
	const row = el("div", { class: "svc-row" }, label, value);
	if (onClick) {
		row.classList.add("svc-clickable");
		row.setAttribute("aria-label", `${name}: open settings`);
		makeKeyboardClickable(row, onClick);
	}
	return row;
}

/** A model-id line: pill + provider / id in monospace. */
function modelLine(p: HTMLSpanElement, id: string): HTMLSpanElement {
	const line = el("span", { class: "svc-model" });
	line.append(p, " ", el("span", { class: "mono", text: id }));
	return line;
}

/** Section heading inside the panel. */
function svcSection(text: string): HTMLDivElement {
	return el("div", { class: "svc-section", text });
}

/**
 * The display-only overview of every model/service driving the session.
 * Read off /api/health + live session state; nothing here is mutated by
 * ACB. Actionable rows (chat model, thinking, image, TTS voice) open the
 * existing pickers; the rest show a hint pointing at the env var or at
 * "tell pi" so the user knows how to change them.
 */
export function openModelsPanel(): void {
	refreshCurrentModelLabel();
	const { overlay, box } = openModal("Models & services", "models-panel-box");
	box.append(
		el("div", {
			class: "muted",
			text: "Read-only view of every model in use. To change one, tell pi — or use the command shown.",
			style: "font-size:12px; margin-bottom:6px;",
		}),
	);

	// ── Conversation ──────────────────────────────────────────────
	box.append(svcSection("Conversation"));

	const chatId = state.currentModelId ?? "(none)";
	const chatProvider = state.currentProvider ? `${state.currentProvider} / ` : "";
	box.append(
		svcRow(
			"Chat model",
			"Replies, tool use, coding. The main model — switchable here.",
			modelLine(pill("live", "live"), `${chatProvider}${chatId}`),
			hint("switch → ", kbd("/model")),
			() => {
				overlay.remove();
				openModelPicker();
			},
		),
	);

	box.append(
		svcRow(
			"Thinking level",
			"Extended reasoning budget for the chat model.",
			modelLine(pill("live", "live"), state.currentThinking),
			hint("switch → ", kbd("/think low")),
			() => {
				overlay.remove();
				openThinkPicker();
			},
		),
	);

	// ── Media ─────────────────────────────────────────────────────
	box.append(svcSection("Media generation & analysis"));

	const img = state.imageModel;
	const imgKind = img?.source === "override" ? "set" : img?.source === "env" ? "set" : "default";
	const imgLabel =
		img?.source === "default" ? "default" : img?.source === "env" ? "env" : "override";
	// Derive provider from the (source-tagged) model id so the row tells the
	// truth for local picks too. The unified /imagemodel picker writes
	// `local/<id>` or `venice/<id>`; bare legacy ids default to venice.
	const imgModelRaw = img?.model ?? "z-image-turbo";
	const imgSlash = imgModelRaw.indexOf("/");
	const imgProvider = imgSlash >= 0 ? imgModelRaw.slice(0, imgSlash) : "venice";
	const imgId = imgSlash >= 0 ? imgModelRaw.slice(imgSlash + 1) : imgModelRaw;
	box.append(
		svcRow(
			"Image generation",
			"Local GPU (free), Venice/OpenRouter APIs, or OpenAI Codex OAuth. Routes via /imagemodel.",
			modelLine(pill(imgLabel, imgKind), `${imgProvider} / ${imgId}`),
			hint("switch → ", kbd("/imagemodel")),
			() => {
				overlay.remove();
				// Lean send — see /imagemodel case in handleSlash: extension
				// command, no agent run, must not set isStreaming.
				services.sendSlashCommand?.("/imagemodel");
			},
		),
	);

	box.append(
		svcRow(
			"Multimodal / vision",
			"Reading images & video frames in chat. Routed by pi-multimodal-proxy.",
			modelLine(
				state.visionModel?.source === "env"
					? pill("env", "set")
					: state.visionModel?.source === "config"
						? pill("picked", "set")
						: pill("default", "default"),
				state.visionModel?.model ?? "anthropic/claude-sonnet-4-5",
			),
			hint(
				"switch → ",
				kbd("/multimodal-proxy"),
				state.visionModel?.mode === "fallback"
					? " · mode: fallback (only when chat model can't see images)"
					: state.visionModel?.mode === "always"
						? " · mode: always"
						: state.visionModel?.mode === "off"
							? " · mode: off"
							: "",
			),
		),
	);

	// ── Web ───────────────────────────────────────────────────────
	box.append(svcSection("Web & research"));

	const webPill = state.geminiKey ? pill("key set", "set") : pill("no key", "missing");
	const webModel = state.geminiKey ? "gemini · implicit" : "unavailable";
	box.append(
		svcRow(
			"Web / YouTube",
			"Search, fetch & YouTube transcripts via pi-web-access (Gemini key).",
			modelLine(webPill, webModel),
			hint(
				state.geminiKey
					? "model id is implicit — not exposed per-task"
					: "set GEMINI_API_KEY to enable",
			),
		),
	);

	// ── Voice ─────────────────────────────────────────────────────
	box.append(svcSection("Voice"));

	const rewrite = state.voiceRewriteModel;
	box.append(
		svcRow(
			"Voice-reply rewrite",
			"Generates the 🗣️ Long / 💬 Short spoken text (pi-voice-reply).",
			modelLine(
				rewrite ? pill("env", "set") : pill("session", "implicit"),
				rewrite ?? "(falls back to session model)",
			),
			hint("change → ", kbd("VOICE_REWRITE_MODEL"), " or “switch voice rewrite to …”"),
		),
	);

	box.append(
		svcRow(
			"Speech-to-text (Whisper)",
			"Transcribes your mic / voice notes. Local, CPU.",
			modelLine(pill("env", "set"), `faster-whisper · ${state.whisperModel ?? "medium"}`),
			hint("change → ", kbd("WHISPER_MODEL"), " (tiny/base/small/medium/large)"),
		),
	);

	const ttsVoice = state.ttsVoice ?? state.ttsDefaultVoice ?? "(unset)";
	const engine = state.ttsEngine
		? state.ttsEngine.charAt(0).toUpperCase() + state.ttsEngine.slice(1)
		: "TTS";
	box.append(
		svcRow(
			"Text-to-speech",
			`Synthesises audio for playback & voice replies. Engine: ${engine}.`,
			modelLine(pill("env", "set"), `voice ${ttsVoice}`),
			hint("switch voice → ", kbd("/voice"), " · engine via ", kbd("TTS_ENGINE")),
			() => {
				overlay.remove();
				void openVoicePicker();
			},
		),
	);

	box.append(el("hr", { class: "svc-divider" }));
	const footer = el("div", { class: "svc-footer" });
	footer.append(
		el("b", { text: "Display only." }),
		" Actionable rows open a picker; the rest reflect config read from pi & env. To change any model, tell pi in chat, or edit the env var shown. Env-backed rows reload after an ",
		kbd("agentchatbox"),
		" restart.",
	);
	box.append(footer);

	box.append(
		el(
			"div",
			{ class: "svc-actions" },
			el("button", { class: "btn", text: "Close", onclick: () => overlay.remove() }),
		),
	);
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
	makeKeyboardClickable(modelLine, () => {
		overlay.remove();
		openModelPicker();
	});
	box.append(modelLine);

	// Image-generation model — owned by the pi-venice-image extension.
	// Clicking sends `/imagemodel`, which the extension handles via
	// ctx.ui.select() — ACB renders the picker through the extension_ui
	// relay. ACB doesn't know the current image model (that state lives
	// in the extension's override file), so the value is best-effort:
	// the extension notifies on change, but we don't persist the label.
	const imageLine = el("div", { class: "overflow-row" });
	imageLine.append(el("div", { class: "overflow-label" }, "image"));
	imageLine.append(
		el("div", { class: "overflow-value" }, state.currentImageModelLabel ?? "default"),
	);
	imageLine.title = "Switch image-generation model";
	makeKeyboardClickable(imageLine, () => {
		overlay.remove();
		// Lean send — see /imagemodel case in handleSlash: extension
		// command, no agent run, must not set isStreaming.
		services.sendSlashCommand?.("/imagemodel");
	});
	box.append(imageLine);

	// All models & services overview — opens the display-only panel that
	// lists every model driving the session (chat, image, web, voice…).
	const allModelsLine = el("div", { class: "overflow-row" });
	allModelsLine.append(el("div", { class: "overflow-label" }, "all models"));
	allModelsLine.append(el("div", { class: "overflow-value" }, "overview"));
	allModelsLine.title = "Show all models & services in use";
	makeKeyboardClickable(allModelsLine, () => {
		overlay.remove();
		openModelsPanel();
	});
	box.append(allModelsLine);

	// Copy a shareable link to the current chat (`/s/<id>`). Mirrors the
	// `/link` slash command; surfaced here for discoverability on mobile
	// where the input box is the only entry point to slash commands.
	const linkUrl = shareableSessionUrl(state.sessionId);
	if (linkUrl) {
		const linkLine = el("div", { class: "overflow-row" });
		linkLine.append(el("div", { class: "overflow-label" }, "chat link"));
		linkLine.append(
			el("div", { class: "overflow-value" }, `${linkUrl.replace(/^https?:\/\//, "")}`),
		);
		makeKeyboardClickable(linkLine, async () => {
			const ok = await copyToClipboard(linkUrl);
			const value = linkLine.querySelector(".overflow-value")!;
			value.textContent = ok ? "✓ copied" : "✗ denied";
			setTimeout(() => {
				value.textContent = linkUrl.replace(/^https?:\/\//, "");
			}, 1500);
		});
		box.append(linkLine);
	}

	const thinkLine = el("div", { class: "overflow-row" });
	thinkLine.append(el("div", { class: "overflow-label" }, "think"));
	thinkLine.append(el("div", { class: "overflow-value" }, state.currentThinking));
	makeKeyboardClickable(thinkLine, () => {
		overlay.remove();
		openThinkPicker();
	});
	box.append(thinkLine);

	const voiceLine = el("div", { class: "overflow-row" });
	voiceLine.append(el("div", { class: "overflow-label" }, "voice"));
	voiceLine.append(el("div", { class: "overflow-value" }, state.ttsVoice ?? "default"));
	makeKeyboardClickable(voiceLine, () => {
		overlay.remove();
		void openVoicePicker();
	});
	box.append(voiceLine);

	const speedLine = el("div", { class: "overflow-row" });
	speedLine.append(el("div", { class: "overflow-label" }, "speed"));
	speedLine.append(el("div", { class: "overflow-value" }, `${state.ttsSpeed}×`));
	makeKeyboardClickable(speedLine, () => {
		overlay.remove();
		openSpeedPicker();
	});
	box.append(speedLine);

	// --- loaded capabilities (mobile: badge hidden, show in overflow) ---
	if (state.capabilities && state.capabilities.length > 0) {
		const caps = state.capabilities;
		const skills = caps.filter((c) => c.source === "skill");
		const extPkgs = new Set(
			caps.filter((c) => c.source === "extension").map((c) => c.sourceInfo?.source ?? c.name),
		);
		const parts: string[] = [];
		if (skills.length) parts.push(`${skills.length} skill${skills.length !== 1 ? "s" : ""}`);
		if (extPkgs.size) parts.push(`${extPkgs.size} extension${extPkgs.size !== 1 ? "s" : ""}`);
		if (parts.length > 0) {
			const capsLine = el("div", { class: "overflow-row" });
			capsLine.append(el("div", { class: "overflow-label" }, "loaded"));
			capsLine.append(el("div", { class: "overflow-value" }, parts.join(" · ")));
			makeKeyboardClickable(capsLine, () => {
				overlay.remove();
				toggleCapabilitiesPopover();
			});
			box.append(capsLine);
		}
	}

	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
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
	const esc = escapeHtml;
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
	lines.push(
		`<!doctype html><html><head><meta charset="utf-8"><title>${esc(state.title)} — agentchatbox export</title><style>${css}</style></head><body>`,
	);
	lines.push(`<h1>${esc(state.title)}</h1>`);
	lines.push(
		`<div class="meta">id: ${esc((state.sessionId ?? "").slice(0, 8))} · model: ${esc(state.currentModelId ?? "(unknown)")} · thinking: ${esc(state.currentThinking)} · ${state.messages.length} messages · ${c.input.toLocaleString()}/${c.output.toLocaleString()} tok · $${c.cost.toFixed(6)}</div>`,
	);
	for (const m of state.messages) {
		if (m.kind === "user") {
			lines.push(
				`<div class="msg user"><span class="role">You ›</span><span class="body">${esc(m.text)}</span></div>`,
			);
		} else if (m.kind === "assistant") {
			lines.push(`<div class="msg assistant"><span class="role">Pi ›</span><span class="body">`);
			if (m.thinking)
				lines.push(
					`<details class="thinking"><summary>▸ thinking</summary><pre class="thinking-body">${esc(m.thinking)}</pre></details>`,
				);
			lines.push(esc(m.text));
			lines.push(`</span></div>`);
		} else if (m.kind === "tool") {
			const args = (() => {
				try {
					return JSON.stringify(m.args);
				} catch {
					return String(m.args);
				}
			})();
			lines.push(
				`<div class="msg tool"><span class="role">Tool ›</span><div class="tool-body"><div class="tool-name">${esc(m.name)} ${esc(args)}</div>`,
			);
			if (m.result !== undefined) {
				lines.push(
					`<pre class="tool-result${m.isError ? " tool-error" : ""}">${esc(m.result)}</pre>`,
				);
			}
			lines.push(`</div></div>`);
		} else if (m.kind === "error") {
			lines.push(
				`<div class="msg error"><span class="role">!</span><span class="body">${esc(m.text)}</span></div>`,
			);
		}
	}
	lines.push(`<footer>Exported from agentchatbox · ${new Date().toISOString()}</footer>`);
	lines.push(`</body></html>`);
	const blob = new Blob([lines.join("\n")], {
		type: "text/html;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${
		state.title
			.replace(/[^a-z0-9_-]+/gi, "-")
			.toLowerCase()
			.slice(0, 40) || "session"
	}-${new Date().toISOString().slice(0, 10)}.html`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
