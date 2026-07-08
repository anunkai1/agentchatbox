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
import { $, el } from "./dom.js";
import { appendError, appendNode, refreshStatus, toggleCapabilitiesPopover } from "./render.js";
import { type ModelOption, state } from "./state.js";
import { saveSessionPrefs } from "./prefs.js";
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
	imagemodel: "open the image-generation model picker (alias: /image)",
	image: "open the image-generation model picker (alias: /imagemodel)",
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
	link: "copy a shareable link to this chat (alias: /share)",
	share: "copy a shareable link to this chat (alias: /link)",
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
	project: "start a new chat in a project: /project <name|id>",
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
		$("#status-bar").textContent = Object.entries(SLASH_COMMANDS)
			.map(([k, v]) => `/${k} — ${v}`)
			.join("    ");
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
	setImageModel(modelId: string | null): void;
	setThinking(level: ThinkingLevel): void;
	abort(): void;
	/** Start a new session in a project (defaults to Global when omitted). */
	newSession(projectId?: string): void;
	resumeSession(sessionId: string): void;
	listSessions(): void;
	renameSession(name: string): void;
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
	void import("./render.js").then(({ renderShell }) => renderShell());
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
		case "imagemodel":
		case "image":
			openImageModelPicker();
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
				void import("./render.js").then(({ openProjectEditor }) => openProjectEditor());
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
				`  image:     ${state.currentImageModelId ?? "(default)"}\n` +
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
				`  /imagemodel    switch image-generation model (Venice)\n` +
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
		case "websearch": {
			const query = rest;
			if (!query) {
				appendError("Usage: /websearch <query>");
			} else {
				sendAsUserFn(
					`Use web_search to look up: ${query}\nGive me a 3-sentence summary plus the top 3 source URLs.`,
				);
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
				sendAsUserFn(
					`Use fetch_content to grab ${url} and summarise the key points in 5 bullet points.`,
				);
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
				sendAsUserFn(
					`Use code_search to find: ${query}\nGive me 2 short code snippets with source URLs.`,
				);
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

interface ModalRefs {
	overlay: HTMLDivElement;
	box: HTMLDivElement;
}
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

/**
 * Image-model picker — separate dialog from openModelPicker() because
 * chat models and image models are conceptually independent: switching
 * the image model does not change which model the agent chats with.
 *
 * Image models come from `/api/image-models` (separate endpoint; the
 * chat `/api/models` endpoint only returns chat models). They're all
 * Venice today, grouped under "Venice images". Picking one sends a
 * `setImageModel` RPC; the server writes the chosen model id to
 * `/home/lepton/.config/acb/image-model`, which the pi-venice-image
 * extension reads on each `venice_generate_image` tool call — so the
 * change takes effect on the next agent invocation without respawning
 * the pi child (which matters: image generation is invoked from inside
 * a long agent loop, and a respawn would lose its progress).
 *
 * The "Use default" row clears the override (modelId = null), letting
 * the extension fall back to its built-in default (z-image-turbo).
 */
export function openImageModelPicker(): void {
	if (state.availableImageModels.length === 0) {
		appendError(
			"No image models available (server has no image-gen provider keys configured).",
		);
		return;
	}
	const { overlay, box } = openModal("Image generation model", "image-picker-box");
	box.append(
		el(
			"div",
			{ class: "picker-help" },
			"Used by the venice_generate_image tool. Selecting here sets the default for the next image-generation call.",
		),
	);

	// "Use default" row — clears the override so the extension uses its
	// built-in default (z-image-turbo). Highlighted when no override is
	// set.
	const useDefault = el("div", { class: "model-row" });
	useDefault.append(
		el("div", { class: "model-name" }, "Use extension default (z-image-turbo)"),
	);
	useDefault.append(el("div", { class: "model-provider" }, "no override"));
	if (state.currentImageModelId === null) useDefault.classList.add("active");
	useDefault.addEventListener("click", () => {
		state.currentImageModelId = null;
		chatControls?.setImageModel(null);
		refreshStatus();
		overlay.remove();
	});
	box.append(useDefault);

	// Group by provider. All Venice today, but the structure supports
	// adding e.g. OpenRouter images later without UI changes.
	const groups = new Map<string, typeof state.availableImageModels>();
	for (const m of state.availableImageModels) {
		const list = groups.get(m.provider) ?? [];
		list.push(m);
		groups.set(m.provider, list);
	}
	for (const [, list] of groups) {
		list.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
	}

	for (const [provider, models] of groups) {
		const headerLabel = `${provider} images · ${models.length}`;
		const header = el("div", { class: "model-group-header" });
		header.append(el("span", { class: "model-group-twisty" }, "▾"));
		header.append(el("span", { class: "model-group-title" }, headerLabel));

		const rows = el("div", { class: "model-group-rows" });
		for (const m of models) {
			const row = el("div", { class: "model-row" });
			const main = el("div", { class: "model-name" }, m.name ?? m.id);
			for (const tag of m.tags ?? []) {
				main.append(
					el(
						"span",
						{
							class: `model-badge tag-${tag}`,
							title: tag,
						},
						tag,
					),
				);
			}
			row.append(main);
			row.append(el("div", { class: "model-provider" }, m.id === m.name ? "" : m.id));
			if (m.id === state.currentImageModelId) row.classList.add("active");
			row.addEventListener("click", () => {
				state.currentImageModelId = m.id;
				chatControls?.setImageModel(m.id);
				refreshStatus();
				overlay.remove();
			});
			rows.append(row);
		}

		const group = el("div", { class: "model-group" });
		group.append(header, rows);
		box.append(group);

		// Expand any group containing the current selection so it's visible.
		const expanded = models.some((m) => m.id === state.currentImageModelId);
		if (!expanded) header.classList.add("collapsed");
		if (!expanded) rows.classList.add("hidden");
		header.addEventListener("click", () => {
			const isCollapsed = header.classList.contains("collapsed");
			header.classList.toggle("collapsed", !isCollapsed);
			rows.classList.toggle("hidden", !isCollapsed);
		});
	}

	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
}

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
					models.find((m) => m.id === state.currentModelId)?.name ??
						state.currentModelId ??
						"",
				)
			: null;

		const header = el("div", { class: "model-group-header" });
		header.append(el("span", { class: "model-group-twisty" }, "▾"));
		header.append(headerLabel);
		if (activeTag) header.append(activeTag);

		const rows = el("div", { class: "model-group-rows" });
		const raw: HTMLElement[] = [];
		for (const m of models) {
			const row = el("div", { class: "model-row" });
			const main = el("div", { class: "model-name" }, m.name ?? m.id);
			if (m.reasoning) {
				main.append(
					el("span", { class: "model-badge", title: "Supports extended thinking" }, "thinking"),
				);
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

		header.addEventListener("click", () => {
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
				setExpanded(g, g.all.some((m) => m.id === state.currentModelId));
			}
		}
	};
	filterInput.addEventListener("input", applyFilter);
	// Autofocus so you can just start typing.
	setTimeout(() => filterInput.focus(), 0);

	box.append(
		el("button", {
			class: "btn",
			text: "Close",
			onclick: () => overlay.remove(),
		}),
	);
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
		row.addEventListener("click", () => {
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
	box.append(el("p", { class: "muted", text: "Loading sessions…" }));
	// Save the box in a closure-captured var so the listener can fill it.
	pendingSessionsBox = box;
	pendingSessionsOverlay = overlay;
	setTimeout(() => {
		if (pendingSessionsBox === box) {
			box.innerHTML = "";
			box.append(
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
			row.addEventListener("click", () => {
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
	const { listVoices } = await import("./api.js");
	const { appendError } = await import("./render.js");

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

	// Image-generation model — a separate setting from the chat model.
	// Defaults to "extension default" (the pi-venice-image extension's
	// built-in z-image-turbo) when the user hasn't picked one. Same
	// overflow-row style as the chat model row above so the two look
	// like a pair.
	const imageLine = el("div", { class: "overflow-row" });
	imageLine.append(el("div", { class: "overflow-label" }, "image"));
	const imageValue = state.currentImageModelId ?? "default";
	const imageLabel =
		state.availableImageModels.find((m) => m.id === state.currentImageModelId)?.name ??
		imageValue;
	imageLine.append(el("div", { class: "overflow-value" }, imageLabel));
	if (state.availableImageModels.length === 0) {
		// No image models configured (VENICE_API_KEY missing or no
		// image-capable provider). Show the row as disabled rather
		// than hiding it, so the user can see the feature exists.
		imageLine.classList.add("overflow-row-disabled");
		imageLine.title = "No image-generation provider configured";
	} else {
		imageLine.addEventListener("click", () => {
			overlay.remove();
			openImageModelPicker();
		});
	}
	box.append(imageLine);

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
		linkLine.addEventListener("click", async () => {
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

	const speedLine = el("div", { class: "overflow-row" });
	speedLine.append(el("div", { class: "overflow-label" }, "speed"));
	speedLine.append(el("div", { class: "overflow-value" }, `${state.ttsSpeed}×`));
	speedLine.addEventListener("click", () => {
		overlay.remove();
		openSpeedPicker();
	});
	box.append(speedLine);

	// --- loaded capabilities (mobile: badge hidden, show in overflow) ---
	if (state.capabilities) {
		const caps = state.capabilities;
		const parts: string[] = [];
		if (caps.tools.length)
			parts.push(`${caps.tools.length} tool${caps.tools.length !== 1 ? "s" : ""}`);
		if (caps.skills.length)
			parts.push(`${caps.skills.length} skill${caps.skills.length !== 1 ? "s" : ""}`);
		if (parts.length > 0) {
			const capsLine = el("div", { class: "overflow-row" });
			capsLine.append(el("div", { class: "overflow-label" }, "loaded"));
			capsLine.append(el("div", { class: "overflow-value" }, parts.join(" · ")));
			capsLine.addEventListener("click", () => {
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
