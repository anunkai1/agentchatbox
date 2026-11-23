/**
 * Dedicated "Select text" modal for copying partial spans of a single message,
 * especially on mobile browsers where dragging selection handles past the top
 * or bottom of a long message escapes into surrounding chrome or other rows.
 */

import { el, mountModal } from "./dom.js";

export interface SelectTextOptions {
	title?: string;
	copyText?: (text: string) => Promise<boolean>;
	showToast?: (message: string, level?: "info" | "error") => void;
}

/** Return the non-empty selected substring contained within `container`, or "". */
function selectedTextWithin(container: HTMLElement): string {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
	const range = sel.getRangeAt(0);
	if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
		return "";
	}
	return sel.toString();
}

export function openSelectTextModal(rawText: string, options: SelectTextOptions = {}): void {
	const text = rawText.trim() ? rawText : "";
	if (!text) return;

	const title = options.title || "Select text";
	const overlay = el("div", { class: "modal-overlay select-text-overlay" });
	const box = el("div", { class: "modal-box select-text-modal" });

	const header = el(
		"div",
		{ class: "select-text-header" },
		el("h3", { class: "select-text-title" }, title),
		el("p", { class: "select-text-hint" }, "Highlight any part to copy"),
	);

	const body = el(
		"div",
		{
			class: "select-text-body",
			tabIndex: 0,
			role: "textbox",
			"aria-readonly": "true",
			"aria-multiline": "true",
			"aria-label": `${title} content`,
		},
		text,
	);

	const selectAllBtn = el("button", { class: "btn", type: "button" }, "Select all");
	const copyBtn = el("button", { class: "btn btn-primary", type: "button" }, "Copy all");

	const syncCopyLabel = () => {
		const active = selectedTextWithin(body);
		copyBtn.textContent = active ? "Copy selected" : "Copy all";
	};

	const onSelectionChange = () => {
		if (!overlay.isConnected) {
			document.removeEventListener("selectionchange", onSelectionChange);
			return;
		}
		syncCopyLabel();
	};
	document.addEventListener("selectionchange", onSelectionChange);

	selectAllBtn.addEventListener("click", () => {
		const sel = window.getSelection();
		if (!sel) return;
		const range = document.createRange();
		range.selectNodeContents(body);
		sel.removeAllRanges();
		sel.addRange(range);
		copyBtn.textContent = "Copy selected";
	});

	// On mobile browsers, tapping a footer button can collapse the active
	// selection on pointerdown before click fires. Snapshot the live selection
	// at pointerdown so Copy always receives what the user highlighted.
	let pendingCopySelection = "";
	copyBtn.addEventListener("pointerdown", () => {
		pendingCopySelection = selectedTextWithin(body);
	});

	copyBtn.addEventListener("click", () => {
		if (!options.copyText) return;
		const liveSelection = selectedTextWithin(body);
		const chosen = liveSelection || pendingCopySelection;
		pendingCopySelection = "";
		const target = chosen || text;
		const copiedSelection = Boolean(chosen && chosen !== text);
		void options.copyText(target).then((ok) => {
			options.showToast?.(
				ok ? (copiedSelection ? "Selection copied." : "Text copied.") : "Clipboard access denied.",
				ok ? "info" : "error",
			);
		});
	});

	const actions = el("div", { class: "dialog-actions select-text-actions" }, selectAllBtn, copyBtn);
	box.append(header, body, actions);

	mountModal(overlay, box, {
		label: title,
		initialFocus: body,
		onDismiss: () => {
			document.removeEventListener("selectionchange", onSelectionChange);
		},
	});
}
