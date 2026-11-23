/**
 * In-chat Find bar (Ctrl/Cmd+F, Settings → Find in chat, or Quick Switcher).
 * Highlights case-insensitive matches inside visible message content, steps
 * between matches, and cleanly restores the original DOM text nodes on close.
 */

import { el } from "./dom.js";

const BAR_ID = "chat-find-bar";
const INPUT_ID = "chat-find-input";
const HIT_CLASS = "chat-find-hit";
const CURRENT_CLASS = "is-current";
const MAX_MATCHES = 500;

const CONTENT_SELECTORS = [
	".row-user .bubble",
	".row-assistant .text",
	".row-note .text",
	".row-error",
	".thinking:not(.display-hidden) .thinking-body",
	".row-tool:not(.display-hidden) .tool-card",
].join(", ");

const SKIP_ANCESTOR_SELECTOR = [
	".code-block-header",
	".message-actions",
	".voice-actions",
	".assistant-meta",
	".assistant-controls",
	".note-meta",
	".display-hidden",
	"[hidden]",
	"button",
	"script",
	"style",
	"svg",
].join(", ");

let hits: HTMLElement[] = [];
let activeIndex = -1;
let lastFocusedBeforeFind: HTMLElement | null = null;

function getBar(): HTMLElement | null {
	return typeof document !== "undefined" ? document.getElementById(BAR_ID) : null;
}

function getInput(): HTMLInputElement | null {
	return typeof document !== "undefined"
		? (document.getElementById(INPUT_ID) as HTMLInputElement | null)
		: null;
}

export function isChatFindOpen(): boolean {
	const bar = getBar();
	return Boolean(bar && !bar.hidden);
}

/** Unwrap every highlight mark back into its original plain text node. */
export function clearChatFindHighlights(): void {
	if (typeof document === "undefined") return;
	const container = document.getElementById("messages");
	if (container) {
		const marks = container.querySelectorAll<HTMLElement>(`mark.${HIT_CLASS}`);
		const parents = new Set<Node>();
		for (const mark of marks) {
			const parent = mark.parentNode;
			if (!parent) continue;
			parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
			parents.add(parent);
		}
		for (const parent of parents) parent.normalize();
	}
	hits = [];
	activeIndex = -1;
}

function updateCounter(): void {
	const bar = getBar();
	const input = getInput();
	const countEl = bar?.querySelector<HTMLElement>(".chat-find-count");
	const prevBtn = bar?.querySelector<HTMLButtonElement>("[data-find-prev]");
	const nextBtn = bar?.querySelector<HTMLButtonElement>("[data-find-next]");
	const query = input?.value ?? "";
	const hasQuery = query.length > 0;
	const hasHits = hits.length > 0;

	if (countEl) {
		if (!hasQuery) {
			countEl.textContent = "";
			countEl.classList.remove("is-empty");
		} else if (!hasHits) {
			countEl.textContent = "0 / 0";
			countEl.classList.add("is-empty");
		} else {
			countEl.textContent = `${activeIndex + 1} / ${hits.length}${hits.length >= MAX_MATCHES ? "+" : ""}`;
			countEl.classList.remove("is-empty");
		}
	}
	if (prevBtn) prevBtn.disabled = !hasHits;
	if (nextBtn) nextBtn.disabled = !hasHits;
}

function revealAndScrollTo(hit: HTMLElement): void {
	// Open any enclosing collapsed <details> (e.g. relay playback notes) so the hit is visible.
	let parent: Element | null = hit.parentElement;
	while (parent) {
		if (parent instanceof HTMLDetailsElement && !parent.open) parent.open = true;
		parent = parent.parentElement;
	}
	if (typeof hit.scrollIntoView === "function") {
		hit.scrollIntoView({ block: "center", behavior: "smooth" });
	}
}

function setActiveMatch(index: number, scroll = true): void {
	if (hits.length === 0) {
		activeIndex = -1;
		updateCounter();
		return;
	}
	if (activeIndex >= 0 && activeIndex < hits.length) {
		hits[activeIndex].classList.remove(CURRENT_CLASS);
	}
	activeIndex = ((index % hits.length) + hits.length) % hits.length;
	const current = hits[activeIndex];
	current.classList.add(CURRENT_CLASS);
	if (scroll) revealAndScrollTo(current);
	updateCounter();
}

export function stepChatFind(delta: 1 | -1): void {
	if (hits.length === 0) return;
	setActiveMatch(activeIndex + delta, true);
}

