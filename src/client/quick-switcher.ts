/**
 * Quick Switcher (Ctrl/Cmd+K): fast keyboard jump across conversations,
 * models, slash commands, and common workspace actions.
 */

import type { SessionSummary } from "../shared/protocol.js";
import { el, mountModal } from "./dom.js";
import { state } from "./state.js";

export interface QuickSwitcherCommand {
	name: string;
	description: string;
	category: string;
}

export interface QuickSwitcherContext {
	sessions: SessionSummary[];
	commands: QuickSwitcherCommand[];
	onResumeSession: (sessionId: string) => void;
	onNewChat: () => void;
	onToggleSidebar: () => void;
	onOpenSettings: () => void;
	onOpenThemePicker: () => void;
	onOpenCompact: () => void;
	onOpenPinnedModels: () => void;
	onOpenAllModels: () => void;
	onSelectModel: (modelId: string, provider: string) => void;
	onRunSlash: (commandName: string, needsArgument: boolean) => void;
}

interface QuickItem {
	section: string;
	label: string;
	meta?: string;
	badge?: string;
	searchText: string;
	run: () => void;
}

const MODAL_ID = "quick-switcher-modal";

export function isQuickSwitcherOpen(): boolean {
	return Boolean(typeof document !== "undefined" && document.getElementById(MODAL_ID));
}

export function closeQuickSwitcher(): boolean {
	const existing = typeof document !== "undefined" ? document.getElementById(MODAL_ID) : null;
	if (!existing) return false;
	existing.remove();
	return true;
}

export function openQuickSwitcher(ctx: QuickSwitcherContext, initialQuery = ""): void {
	if (closeQuickSwitcher()) {
		if (!initialQuery) return;
	}

	const overlay = el("div", { class: "modal-overlay", id: MODAL_ID });
	const box = el("div", { class: "modal-box quick-switcher-box" });
	const heading = el("h3", { class: "sr-only" }, "Quick switcher");
	const input = el("input", {
		type: "search",
		class: "quick-switcher-input",
		placeholder: "Jump to chat, model, action, or /command…",
		"aria-label": "Jump to chat, model, action, or slash command",
		autocomplete: "off",
		value: initialQuery,
	}) as HTMLInputElement;
	const list = el("div", {
		class: "quick-switcher-list",
		role: "listbox",
		"aria-label": "Quick switcher results",
	});
	const footer = el(
		"div",
		{ class: "quick-switcher-footer" },
		el("span", {}, "↑↓ navigate · Enter open · Esc close"),
		el("span", {}, "Type / for commands"),
	);
	box.append(heading, input, list, footer);

	const projectNameById = new Map(state.projects.map((p) => [p.id, p.name]));

	const actionItems: QuickItem[] = [
		{
			section: "Actions",
			label: "New chat",
			meta: "Start a fresh conversation",
			searchText: "new chat fresh conversation",
			run: ctx.onNewChat,
		},
		{
			section: "Actions",
			label: "Toggle sidebar",
			meta: "Ctrl/⌘+B",
			searchText: "toggle sidebar hide show panel",
			run: ctx.onToggleSidebar,
		},
		{
			section: "Actions",
			label: "Settings",
			meta: "Chat, display, media & shortcuts",
			searchText: "settings preferences options config",
			run: ctx.onOpenSettings,
		},
		{
			section: "Actions",
			label: "Switch theme",
			meta: "Pure black, soft dark, light, or system",
			searchText: "theme light dark black system appearance colour color",
			run: ctx.onOpenThemePicker,
		},
		{
			section: "Actions",
			label: "Compact context",
			meta: "Condense older turns to free context window",
			searchText: "compact context summarize condense tokens",
			run: ctx.onOpenCompact,
		},
		{
			section: "Actions",
			label: "Pinned models",
			meta: "Quick list of ♥ hearted models",
			searchText: "pinned hearted models favorites",
			run: ctx.onOpenPinnedModels,
		},
		{
			section: "Actions",
			label: "All models",
			meta: "Browse every configured provider & model",
			searchText: "all models picker switch model",
			run: ctx.onOpenAllModels,
		},
	];

	const sessionItems: QuickItem[] = ctx.sessions.map((s) => {
		const title = s.title || "Untitled";
		const project = s.projectId && s.projectId !== "global" ? projectNameById.get(s.projectId) : "";
		const isCurrent = s.id === state.sessionId;
		return {
			section: "Conversations",
			label: title,
			meta: [project, `${s.messageCount} msgs`].filter(Boolean).join(" · "),
			badge: isCurrent ? "current" : s.pinned ? "★" : undefined,
			searchText: `${title} ${project ?? ""} ${s.id}`.toLowerCase(),
			run: () => ctx.onResumeSession(s.id),
		};
	});

	const modelItems: QuickItem[] = state.availableModels.map((m) => {
		const label = m.name ?? m.id;
		const isCurrent = m.id === state.currentModelId;
		return {
			section: "Models",
			label,
			meta: m.id === label ? m.provider : `${m.provider} · ${m.id}`,
			badge: isCurrent ? "active" : undefined,
			searchText: `${label} ${m.id} ${m.provider} model`.toLowerCase(),
			run: () => ctx.onSelectModel(m.id, m.provider),
		};
	});

	const commandItems: QuickItem[] = ctx.commands.map((c) => ({
		section: "Slash commands",
		label: `/${c.name}`,
		meta: c.description,
		badge: c.category,
		searchText: `/${c.name} ${c.name} ${c.description} ${c.category}`.toLowerCase(),
		run: () => ctx.onRunSlash(c.name, /<[^>]+>/.test(c.description)),
	}));

	let filtered: QuickItem[] = [];
	let selected = 0;

	const filterItems = (raw: string): QuickItem[] => {
		const trimmed = raw.trim().toLowerCase();
		if (!trimmed) {
			return [...actionItems.slice(0, 5), ...sessionItems.slice(0, 12)];
		}
		if (trimmed.startsWith("/")) {
			const q = trimmed.slice(1);
			return commandItems.filter((item) => !q || item.searchText.includes(q)).slice(0, 24);
		}
		const tokens = trimmed.split(/\s+/).filter(Boolean);
		const matches = (item: QuickItem) => tokens.every((t) => item.searchText.includes(t));
		return [
			...sessionItems.filter(matches).slice(0, 10),
			...actionItems.filter(matches).slice(0, 6),
			...modelItems.filter(matches).slice(0, 8),
			...commandItems.filter(matches).slice(0, 8),
		];
	};

	const activate = (item: QuickItem | undefined) => {
		if (!item) return;
		overlay.remove();
		item.run();
	};

	const updateSelection = () => {
		const rows = list.querySelectorAll<HTMLButtonElement>(".quick-switcher-item");
		rows.forEach((row, idx) => {
			const active = idx === selected;
			row.classList.toggle("active", active);
			row.setAttribute("aria-selected", String(active));
			if (active) row.scrollIntoView({ block: "nearest" });
		});
	};

	const renderList = () => {
		filtered = filterItems(input.value);
		selected = Math.min(selected, Math.max(0, filtered.length - 1));
		list.replaceChildren();
		if (filtered.length === 0) {
			list.append(
				el("div", { class: "quick-switcher-empty" }, "No matching chats, models, or commands"),
			);
			return;
		}
		let lastSection = "";
		filtered.forEach((item, idx) => {
			if (item.section !== lastSection) {
				lastSection = item.section;
				list.append(el("div", { class: "quick-switcher-section" }, item.section));
			}
			const row = el("button", {
				class: `quick-switcher-item${idx === selected ? " active" : ""}`,
				type: "button",
				role: "option",
				"aria-selected": String(idx === selected),
			});
			const main = el(
				"span",
				{ class: "quick-switcher-item-main" },
				el("span", { class: "quick-switcher-item-label" }, item.label),
				item.meta ? el("span", { class: "quick-switcher-item-meta" }, item.meta) : "",
			);
			row.append(main);
			if (item.badge) {
				row.append(el("span", { class: "quick-switcher-item-badge" }, item.badge));
			}
			row.addEventListener("mouseenter", () => {
				selected = idx;
				updateSelection();
			});
			row.addEventListener("click", () => activate(item));
			list.append(row);
		});
	};

	input.addEventListener("input", () => {
		selected = 0;
		renderList();
	});
	input.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			if (filtered.length > 0) {
				selected = (selected + 1) % filtered.length;
				updateSelection();
			}
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			if (filtered.length > 0) {
				selected = (selected - 1 + filtered.length) % filtered.length;
				updateSelection();
			}
		} else if (event.key === "Enter") {
			event.preventDefault();
			activate(filtered[selected]);
		}
	});

	renderList();
	mountModal(overlay, box, {
		label: "Quick switcher",
		initialFocus: input,
	});
	if (initialQuery) {
		setTimeout(() => {
			input.setSelectionRange(input.value.length, input.value.length);
		}, 0);
	}
}