function collectTextNodes(root: HTMLElement): Text[] {
	const nodes: Text[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let current = walker.nextNode();
	while (current) {
		const parent = current.parentElement;
		if (parent && !parent.closest(SKIP_ANCESTOR_SELECTOR) && (current.nodeValue?.length ?? 0) > 0) {
			nodes.push(current as Text);
		}
		current = walker.nextNode();
	}
	return nodes;
}

function runSearch(query: string, scrollToNearest = true): void {
	clearChatFindHighlights();
	const trimmed = query;
	if (!trimmed) {
		updateCounter();
		return;
	}
	const container = document.getElementById("messages");
	if (!container) {
		updateCounter();
		return;
	}

	const needle = trimmed.toLowerCase();
	const needleLen = needle.length;
	const roots = container.querySelectorAll<HTMLElement>(CONTENT_SELECTORS);
	const found: HTMLElement[] = [];

	outer: for (const root of roots) {
		if (root.closest(".display-hidden, [hidden]")) continue;
		const textNodes = collectTextNodes(root);
		for (const node of textNodes) {
			const raw = node.nodeValue ?? "";
			const lower = raw.toLowerCase();
			let pos = lower.indexOf(needle);
			if (pos === -1) continue;

			const frag = document.createDocumentFragment();
			let cursor = 0;
			while (pos !== -1) {
				if (pos > cursor) {
					frag.append(document.createTextNode(raw.slice(cursor, pos)));
				}
				const mark = document.createElement("mark");
				mark.className = HIT_CLASS;
				mark.textContent = raw.slice(pos, pos + needleLen);
				frag.append(mark);
				found.push(mark);
				cursor = pos + needleLen;
				if (found.length >= MAX_MATCHES) break;
				pos = lower.indexOf(needle, cursor);
			}
			if (cursor < raw.length) {
				frag.append(document.createTextNode(raw.slice(cursor)));
			}
			node.parentNode?.replaceChild(frag, node);
			if (found.length >= MAX_MATCHES) break outer;
		}
	}

	hits = found;
	if (hits.length === 0) {
		activeIndex = -1;
		updateCounter();
		return;
	}

	// Start at the last match (closest to the bottom / latest messages) when searching
	// from the bottom of the transcript, or the first visible match in the viewport.
	const wrap = document.querySelector<HTMLElement>(".messages-wrap");
	let startIndex = hits.length - 1;
	if (wrap && typeof wrap.getBoundingClientRect === "function") {
		const wrapRect = wrap.getBoundingClientRect();
		if (wrapRect.height > 0) {
			const inView = hits.findIndex((h) => {
				const r = h.getBoundingClientRect();
				return r.bottom >= wrapRect.top && r.top <= wrapRect.bottom;
			});
			if (inView !== -1) startIndex = inView;
		}
	}
	setActiveMatch(startIndex, scrollToNearest);
}

/** Create the floating find bar element (mounted inside `.messages-region`). */
export function createChatFindBar(): HTMLElement {
	const bar = el("div", {
		class: "chat-find-bar",
		id: BAR_ID,
		role: "search",
		"aria-label": "Find in current chat",
		hidden: true,
	});

	const input = el("input", {
		type: "search",
		id: INPUT_ID,
		class: "chat-find-input",
		placeholder: "Find in chat…",
		"aria-label": "Find in current chat",
		autocomplete: "off",
		spellcheck: false,
	}) as HTMLInputElement;

	const count = el("span", {
		class: "chat-find-count",
		"aria-live": "polite",
	});

	const prevBtn = el(
		"button",
		{
			type: "button",
			class: "chat-find-btn",
			"data-find-prev": "1",
			title: "Previous match (Shift+Enter)",
			"aria-label": "Previous match",
			disabled: true,
			onclick: () => stepChatFind(-1),
		},
		"↑",
	);

	const nextBtn = el(
		"button",
		{
			type: "button",
			class: "chat-find-btn",
			"data-find-next": "1",
			title: "Next match (Enter)",
			"aria-label": "Next match",
			disabled: true,
			onclick: () => stepChatFind(1),
		},
		"↓",
	);

	const closeBtn = el(
		"button",
		{
			type: "button",
			class: "chat-find-btn chat-find-close",
			title: "Close find (Esc)",
			"aria-label": "Close find in chat",
			onclick: () => closeChatFind(true),
		},
		"✕",
	);

	input.addEventListener("input", () => {
		runSearch(input.value, true);
	});

	input.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			stepChatFind(e.shiftKey ? -1 : 1);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			closeChatFind(true);
		}
	});

	bar.append(input, count, prevBtn, nextBtn, closeBtn);
	return bar;
}

export function openChatFind(initialQuery?: string): void {
	const bar = getBar();
	const input = getInput();
	if (!bar || !input) return;

	if (bar.hidden) {
		const active = document.activeElement;
		lastFocusedBeforeFind = active instanceof HTMLElement ? active : null;
		bar.hidden = false;
	}
	if (typeof initialQuery === "string") {
		input.value = initialQuery;
	}
	input.focus();
	input.select();
	if (input.value) {
		runSearch(input.value, true);
	} else {
		updateCounter();
	}
}

export function closeChatFind(restoreFocus = false): boolean {
	const bar = getBar();
	if (!bar || bar.hidden) return false;
	clearChatFindHighlights();
	bar.hidden = true;
	updateCounter();
	if (restoreFocus) {
		if (lastFocusedBeforeFind?.isConnected) {
			lastFocusedBeforeFind.focus({ preventScroll: true });
		} else {
			document.querySelector<HTMLTextAreaElement>("#input")?.focus({ preventScroll: true });
		}
	}
	lastFocusedBeforeFind = null;
	return true;
}

/** Called when switching chats or re-rendering the transcript. */
export function refreshChatFind(): void {
	if (!isChatFindOpen()) {
		clearChatFindHighlights();
		return;
	}
	const input = getInput();
	if (input?.value) {
		runSearch(input.value, false);
	} else {
		clearChatFindHighlights();
		updateCounter();
	}
}
